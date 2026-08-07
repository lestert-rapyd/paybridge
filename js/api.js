/* ─────────────────────────────────────────────────────────────
   Backend fetch wrappers. The backend signs each request with the
   Rapyd secret key (server-side) and proxies to the real Rapyd API.
   ───────────────────────────────────────────────────────────── */

export const BACKEND_URL = 'https://rapyd-backend.vercel.app';

/** POST /api/create-direct-payment → Rapyd POST /v1/payments (own-fields flow) */
export async function createDirectPayment(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-direct-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** POST /api/create-checkout-session → Rapyd POST /v1/checkout (toolkit flow, Phase 3) */
export async function createCheckoutSession(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** POST /api/create-refund → Rapyd POST /v1/refunds (back office) */
export async function createRefund(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** GET /api/retrieve-payment?id=payment_xxx&env=…&profile=… → Rapyd GET /v1/payments/{id}.
    Used by the back office to pull the live payment (settled FX legs +
    refunded_amount) when the SE clicks through to a payment's detail view.
    `profile` = the sandbox MID that created the payment — it's the only one
    that can see it. */
export async function retrievePayment(id, env, profile) {
  const qs = new URLSearchParams({ id, env });
  if (profile) qs.set('profile', profile);
  const res = await fetch(`${BACKEND_URL}/api/retrieve-payment?${qs.toString()}`);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** POST /api/create-customer → Rapyd POST /v1/customers. Always the ENRICHED
    body (see customers.js) so the one session customer is AFT-ready. */
export async function createCustomer(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-customer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** GET /api/retrieve-customer?id=cus_xxx&env=…&profile=… → Rapyd GET
    /v1/customers/{id}. The back office's customer view reads the object back
    from Rapyd (payment_methods, created_at) rather than narrating local state.
    `profile` = the sandbox MID that minted the cus_*** — no other one sees it. */
export async function retrieveCustomer(id, env, profile) {
  const qs = new URLSearchParams({ id, env });
  if (profile) qs.set('profile', profile);
  const res = await fetch(`${BACKEND_URL}/api/retrieve-customer?${qs.toString()}`);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** GET /api/list-customer-payment-methods → Rapyd GET
    /v1/customers/{id}/payment_methods?category=card. Card objects carry
    id (card_***), last4, expiry and network_reference_id. */
export async function listCustomerPaymentMethods(customerId, { env, profile } = {}) {
  const qs = new URLSearchParams({ customer: customerId, env: env || 'sandbox' });
  if (profile) qs.set('profile', profile);
  const res = await fetch(`${BACKEND_URL}/api/list-customer-payment-methods?${qs.toString()}`);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** GET /api/get-fx-rate?... → Rapyd GET /v1/fx_rates (action_type=payment).
    Powers the FX popover's live "customer pays / you receive" preview. buy_ is
    the side the merchant receives, sell_ the side the customer is charged;
    amount is in the fixed_side currency (see app.js's fxPreviewParams). */
export async function getFxRate({ buyCurrency, sellCurrency, amount, fixedSide, env, profile }) {
  const qs = new URLSearchParams({
    buy_currency: buyCurrency,
    sell_currency: sellCurrency,
    amount: String(amount),
    fixed_side: fixedSide,
    env,
  });
  if (profile) qs.set('profile', profile);
  const res = await fetch(`${BACKEND_URL}/api/get-fx-rate?${qs.toString()}`);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** GET /api/webhooks?refs=ref1,ref2,... → batched status for the back-office ledger poller */
export async function fetchWebhooksBatch(refs) {
  const qs = encodeURIComponent(refs.join(','));
  const res = await fetch(`${BACKEND_URL}/api/webhooks?refs=${qs}`);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return data || { byRef: {}, configured: false };
}
