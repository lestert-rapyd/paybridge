/* ─────────────────────────────────────────────────────────────
   Webhook watcher (Phase 5).
   Polls GET /api/webhooks?ref=… and renders each real incoming
   webhook as an expandable card (pill + line-numbered JSON), mirroring
   the Response tab. Fires onTerminal(event) once a PAYMENT_COMPLETED /
   PAYMENT_FAILED (or terminal status) arrives — that drives the
   left-panel success/error screen. Falls back to Retrieve Payment.
   ───────────────────────────────────────────────────────────── */

import { BACKEND_URL } from './api.js';
import { state } from './state.js';
import { renderJSONView } from './json-view.js';

const $ = (s) => document.querySelector(s);
const FAIL_STATUS = ['ERR', 'EXP', 'CAN', 'DEC'];

let timer = null;
let ref = null;
let paymentId = null;
let paymentIdAt = 0;    // when we learned the payment id — fallback timing keys off this
let startedAt = 0;
let configured = null;
let fallbackDone = false;
let fallbackStatus = null;
let onTerminal = null;
let onPoll = null;
let terminalSource = null; // null | 'fallback' | 'webhook'

export function startWebhookWatch({ reference, payment_id, onTerminal: cb, onPoll: pollCb } = {}) {
  stopWebhookWatch();
  ref = reference;
  paymentId = payment_id || null;
  paymentIdAt = payment_id ? Date.now() : 0;
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

function classify(e) {
  const type = (e.type || '').toUpperCase();
  // Best practice: only the terminal webhook confirms an outcome.
  // PAYMENT_COMPLETED (or a capture) = terminal success.
  if (/COMPLETED|CAPTURE/.test(type)) return 'success';
  // PAYMENT_FAILED / declined / expired / cancelled = terminal failure.
  if (/FAILED|DECLINED|EXPIRED|CANCEL/.test(type)) return 'failure';
  // PAYMENT_SUCCEEDED (even CLO+paid) and status ACT are intermediate — wait
  // for the terminal event; never confirm off PAYMENT_SUCCEEDED.
  return 'pending';
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
      const r = await fetch(`${BACKEND_URL}/api/retrieve-payment?id=${encodeURIComponent(paymentId)}&env=${state.env}`);
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

function render(events) {
  const el = $('#panel-webhooks');
  if (!el) return;
  const listening = !!timer;

  let html = `
    <div class="wh-status ${listening ? 'live' : ''}">
      <span class="wh-status-dot"></span>
      ${listening ? 'Listening for webhooks' : (events.length ? 'Delivered' : 'Idle')}
      <span class="wh-ref">ref ${ref || '—'}</span>
    </div>`;

  if (configured === false) {
    html += `<div class="wh-note">Webhook receiver not configured — add Vercel KV + register <code>/api/webhook</code>. Showing polling fallback.</div>`;
  }

  if (events.length) {
    html += events.map((e, i) => {
      const kind = classify(e);
      return `
        <details class="wh-card ${kind}" ${i === 0 ? 'open' : ''}>
          <summary class="wh-card-head">
            <span class="wh-chev">▸</span>
            ${pill(e.type || 'EVENT', 'evt')}
            ${fieldPills(e)}
            ${verifyChip(e.verified)}
          </summary>
          <div class="wh-card-json">${renderJSONView(e.raw || e)}</div>
        </details>`;
    }).join('');
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

  el.innerHTML = html;
}
