/* ─────────────────────────────────────────────────────────────
   Own Card Fields flow (PCI-DSS model).
   Merchant fields collect the card; submit fires the real Rapyd
   POST /v1/payments. Focus/typing highlights + updates the live
   request body. The final success/error screen is driven by the
   real webhook (with a Retrieve-Payment fallback). 3DS renders inline.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, activeProduct } from '../verticals.js';
import { createDirectPayment } from '../api.js';
import { renderJSONView, highlightPaths } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';
import { startWebhookWatch } from '../webhooks.js';
import { renderProcessing, render3DS, renderSuccess, renderError } from '../screens.js';
import {
  FIELD_MAP, detectBrand,
  formatNumber, formatExpiry, parseExpiry,
} from '../sync.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import * as ledger from '../ledger.js';

const $ = (s, r = document) => r.querySelector(s);

const card = { number: '', expiry: '', cvv: '', name: '' };
let tds = false;
let focusedId = null;
let sent = false;

/* ── Request bodies ──────────────────────────────────────── */
function displayBody() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const { type } = detectBrand(card.number);
  const { month, year } = parseExpiry(card.expiry);
  const body = {
    amount: Number(p.amount),
    currency: p.currency,
    capture: true,
    payment_method: {
      type,
      fields: {
        number: card.number.replace(/\s/g, ''),
        expiration_month: month,
        expiration_year: year,
        cvv: card.cvv,
        name: card.name,
      },
    },
    statement_descriptor: v.descriptor,
    merchant_reference_id: state.reference || '(assigned on submit)',
    // NO complete/error_payment_url here: those are for full-redirect flows.
    // With the embedded 3DS iframe they'd render inside the frame after the
    // ACS and flash before the webhook-driven success screen takes over.
  };
  if (tds) body.payment_method_options = { '3d_required': true };
  // No-FX flows must omit all three fields entirely — sending any of them
  // without the others errors the call. FX config lives on state.fx —
  // edited via the popover beside app.js's price tile, not on this page.
  const fx = state.fx;
  if (fx.enabled && fx.requestedCurrency) {
    body.requested_currency = fx.requestedCurrency;
    body.fixed_side = fx.fixedSide;
    body.expiration = Math.floor(Date.now() / 1000) + 24 * 3600; // silent — not an SE-facing control
  }
  return body;
}
function postBody() {
  const b = displayBody();
  b.merchant_reference_id = state.reference;
  return { ...b, env: state.env };
}

/* ── Left panel markup ───────────────────────────────────── */
export function renderPaymentHTML() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  return `
    <div class="co-field">
      <label>Card number</label>
      <div class="co-input">
        <span class="field-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2.5" fill="#e8e3f7"></rect><rect x="2" y="8" width="20" height="3" fill="#7c3aed"></rect><rect x="5" y="14" width="6" height="2" rx="1" fill="#b8a9e6"></rect></svg></span>
        <input id="f-number" inputmode="numeric" autocomplete="cc-number" placeholder="4111 1111 1111 1111" maxlength="23" />
        <span class="card-brand" id="card-brand"></span>
      </div>
    </div>
    <div class="co-row">
      <div class="co-field">
        <label>Expiry</label>
        <div class="co-input"><input id="f-expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="12 / 27" maxlength="7" /></div>
      </div>
      <div class="co-field">
        <label>CVV</label>
        <div class="co-input"><input id="f-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" /></div>
      </div>
    </div>
    <div class="co-field">
      <label>Name on card</label>
      <div class="co-input"><input id="f-name" autocomplete="cc-name" placeholder="Jordan Taylor" /></div>
    </div>
    <label class="co-tds">
      <input type="checkbox" id="f-tds" ${tds ? 'checked' : ''} />
      <span>Require 3-D Secure</span>
    </label>
    <button class="co-cta" id="pay-btn">${v.cta} ${p.amount} ${p.currency}</button>`;
}

/* ── Request panel ───────────────────────────────────────── */
function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  const st = newSaltTimestamp();
  const body = displayBody();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/payments</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${sent ? 'signed &amp; sent' : 'updates as you type'}</span></div>
    <div id="req-json">${renderJSONView(body)}</div>`;
  fillSignature(el, 'post', '/v1/payments', st, body); // live — recomputes with the body
  applyHighlight();
}
function applyHighlight() {
  highlightPaths($('#req-json'), focusedId ? (FIELD_MAP[focusedId] || []) : []);
}

/* ── Response panel ──────────────────────────────────────── */
function respBadge(httpStatus, data) {
  const d = data?.data;
  if (d?.status === 'CLO' && d?.paid) return ['PAID · CLO', 'success'];
  if (d?.status === 'ACT')           return ['ACTION · ACT', 'pending'];
  if (data?.error)                   return [String(data.error), 'failure'];
  if (d?.status)                     return [d.status, 'pending'];
  return [`HTTP ${httpStatus}`, httpStatus < 400 ? 'success' : 'failure'];
}
function renderResponseSending() {
  $('#panel-response').innerHTML = `<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>`;
}
let lastResponse = null; // persisted so switching back from back office can repaint without resetting anything
function renderResponse(httpStatus, data) {
  lastResponse = { httpStatus, data };
  const [badge, kind] = respBadge(httpStatus, data);
  $('#panel-response').innerHTML = `
    <div class="eng-pillrow">
      <span class="wh-pill ${httpStatus < 400 ? 'success' : 'failure'}">HTTP ${httpStatus}</span>
      <span class="wh-pill ${kind}">${badge}</span>
    </div>
    ${renderJSONView(data ?? { error: 'no response body' })}`;
}

/** Back office may have repainted #panel-request/#panel-response while this
    flow's own state kept changing in the background (a client watcher tick
    can't touch these — see webhooks.js's leftView guard — but this flow's own
    request/response are plain innerHTML writes with no such guard, so they
    need to be explicitly restored when the SE switches back to Client Site). */
export function refreshRightPanel() {
  renderRequest();
  if (lastResponse) renderResponse(lastResponse.httpStatus, lastResponse.data);
}

/* ── Terminal (webhook or fallback) → left screen ────────── */
function handleTerminal(ev) {
  // ev is a terminal PAYMENT_COMPLETED/PAYMENT_FAILED webhook, or the poll
  // fallback's status object (CLO+paid) when no webhook was delivered.
  const success = /COMPLETED|CAPTURE/.test((ev.type || '').toUpperCase()) || (ev.status === 'CLO' && ev.paid);
  if (success) {
    setStatus('Paid · CLO', 'ok'); renderSuccess(ev); toast('✅ Confirmed by webhook');
    ledger.updateStatus(state.reference, { status: 'completed', phase: 'completed' });
  } else {
    setStatus('Failed', 'error'); renderError(ev); toast('❌ Payment failed', 'err');
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'failed' });
  }
}

/* ── Submit ──────────────────────────────────────────────── */
async function pay() {
  const btn = $('#pay-btn');
  btn.disabled = true;
  btn.textContent = 'Processing…';
  setStatus('Processing…', 'processing');
  state.reference = `pb_${state.vertical}_${Date.now()}`;
  {
    const v = VERTICALS[state.vertical];
    const p = activeProduct();
    const digits = card.number.replace(/\D/g, '');
    const brand = detectBrand(card.number).brand; // 'VISA' | 'MASTERCARD' | ''
    const network = brand ? brand[0] + brand.slice(1).toLowerCase() : null;
    const fx = state.fx;
    const fxSnapshot = fx.enabled && fx.requestedCurrency ? { currency: fx.requestedCurrency, amount: p.amount } : null;
    state.lastPayment = { descriptor: v.descriptor, amount: p.amount, currency: p.currency, last4: digits.slice(-4), network, fx: fxSnapshot };
    ledger.recordPayment(state.reference, {
      model: 'own-fields', vertical: state.vertical, amount: p.amount, currency: p.currency,
      requested_currency: fx.enabled ? fx.requestedCurrency : null, fixed_side: fx.enabled ? fx.fixedSide : null,
    });
  }
  sent = true;
  renderRequest(); // fresh salt/timestamp/signature for the send
  setActiveTab('response');
  renderResponseSending();

  try {
    const { httpStatus, data } = await createDirectPayment(postBody());
    renderResponse(httpStatus, data);
    const d = data?.data;

    if (!d || data?.error) {
      setStatus('Declined', 'error');
      toast(`❌ ${data?.message || data?.error || 'Payment failed'}`, 'err');
      renderError({ status: data?.error || 'ERR', message: data?.message || 'The payment was declined.' });
      ledger.updateStatus(state.reference, { status: 'failed', phase: 'declined' });
      return;
    }

    ledger.setPaymentId(state.reference, d.id);

    if (d.status === 'ACT' && d.next_action === '3d_verification') {
      setStatus('3DS challenge', 'action');
      render3DS(d.redirect_url);
      ledger.updateStatus(state.reference, { phase: 'pending_3ds' });
    } else if (d.status === 'CLO' && d.paid) {
      setStatus('Authorized · confirming', 'processing');
      renderProcessing('Payment authorized', 'Waiting for the confirmation webhook…');
      ledger.updateStatus(state.reference, { phase: 'awaiting_confirmation' });
    } else {
      renderProcessing('Processing…');
    }
    startWebhookWatch({ reference: state.reference, payment_id: d.id, onTerminal: handleTerminal });
  } catch (err) {
    renderResponse(0, { error: 'network_error', message: err.message });
    setStatus('Error', 'error');
    renderError({ status: 'ERR', message: err.message });
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'error' });
  } finally {
    sent = false;
  }
}

/* ── Fields ──────────────────────────────────────────────── */
function updateBrand() { const el = $('#card-brand'); if (el) el.textContent = detectBrand(card.number).brand; }

function fillTestCard() {
  const set = (id, val) => { const el = $(`#${id}`); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('f-number', '4111 1111 1111 1111');
  set('f-expiry', '12 / 27');
  set('f-cvv', '123');
  set('f-name', 'Jordan Taylor');
}

export function mount() {
  const els = { number: $('#f-number'), expiry: $('#f-expiry'), cvv: $('#f-cvv'), name: $('#f-name') };
  if (!els.number) return; // checkout replaced by a screen
  els.number.value = card.number;
  els.expiry.value = card.expiry;
  els.cvv.value = card.cvv;
  els.name.value = card.name;
  updateBrand();
  sent = false;
  renderRequest();

  const wire = (key, el, formatter) => {
    el.addEventListener('input', () => {
      if (formatter) el.value = formatter(el.value);
      card[key] = el.value;
      if (key === 'number') updateBrand();
      setStatus('Drafting request', 'drafting');
      renderRequest();
    });
  };
  wire('number', els.number, formatNumber);
  wire('expiry', els.expiry, formatExpiry);
  wire('cvv', els.cvv, v => v.replace(/\D/g, '').slice(0, 4));
  wire('name', els.name, null);

  $('#f-tds').addEventListener('change', e => { tds = e.target.checked; renderRequest(); });
  $('#pay-btn').addEventListener('click', pay);
  $('#use-test')?.addEventListener('click', fillTestCard);
}

// Highlight sync — delegated on `document` via focusin/focusout (which,
// unlike focus/blur, bubble) so it's wired exactly ONCE at module load and
// keeps working regardless of how often the underlying element gets
// recreated: card fields on every own-fields mount(), the price tile on
// every vertical/model/env reset, the FX popover's fields on every popover
// re-render (app.js rebuilds #fx-popover's innerHTML far more often than
// mount() runs — a per-element listener there would silently go stale).
document.addEventListener('focusin', e => {
  if (!(e.target.id in FIELD_MAP)) return;
  focusedId = e.target.id;
  applyHighlight();
});
document.addEventListener('focusout', e => {
  if (!(e.target.id in FIELD_MAP)) return;
  focusedId = null;
  applyHighlight();
});

/* ── Toast ───────────────────────────────────────────────── */
function toast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
