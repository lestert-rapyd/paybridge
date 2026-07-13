/* ─────────────────────────────────────────────────────────────
   Checkout Toolkit flow (non-PCI model).
   Rapyd's hosted iframe collects the card. We make the real
   POST /v1/checkout call, render the toolkit (embedded / wallets) or
   hand off (hosted). Scenario toggles map 1:1 onto the client-side
   RapydCheckoutToolkit config, mirrored live in the Request tab:
     · Wallet buttons only  → digital_wallets_buttons_only
     · Inline vs modal      → where the merchant page puts the container
     · 3DS in iframe/popup  → wait_on_payment_redirect
     · Toolkit vs own button→ hide_submit_button + CHECKOUT_SUBMIT_PAYMENT
   The left success/error screen is driven by the terminal webhook.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import { createCheckoutSession } from '../api.js';
import { renderJSONView } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';
import { startWebhookWatch, setWatchPaymentId } from '../webhooks.js';
import { renderProcessing, renderSuccess, renderError } from '../screens.js';

const $ = (s, r = document) => r.querySelector(s);

let mode = 'embedded';        // embedded | wallets | hosted
let tds = true;               // adds payment_method_options.3d_required
let display = 'inline';       // inline | modal   (merchant-side presentation)
let tdsFlow = 'iframe';       // iframe | popup   (wait_on_payment_redirect)
let payBtn = 'toolkit';       // toolkit | own    (hide_submit_button)
let events = [];
let listenersBound = false;
let lastSession = null;

const TOOLKIT_MODES = [
  { id: 'embedded', label: 'Full toolkit', hint: 'card + wallets iframe' },
  { id: 'wallets',  label: 'Wallet buttons', hint: 'AP / GP only' },
  { id: 'hosted',   label: 'Hosted page',   hint: 'full redirect' },
];

const SCENARIOS = [
  { key: 'display', label: 'Display', options: [['inline', 'Inline'], ['modal', 'Modal']] },
  { key: 'tdsFlow', label: '3-D Secure', options: [['iframe', 'In iframe'], ['popup', 'Popup']] },
  { key: 'payBtn',  label: 'Pay button', options: [['toolkit', "Toolkit's"], ['own', "Merchant's"]] },
];
const SCENARIO_STATE = { display: () => display, tdsFlow: () => tdsFlow, payBtn: () => payBtn };

/* ── Request body (server-side POST /v1/checkout) ────────── */
function displayBody() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  return {
    amount: Number(p.amount),
    capture: true,
    currency: p.currency,
    country: p.country,
    description: p.name,
    merchant_reference_id: state.reference || '(assigned on launch)',
    // real pages — the vertical domains (shop.paybridge.com etc.) are display-only fiction
    complete_checkout_url: 'https://rapydtoolkit.com/complete',
    cancel_checkout_url: 'https://rapydtoolkit.com/cancel',
    custom_elements: { display_description: true },
    payment_method_type_categories: ['card'],
    payment_method_options: { '3d_required': tds },
  };
}
function postBody() {
  const b = displayBody();
  b.merchant_reference_id = state.reference;
  return { ...b, env: state.env };
}

/* ── Client-side toolkit config (mirrors the toggles) ────── */
function toolkitConfig(checkoutId) {
  return {
    id: checkoutId || '(data.id from the response)',
    pay_button_text: 'Pay Now',
    pay_button_color: VERTICALS[state.vertical].dot,
    hide_submit_button: payBtn === 'own',
    digital_wallets_buttons_only: mode === 'wallets',
    digital_wallets_include_methods: ['google_pay', 'apple_pay'],
    wait_on_payment_confirmation: true,
    wait_on_payment_redirect: tdsFlow === 'iframe',
    close_on_complete: true,
    page_type: 'collection',
  };
}

/* ── Left panel markup (pre-launch) ──────────────────────── */
export function renderPaymentHTML() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  const chips = TOOLKIT_MODES.map(m => `
    <button class="tk-chip ${m.id === mode ? 'active' : ''}" data-mode="${m.id}">
      <span class="tkc-label">${m.label}</span><span class="tkc-hint">${m.hint}</span>
    </button>`).join('');
  const toggles = SCENARIOS.map(s => `
    <div class="tk-opt" data-opt="${s.key}">
      <span class="tk-opt-label">${s.label}</span>
      <div class="seg">${s.options.map(([val, label]) =>
        `<button data-val="${val}" class="${SCENARIO_STATE[s.key]() === val ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    </div>`).join('');
  return `
    <div id="tk-area">
      <div class="tk-note">Rapyd's secure iframe collects the card. Your page only creates the session and receives the outcome — <b>never the card data</b>.</div>
      <div class="tk-modes">${chips}</div>
      <div class="tk-opts" id="tk-opts" ${mode === 'hosted' ? 'hidden' : ''}>${toggles}</div>
      <label class="co-tds">
        <input type="checkbox" id="tk-tds" ${tds ? 'checked' : ''} />
        <span>Require 3-D Secure</span>
      </label>
      <button class="co-cta" id="tk-launch">${v.cta} ${p.symbol}${p.amount}</button>
    </div>`;
}

/* ── Post-launch checkout stage (inline L/R or modal) ────── */
function summaryHTML() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  const [c1, c2] = p.thumb;
  const glyph = { ecommerce: '🪑', crypto: '₿', gaming: '🎲' }[state.vertical] || '◆';
  const feeLabel = p.delivery ? 'Delivery' : 'Fees';
  return `
    <aside class="tk-summary">
      <div class="tk-sum-merchant">${v.merchant}</div>
      <div class="co-order">
        <div class="co-thumb" style="background:linear-gradient(135deg,${c1},${c2})">${glyph}</div>
        <div class="co-order-info">
          <div class="co-order-name">${p.name}</div>
          <div class="co-order-desc">${p.desc}</div>
        </div>
      </div>
      <div class="co-totals">
        <div class="co-line"><span>Subtotal</span><span>${p.symbol}${p.amount}</span></div>
        <div class="co-line"><span>${feeLabel}</span><span>${p.delivery || 'Free'}</span></div>
        <div class="co-line total"><span>Total</span><span class="co-total-amt">${p.symbol}${p.amount}</span></div>
      </div>
    </aside>`;
}

function payColHTML() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  const ownBtn = payBtn === 'own' && mode !== 'wallets'
    ? `<button class="co-cta" id="tk-own-pay">${v.cta} ${p.symbol}${p.amount} — merchant button</button>`
    : '';
  return `<div class="tk-paycol"><div id="rapyd-checkout"></div>${ownBtn}</div>`;
}

function renderStage() {
  const host = document.getElementById('checkout');
  if (display === 'modal' && mode !== 'hosted') {
    // Merchant page stays put behind a dimmed backdrop — the toolkit lives in a modal.
    $('#tk-launch')?.setAttribute('disabled', '');
    host.insertAdjacentHTML('beforeend', `
      <div class="tk-modal-backdrop">
        <div class="tk-modal">
          <div class="tk-modal-head"><span>Checkout · ${VERTICALS[state.vertical].merchant}</span><button class="tk-modal-x" id="tk-modal-close">✕</button></div>
          ${payColHTML()}
        </div>
      </div>`);
    $('#tk-modal-close')?.addEventListener('click', () => {
      host.querySelector('.tk-modal-backdrop')?.remove();
      $('#tk-launch')?.removeAttribute('disabled');
    });
  } else {
    // Inline: Stripe-style two-panel — order summary left, toolkit right.
    host.innerHTML = `<div class="tk-checkout">${summaryHTML()}${payColHTML()}</div>`;
  }
  $('#tk-own-pay')?.addEventListener('click', () => {
    const iframe = document.querySelector('#rapyd-checkout iframe');
    if (!iframe) return;
    iframe.contentWindow.postMessage({ type: 'CHECKOUT_SUBMIT_PAYMENT' }, '*');
    logEvent('CHECKOUT_SUBMIT_PAYMENT', 'postMessage from merchant button', 'action');
  });
}

/* ── Right: request / response ───────────────────────────── */
function headerRows() {
  return `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/checkout</span></div>
    <p class="eng-label">Headers</p>
    <div class="req-headers">
      <span class="hk">access_key</span><span class="hv">‹your access key›</span>
      <span class="hk">signature</span><span class="hv">‹HMAC-SHA256 · signed on your server›</span>
      <span class="hk">Content-Type</span><span class="hv">application/json</span>
    </div>`;
}
function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  const tkSection = mode === 'hosted' ? '' : `
    <div class="req-bodylabel" style="margin-top:18px"><p class="eng-label">Toolkit config · client-side JS</p><span class="hint">updates with the toggles</span></div>
    ${renderJSONView(toolkitConfig(lastSession?.data?.id))}`;
  el.innerHTML = `
    ${headerRows()}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">no card data — collected by the iframe</span></div>
    ${renderJSONView(displayBody())}
    ${tkSection}`;
}

function renderResponse() {
  const el = $('#panel-response');
  if (!el) return;
  let html = '';
  if (lastSession) {
    const ok = !lastSession.error;
    html += `<div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${ok ? 200 : 400}</span><span class="wh-pill ${ok ? 'success' : 'failure'}">${ok ? 'CHECKOUT CREATED' : 'ERROR'}</span></div>
      ${renderJSONView(lastSession)}`;
  }
  html += `<p class="eng-label" style="margin-top:16px">Toolkit lifecycle</p>`;
  if (!events.length) {
    html += `<div class="wh-waiting">Interact with the checkout on the left…</div>`;
  } else {
    html += `<div class="tk-events">` + events.map(e => `
      <div class="tk-event ${e.cls || ''}">
        <span class="tke-name">${e.name}</span>
        ${e.detail ? `<span class="tke-detail">${e.detail}</span>` : ''}
      </div>`).join('') + `</div>`;
  }
  el.innerHTML = html;
}

function logEvent(name, detail = '', cls = '') {
  events.push({ name, detail, cls });
  renderResponse();
}

/* ── Terminal (webhook / fallback) → left screen ─────────── */
function handleTerminal(ev) {
  // Terminal PAYMENT_COMPLETED/PAYMENT_FAILED webhook, or the poll fallback's
  // status object (CLO+paid). Never confirmed off PAYMENT_SUCCEEDED.
  const success = /COMPLETED|CAPTURE/.test((ev.type || '').toUpperCase()) || (ev.status === 'CLO' && ev.paid);
  if (success) { setStatus('Paid', 'ok'); renderSuccess(ev); }
  else { setStatus('Failed', 'error'); renderError(ev); }
}

/* ── Toolkit script + render ─────────────────────────────── */
function loadToolkitScript() {
  return new Promise(resolve => {
    const url = state.env === 'live' ? 'https://checkouttoolkit.rapyd.net' : 'https://sandboxcheckouttoolkit.rapyd.net';
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.body.appendChild(s);
  });
}

function bindToolkitEvents() {
  if (listenersBound) return;
  listenersBound = true;
  window.addEventListener('onLoading', e => logEvent('onLoading', `loading: ${e.detail?.loading}`));
  window.addEventListener('onCheckoutPaymentPending', e => {
    if (e.detail?.id) setWatchPaymentId(e.detail.id);
    logEvent('onCheckoutPaymentPending', `${e.detail?.status || ''} ${e.detail?.next_action || ''}`.trim(), 'action');
    setStatus('Pending · 3DS', 'action');
    // Popup scenario: the merchant page handles the 3DS redirect itself.
    const redirect = e.detail?.redirect_url;
    if (tdsFlow === 'popup' && redirect) {
      window.open(redirect, 'rapyd-3ds', 'width=480,height=720');
      logEvent('3DS popup opened', 'window.open(redirect_url)', 'action');
    }
  });
  window.addEventListener('onCheckoutPaymentSuccess', e => {
    if (e.detail?.id) setWatchPaymentId(e.detail.id);
    logEvent('onCheckoutPaymentSuccess', `${e.detail?.status || ''} · paid:${e.detail?.paid}`, 'ok');
    setStatus('Confirming…', 'processing');
    renderProcessing('Payment received', 'Confirming via webhook…');
  });
  window.addEventListener('onCheckoutPaymentFailure', e => {
    logEvent('onCheckoutPaymentFailure', (e.detail?.error && (e.detail.error.message || e.detail.error)) || 'failure', 'err');
    setStatus('Failed', 'error');
    renderError({ status: 'ERR', message: 'The payment failed in the toolkit.' });
  });
}

function renderToolkit(checkoutId) {
  bindToolkitEvents();
  try {
    const checkout = new RapydCheckoutToolkit(toolkitConfig(checkoutId));
    checkout.displayCheckout();
    logEvent('displayCheckout()', 'iframe rendering', '');
  } catch (err) {
    logEvent('toolkit error', err.message, 'err');
  }
}

/* ── Launch ──────────────────────────────────────────────── */
async function launch() {
  const btn = $('#tk-launch');
  btn.disabled = true;
  btn.textContent = 'Creating session…';
  setStatus('Creating session…', 'processing');
  events = [];
  lastSession = null;
  state.reference = `pb_${state.vertical}_tk_${Date.now()}`;
  renderRequest();
  setActiveTab('request');

  try {
    const { data } = await createCheckoutSession(postBody());
    lastSession = data;
    renderRequest(); // config now shows the real checkout id
    renderResponse();
    setActiveTab('response');
    const id = data?.data?.id;
    const redirect = data?.data?.redirect_url;
    if (!id) throw new Error(data?.message || 'No checkout id returned');
    logEvent('session created', id, 'ok');
    startWebhookWatch({ reference: state.reference, onTerminal: handleTerminal });

    if (mode === 'hosted') {
      setStatus('Redirect ready', 'action');
      $('#tk-area').innerHTML = `
        <div class="tk-redirect">
          <div class="tk-redirect-title">Hosted checkout ready</div>
          <div class="tk-redirect-desc">In production the customer is redirected to Rapyd's hosted page. Opening in a new tab here keeps the demo alive — the outcome returns via webhook.</div>
          <button class="co-cta" id="tk-open">Open hosted checkout ↗</button>
        </div>`;
      $('#tk-open').addEventListener('click', () => window.open(redirect, '_blank', 'noopener'));
    } else {
      await loadToolkitScript();
      renderStage();
      renderToolkit(id);
      setStatus('Toolkit rendered', 'processing');
    }
  } catch (err) {
    lastSession = { error: 'error', message: err.message };
    renderResponse();
    setStatus('Error', 'error');
    renderError({ status: 'ERR', message: err.message });
  }
}

/* ── Mount ───────────────────────────────────────────────── */
export function mount() {
  if (!$('#tk-area')) return;
  renderRequest();
  events = [];
  lastSession = null;

  $('#tk-area').querySelectorAll('.tk-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      mode = chip.dataset.mode;
      $('#tk-area').querySelectorAll('.tk-chip').forEach(c => c.classList.toggle('active', c === chip));
      $('#tk-opts').hidden = mode === 'hosted';
      renderRequest();
    });
  });

  $('#tk-area').querySelectorAll('.tk-opt').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      const val = btn.dataset.val;
      const key = row.dataset.opt;
      if (key === 'display') display = val;
      if (key === 'tdsFlow') tdsFlow = val;
      if (key === 'payBtn') payBtn = val;
      row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      renderRequest(); // toolkit config JSON syncs with the toggles
    });
  });

  $('#tk-tds').addEventListener('change', e => { tds = e.target.checked; renderRequest(); });
  $('#tk-launch').addEventListener('click', launch);
}
