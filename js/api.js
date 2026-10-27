/* ─────────────────────────────────────────────────────────────
   Backend fetch wrappers. The backend signs each request with the
   Rapyd secret key (server-side) and proxies to the real Rapyd API.

   Every wrapper funnels through one request() helper and returns
   { ok, httpStatus, data } — it NEVER throws: a transport failure comes
   back as httpStatus 0 + { error: 'NETWORK_ERROR' }, so callers branch on
   one shape instead of a try/catch plus a status check.

   Live mode is gated server-side: a request whose env is 'live' carries
   the X-PayBridge-Live-Token the SE entered for this tab (sessionStorage,
   never a URL, never logged). A 401/403 from the gate clears it and
   raises `paybridge:live-auth-failed` so the shell can re-prompt.
   ───────────────────────────────────────────────────────────── */

const DEFAULT_BACKEND = 'https://rapyd-backend.vercel.app';

/** Backend origin. Overridable per deployment via
    <meta name="paybridge-backend" content="https://…"> — deliberately NOT
    via a query param, which would let a crafted link point the demo (and
    the live token) at someone else's server. */
export const BACKEND_URL = (() => {
  if (typeof document === 'undefined') return DEFAULT_BACKEND;
  const meta = document.querySelector('meta[name="paybridge-backend"]')?.getAttribute('content')?.trim();
  return (meta || DEFAULT_BACKEND).replace(/\/+$/, '');
})();

/* ── Idempotency ─────────────────────────────────────────────
   One key per LOGICAL operation: a caller that retries the same payment /
   refund passes the same key, so Rapyd dedupes instead of charging twice. */

/** `n` random hex chars — crypto when available. */
function randomHex(n) {
  try {
    if (globalThis.crypto?.getRandomValues) {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2)));
      return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, n);
    }
  } catch { /* fall through */ }
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function newIdempotencyKey() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return randomHex(32);
}

/** A fresh merchant_reference_id: `${prefix}_${ms}_${64 random bits}`.
    GET /api/webhooks?ref= is unauthenticated, so the reference IS the read
    capability for a payment's stored webhooks — a bare timestamp could be
    enumerated (20 guesses per ?refs= call). ~45 chars, well under the
    backend's 128-char cap even with a `_refund_…` suffix. */
export function newReference(prefix) {
  return `${prefix}_${Date.now()}_${randomHex(16)}`;
}

/* ── Live token (per tab) ────────────────────────────────────
   sessionStorage can throw (privacy mode, sandboxed iframe) or not exist
   (test harness), so an in-memory copy backs it. */
const TOKEN_KEY = 'pb_live_token';
let memToken = null;

export function getLiveToken() {
  try {
    const v = sessionStorage.getItem(TOKEN_KEY);
    if (v) return v;
  } catch { /* storage unavailable */ }
  return memToken;
}

export function setLiveToken(token) {
  memToken = token || null;
  try {
    if (memToken) sessionStorage.setItem(TOKEN_KEY, memToken);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable — memory copy still holds it */ }
}

const LIVE_AUTH_ERRORS = new Set(['LIVE_AUTH_REQUIRED', 'LIVE_DISABLED']);

function liveAuthFailed(error, message) {
  setLiveToken(null);
  try {
    window.dispatchEvent(new CustomEvent('paybridge:live-auth-failed', { detail: { error, message } }));
  } catch { /* no window (test harness) */ }
}

/** The one request helper. `env` is the request's env (body.env or the
    query's env) — only 'live' attaches the gate token. */
async function request(path, { method = 'GET', query = null, body, env, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);
  if (env === 'live') {
    const t = getLiveToken();
    if (t) headers['X-PayBridge-Live-Token'] = t;
  }
  let url = `${BACKEND_URL}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (err) {
    // CORS-less 404s from an undeployed route also land here ("Failed to fetch").
    return { ok: false, httpStatus: 0, data: { error: 'NETWORK_ERROR', message: err?.message || 'Network request failed' } };
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if ((res.status === 401 || res.status === 403) && LIVE_AUTH_ERRORS.has(data?.error)) {
    liveAuthFailed(data.error, data.message || '');
  }
  return { ok: res.ok, httpStatus: res.status, data };
}

const post = (path, body, { idempotencyKey } = {}) =>
  request(path, { method: 'POST', body: body ?? {}, env: body?.env, idempotencyKey });

/** POST /api/create-direct-payment → Rapyd POST /v1/payments (own-fields flow) */
export function createDirectPayment(body, opts = {}) {
  return post('/api/create-direct-payment', body, opts);
}

/** POST /api/create-checkout-session → Rapyd POST /v1/checkout (toolkit flow, Phase 3) */
export function createCheckoutSession(body, opts = {}) {
  return post('/api/create-checkout-session', body, opts);
}

/** POST /api/create-refund → Rapyd POST /v1/refunds (back office) */
export function createRefund(body, opts = {}) {
  return post('/api/create-refund', body, opts);
}

/** GET /api/retrieve-payment?id=payment_xxx&env=…&profile=… → Rapyd GET /v1/payments/{id}.
    Used by the back office to pull the live payment (settled FX legs +
    refunded_amount) when the SE clicks through to a payment's detail view,
    and by the watchers to confirm an outcome a webhook only claimed.
    `profile` = the sandbox MID that created the payment — it's the only one
    that can see it. */
export function retrievePayment(id, env, profile) {
  return request('/api/retrieve-payment', { query: { id, env, profile }, env });
}

/** POST /api/create-customer → Rapyd POST /v1/customers. Always the ENRICHED
    body (see customers.js) so the one session customer is AFT-ready. */
export function createCustomer(body, opts = {}) {
  return post('/api/create-customer', body, opts);
}

/** GET /api/retrieve-customer?id=cus_xxx&env=…&profile=… → Rapyd GET
    /v1/customers/{id}. The back office's customer view reads the object back
    from Rapyd (payment_methods, created_at) rather than narrating local state.
    `profile` = the sandbox MID that minted the cus_*** — no other one sees it. */
export function retrieveCustomer(id, env, profile) {
  return request('/api/retrieve-customer', { query: { id, env, profile }, env });
}

/** GET /api/list-customer-payment-methods → Rapyd GET
    /v1/customers/{id}/payment_methods?category=card. Card objects carry
    id (card_***), last4, expiry and network_reference_id. */
export function listCustomerPaymentMethods(customerId, { env, profile } = {}) {
  const e = env || 'sandbox';
  return request('/api/list-customer-payment-methods', { query: { customer: customerId, env: e, profile }, env: e });
}

/** GET /api/get-fx-rate?... → Rapyd GET /v1/fx_rates (action_type=payment).
    Powers the FX popover's live "customer pays / you receive" preview. buy_ is
    the side the merchant receives, sell_ the side the customer is charged;
    amount is in the fixed_side currency (see app.js's fxPreviewParams). */
export function getFxRate({ buyCurrency, sellCurrency, amount, fixedSide, env, profile }) {
  return request('/api/get-fx-rate', {
    query: {
      buy_currency: buyCurrency,
      sell_currency: sellCurrency,
      amount: String(amount),
      fixed_side: fixedSide,
      env,
      profile,
    },
    env,
  });
}

/* ── Webhook reads (GET /api/webhooks) ───────────────────────
   Not Rapyd-proxy calls, so no live gate. These return the receiver's
   own shape rather than { ok, httpStatus, data }; `configured` is null
   when the read itself failed (unknown ≠ "KV not configured"), and `ok`
   says whether the read landed. */
const MAX_REFS_PER_CALL = 20; // the backend's cap — more would be silently dropped
const MAX_REF_LEN = 128;

/** GET /api/webhooks?ref=… → the events filed under one merchant_reference_id. */
export async function fetchWebhooks(ref) {
  if (!ref) return { events: [], configured: null, ok: false };
  const { ok, data } = await request('/api/webhooks', { query: { ref } });
  return {
    events: ok && Array.isArray(data?.events) ? data.events : [],
    configured: typeof data?.configured === 'boolean' ? data.configured : null,
    ok,
  };
}

/** GET /api/webhooks?customer=cus_… → CUSTOMER_* events. They carry no
    merchant_reference_id, so the receiver files them under the cus_*** id. */
export async function fetchCustomerWebhooks(customerId, { env } = {}) {
  if (!customerId) return { events: [], configured: null, ok: false };
  const { ok, data } = await request('/api/webhooks', { query: { customer: customerId, env } });
  return {
    events: ok && Array.isArray(data?.events) ? data.events : [],
    configured: typeof data?.configured === 'boolean' ? data.configured : null,
    ok,
  };
}

/** GET /api/webhooks?refs=ref1,ref2,... → batched status for the back-office
    ledger poller. Chunked to the backend's 20-ref cap and merged, so a long
    session never has refs silently dropped. Returns { byRef, configured }. */
export async function fetchWebhooksBatch(refs) {
  const list = [...new Set((refs || []).filter((r) => r && String(r).length <= MAX_REF_LEN))];
  if (!list.length) return { byRef: {}, configured: null };
  const chunks = [];
  for (let i = 0; i < list.length; i += MAX_REFS_PER_CALL) chunks.push(list.slice(i, i + MAX_REFS_PER_CALL));
  const results = await Promise.all(chunks.map((c) => request('/api/webhooks', { query: { refs: c.join(',') } })));
  const byRef = {};
  let configured = null;
  for (const { ok, data } of results) {
    if (ok && data?.byRef && typeof data.byRef === 'object') Object.assign(byRef, data.byRef);
    if (data?.configured === true) configured = true;
    else if (data?.configured === false && configured === null) configured = false;
  }
  return { byRef, configured };
}
