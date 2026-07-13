/* ─────────────────────────────────────────────────────────────
   Left-panel post-payment screens: processing → (inline 3DS) →
   success / error. The terminal screen is driven by the real
   PAYMENT_COMPLETED / PAYMENT_FAILED webhook (see webhooks.js).
   ───────────────────────────────────────────────────────────── */

import { VERTICALS } from './verticals.js';
import { state, setState } from './state.js';

const host = () => document.getElementById('checkout');
const set3DSWidth = (on) => document.querySelector('.browser')?.classList.toggle('wide-3ds', on);
/* End screens always render in the standard narrow card — the toolkit's
   wide stage would otherwise stretch the success/error layout. */
const resetWide = () => document.querySelector('.browser')?.classList.remove('wide-tk');

/* "Visa ending 1111" / "Apple Pay" / "Google Pay ending 4242" */
function cardLabel(pay, lp) {
  const pmd = pay.payment_method_data || {};
  const hint = `${pmd.type || ''} ${pmd.name || ''}`.toLowerCase();
  const last4 = pmd.last4 || lp.last4;
  const ending = last4 ? ` ending ${last4}` : '';
  if (/apple/.test(hint)) return `Apple Pay${ending}`;
  if (/google/.test(hint)) return `Google Pay${ending}`;
  const network =
    /visa/.test(hint) ? 'Visa' :
    /master/.test(hint) ? 'Mastercard' :
    /amex|american_?express/.test(hint) ? 'Amex' :
    lp.network || null;
  if (network && last4) return `${network}${ending}`;
  if (last4) return `Card${ending}`;
  return '—';
}

/* Standalone annotations rendered OUTSIDE the client-site window. */
function setOffstage(html) {
  const el = document.getElementById('offstage');
  if (!el) return;
  el.innerHTML = html || '';
  el.hidden = !html;
}

/* ── Customer's bank-app view (statement descriptor) ─────────
   Reads the real payment from the terminal webhook when present,
   falling back to the request snapshot (state.lastPayment). Shows
   the FX variant (charged currency big, original small) when the
   payment carries FX fields — reactive once FX is configured. */
function bankViewHTML(event) {
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  const descriptor = pay.statement_descriptor || lp.descriptor;
  if (!descriptor) return '';

  const currency = pay.currency_code || lp.currency || '';
  const amount = fmtAmount(pay.amount ?? lp.amount);
  const fxRate = Number(pay.fx_rate);
  const origCurrency = pay.original_currency || pay.merchant_requested_currency || lp.fx?.currency;
  const origAmount = pay.original_amount ?? pay.merchant_requested_amount ?? lp.fx?.amount;
  const isFx = !!(origCurrency && origCurrency !== currency && (fxRate ? fxRate !== 1 : true) && origAmount != null);

  const main = `− ${amount} ${currency}`;
  const d = new Date();
  const when = `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  return `
    <div class="bank-view">
      <div class="bank-view-label">Customer's bank app · <code>statement_descriptor</code></div>
      <div class="bank-card">
        <div class="bank-ico">↑</div>
        <div class="bank-info">
          <div class="bank-desc">${descriptor}</div>
          <div class="bank-date">${when}</div>
        </div>
        <div class="bank-amt">
          <div class="bank-amt-main">${main}</div>
          ${isFx ? `<div class="bank-amt-fx">− ${fmtAmount(origAmount)} ${origCurrency}</div>` : ''}
        </div>
      </div>
    </div>`;
}
function fmtAmount(a) {
  const n = Number(a);
  return Number.isFinite(n) ? n.toFixed(2) : (a ?? '—');
}

export function renderProcessing(title = 'Confirming payment…', sub = 'Waiting for Rapyd to confirm via webhook…') {
  resetWide();
  setOffstage(null);
  host().innerHTML = `
    <div class="screen">
      <div class="screen-spinner"></div>
      <div class="screen-title">${title}</div>
      <div class="screen-sub">${sub}</div>
      <div class="screen-hint">The webhook is the source of truth — the confirmation lands on the right ▸</div>
    </div>`;
}

export function render3DS(url) {
  set3DSWidth(true);
  setOffstage(null);
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
  set3DSWidth(false);
  resetWide();
  const v = VERTICALS[state.vertical];
  const p = v.product;
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  const reference = pay.merchant_reference_id || state.reference || '—';
  host().innerHTML = `
    <div class="screen success">
      <div class="screen-badge ok">✓</div>
      <div class="screen-title">${successVerb(v)} confirmed</div>
      <div class="screen-sub">${v.merchant} · <b>${p.symbol}${p.amount}</b> ${p.currency}</div>
      ${v.successNote ? `<div class="screen-next">${v.successNote}</div>` : ''}
      <div class="screen-facts">
        <div><span>Payment</span><code>${event.payment_id || '—'}</code></div>
        <div><span>Reference</span><code>${reference}</code></div>
        <div><span>Card</span><code>${cardLabel(pay, lp)}</code></div>
        <div><span>Status</span><code>${event.status || 'CLO'}</code></div>
        <div><span>Confirmed by</span><code>${event.type || 'webhook'}</code></div>
      </div>
      <button class="co-cta" id="screen-reset">Run another payment</button>
    </div>`;
  setOffstage(bankViewHTML(event)); // bank-app view lives OUTSIDE the client window
  wireReset();
}

export function renderError(event = {}) {
  set3DSWidth(false);
  resetWide();
  setOffstage(null);
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
