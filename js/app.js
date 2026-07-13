/* ─────────────────────────────────────────────────────────────
   PayBridge Demo Suite — bootstrap (on-brand redesign)
   ───────────────────────────────────────────────────────────── */

import { VERTICALS, VERTICAL_ORDER } from './verticals.js';
import { state, setState, subscribe } from './state.js';
import { setActiveTab, setStatus } from './ui.js';
import { stopWebhookWatch } from './webhooks.js';
import * as ownFields from './flows/own-fields.js';
import * as toolkit from './flows/toolkit.js';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FLOWS = { 'own-fields': ownFields, 'toolkit': toolkit };

const MODEL_DESC = {
  'own-fields': "Merchant collects the card and calls POST /v1/payments directly — a PCI-DSS path.",
  'toolkit':    "Rapyd's iframe collects the card — zero PCI scope for the merchant.",
};

const THUMB_GLYPH = { ecommerce: '🪑', crypto: '₿', gaming: '🎲' };

/* ── Left: checkout ──────────────────────────────────────── */
function renderCheckout() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  const flow = FLOWS[state.model];
  const host = $('#checkout');
  const [c1, c2] = p.thumb;

  const feeLabel = p.delivery ? 'Delivery' : 'Fees';
  const feeValue = p.delivery ? p.delivery : 'Free';

  const payLabel = state.model === 'own-fields'
    ? `<div class="co-paylabel"><span class="lbl">Pay by card</span><button class="use-test" id="use-test">Use test card</button></div>`
    : `<div class="co-paylabel"><span class="lbl">Payment method</span></div>`;

  // A flow can own the whole client page (toolkit's two-panel stage);
  // otherwise it slots into the standard checkout shell.
  if (flow.renderPageHTML) {
    host.innerHTML = flow.renderPageHTML();
  } else {
    host.innerHTML = `
      <div class="co-merchant">${v.merchant.toUpperCase()}</div>
      <div class="co-tagline">${v.headline}</div>

      <div class="co-order">
        <div class="co-thumb" style="background:linear-gradient(135deg,${c1},${c2})">${THUMB_GLYPH[state.vertical]}</div>
        <div class="co-order-info">
          <div class="co-order-name">${p.name}</div>
          <div class="co-order-desc">${p.desc}</div>
        </div>
        <div class="co-order-price">${p.symbol}${p.amount}</div>
      </div>

      <div class="co-totals">
        <div class="co-line"><span>Subtotal</span><span>${p.symbol}${p.amount}</span></div>
        <div class="co-line"><span>${feeLabel}</span><span>${feeValue}</span></div>
        <div class="co-line total"><span>Total</span><span class="co-total-amt">${p.symbol}${p.amount}</span></div>
      </div>

      ${payLabel}
      ${flow.renderPaymentHTML()}`;
  }

  // Optional SE controls deck outside the fake client site (unused by
  // current flows — toolkit config lives inside its page).
  const controls = $('#demo-controls');
  controls.innerHTML = flow.renderControlsHTML ? flow.renderControlsHTML() : '';
  controls.hidden = !flow.renderControlsHTML;

  // width classes (JS-toggled; see main.css note on :has())
  const browser = $('.browser');
  browser.classList.toggle('wide-tk', !!flow.renderPageHTML);
  browser.classList.remove('wide-3ds');

  flow.mount();
}

/* ── Right: response + webhooks empties (flows fill Request) ── */
function renderBackend() {
  $('#panel-response').innerHTML = emptyState('⇄', `Rapyd's response appears here once a call is made.`);
  $('#panel-webhooks').innerHTML = emptyState('📡', `Incoming webhooks land here as Rapyd fires them. Polling fills in if a webhook is delayed.`);
  $('#panel-console').innerHTML = emptyState('▸', `Toolkit lifecycle events stream here once the toolkit renders.`);
  $('#rtab-console').style.display = state.model === 'toolkit' ? '' : 'none';
}
function emptyState(ico, text) {
  return `<div class="eng-empty"><div class="ee-ico">${ico}</div><div class="ee-text">${text}</div></div>`;
}

/* ── Header controls ─────────────────────────────────────── */
function renderVerticalPills() {
  $('#vertical-pills').innerHTML = VERTICAL_ORDER.map(id => {
    const v = VERTICALS[id];
    return `<button data-vertical="${id}" class="${id === state.vertical ? 'active' : ''}">
      <span class="vp-dot" style="background:${v.dot}"></span>${v.label}
    </button>`;
  }).join('');
}

function syncControlStates() {
  document.documentElement.dataset.vertical = state.vertical;
  $$('#vertical-pills button').forEach(b => b.classList.toggle('active', b.dataset.vertical === state.vertical));
  $$('#env-switch button').forEach(b => b.classList.toggle('active', b.dataset.env === state.env));
  $$('.model-btn').forEach(b => b.classList.toggle('active', b.dataset.model === state.model));
  $('#client-domain').textContent = VERTICALS[state.vertical].domain;
  $('#model-desc').textContent = MODEL_DESC[state.model];
}

/* ── Wiring ──────────────────────────────────────────────── */
function wire() {
  $('#vertical-pills').addEventListener('click', e => {
    const btn = e.target.closest('button[data-vertical]');
    if (btn && btn.dataset.vertical !== state.vertical) setState({ vertical: btn.dataset.vertical });
  });
  $('#env-switch').addEventListener('click', e => {
    const btn = e.target.closest('button[data-env]');
    if (btn && btn.dataset.env !== state.env) setState({ env: btn.dataset.env });
  });
  $('#model-switch').addEventListener('click', e => {
    const btn = e.target.closest('.model-btn');
    if (btn && btn.dataset.model !== state.model) setState({ model: btn.dataset.model });
  });
  $('.rtabs').addEventListener('click', e => {
    const btn = e.target.closest('.rtab');
    if (btn) setActiveTab(btn.dataset.tab);
  });
}

/* ── Render orchestration ────────────────────────────────── */
function renderAll() {
  stopWebhookWatch();
  syncControlStates();
  setActiveTab('request');
  setStatus('Awaiting input', 'idle');
  renderBackend();
  renderCheckout();
}

subscribe(renderAll);

document.documentElement.dataset.vertical = state.vertical;
renderVerticalPills();
wire();
renderAll();
