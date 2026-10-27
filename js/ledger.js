/* ─────────────────────────────────────────────────────────────
   Session-scoped payment ledger — the back office's source of truth.
   NOT a global webhook list (that would mix every concurrent demo user
   on this shared sandbox tool); this only ever knows about
   payments/refunds made in THIS browser tab this session.

   Independent of the customer-facing singleton watcher in webhooks.js —
   no shared state, so an in-progress 3DS challenge (driving the client
   screen via that singleton) and a back-office refund poll never
   interfere with each other.

   Trust: only a signature-verified webhook (or our own Retrieve Payment
   result) settles an entry — and only one signed for the entry's env and
   about the entry's own payment/refund id (classify.js isTrustedFor). Any
   other terminal-looking webhook — forged, or genuinely signed for
   someone else's payment that reused our reference — triggers a Retrieve
   Payment instead, so it can't credit the wallet. An entry whose id isn't
   known yet is settled ONLY via Retrieve (which checks the reference).
   ───────────────────────────────────────────────────────────── */

import { fetchWebhooksBatch, retrievePayment } from './api.js';
import { classify, isTrustedFor } from './classify.js';
import { state } from './state.js';

const entries = new Map(); // reference -> entry
const listeners = new Set();
let timer = null;

function notify() {
  state.ledger = [...entries.values()];
  for (const fn of listeners) {
    // one throwing subscriber must not starve the rest (or reject a poll)
    try { fn(state.ledger); } catch (err) { console.error('ledger listener failed:', err); }
  }
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

/** Re-read one payment from Rapyd (with the env + MID that created it) and
    merge it — the back office calls this after a refund, so refunded_amount
    and the X/Y figures follow the server. Never rejects. */
export async function refreshPayment(reference) {
  try {
    const e = entries.get(reference);
    if (!e?.payment_id) return;
    const { ok, data } = await retrievePayment(e.payment_id, e.env || state.env, e.profile || state.profile);
    if (ok && !data?.error && data?.data) applyPaymentObject(reference, data.data); // notifies
  } catch { /* transient — the ledger keeps its last figures */ }
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
    The LARGER of Rapyd's server-side refunded_amount (from the last GET)
    and this session's completed refunds — the GET goes stale the moment a
    new refund completes, and taking it alone made the full-refund default
    over-ask. Returns { refunded, total, currency, remaining, count }. */
export function refundedTotals(entry) {
  const s = entry.settled || {};
  const total = s.original_amount ?? num(entry.amount) ?? 0;
  const currency = s.currency || entry.currency;
  const completed = entry.refunds.filter((r) => r.status === 'completed');
  // customer_equiv normalizes both FX routes back to the customer currency,
  // so X/Y stays correct even when a refund was issued in merchant currency.
  const localSum = completed
    .reduce((acc, r) => acc + (num(r.customer_equiv) ?? num(r.amount) ?? 0), 0);
  const refunded = Math.max(num(s.refunded_amount) ?? 0, localSum);
  const remaining = Math.max(0, Math.round((total - refunded) * 100) / 100);
  return { refunded: Math.round(refunded * 100) / 100, total, currency, remaining, count: completed.length };
}

/** The shopper's Orders page, grouped: `mine` — payments made under the
    signed-in customer `customerId`; `guest` — this tab's guest checkouts (no
    customer at all). Payments under some OTHER customer (one forgotten or
    swapped out this session) belong to neither. Same merchant (vertical) and
    environment only; newest first. Pure — tests/unit.js pins it. */
export function ordersFor(list, { customerId = null, vertical, env } = {}) {
  const here = (list || [])
    .filter((e) => e && e.kind === 'payment' && e.vertical === vertical && e.env === env)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return {
    mine: customerId ? here.filter((e) => e.customer_id === customerId) : [],
    guest: here.filter((e) => !e.customer_id),
  };
}

/** Called right when a flow builds its outbound body — captures exactly
    what the customer was charged, independent of what the webhook later
    reports (this is what makes the FX-safe refund default correct).
    Stored-credential extensions (all optional, additive):
      origin          'client' | 'backoffice' (MIT charges fire from back office)
      initiation_type the body's initiation_type ('customer_present' default)
      credential      { kind: 'vault'|'token', label } when a stored card paid
      aft             the payment carried the AFT indicator block
      profile         sandbox MID that created it (retrieval/refunds must reuse it)
      env             'sandbox' | 'live' it was created in — defaults to state.env
                      NOW, so a later env switch can't send its retrieve/refund
                      to the other environment
      items           what was bought — [{ id, name, qty, amount, currency,
                      billing }] (verticals.js orderItems); the shopper's
                      Orders page (js/site/account.js) reads it. Text only.
      customer_id     the cus_*** the payment was made under (the body's
                      `customer`), or null for a guest checkout — what the
                      Orders page groups by (ordersFor below). */
export function recordPayment(reference, { model, vertical, amount, currency, requested_currency, fixed_side, last4, brand, origin, initiation_type, credential, aft, profile, env, items, customer_id }) {
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
    origin: origin || 'client',
    initiation_type: initiation_type || 'customer_present',
    credential: credential || null,
    aft: !!aft,
    items: Array.isArray(items) ? items.map((i) => ({ ...i })) : null,
    customer_id: typeof customer_id === 'string' && /^cus_/.test(customer_id) ? customer_id : null,
    profile: profile || state.profile,
    env: env || state.env,
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

/* ── Poller ──────────────────────────────────────────────────
   Every 4s: read the webhooks filed under each still-open reference
   (newest first, chunked by api.js to the backend's 20-ref cap) and
   settle from TRUSTED terminal events only. Retrieve Payment backs it up:
     · an unverified terminal-looking webhook → confirm immediately
     · no webhook at all → retrieve on a backoff (15s, 30s, 60s, 120s…)
       for entries no other watcher covers (back-office MIT charges,
       refunds, client payments once webhooks.js's 5-minute watch ended)
     · completed but never settled → retrieve to backfill the FX truth
   Anything still unsettled 30 min after creation leaves the active set —
   the payment didn't happen in this demo's lifetime, and polling it
   forever would grow every request. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const CLIENT_WATCH_MS = 5 * 60 * 1000;      // webhooks.js's own watch window
const BACKOFF_MS = [15000, 30000, 60000, 120000];
const FAIL_STATUS = ['ERR', 'EXP', 'CAN', 'DEC'];
let polling = false;

// Confirmation bookkeeping lives off-entry (state.ledger stays plain data).
const confirmMeta = new WeakMap(); // entry | refund -> { inFlight, attempts, nextAt, seen }
function metaFor(obj) {
  let m = confirmMeta.get(obj);
  if (!m) { m = { inFlight: false, attempts: 0, nextAt: obj.created_at + BACKOFF_MS[0], seen: new Set() }; confirmMeta.set(obj, m); }
  return m;
}
/** May we fire a Retrieve for `obj` now? `urgentKey` = an unverified
    terminal event not yet confirmed — each one buys one immediate check. */
function claimConfirm(obj, urgentKey) {
  const m = metaFor(obj);
  if (m.inFlight) return false;
  const now = Date.now();
  if (urgentKey && !m.seen.has(urgentKey)) m.seen.add(urgentKey);
  else if (now < m.nextAt) return false;
  m.inFlight = true;
  m.attempts += 1;
  m.nextAt = now + BACKOFF_MS[Math.min(m.attempts, BACKOFF_MS.length - 1)];
  return true;
}
const releaseConfirm = (obj) => { metaFor(obj).inFlight = false; };
const eventKey = (ev) => `${ev.event_id || ''}|${ev.received_at || ''}|${ev.type || ''}`;

const isOpen = (x) => x.status !== 'completed' && x.status !== 'failed';
const fresh = (x, now) => now - x.created_at < ACTIVE_WINDOW_MS;

function activeRefs() {
  const now = Date.now();
  const refs = [];
  for (const e of entries.values()) {
    // Keep polling a payment until it's terminal AND we've harvested its
    // settled FX truth — the client flow's own watcher may flip status to
    // completed (via updateStatus) before the poller sees the webhook, and
    // the wallet needs e.settled regardless of who confirmed first.
    if (fresh(e, now) && (isOpen(e) || (e.status === 'completed' && !e.settled))) {
      refs.push({ ref: e.reference, at: e.created_at });
    }
    for (const r of e.refunds) {
      if (isOpen(r) && fresh(r, now)) refs.push({ ref: r.reference, at: r.created_at });
    }
  }
  // newest first — the payment the SE is narrating right now matters most
  return refs.sort((a, b) => b.at - a.at).map((x) => x.ref);
}

/** Split a reference's events into the trusted terminal outcome (if any)
    and the terminal-looking events that only earn a confirmation, never a
    settlement (`claims`). `env` / `id` = the entry's env and its known
    payment (or refund) id; with no id yet, NOTHING settles directly — a
    signed event for another payment could carry our reference. */
function terminal(events, { env, id }) {
  let success = null, failure = null;
  const claims = [];
  for (const ev of events) {
    const kind = classify(ev);
    if (kind === 'pending') continue;
    if (!id || !isTrustedFor(ev, { env, paymentId: id })) { claims.push(ev); continue; }
    if (kind === 'success') success = success || ev;
    else failure = failure || ev;
  }
  return { success, failure, claims };
}

/** The first claim not yet sent for confirmation (else the first) — so a
    forged event can't hog the one urgent check and starve a real one. */
function nextClaim(obj, claims) {
  const seen = metaFor(obj).seen;
  return claims.find((c) => !seen.has(eventKey(c))) || claims[0] || null;
}

/** Settle a payment entry from a full Rapyd payment object. Only a FINAL
    status settles — an ACT (3DS still open) answer changes nothing. */
function settlePayment(e, p) {
  let changed = false;
  if (p.id && e.payment_id !== p.id) { e.payment_id = p.id; changed = true; }
  const won = p.status === 'CLO' && p.paid;
  if (won) { e.settled = settlementOf(p); changed = true; }
  if (isOpen(e)) {
    if (won) { e.status = 'completed'; e.phase = 'completed'; changed = true; }
    else if (FAIL_STATUS.includes(p.status)) { e.status = 'failed'; e.phase = 'failed'; changed = true; }
  }
  return changed;
}

/** GET the entry's payment with the env + MID that created it. A payment id
    taken from an (unverified) webhook must carry THIS entry's reference —
    otherwise a forged event could point us at any payment on the MID. */
async function retrieveFor(e, hintId) {
  const id = e.payment_id || hintId;
  if (!id) return null;
  const { ok, data } = await retrievePayment(id, e.env || state.env, e.profile || state.profile);
  const p = ok && !data?.error ? data?.data : null;
  if (!p) return null;
  if (!e.payment_id && p.merchant_reference_id !== e.reference) return null;
  return p;
}

async function confirmPayment(e, hint) {
  try {
    // hint (a claim) may only supply the id when we have none — retrieveFor
    // then requires the payment to carry this entry's reference.
    const p = await retrieveFor(e, hint?.payment_id);
    if (p && settlePayment(e, p)) notify();
  } catch { /* transient — the backoff retries */ } finally { releaseConfirm(e); }
}

const refundList = (p) => (Array.isArray(p?.refunds) ? p.refunds : Array.isArray(p?.refunds?.data) ? p.refunds.data : []);

/** Confirm a refund from its parent payment: Rapyd's payment object lists
    its refunds (match by refund id, else merchant_reference_id); failing
    that, a server refunded_amount that already covers this refund counts.
    The triggering event is never consulted — a forged event may only cause
    a confirmation, never choose which refund it settles from. */
async function confirmRefund(e, r) {
  try {
    const p = await retrieveFor(e, null);
    if (!p) return;
    let changed = false;
    if (p.status === 'CLO' && p.paid) { e.settled = settlementOf(p); changed = true; } // fresh refunded_amount
    const list = refundList(p);
    const match = (r.refund_id && list.find((x) => x?.id === r.refund_id)) ||
      list.find((x) => x?.merchant_reference_id === r.reference);
    if (isOpen(r)) {
      const st = String(match?.status || '').toLowerCase();
      if (st === 'completed') {
        Object.assign(r, { status: 'completed', refund_id: match.id || r.refund_id,
          amount: match.amount ?? r.amount, currency: match.currency ?? r.currency });
        changed = true;
      } else if (/rejected|error|cancel|fail/.test(st)) {
        r.status = 'failed'; changed = true;
      } else if (!match) {
        const priorDone = e.refunds
          .filter((x) => x !== r && x.status === 'completed')
          .reduce((acc, x) => acc + (num(x.customer_equiv) ?? num(x.amount) ?? 0), 0);
        const need = priorDone + (num(r.customer_equiv) ?? num(r.amount) ?? 0);
        const server = num(p.refunded_amount);
        if (server != null && need > 0 && server >= need - 0.005) { r.status = 'completed'; changed = true; }
      }
    }
    if (changed) notify();
  } catch { /* transient — the backoff retries */ } finally { releaseConfirm(r); }
}

async function pollOnce(refs) {
  const { byRef = {} } = await fetchWebhooksBatch(refs);
  const wanted = new Set(refs);
  const now = Date.now();
  let changed = false;
  const followUps = [];

  for (const e of entries.values()) {
    if (wanted.has(e.reference)) {
      const events = byRef[e.reference] || [];
      const { success, failure, claims } = terminal(events, { env: e.env, id: e.payment_id });
      const claim = nextClaim(e, claims);
      if (isOpen(e)) {
        if (success) {
          // success.payment_id === e.payment_id here (isTrustedFor) — the id is
          // never taken from an event; an id-less entry settles via Retrieve.
          e.status = 'completed'; e.phase = 'completed';
          if (success.raw?.data) e.settled = settlementOf(success.raw.data); // harvest the FX truth
          changed = true;
        } else if (failure) {
          e.status = 'failed'; e.phase = 'failed'; changed = true;
        } else if (claim && claimConfirm(e, eventKey(claim))) {
          followUps.push(() => confirmPayment(e, claim));
        } else if (e.payment_id && (e.origin !== 'client' || now - e.created_at > CLIENT_WATCH_MS) && claimConfirm(e)) {
          // no webhook delivered — nothing else is watching this one
          followUps.push(() => confirmPayment(e, null));
        }
      } else if (e.status === 'completed' && !e.settled) {
        // client watcher confirmed first — backfill settled from the same
        // (trusted) webhook, else from a Retrieve
        if (success?.raw?.data) { e.settled = settlementOf(success.raw.data); changed = true; }
        else if ((e.payment_id || claim?.payment_id) && claimConfirm(e, claim ? eventKey(claim) : null)) followUps.push(() => confirmPayment(e, claim));
      }
    }
    for (const r of e.refunds) {
      if (!wanted.has(r.reference) || !isOpen(r)) continue;
      const { success, failure, claims } = terminal(byRef[r.reference] || [], { env: e.env, id: r.refund_id });
      const claim = nextClaim(r, claims);
      if (success) {
        r.status = 'completed';
        const raw = success.raw?.data;
        if (raw) {
          r.refund_id = raw.id || r.refund_id;
          r.amount = raw.amount ?? r.amount;
          r.currency = raw.currency ?? r.currency;
        }
        // refunded_amount on the parent is now stale — pull the server's
        followUps.push(() => refreshPayment(e.reference));
        changed = true;
      } else if (failure) {
        r.status = 'failed'; changed = true;
      } else if (e.payment_id && claimConfirm(r, claim ? eventKey(claim) : null)) {
        followUps.push(() => confirmRefund(e, r));
      }
    }
  }
  if (changed) notify();
  // Fire-and-forget: each confirm notifies on its own; none of them throws.
  for (const run of followUps) run();
}

async function poll() {
  if (polling) return; // a slow read must not stack overlapping polls
  const refs = activeRefs();
  if (!refs.length) return; // interval keeps running (cheap no-op) — a later payment/refund may add refs
  polling = true;
  try { await pollOnce(refs); } catch { /* transient — next tick retries */ } finally { polling = false; }
}

function ensurePolling() {
  if (timer) return;
  timer = setInterval(poll, 4000);
}
