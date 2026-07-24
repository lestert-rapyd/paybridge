/* ─────────────────────────────────────────────────────────────
   Left-panel post-payment screens: processing → (inline 3DS) →
   success / error. The terminal screen is driven by the real
   PAYMENT_COMPLETED / PAYMENT_FAILED webhook (see webhooks.js).
   ───────────────────────────────────────────────────────────── */

import { VERTICALS, activeProduct } from './verticals.js';
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

  // When FX was configured, drive the figures off the checkout snapshot so the
  // statement matches exactly what the customer saw: `charged` is what hit the
  // card (main line); `base` is the merchant's price (the small original line,
  // shown only when the customer paid in a different currency, i.e. 'buy').
  const fx = lp.fx;
  let currency, amount, isFx = false, origCurrency, origAmount;
  if (fx) {
    currency = fx.charged.currency;
    amount = fmtAmount(fx.charged.amount);
    isFx = fx.charged.currency !== fx.base.currency;
    origCurrency = fx.base.currency;
    origAmount = fx.base.amount;
  } else {
    currency = pay.currency_code || lp.currency || '';
    amount = fmtAmount(pay.amount ?? lp.amount);
  }

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
/* What the customer paid — the lastPayment snapshot already holds the converted
   figure (under 'buy'), so success/decline screens match the checkout total. */
function paidLabel() {
  const lp = state.lastPayment;
  if (lp && lp.amount != null) return `${fmtAmount(lp.amount)} ${lp.currency || ''}`.trim();
  const p = activeProduct();
  return `${p.amount} ${p.currency}`;
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

const LOCK_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#5b564d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path><circle cx="12" cy="15.5" r="1.3" fill="#5b564d"></circle></svg>`;

export function render3DS(url) {
  set3DSWidth(true);
  setOffstage(null);
  host().innerHTML = `
    <div class="screen-3ds">
      <div class="screen-3ds-bar">
        <span class="tds-ico">${LOCK_SVG}</span>
        <div>
          <div class="screen-3ds-title">3-D Secure verification</div>
          <div class="screen-3ds-sub">Complete the challenge — then we wait for the outcome webhook.</div>
        </div>
      </div>
      <iframe class="tds-frame" src="${url}" title="3-D Secure challenge"></iframe>
    </div>`;
}

/* facts rows: click any value to copy it ("Copied ✓" feedback) */
function factsHTML(rows) {
  return `<div class="screen-facts rise-4">` + rows
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value, danger]) =>
      `<div><span>${label}</span><code ${danger ? 'class="danger"' : ''} data-copy="${value}" title="Click to copy">${value}</code></div>`)
    .join('') + `</div>`;
}
function wireCopy() {
  host().querySelectorAll('[data-copy]').forEach(el => {
    el.addEventListener('click', () => {
      try { navigator.clipboard?.writeText(el.dataset.copy); } catch { /* clipboard unavailable */ }
      const orig = el.textContent;
      el.textContent = 'Copied ✓';
      setTimeout(() => { el.textContent = orig; }, 1400);
    });
  });
}

const CHECK_SVG = `<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>`;
const CROSS_SVG = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M7 7l10 10"></path><path d="M17 7L7 17"></path></svg>`;

function badgeHTML(kind) {
  const err = kind === 'err';
  return `
    <div class="cs-badge-wrap">
      <span class="cs-ring ${err ? 'err' : ''}"></span>
      <span class="cs-glow ${err ? 'err' : ''}"></span>
      <span class="cs-badge ${err ? 'err' : 'ok'}">${err ? CROSS_SVG : CHECK_SVG}</span>
    </div>`;
}

export function renderSuccess(event = {}) {
  set3DSWidth(false);
  resetWide();
  const v = VERTICALS[state.vertical];
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  const reference = pay.merchant_reference_id || state.reference || '—';
  host().innerHTML = `
    <div class="screen success">
      ${badgeHTML('ok')}
      <div class="screen-title rise-1">${successVerb(v)} confirmed</div>
      <div class="screen-sub rise-2">${v.merchant} · <strong>${paidLabel()}</strong></div>
      ${v.successNote ? `<div class="screen-next rise-3">${v.successNote}</div>` : ''}
      ${factsHTML([
        ['Payment', event.payment_id || '—'],
        ['Reference', reference],
        ['Card', cardLabel(pay, lp)],
        ['Status', event.status || 'CLO'],
        ['Confirmed by', event.type || 'webhook'],
      ])}
      <button class="co-cta rise-5" id="screen-reset">Run another payment</button>
    </div>`;
  setOffstage(bankViewHTML(event)); // bank-app view lives OUTSIDE the client window
  wireCopy();
  wireReset();
}

export function renderError(event = {}) {
  set3DSWidth(false);
  resetWide();
  setOffstage(null);
  const v = VERTICALS[state.vertical];
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  const declineCode = pay.failure_code || event.code || null;
  const note = event.message && event.message !== 'The payment did not complete.'
    ? event.message
    : 'Your card was declined — no charge was made. Try a different card, or contact your bank if it keeps happening.';
  host().innerHTML = `
    <div class="screen error">
      ${badgeHTML('err')}
      <div class="screen-title rise-1">Payment declined</div>
      <div class="screen-sub rise-2">${v.merchant} · <strong>${paidLabel()}</strong></div>
      <div class="screen-next err rise-3">${note}</div>
      ${factsHTML([
        ['Payment', event.payment_id || '—'],
        ['Reference', pay.merchant_reference_id || state.reference || '—'],
        ['Card', cardLabel(pay, lp)],
        ['Status', event.status || 'ERR', true],
        ['Decline code', declineCode, true],
        ['Signalled by', event.type || 'webhook'],
      ])}
      <button class="co-cta rise-5" id="screen-reset">Try a different card</button>
      <button class="cs-secondary rise-6" id="screen-back">Back to store</button>
    </div>`;
  wireCopy();
  wireReset();
  document.getElementById('screen-back')?.addEventListener('click', () => setState({}));
}

function successVerb(v) {
  return v.cta === 'Deposit' ? 'Deposit' : v.cta === 'Buy' ? 'Purchase' : 'Payment';
}

function wireReset() {
  document.getElementById('screen-reset')?.addEventListener('click', () => setState({})); // re-render checkout fresh
}
