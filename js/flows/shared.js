/* ─────────────────────────────────────────────────────────────
   Shared pieces of the two client flows (own-fields.js / toolkit.js).
   Both used to carry their own copy of each of these, and the copies
   had started to drift (one harvest dropped the save before checking
   the event, the other logged; one totals block escaped nothing).

     · order totals + the fx_rates beat card     (markup)
     · the POST /v1/payments response card        (markup)
     · the amount gate                            (F13 — sync.js validAmount)
     · the idempotent send                        (one key per logical attempt)
     · the terminal handler                       (trusted event → screen + ledger)
     · the card-save slot + harvest               (card_*** / NRID / vault PAN)

   Flow-specific differences stay parameters; nothing here reads a
   flow's module state.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { activeProduct, customerCharge, chargeText, getFxBeat, fxBeatPath } from '../verticals.js';
import { newIdempotencyKey, retrievePayment } from '../api.js';
import { renderJSONView } from '../json-view.js';
import { esc, setStatus } from '../ui.js';
import { brandLabel, validAmount, currencyDecimals } from '../sync.js';
import { isTrusted } from '../classify.js';
import { renderSuccess, renderError } from '../screens.js';
import * as ledger from '../ledger.js';
import * as customers from '../customers.js';
import { promoteToReturning } from '../identity.js';
import { beatCardHTML } from '../customer-beat.js';

/* ── Markup ──────────────────────────────────────────────── */

/** Customer-facing order totals. `c` is a customerCharge() object — what the
    customer actually pays (the converted figure under 'buy'). The amount can
    be SE-typed (the price tile), so it's escaped like any other input. */
export function totalsHTML(c, feeLabel, feeValue, perMonth = false) {
  const amt = esc(chargeText(c));
  const mo = perMonth ? ' <span class="per-mo">/mo</span>' : '';
  return `
    <div class="co-line"><span>Subtotal</span><span>${amt}</span></div>
    <div class="co-line"><span>${esc(feeLabel)}</span><span class="${feeValue === 'Free' ? 'free' : ''}">${esc(feeValue)}</span></div>
    <div class="co-line total"><span>Total</span><span class="co-total-amt">${amt}${mo}</span></div>`;
}

/** totalsHTML() for the active product — the common call. */
export function productTotalsHTML(p = activeProduct()) {
  return totalsHTML(customerCharge(), p.delivery ? 'Delivery' : 'Fees', p.delivery || 'Free', p.billing === 'subscription');
}

/* The fx_rates quote, as a card. Recorded in verticals.js by app.js's debounced
   fetcher; shown by both flows so the call the FX controls make is inspectable
   like any other beat instead of living only on the storefront. */
export function fxCardHTML() {
  const b = getFxBeat();
  if (!b) return '';
  const ok = b.httpStatus >= 200 && b.httpStatus < 400 && !b.data?.error;
  return beatCardHTML({
    id: 'beat-fx', method: 'GET', path: fxBeatPath(), // text — beatCardHTML escapes path/badge
    badge: ok ? 'quoted' : 'failed', badgeKind: ok ? 'ok' : 'err',
    inner: `
      <div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">${httpLabel(b.httpStatus)}</span></div>
      ${renderJSONView(b.data ?? { error: 'no response body' })}`,
  });
}

/** "HTTP 402", or "NO RESPONSE" for api.js's transport failure (httpStatus 0). */
export const httpLabel = (s) => (s ? `HTTP ${esc(s)}` : 'NO RESPONSE');
export const httpOk = (s) => s >= 200 && s < 400;

/** [label, kind] for a POST /v1/payments response — kind feeds .wh-pill. */
export function paymentBadge(httpStatus, data) {
  const d = data?.data;
  if (d?.status === 'CLO' && d?.paid) return ['PAID · CLO', 'success'];
  if (d?.status === 'ACT')           return ['ACTION · ACT', 'pending'];
  if (data?.error)                   return [String(data.error), 'failure'];
  if (d?.status)                     return [String(d.status), 'pending'];
  return [httpLabel(httpStatus), httpOk(httpStatus) ? 'success' : 'failure'];
}
const BADGE_KIND = { success: 'ok', failure: 'err', pending: 'live' };

/** The POST /v1/payments response card — own-fields' payment and the
    toolkit's express token charge render the same call the same way.
    beatCardHTML escapes its badge (text); `inner` is ours to escape. */
export function paymentResponseCardHTML({ id, n, httpStatus, data }) {
  const [badge, kind] = paymentBadge(httpStatus, data);
  return beatCardHTML({
    id, n, method: 'POST', path: '/v1/payments',
    badge, badgeKind: BADGE_KIND[kind] || '',
    inner: `
      <div class="eng-pillrow">
        <span class="wh-pill ${httpOk(httpStatus) ? 'success' : 'failure'}">${httpLabel(httpStatus)}</span>
        <span class="wh-pill ${kind}">${esc(badge)}</span>
      </div>
      ${renderJSONView(data ?? { error: 'no response body' })}`,
  });
}

/* ── Amount gate (F13) ───────────────────────────────────────
   The tile's amount is free text; '' or '149.999' GBP used to go out as
   Number('') = 0 or a 3-decimal amount Rapyd rejects. app.js now keeps an
   invalid draft out of productOverride and raises state.amountInvalid
   instead (and owns the tile's own invalid styling) — so the gate is that
   flag first, then the product's amount itself as the backstop. */

/** null when the active product's amount can be sent, else the reason (plain text). */
export function amountProblem(p = activeProduct()) {
  if (state.amountInvalid) return 'Fix the amount — Pay stays disabled until it’s valid';
  if (validAmount(p.amount, p.currency)) return null;
  const n = Number(String(p.amount ?? '').trim());
  if (String(p.amount ?? '').trim() === '' || !Number.isFinite(n)) return 'Enter an amount';
  if (n <= 0) return 'The amount must be greater than zero';
  const dp = currencyDecimals(p.currency);
  return dp === 0
    ? `${p.currency} amounts can’t have decimals`
    : `${p.currency} allows at most ${dp} decimal place${dp === 1 ? '' : 's'}`;
}

/** Body value for `amount`: a number once valid; the raw text while it isn't,
    so the request panel shows what's wrong instead of a silent 0. */
export function bodyAmount(p = activeProduct()) {
  return validAmount(p.amount, p.currency) ? Number(p.amount) : p.amount;
}

/* ── Errors ──────────────────────────────────────────────── */

/** The backend's live-gate refusals (see the backend contract). api.js already
    raises paybridge:live-auth-failed for the auth pair; the flows just render
    them as a normal failure with the server's message. */
export const LIVE_GATE_ERRORS = new Set([
  'LIVE_AUTH_REQUIRED', 'LIVE_DISABLED', 'LIVE_LIMIT', 'LIVE_RAW_CARD_FORBIDDEN', 'LIVE_FIELD_NOT_ALLOWED',
]);
const STATUS_TEXT = {
  LIVE_AUTH_REQUIRED: 'Live token required',
  LIVE_DISABLED: 'Live disabled',
  LIVE_LIMIT: 'Over live limit',
  LIVE_RAW_CARD_FORBIDDEN: 'Card data blocked (live)',
  LIVE_FIELD_NOT_ALLOWED: 'Field blocked (live)',
  NETWORK_ERROR: 'Network error',
};
/** Header status-pill text for a failed create call. */
export const failureStatusText = (data, fallback = 'Declined') => STATUS_TEXT[data?.error] || fallback;

/** Only an https URL may be opened / framed from a server response. */
export function httpsUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

/* ── Idempotent send (F15) ───────────────────────────────────
   ONE Idempotency-Key per logical attempt (a Pay click, a session launch).
   When the outcome is unknown — no response at all, or the backend's 502/504
   for a Rapyd 5xx / timeout — the SAME body is re-sent once under the SAME
   key, so Rapyd answers with the original result instead of charging twice.
   A definite answer (2xx/4xx) is never retried. */
const UNKNOWN_OUTCOME = new Set([0, 502, 504]);
const RETRY_DELAY_MS = 1500;

/** Still unknown after sendIdempotent's retry: the payment may exist. A flow
    must NOT call that a decline — it leaves the ledger entry pending (phase
    'unconfirmed') and watches the reference, so a trusted webhook or a
    Retrieve-confirmed claim can still settle it. */
export const isUnknownOutcome = (httpStatus) => UNKNOWN_OUTCOME.has(httpStatus);

/** call: an api.js POST wrapper (never throws). Resolves its { ok, httpStatus, data }. */
export async function sendIdempotent(call, body, { onRetry } = {}) {
  const idempotencyKey = newIdempotencyKey();
  let res = await call(body, { idempotencyKey });
  if (UNKNOWN_OUTCOME.has(res?.httpStatus)) {
    try { onRetry?.(res); } catch { /* UI hook only */ }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    res = await call(body, { idempotencyKey });
  }
  return res;
}

/* ── Terminal handler ────────────────────────────────────────
   webhooks.js only ever hands onTerminal a TRUSTED event — a signature-
   verified webhook or its own retrieve-derived { source: 'retrieve', … }.
   The isTrusted() check below is belt and braces: this is the code path
   that paints "paid" and saves a card. `reference` is the payment the watch
   was started for, so the ledger update can't land on a newer one. */
/* `onShown(success)` runs just before the terminal screen paints, only when
   it does (this payment still owns the screen) — the hosted flow uses it to
   move the address bar back to the merchant's return page (js/seam.js). */
export function terminalHandler({ reference, paidLabel = 'Paid', slot = null, hooks = {}, onShown = null }) {
  return (ev) => {
    if (!isTrusted(ev)) return;
    const success = /COMPLETED|CAPTURE/.test(String(ev.type || '').toUpperCase()) || (ev.status === 'CLO' && ev.paid);
    const current = state.reference === reference; // a reset/new payment owns the screen now
    if (success) {
      if (current) { onShown?.(true); setStatus(paidLabel, 'ok'); renderSuccess(ev); }
      ledger.updateStatus(reference, { status: 'completed', phase: 'completed' });
      slot?.harvest(ev, hooks);
    } else {
      if (current) { onShown?.(false); setStatus('Failed', 'error'); renderError(ev); }
      ledger.updateStatus(reference, { status: 'failed', phase: 'failed' });
      slot?.clear(reference); // nothing was authorised for reuse
    }
  };
}

/* ── Card-save slot + harvest ────────────────────────────────
   Between the create call and the terminal event, a flow holds a snapshot
   of what it promised to save. The slot is cleared ONLY by a successful
   harvest or a terminal failure — never just because an event arrived
   (the old harvests nulled it first and then found no raw.data on the
   status-poll event, silently losing the card).

   The snapshot captures customers.bucketKey() and the reference when the
   payment is sent: the SE may switch sandbox profile during a 3DS
   challenge, and the cus_/card_ must land under the MID that minted it. */

/** Build the snapshot. Call it synchronously right before the create call. */
export function pendingCardSave({ vault = false, token = false, recurrence_type, aft = false, origin_model, origin_product, snapshot = null }) {
  return {
    vault, token, recurrence_type, aft: !!aft,
    origin_vertical: state.vertical, origin_model, origin_product,
    snapshot,
    key: customers.bucketKey(),
    reference: state.reference,
    busy: false,
  };
}

/** One pending save per flow. harvest() is fire-and-forget and never rejects. */
export function cardSaveSlot() {
  let pending = null;
  return {
    arm(ps) { pending = ps || null; },
    /** Drop the pending save — optionally only when it belongs to `reference`. */
    clear(reference) { if (!reference || pending?.reference === reference) pending = null; },
    get pending() { return pending; },
    harvest(ev, hooks) {
      const ps = pending;
      if (!ps || ps.busy) return; // a second terminal (webhook upgrading a retrieve) must not double-save
      ps.busy = true;
      harvestSavedCard(ev, ps, hooks).then((done) => {
        ps.busy = false;
        if (done && pending === ps) pending = null;
      });
    },
  };
}

const cardIdOf = (d) => {
  const pmd = d.payment_method_data || {};
  return (typeof d.payment_method === 'string' && /^card_/.test(d.payment_method) && d.payment_method) ||
    (typeof pmd.id === 'string' && /^card_/.test(pmd.id) && pmd.id) || null;
};
// A payment object from a different session's payment must never be harvested.
const sameRef = (d, ps) => !d.merchant_reference_id || !ps.reference || d.merchant_reference_id === ps.reference;
// …nor one from a different payment that reused our reference (anyone can
// create a sandbox payment with any merchant_reference_id) — once the ledger
// knows this payment's id, the object must be that payment.
const samePayment = (d, ps) => {
  const known = ledger.getEntry(ps.reference)?.payment_id;
  return !known || d.id === known;
};
const ours = (d, ps) => sameRef(d, ps) && samePayment(d, ps);

/** The full Rapyd payment behind a trusted terminal event: its raw.data (a
    webhook, or webhooks.js's retrieve-derived event), else a Retrieve Payment
    under the env + MID the save was armed with. null when neither exists. */
async function paymentObjectFor(ev, ps) {
  const d = ev?.raw?.data;
  if (d && typeof d === 'object') return ours(d, ps) ? d : null;
  const id = ev?.payment_id || ledger.getEntry(ps.reference)?.payment_id;
  if (!id) return null;
  const sep = ps.key.indexOf(':');
  const { ok, data } = await retrievePayment(id, ps.key.slice(0, sep), ps.key.slice(sep + 1));
  const p = ok && !data?.error ? data?.data : null;
  return p && ours(p, ps) ? p : null;
}

/** Pull the stored credential(s) out of the completed payment: card_*** as
    the payment's payment_method (or payment_method_data.id), the scheme's
    network_reference_id in payment_method_data. The list endpoint then
    silently backfills what the payment didn't carry (expiry etc.).
    hooks: { onCardSaved(cardId, ps), onSync(ps) } — the toolkit logs both.
    Resolves true once harvested, false when there was nothing to harvest
    from yet (the slot keeps the save for the next trusted event). */
export async function harvestSavedCard(ev, ps, { onCardSaved, onSync } = {}) {
  if (!ps) return false;
  try {
    const d = await paymentObjectFor(ev, ps);
    if (!d) return false;
    const opts = { key: ps.key };
    const pmd = d.payment_method_data || {};
    const nri = pmd.network_reference_id || null;
    const snap = ps.snapshot || {};
    const meta = {
      recurrence_type: ps.recurrence_type, aft: ps.aft,
      origin_vertical: ps.origin_vertical, origin_model: ps.origin_model, origin_product: ps.origin_product,
    };
    if (ps.vault) {
      const ref = customers.addVaultCredential({ ...snap, ...meta }, opts);
      if (nri) customers.setNetworkReferenceId(ref, nri, opts);
    }
    if (ps.token) {
      const cardId = cardIdOf(d);
      if (cardId) {
        const ref = customers.upsertTokenCredential({
          card_id: cardId,
          type: pmd.type || snap.type || null,
          brand: snap.brand || brandLabel(pmd.type),
          last4: pmd.last4 || snap.last4 || null,
          expiration_month: snap.expiration_month || pmd.expiration_month || null,
          expiration_year: snap.expiration_year || pmd.expiration_year || null,
          ...meta,
        }, opts);
        if (nri) customers.setNetworkReferenceId(ref, nri, opts);
        onCardSaved?.(cardId, ps);
      }
      onSync?.(ps);
      customers.refreshTokens(opts).catch(() => {}); // silent backfill — never rejects, belt and braces
    }
    // A card is now on file, so the natural next state is "Returning customer"
    // — but only if the SE is still looking at the bucket it was filed under.
    if (customers.bucketKey() === ps.key) promoteToReturning();
    return true;
  } catch (err) {
    console.error('card harvest failed:', err);
    return false;
  }
}
