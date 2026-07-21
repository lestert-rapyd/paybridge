/* ─────────────────────────────────────────────────────────────
   Session-scoped payment ledger — the back office's source of truth.
   NOT the global `wh:recent` KV list (that mixes every concurrent demo
   user on this shared sandbox tool); this only ever knows about
   payments/refunds made in THIS browser tab this session.

   Independent of the customer-facing singleton watcher in webhooks.js —
   no shared state, so an in-progress 3DS challenge (driving the client
   screen via that singleton) and a back-office refund poll never
   interfere with each other.
   ───────────────────────────────────────────────────────────── */

import { fetchWebhooksBatch } from './api.js';
import { classify } from './classify.js';
import { state } from './state.js';

const entries = new Map(); // reference -> entry
const listeners = new Set();
let timer = null;

function notify() {
  state.ledger = [...entries.values()];
  for (const fn of listeners) fn(state.ledger);
}

export function subscribeLedger(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLedger() {
  return [...entries.values()].sort((a, b) => b.created_at - a.created_at);
}

export function getEntry(reference) {
  return entries.get(reference) || null;
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

/** Pull the settled truth out of a full Rapyd payment object (webhook
    raw.data OR the GET /v1/payments response — same shape). This is what
    powers the wallet, the summary tiles and the detail view:
      - what the CUSTOMER paid  → original_amount / currency
      - what the MERCHANT got   → merchant_requested_amount / _currency (FX only)
      - the rate at capture, the card last4/brand, and Rapyd's own running
        refunded_amount (server truth for X/Y eligibility). */
export function settlementOf(d = {}) {
  const pmd = d.payment_method_data || {};
  const merchAmt = num(d.merchant_requested_amount);
  const merchCur = d.merchant_requested_currency || null;
  return {
    original_amount: num(d.original_amount) ?? num(d.amount),
    currency: d.currency_code || d.currency || null,
    // only treat as FX when a distinct merchant leg is actually present
    merchant_requested_amount: merchCur && merchAmt != null ? merchAmt : null,
    merchant_requested_currency: merchCur && merchAmt != null ? merchCur : null,
    fx_rate: num(d.fx_rate),
    last4: pmd.last4 || null,
    brand: pmd.type || null,
    refunded_amount: num(d.refunded_amount) ?? 0,
  };
}

/** Merge a retrieved/webhook payment object into the ledger entry — used by
    the poller on PAYMENT_COMPLETED and by the back office after a live GET,
    so a tile's settled figures and refunded_amount stay in sync either way. */
export function applyPaymentObject(reference, payObj) {
  const e = entries.get(reference);
  if (!e || !payObj) return;
  e.settled = settlementOf(payObj);
  if (payObj.id) e.payment_id = payObj.id;
  notify();
}

/** Wallet balance, derived (never stored) — folds completed payments as
    credits and completed refunds as debits, per currency. Recomputed on
    every notify(), so it's reactive to refunds by construction. */
export function walletBalances() {
  const bal = {};
  const add = (cur, amt) => { if (cur && amt != null) bal[cur] = (bal[cur] || 0) + amt; };
  for (const e of entries.values()) {
    if (e.status !== 'completed') continue;
    const s = e.settled;
    // credit the leg that actually landed in the wallet
    if (s?.merchant_requested_amount != null) add(s.merchant_requested_currency, s.merchant_requested_amount);
    else add(e.currency, num(e.amount));
    for (const r of e.refunds) {
      if (r.status !== 'completed') continue;
      add(r.merchant_debit_currency || r.currency, -(r.merchant_debit_amount ?? num(r.amount)));
    }
  }
  // drop noise from float subtraction
  for (const k of Object.keys(bal)) bal[k] = Math.round(bal[k] * 100) / 100;
  return bal;
}

/** How much of a payment has been refunded, in the customer currency.
    Prefers Rapyd's server-side refunded_amount (from a GET) when present,
    else sums this session's completed refunds that were in the customer
    currency. Returns { refunded, total, currency, remaining, count }. */
export function refundedTotals(entry) {
  const s = entry.settled || {};
  const total = s.original_amount ?? num(entry.amount) ?? 0;
  const currency = s.currency || entry.currency;
  const completed = entry.refunds.filter((r) => r.status === 'completed');
  // customer_equiv normalizes both FX routes back to the customer currency,
  // so X/Y stays correct even when a refund was issued in merchant currency.
  const localSum = completed
    .reduce((acc, r) => acc + (num(r.customer_equiv) ?? num(r.amount) ?? 0), 0);
  const refunded = s.refunded_amount != null && s.refunded_amount > 0 ? s.refunded_amount : localSum;
  const remaining = Math.max(0, Math.round((total - refunded) * 100) / 100);
  return { refunded: Math.round(refunded * 100) / 100, total, currency, remaining, count: completed.length };
}

/** Called right when a flow builds its outbound body — captures exactly
    what the customer was charged, independent of what the webhook later
    reports (this is what makes the FX-safe refund default correct). */
export function recordPayment(reference, { model, vertical, amount, currency, requested_currency, fixed_side, last4, brand }) {
  entries.set(reference, {
    reference,
    kind: 'payment',
    model,
    vertical,
    payment_id: null,
    amount,
    currency,
    last4: last4 || null,   // fallback for the tile until the webhook carries payment_method_data
    brand: brand || null,
    requested_currency: requested_currency || null,
    fixed_side: fixed_side || null,
    status: 'pending',   // 'pending' | 'completed' | 'failed'
    phase: 'created',    // human-readable live phase for the back-office pill
    settled: null,       // filled from PAYMENT_COMPLETED / GET (see settlementOf)
    refunds: [],
    created_at: Date.now(),
  });
  notify();
  ensurePolling();
}

export function setPaymentId(reference, paymentId) {
  const e = entries.get(reference);
  if (!e || !paymentId) return;
  e.payment_id = paymentId;
  notify();
}

/** Live intermediate status (e.g. "pending_3ds") as well as terminal
    outcomes — called from the same points that already drive setStatus()
    in own-fields.js/toolkit.js, so back office reflects the payment's
    real-time state, not just its eventual outcome. */
export function updateStatus(reference, patch) {
  const e = entries.get(reference);
  if (!e) return;
  Object.assign(e, patch);
  notify();
}

export function recordRefund(paymentReference, { reference, amount, currency, reason, route, merchant_debit_amount, merchant_debit_currency, customer_equiv }) {
  const e = entries.get(paymentReference);
  if (!e) return;
  e.refunds.push({
    reference,
    refund_id: null,
    amount: amount ?? null,            // refund body amount — what we send to Rapyd
    currency: currency ?? null,
    customer_equiv: customer_equiv ?? amount ?? null, // normalized to customer currency, for X/Y
    merchant_debit_amount: merchant_debit_amount ?? amount ?? null, // wallet leg
    merchant_debit_currency: merchant_debit_currency ?? currency ?? null,
    route: route || null,              // 'customer' | 'merchant' | null (non-FX)
    reason: reason || '',
    status: 'pending',
    created_at: Date.now(),
  });
  notify();
  ensurePolling();
}

export function updateRefund(paymentReference, refundReference, patch) {
  const e = entries.get(paymentReference);
  const r = e?.refunds.find((x) => x.reference === refundReference);
  if (!r) return;
  Object.assign(r, patch);
  notify();
}

function activeRefs() {
  const refs = [];
  for (const e of entries.values()) {
    // Keep polling a payment until it's terminal AND we've harvested its
    // settled FX truth — the client flow's own watcher may flip status to
    // completed (via updateStatus) before the poller sees the webhook, and
    // the wallet needs e.settled regardless of who confirmed first.
    if (e.status !== 'completed' && e.status !== 'failed') refs.push(e.reference);
    else if (e.status === 'completed' && !e.settled) refs.push(e.reference);
    for (const r of e.refunds) {
      if (r.status !== 'completed' && r.status !== 'failed') refs.push(r.reference);
    }
  }
  return refs;
}

async function poll() {
  const refs = activeRefs();
  if (!refs.length) return; // interval keeps running (cheap no-op) — a later payment/refund may add refs
  let byRef = {};
  try {
    const data = await fetchWebhooksBatch(refs);
    byRef = data.byRef || {};
  } catch { /* transient */ }

  let changed = false;
  const terminal = (events) => {
    const success = events.find((ev) => classify(ev) === 'success');
    const failure = events.find((ev) => classify(ev) === 'failure');
    return { success, failure };
  };

  for (const e of entries.values()) {
    const events = byRef[e.reference];
    if (events?.length && e.status !== 'completed' && e.status !== 'failed') {
      const { success, failure } = terminal(events);
      if (success) {
        e.status = 'completed'; e.phase = 'completed';
        if (success.raw?.data) e.settled = settlementOf(success.raw.data); // harvest the FX truth
        changed = true;
      }
      else if (failure) { e.status = 'failed'; e.phase = 'failed'; changed = true; }
    } else if (events?.length && e.status === 'completed' && !e.settled) {
      // client watcher confirmed first — backfill settled from the same webhook
      const { success } = terminal(events);
      if (success?.raw?.data) { e.settled = settlementOf(success.raw.data); changed = true; }
    }
    for (const r of e.refunds) {
      const rEvents = byRef[r.reference];
      if (rEvents?.length && r.status !== 'completed' && r.status !== 'failed') {
        const { success, failure } = terminal(rEvents);
        if (success) {
          r.status = 'completed';
          const raw = success.raw?.data;
          if (raw) {
            r.refund_id = raw.id || r.refund_id;
            r.amount = raw.amount ?? r.amount;
            r.currency = raw.currency ?? r.currency;
          }
          changed = true;
        } else if (failure) { r.status = 'failed'; changed = true; }
      }
    }
  }
  if (changed) notify();
}

function ensurePolling() {
  if (timer) return;
  timer = setInterval(poll, 4000);
}
