/* ─────────────────────────────────────────────────────────────
   Webhook watcher (Phase 5).
   Polls GET /api/webhooks?ref=… and renders each real incoming
   webhook as an expandable card (pill + line-numbered JSON), mirroring
   the Response tab. Fires onTerminal(event) once a PAYMENT_COMPLETED /
   PAYMENT_FAILED (or terminal status) arrives — that drives the
   left-panel success/error screen. Falls back to Retrieve Payment.

   Trust: /api/webhook is a public URL, so a webhook only DRIVES the
   screen when the receiver verified its Rapyd signature with a key pair
   of THIS payment's environment and, once the payment id is known, the
   event is about that payment (classify.js isTrustedFor — anyone can get
   a sandbox MID to sign a PAYMENT_COMPLETED carrying our reference). Any
   other terminal-looking event is still painted —
   with an "unverified — not trusted" chip — and triggers an immediate
   Retrieve Payment; onTerminal only ever sees a trusted event: a
   verified webhook, or the retrieve-derived
     { type: '(status poll)', source: 'retrieve', status, paid,
       payment_id, raw: { data: <full Rapyd payment> } }
   whose raw.data lets the flows harvest card_*** / NRID from it too.

   Retrieve fallback: retried on a backoff (15s, 30s, 60s, 120s, …
   after the payment id is known) until the payment reaches a final
   status — a customer still in a 3DS challenge at 15s is the normal
   case, not an edge case.

   The panel holds TWO sections, in beat order: the customer beat's
   CUSTOMER_* events above the payment's — plus, on a page that registers
   one (the wallet's PAYOUT_* events, js/site/wallet-page.js via steps.js),
   a third below them. All are painted from here so there stays exactly ONE
   writer of #panel-webhooks (this module's poll re-runs every 2.5s and
   would otherwise clobber a second writer).

   CUSTOMER_* events carry no merchant_reference_id, so the receiver
   files them under the cus_*** id — the customer poll reads
   GET /api/webhooks?customer=cus_… (never a global list).
   ───────────────────────────────────────────────────────────── */

import { fetchWebhooks, fetchCustomerWebhooks, retrievePayment } from './api.js';
import { state } from './state.js';
import { renderJSONView } from './json-view.js';
import { classify, isTrusted, isTrustedFor } from './classify.js';
import { esc } from './ui.js';

const $ = (s) => document.querySelector(s);
const FAIL_STATUS = ['ERR', 'EXP', 'CAN', 'DEC'];
// Retrieve fallback offsets from the moment the payment id is known.
const RETRY_AT_MS = [15000, 30000, 60000, 120000, 180000, 240000];
const WATCH_MS = 300000; // 5 min — SE may pause to narrate the 3DS challenge

let timer = null;
let gen = 0;            // bumps on every (re)start/clear — late async results from an older watch are dropped
let ref = null;
let paymentId = null;
let paymentIdAt = 0;    // when we learned the payment id — fallback timing keys off this
let watchProfile = null; // sandbox MID that created the payment — the only one that can retrieve it
let watchEnv = null;     // env it was created in — a later env switch must not re-route the retrieve
let startedAt = 0;
let configured = null;
let fallbackStatus = null;
let onTerminal = null;
let onPoll = null;
let terminalSource = null; // null | 'fallback' | 'webhook'
let lastEvents = [];       // last payment events painted — so the customer poll can repaint without them
let pollBusy = false;
let retrieveBusy = false;
let retryIdx = 0;          // next RETRY_AT_MS slot
let retrieveDone = false;  // Retrieve saw a final status — stop the backoff (the canonical webhook may still land)
let confirmed = new Set(); // unverified events already sent to Retrieve for confirmation

export function startWebhookWatch({ reference, payment_id, onTerminal: cb, onPoll: pollCb } = {}) {
  stopWebhookWatch();
  gen++;
  ref = reference;
  paymentId = payment_id || null;
  paymentIdAt = payment_id ? Date.now() : 0;
  watchProfile = state.profile; // captured now — a later profile switch must not re-key the fallback
  watchEnv = state.env;
  onTerminal = cb || null;
  onPoll = pollCb || null;
  startedAt = Date.now();
  configured = null;
  fallbackStatus = null;
  terminalSource = null;
  pollBusy = false;
  retrieveBusy = false;
  retryIdx = 0;
  retrieveDone = false;
  confirmed = new Set();
  render([]);
  poll();
  timer = setInterval(poll, 2500);
}

export function setWatchPaymentId(id) {
  if (!id) return;
  if (!paymentId) paymentIdAt = Date.now(); // toolkit: payment exists only now
  paymentId = id;
}

export function stopWebhookWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Flow reset (vertical/model/env switch, "Run another payment"): forget the
    previous payment entirely, so its section can't be repainted where the empty
    state belongs. The CUSTOMER section deliberately survives — the cus_*** is
    still real. Kept separate from stopWebhookWatch(), which maybeFireTerminal()
    calls and then renders the terminal event off exactly this state. */
export function clearPaymentWatch() {
  stopWebhookWatch();
  gen++; // an in-flight poll/retrieve for the old payment must not repaint it
  ref = null;
  paymentId = null;
  lastEvents = [];
  fallbackStatus = null;
  configured = null;
  terminalSource = null;
}

/* ── Customer beat (POST /v1/customers) ──────────────────────
   State is PUSHED in from customer-beat.js rather than imported back out of
   it — that module already imports this one to start the watch, and a cycle
   between the two would be the only one in the codebase. */
let cusId = null;
let cusBeat = 'idle';    // idle | draft | sending | created | error
let cusEvents = [];
let cusTimer = null;
let cusStartedAt = 0;
let cusConfigured = null;
let cusSettled = false;  // the watch window closed — "none delivered" is now the honest answer

export function setCustomerBeat({ id = null, state: beat = 'idle' } = {}) {
  const same = id === cusId && beat === cusBeat;
  if (id !== cusId) {
    // A different (or withdrawn) customer — the old events describe someone else.
    stopCustomerWatch();
    cusEvents = [];
    cusSettled = false;
  }
  cusId = id;
  cusBeat = beat;
  if (beat === 'created' && id && !cusTimer && !cusSettled) startCustomerWatch();
  if (!same) repaintWebhooks();
}

function startCustomerWatch() {
  cusStartedAt = Date.now();
  cusPoll();
  cusTimer = setInterval(cusPoll, 2500);
}
function stopCustomerWatch() {
  if (cusTimer) clearInterval(cusTimer);
  cusTimer = null;
}

const isCustomerEvent = (e) => {
  if (!/^CUSTOMER/i.test(e?.type || '')) return false;
  const d = e.raw?.data || {};
  // CUSTOMER_CREATED carries the cus_*** as data.id; the payment-method events
  // carry the card as data.id and the customer as data.customer. Still checked
  // client-side — the list is filed by customer id, but belt and braces.
  return d.id === cusId || d.customer === cusId;
};

async function cusPoll() {
  const id = cusId;
  if (!id) return;
  const { events, configured: c, ok } = await fetchCustomerWebhooks(id, { env: state.env });
  if (id !== cusId) return; // the customer changed while this read was in flight
  if (typeof c === 'boolean') cusConfigured = c;
  if (ok) cusEvents = events.filter(isCustomerEvent);
  const created = cusEvents.some(e => /^CUSTOMER_CREATED/i.test(e.type || ''));
  // 60s is generous for a webhook Rapyd only sends when the event is
  // registered for the MID; after that, silence IS the answer.
  if (created || Date.now() - cusStartedAt > 60000) {
    stopCustomerWatch();
    cusSettled = true;
  }
  repaintWebhooks();
}

/* ── Payment watch ───────────────────────────────────────────── */
const eventKey = (e) => `${e.event_id || ''}|${e.received_at || ''}|${e.type || ''}`;
const isFinal = (p) => (p.status === 'CLO' ? !!p.paid : FAIL_STATUS.includes(p.status));

// A throwing flow handler must not wedge the watcher mid-transition.
function fireTerminal(ev) {
  try { onTerminal?.(ev); } catch (err) { console.error('onTerminal handler failed:', err); }
}

// Counts for THIS watch: verified by this env's MID and, once known, about
// this payment. A verified event for another payment is only a claim.
const counts = (e) => isTrustedFor(e, { env: watchEnv, paymentId });

function maybeFireTerminal(events) {
  if (terminalSource === 'webhook' || !onTerminal) return;
  const trusted = events.filter(counts);
  const hit = trusted.find(e => classify(e) === 'success') || trusted.find(e => classify(e) === 'failure');
  if (hit) {
    // Fires even after a poll-fallback confirmation — the verified webhook is
    // the canonical signal, so it upgrades the screen ("Confirmed by …").
    terminalSource = 'webhook';
    fireTerminal(hit);
    stopWebhookWatch();
    render(events);
    return;
  }
  if (terminalSource) return; // already confirmed by Retrieve — an unverified event adds nothing
  // An unverified terminal-looking event is a CLAIM: check it with Rapyd now
  // rather than waiting for the next backoff slot.
  const claim = events.find(e => !counts(e) && classify(e) !== 'pending' && !confirmed.has(eventKey(e)));
  if (claim && !retrieveBusy && (paymentId || claim.payment_id)) {
    confirmed.add(eventKey(claim));
    runRetrieve(claim);
  }
}

/** Backoff schedule — RETRY_AT_MS after the payment id is known, until a
    final status. Independent of whether any (non-terminal) webhook landed:
    a PAYMENT_SUCCEEDED with no PAYMENT_COMPLETED behind it must not strand
    the screen. */
function maybeRetrieve() {
  if (terminalSource || retrieveDone || retrieveBusy || !paymentId || !paymentIdAt) return;
  if (retryIdx >= RETRY_AT_MS.length || Date.now() - paymentIdAt < RETRY_AT_MS[retryIdx]) return;
  retryIdx++;
  runRetrieve(null);
}

/** GET /v1/payments/{id} with the env + MID captured at watch start. `claim`
    (an unverified webhook) may supply the id when the flow hasn't learned it
    yet — then the payment must carry THIS session's reference, or a forged
    event could point us at any payment on the MID. */
async function runRetrieve(claim) {
  const id = paymentId || claim?.payment_id;
  if (!id) return;
  const my = gen;
  retrieveBusy = true;
  try {
    const { ok, data } = await retrievePayment(id, watchEnv || state.env, watchProfile || state.profile);
    if (my !== gen) return;
    const p = ok && !data?.error ? data?.data : null;
    if (!p) return;
    if (!paymentId) {
      if (p.merchant_reference_id !== ref) return;
      setWatchPaymentId(p.id);
    }
    fallbackStatus = { status: p.status, paid: p.paid, id: p.id };
    if (isFinal(p)) {
      retrieveDone = true;
      if (!terminalSource && onTerminal) {
        terminalSource = 'fallback';
        fireTerminal({ type: '(status poll)', source: 'retrieve', status: p.status, paid: p.paid, payment_id: p.id, raw: { data: p } });
        // keep watching — the late webhook still lands in the panel and
        // upgrades the confirmation via maybeFireTerminal()
      }
    }
    render(lastEvents);
  } catch { /* transient — the backoff retries */ } finally {
    if (my === gen) retrieveBusy = false;
  }
}

async function poll() {
  if (pollBusy) return; // a slow read must not stack overlapping polls
  const my = gen;
  pollBusy = true;
  try {
    onPoll?.();
    const { events, configured: c, ok } = await fetchWebhooks(ref);
    if (my !== gen) return;
    if (typeof c === 'boolean') configured = c;
    const evs = ok ? events : lastEvents; // a transient failure keeps what's painted

    render(evs);
    maybeFireTerminal(evs);
    maybeRetrieve();

    // Window runs from the later of watch start and payment creation — the
    // toolkit watch starts at session creation, minutes before the payment.
    const since = Math.max(startedAt, paymentIdAt || 0);
    if (Date.now() - since > WATCH_MS) stopWebhookWatch();
  } catch { /* transient */ } finally {
    if (my === gen) pollBusy = false;
  }
}

/* ── Markup ──────────────────────────────────────────────────
   Everything below lands in innerHTML and webhook bodies are attacker-
   controllable, so every interpolated value goes through esc(). */
function pill(text, cls = '') { return `<span class="wh-pill ${esc(cls)}">${esc(text)}</span>`; }

// One pill per field Rapyd actually sends, rather than one combined string —
// easier to scan, and each field only appears when the event carries it.
function fieldPills(e) {
  const d = e.raw?.data || {};
  const ar = d.authentication_result || {};
  return [
    ['status', e.status ?? d.status, classify(e)],
    ['paid', d.paid ?? e.paid, null],
    ['next_action', d.next_action, null],
    ['eci', ar.eci, null],
    ['result', ar.result, null],
  ]
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v, kind]) => pill(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`, kind || 'field'))
    .join('');
}

function verifyChip(e) {
  if (e.source === 'retrieve') return `<span class="wh-verify ok">✓ confirmed via Retrieve Payment</span>`;
  // Which env's MID signed it — a sandbox signature never settles a live payment.
  if (e.verified === 'verified') return `<span class="wh-verify ok">✓ signature verified${e.verified_env ? ` · ${esc(e.verified_env)}` : ''}</span>`;
  if (e.verified === 'unverified' || e.verified === 'skipped') {
    const why = e.verified === 'skipped' ? 'No Rapyd signature headers' : 'Rapyd signature did not match';
    return `<span class="wh-verify warn" title="${esc(why)} — shown, but confirmed via Retrieve Payment before it counts">unverified — not trusted</span>`;
  }
  return `<span class="wh-verify">received</span>`; // built locally (e.g. back office's synchronous refund failure)
}

/** One webhook event card — shared by both sections here and by the back
    office's webhook tab, so the markup (and its escaping) lives once. */
export function eventCardHTML(e, open) {
  const kind = classify(e);
  const untrusted = kind !== 'pending' && !isTrusted(e) && e.verified !== undefined;
  return `
    <details class="wh-card ${kind}${untrusted ? ' untrusted' : ''}" ${open ? 'open' : ''}>
      <summary class="wh-card-head">
        <span class="wh-chev">▸</span>
        ${pill(e.type || 'EVENT', 'evt')}
        ${fieldPills(e)}
        ${verifyChip(e)}
      </summary>
      <div class="wh-card-json">${renderJSONView(e.raw || e)}</div>
    </details>`;
}

/* Beat 1's section. Four honest states, because Rapyd only sends CUSTOMER_*
   when those events are registered for the MID — "nothing arrived" has to be
   sayable without implying something broke. */
function customerSectionHTML() {
  if (cusBeat === 'idle') return '';
  const label = `<div class="wh-beat-label"><span class="wh-beat-n">1</span>Customer · <code>POST /v1/customers</code></div>`;

  if (cusBeat === 'draft' || cusBeat === 'sending') {
    return `${label}
      <div class="wh-expect-row">
        <span class="wh-expect">CUSTOMER_CREATED</span>
        <span class="wh-expect">CUSTOMER_PAYMENT_METHOD_CREATED</span>
      </div>
      <div class="wh-expect-note">Expected, not yet fired — <code>CUSTOMER_CREATED</code> when the account is created, <code>CUSTOMER_PAYMENT_METHOD_CREATED</code> when the first card is stored under it.</div>`;
  }
  if (cusBeat === 'error') {
    return `${label}<div class="wh-expect-note">The create call failed, so no customer event can fire. See the Response tab.</div>`;
  }

  const listening = !!cusTimer;
  let html = `${label}
    <div class="wh-status ${listening ? 'live' : ''}">
      <span class="wh-status-dot"></span>
      ${listening ? 'Listening for customer events' : (cusEvents.length ? 'Delivered' : 'Not delivered')}
      <span class="wh-ref">${esc(cusId || '—')}</span>
    </div>`;
  if (cusConfigured === false) {
    html += `<div class="wh-note">Webhook receiver not configured — add Vercel KV + register <code>/api/webhook</code>.</div>`;
  } else if (cusEvents.length) {
    html += cusEvents.map((e, i) => eventCardHTML(e, i === 0)).join('');
  } else if (listening) {
    html += `<div class="wh-waiting">Watching for a <code>CUSTOMER_*</code> event filed under <code>${esc(cusId)}</code> — these carry no <code>merchant_reference_id</code>, so the receiver files them by customer id instead of this session's ref.</div>`;
  } else {
    html += `<div class="wh-note">No <code>CUSTOMER_*</code> event delivered. Rapyd fires these only when the event is registered for this MID (Client Portal → Developers → Webhooks) — the <code>${esc(cusId)}</code> in the response is the source of truth either way. <code>CUSTOMER_PAYMENT_METHOD_CREATED</code> may still arrive when the first card is saved.</div>`;
  }
  return html;
}

/* Beat 2's section — the original payment watcher, unchanged apart from the
   beat label and the guard that keeps it out of the way before a payment. */
function paymentSectionHTML() {
  if (!ref) return '';
  const events = lastEvents;
  const listening = !!timer;
  // Numbered only when the customer beat is on screen above it.
  const label = cusBeat === 'idle' ? '' :
    `<div class="wh-beat-label"><span class="wh-beat-n">2</span>Payment events</div>`;

  let html = `${label}
    <div class="wh-status ${listening ? 'live' : ''}">
      <span class="wh-status-dot"></span>
      ${listening ? 'Listening for webhooks' : (events.length ? 'Delivered' : 'Idle')}
      <span class="wh-ref">ref ${esc(ref || '—')}</span>
    </div>`;

  if (configured === false) {
    html += `<div class="wh-note">Webhook receiver not configured — add Vercel KV + register <code>/api/webhook</code>. Showing polling fallback.</div>`;
  }

  if (events.length) {
    html += events.map((e, i) => eventCardHTML(e, i === 0)).join('');
  } else if (configured !== false) {
    html += `<div class="wh-waiting">Waiting for Rapyd to POST an event to <code>/api/webhook</code>…</div>`;
  }

  if (fallbackStatus) {
    html += `<div class="wh-fallback">
      <span class="wh-fallback-tag">POLL FALLBACK</span>
      Retrieve Payment → <code>status: ${esc(fallbackStatus.status)}</code> <code>paid: ${esc(fallbackStatus.paid)}</code>
      <div class="wh-fallback-note">Pull-based — verified webhooks remain the canonical signal.</div>
    </div>`;
  }
  return html;
}

/** Repaint the whole panel from both sections. Exported so app.js can restore
    it after renderBackend() wipes the panel on a flow reset (the customer
    survives a reset, so its section has to come back). */
/* A page's own extra section (markup, '' for none) — registered once by the
   steps router, so this module never imports the page that owns it. */
let extraSection = () => '';
export function setExtraWebhookSection(fn) { extraSection = typeof fn === 'function' ? fn : () => ''; }

export function repaintWebhooks() {
  // Back office has its own renderer for the same shared DOM targets — while
  // it's the active left tab, this watcher keeps polling/tracking terminal
  // state (so the hidden client screen updates correctly in the background)
  // but skips the DOM write so it can't clobber back office's own paint.
  if (state.leftView && state.leftView !== 'client') return;
  const el = $('#panel-webhooks');
  if (!el) return;
  const html = customerSectionHTML() + paymentSectionHTML() + extraSection();
  if (!html) return; // nothing to say yet — leave app.js's empty state alone
  el.innerHTML = html;
}

function render(events) {
  lastEvents = events;
  repaintWebhooks();
}
