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
let startedAt = 0;
let configured = null;
let fallbackDone = false;
let fallbackStatus = null;
let onTerminal = null;
let terminalFired = false;

export function startWebhookWatch({ reference, payment_id, onTerminal: cb } = {}) {
  stopWebhookWatch();
  ref = reference;
  paymentId = payment_id || null;
  onTerminal = cb || null;
  startedAt = Date.now();
  configured = null;
  fallbackDone = false;
  fallbackStatus = null;
  terminalFired = false;
  render([]);
  poll();
  timer = setInterval(poll, 2500);
}

export function setWatchPaymentId(id) { if (id) paymentId = id; }

export function stopWebhookWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

function classify(e) {
  const type = (e.type || '').toUpperCase();
  if (/COMPLETED|SUCCEEDED|CAPTURE/.test(type) || (e.status === 'CLO' && e.paid)) return 'success';
  if (/FAILED|DECLINED|EXPIRED|CANCEL/.test(type) || FAIL_STATUS.includes(e.status)) return 'failure';
  return 'pending';
}

function maybeFireTerminal(events) {
  if (terminalFired || !onTerminal) return;
  const success = events.find(e => classify(e) === 'success');
  const failure = events.find(e => classify(e) === 'failure');
  const hit = success || failure;
  if (hit) {
    terminalFired = true;
    onTerminal(hit);
    stopWebhookWatch();
    render(events);
  }
}

async function poll() {
  let events = [];
  try {
    const r = await fetch(`${BACKEND_URL}/api/webhooks?ref=${encodeURIComponent(ref)}`);
    const j = await r.json();
    events = j.events || [];
    configured = j.configured;
  } catch { /* transient */ }

  const elapsed = Date.now() - startedAt;

  // Fallback: no webhook after 12s + we have a payment id → poll status once.
  if (!events.length && !fallbackDone && paymentId && elapsed > 12000) {
    fallbackDone = true;
    try {
      const r = await fetch(`${BACKEND_URL}/api/retrieve-payment?id=${encodeURIComponent(paymentId)}&env=${state.env}`);
      const j = await r.json();
      const p = j?.data;
      if (p) {
        fallbackStatus = { status: p.status, paid: p.paid, id: p.id };
        if (!terminalFired && onTerminal && (p.status === 'CLO' ? p.paid : FAIL_STATUS.includes(p.status))) {
          terminalFired = true;
          onTerminal({ type: '(status poll)', status: p.status, paid: p.paid, payment_id: p.id });
          stopWebhookWatch();
        }
      }
    } catch { /* ignore */ }
  }

  render(events);
  maybeFireTerminal(events);
  if (elapsed > 120000) stopWebhookWatch();
}

function pill(text, cls = '') { return `<span class="wh-pill ${cls}">${text}</span>`; }

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
      const statusText = `${e.status || '—'}${e.paid != null ? ` · paid:${e.paid}` : ''}`;
      return `
        <details class="wh-card ${kind}" ${i === 0 ? 'open' : ''}>
          <summary class="wh-card-head">
            <span class="wh-chev">▸</span>
            ${pill(e.type || 'EVENT', 'evt')}
            ${pill(statusText, kind)}
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
