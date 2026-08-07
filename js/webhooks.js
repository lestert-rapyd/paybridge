/* ─────────────────────────────────────────────────────────────
   Webhook watcher (Phase 5).
   Polls GET /api/webhooks?ref=… and renders each real incoming
   webhook as an expandable card (pill + line-numbered JSON), mirroring
   the Response tab. Fires onTerminal(event) once a PAYMENT_COMPLETED /
   PAYMENT_FAILED (or terminal status) arrives — that drives the
   left-panel success/error screen. Falls back to Retrieve Payment.

   The panel holds TWO sections, in beat order: the customer beat's
   CUSTOMER_* events above the payment's. Both are painted from here so
   there stays exactly ONE writer of #panel-webhooks (this module's poll
   re-runs every 2.5s and would otherwise clobber a second writer).

   CUSTOMER_* events carry no merchant_reference_id, so the receiver files
   them under wh:unknown + wh:recent — hence the customer poll reads the
   REF-LESS endpoint (which falls back to wh:recent) and filters client-side.
   ───────────────────────────────────────────────────────────── */

import { BACKEND_URL } from './api.js';
import { state } from './state.js';
import { renderJSONView } from './json-view.js';
import { classify } from './classify.js';

const $ = (s) => document.querySelector(s);
const FAIL_STATUS = ['ERR', 'EXP', 'CAN', 'DEC'];

let timer = null;
let ref = null;
let paymentId = null;
let paymentIdAt = 0;    // when we learned the payment id — fallback timing keys off this
let watchProfile = null; // sandbox MID that created the payment — the only one that can retrieve it
let startedAt = 0;
let configured = null;
let fallbackDone = false;
let fallbackStatus = null;
let onTerminal = null;
let onPoll = null;
let terminalSource = null; // null | 'fallback' | 'webhook'
let lastEvents = [];       // last payment events painted — so the customer poll can repaint without them

export function startWebhookWatch({ reference, payment_id, onTerminal: cb, onPoll: pollCb } = {}) {
  stopWebhookWatch();
  ref = reference;
  paymentId = payment_id || null;
  paymentIdAt = payment_id ? Date.now() : 0;
  watchProfile = state.profile; // captured now — a later profile switch must not re-key the fallback
  onTerminal = cb || null;
  onPoll = pollCb || null;
  startedAt = Date.now();
  configured = null;
  fallbackDone = false;
  fallbackStatus = null;
  terminalSource = null;
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
  if (!/^CUSTOMER/i.test(e.type || '')) return false;
  const d = e.raw?.data || {};
  // CUSTOMER_CREATED carries the cus_*** as data.id; the payment-method events
  // carry the card as data.id and the customer as data.customer.
  return d.id === cusId || d.customer === cusId;
};

async function cusPoll() {
  try {
    // No `ref` — the receiver has nowhere to file a merchant_reference_id-less
    // event, so these live in wh:recent (webhooks.js's ref-less fallback).
    const r = await fetch(`${BACKEND_URL}/api/webhooks`);
    const j = await r.json();
    cusConfigured = j.configured;
    cusEvents = (j.events || []).filter(isCustomerEvent);
  } catch { /* transient */ }
  const created = cusEvents.some(e => /^CUSTOMER_CREATED/i.test(e.type || ''));
  // 60s is generous for a webhook Rapyd only sends when the event is
  // registered for the MID; after that, silence IS the answer.
  if (created || Date.now() - cusStartedAt > 60000) {
    stopCustomerWatch();
    cusSettled = true;
  }
  repaintWebhooks();
}

function maybeFireTerminal(events) {
  if (terminalSource === 'webhook' || !onTerminal) return;
  const success = events.find(e => classify(e) === 'success');
  const failure = events.find(e => classify(e) === 'failure');
  const hit = success || failure;
  if (hit) {
    // Fires even after a poll-fallback confirmation — the webhook is the
    // canonical signal, so it upgrades the screen ("Confirmed by …").
    terminalSource = 'webhook';
    onTerminal(hit);
    stopWebhookWatch();
    render(events);
  }
}

async function poll() {
  onPoll?.();
  let events = [];
  try {
    const r = await fetch(`${BACKEND_URL}/api/webhooks?ref=${encodeURIComponent(ref)}`);
    const j = await r.json();
    events = j.events || [];
    configured = j.configured;
  } catch { /* transient */ }

  const elapsed = Date.now() - startedAt;

  // Fallback: no webhook 15s after the PAYMENT exists → poll status once.
  // Timed from paymentIdAt, not watch start — the toolkit watcher starts at
  // session creation, long before the customer finishes the iframe/3DS, and
  // timing from startedAt made the fallback race (and beat) the real webhook.
  if (!events.length && !fallbackDone && paymentId && paymentIdAt && Date.now() - paymentIdAt > 15000) {
    fallbackDone = true;
    try {
      const r = await fetch(`${BACKEND_URL}/api/retrieve-payment?id=${encodeURIComponent(paymentId)}&env=${state.env}&profile=${watchProfile || state.profile}`);
      const j = await r.json();
      const p = j?.data;
      if (p) {
        fallbackStatus = { status: p.status, paid: p.paid, id: p.id };
        if (!terminalSource && onTerminal && (p.status === 'CLO' ? p.paid : FAIL_STATUS.includes(p.status))) {
          terminalSource = 'fallback';
          onTerminal({ type: '(status poll)', status: p.status, paid: p.paid, payment_id: p.id });
          // keep watching — the late webhook still lands in the panel and
          // upgrades the confirmation via maybeFireTerminal()
        }
      }
    } catch { /* ignore */ }
  }

  render(events);
  maybeFireTerminal(events);
  if (elapsed > 300000) stopWebhookWatch(); // 5 min — SE may pause to narrate the 3DS challenge
}

function pill(text, cls = '') { return `<span class="wh-pill ${cls}">${text}</span>`; }

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
    .map(([k, v, kind]) => pill(`${k}: ${v}`, kind || 'field'))
    .join('');
}

function verifyChip(v) {
  if (v === 'verified')   return `<span class="wh-verify ok">✓ signature verified</span>`;
  if (v === 'unverified') return `<span class="wh-verify warn">signature n/a</span>`;
  return `<span class="wh-verify">received</span>`;
}

/* One event card — shared by both sections. */
function eventCardHTML(e, open) {
  const kind = classify(e);
  return `
    <details class="wh-card ${kind}" ${open ? 'open' : ''}>
      <summary class="wh-card-head">
        <span class="wh-chev">▸</span>
        ${pill(e.type || 'EVENT', 'evt')}
        ${fieldPills(e)}
        ${verifyChip(e.verified)}
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
      <span class="wh-ref">${cusId || '—'}</span>
    </div>`;
  if (cusConfigured === false) {
    html += `<div class="wh-note">Webhook receiver not configured — add Vercel KV + register <code>/api/webhook</code>.</div>`;
  } else if (cusEvents.length) {
    html += cusEvents.map((e, i) => eventCardHTML(e, i === 0)).join('');
  } else if (listening) {
    html += `<div class="wh-waiting">Watching <code>wh:recent</code> for a <code>CUSTOMER_*</code> event — these carry no <code>merchant_reference_id</code>, so they can't be filed under this session's ref.</div>`;
  } else {
    html += `<div class="wh-note">No <code>CUSTOMER_*</code> event delivered. Rapyd fires these only when the event is registered for this MID (Client Portal → Developers → Webhooks) — the <code>${cusId}</code> in the response is the source of truth either way. <code>CUSTOMER_PAYMENT_METHOD_CREATED</code> may still arrive when the first card is saved.</div>`;
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
      <span class="wh-ref">ref ${ref || '—'}</span>
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
      Retrieve Payment → <code>status: ${fallbackStatus.status}</code> <code>paid: ${fallbackStatus.paid}</code>
      <div class="wh-fallback-note">Pull-based — webhooks remain the canonical signal.</div>
    </div>`;
  }
  return html;
}

/** Repaint the whole panel from both sections. Exported so app.js can restore
    it after renderBackend() wipes the panel on a flow reset (the customer
    survives a reset, so its section has to come back). */
export function repaintWebhooks() {
  // Back office has its own renderer for the same shared DOM targets — while
  // it's the active left tab, this watcher keeps polling/tracking terminal
  // state (so the hidden client screen updates correctly in the background)
  // but skips the DOM write so it can't clobber back office's own paint.
  if (state.leftView && state.leftView !== 'client') return;
  const el = $('#panel-webhooks');
  if (!el) return;
  const html = customerSectionHTML() + paymentSectionHTML();
  if (!html) return; // nothing to say yet — leave app.js's empty state alone
  el.innerHTML = html;
}

function render(events) {
  lastEvents = events;
  repaintWebhooks();
}
