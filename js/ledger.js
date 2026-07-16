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

/** Called right when a flow builds its outbound body — captures exactly
    what the customer was charged, independent of what the webhook later
    reports (this is what makes the FX-safe refund default correct). */
export function recordPayment(reference, { model, vertical, amount, currency, requested_currency, fixed_side }) {
  entries.set(reference, {
    reference,
    kind: 'payment',
    model,
    vertical,
    payment_id: null,
    amount,
    currency,
    requested_currency: requested_currency || null,
    fixed_side: fixed_side || null,
    status: 'pending',   // 'pending' | 'completed' | 'failed'
    phase: 'created',    // human-readable live phase for the back-office pill
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

export function recordRefund(paymentReference, { reference, amount, currency, reason }) {
  const e = entries.get(paymentReference);
  if (!e) return;
  e.refunds.push({
    reference,
    refund_id: null,
    amount: amount ?? null,
    currency: currency ?? null,
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
    if (e.status !== 'completed' && e.status !== 'failed') refs.push(e.reference);
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
      if (success) { e.status = 'completed'; e.phase = 'completed'; changed = true; }
      else if (failure) { e.status = 'failed'; e.phase = 'failed'; changed = true; }
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
