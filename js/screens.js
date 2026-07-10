/* ─────────────────────────────────────────────────────────────
   Left-panel post-payment screens: processing → (inline 3DS) →
   success / error. The terminal screen is driven by the real
   PAYMENT_COMPLETED / PAYMENT_FAILED webhook (see webhooks.js).
   ───────────────────────────────────────────────────────────── */

import { VERTICALS } from './verticals.js';
import { state, setState } from './state.js';

const host = () => document.getElementById('checkout');

export function renderProcessing(title = 'Confirming payment…', sub = 'Waiting for Rapyd to confirm via webhook…') {
  host().innerHTML = `
    <div class="screen">
      <div class="screen-spinner"></div>
      <div class="screen-title">${title}</div>
      <div class="screen-sub">${sub}</div>
      <div class="screen-hint">The webhook is the source of truth — the confirmation lands on the right ▸</div>
    </div>`;
}

export function render3DS(url) {
  host().innerHTML = `
    <div class="screen-3ds">
      <div class="screen-3ds-bar">
        <span class="tds-lock">🔐</span>
        <div>
          <div class="screen-3ds-title">3-D Secure verification</div>
          <div class="screen-3ds-sub">Complete the challenge — then we wait for the outcome webhook.</div>
        </div>
      </div>
      <iframe class="tds-frame" src="${url}" title="3-D Secure challenge"></iframe>
    </div>`;
}

export function renderSuccess(event = {}) {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  host().innerHTML = `
    <div class="screen success">
      <div class="screen-badge ok">✓</div>
      <div class="screen-title">${successVerb(v)} confirmed</div>
      <div class="screen-sub">${v.merchant} · <b>${p.symbol}${p.amount}</b> ${p.currency}</div>
      <div class="screen-facts">
        <div><span>Payment</span><code>${event.payment_id || '—'}</code></div>
        <div><span>Status</span><code>${event.status || 'CLO'}</code></div>
        <div><span>Confirmed by</span><code>${event.type || 'webhook'}</code></div>
      </div>
      <button class="co-cta" id="screen-reset">Run another payment</button>
      <div class="co-secure">🔒 Confirmed via ${event.type ? 'incoming webhook' : 'payment status'}</div>
    </div>`;
  wireReset();
}

export function renderError(event = {}) {
  const v = VERTICALS[state.vertical];
  host().innerHTML = `
    <div class="screen error">
      <div class="screen-badge err">✕</div>
      <div class="screen-title">Payment ${event.status || 'failed'}</div>
      <div class="screen-sub">${event.message || 'The payment did not complete.'}</div>
      <div class="screen-facts">
        <div><span>Payment</span><code>${event.payment_id || '—'}</code></div>
        <div><span>Status</span><code>${event.status || 'ERR'}</code></div>
        <div><span>Signalled by</span><code>${event.type || 'webhook'}</code></div>
      </div>
      <button class="co-cta" id="screen-reset">Try again</button>
    </div>`;
  wireReset();
}

function successVerb(v) {
  return v.cta === 'Deposit' ? 'Deposit' : v.cta === 'Buy' ? 'Purchase' : 'Payment';
}

function wireReset() {
  document.getElementById('screen-reset')?.addEventListener('click', () => setState({})); // re-render checkout fresh
}
