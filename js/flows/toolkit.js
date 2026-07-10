/* ─────────────────────────────────────────────────────────────
   Checkout Toolkit flow (non-PCI model).
   Rapyd's hosted iframe collects the card — the merchant's page
   never touches card data. We make the real POST /v1/checkout call,
   then render the toolkit (embedded / wallets) or hand off (hosted).
   The right panel shows the real session request/response + the
   toolkit's lifecycle events as they fire.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import { createCheckoutSession } from '../api.js';
import { renderJSON } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';

const $ = (s, r = document) => r.querySelector(s);

let mode = 'embedded';        // 'embedded' | 'wallets' | 'hosted'
let tds = true;
let events = [];              // toolkit lifecycle events
let listenersBound = false;
let lastSession = null;       // response data of the active session

const TOOLKIT_MODES = [
  { id: 'embedded', label: 'Embedded', hint: 'iframe on your page' },
  { id: 'wallets',  label: 'Wallets',  hint: 'Apple / Google Pay' },
  { id: 'hosted',   label: 'Hosted',   hint: 'full redirect' },
];

/* ── Request body ────────────────────────────────────────── */
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
    complete_checkout_url: `https://${v.domain}/complete`,
    cancel_checkout_url: `https://${v.domain}/cancel`,
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

/* ── Left panel markup ───────────────────────────────────── */
export function renderPaymentHTML() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  const chips = TOOLKIT_MODES.map(m => `
    <button class="tk-chip ${m.id === mode ? 'active' : ''}" data-mode="${m.id}">
      <span class="tkc-label">${m.label}</span><span class="tkc-hint">${m.hint}</span>
    </button>`).join('');
  return `
    <div id="tk-area">
      <div class="tk-note">Rapyd's secure iframe collects the card. Your page only creates the session and receives the outcome — <b>never the card data</b>.</div>
      <div class="tk-modes">${chips}</div>
      <label class="co-tds">
        <input type="checkbox" id="tk-tds" ${tds ? 'checked' : ''} />
        <span>Require 3-D Secure <em>· 3d_required</em></span>
      </label>
      <button class="co-cta" id="tk-launch">${v.cta} ${p.symbol}${p.amount}</button>
      <div class="co-secure">🔒 Card data captured inside Rapyd's hosted iframe</div>
    </div>`;
}

/* ── Right: request / response ───────────────────────────── */
function headerRows() {
  const host = state.env === 'live' ? 'api.rapyd.net' : 'sandboxapi.rapyd.net';
  return `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">https://${host}/v1/checkout</span></div>
    <p class="eng-label">Headers</p>
    <div class="req-headers">
      <div><span class="hk">access_key:</span> <span class="hv">‹your access key›</span></div>
      <div><span class="hk">signature:</span> <span class="hv">‹HMAC-SHA256 · signed on your server›</span></div>
      <div><span class="hk">Content-Type:</span> <span class="hv">application/json</span></div>
    </div>`;
}
function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  el.innerHTML = `
    ${headerRows()}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">no card data — collected by the iframe</span></div>
    <div class="code">${renderJSON(displayBody())}</div>`;
}

function renderResponse() {
  const el = $('#panel-response');
  if (!el) return;
  let html = '';
  if (lastSession) {
    html += `<div class="resp-http ok"><span class="rc">HTTP 200</span></div>
      <div class="code">${renderJSON(lastSession)}</div>`;
  }
  html += `<p class="eng-label" style="margin-top:16px">Toolkit lifecycle</p>`;
  if (!events.length) {
    html += `<div class="wh-desc" style="padding-left:0">No events yet — interact with the checkout on the left.</div>`;
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

/* ── Toolkit script + render ─────────────────────────────── */
function loadToolkitScript() {
  return new Promise(resolve => {
    const url = state.env === 'live'
      ? 'https://checkouttoolkit.rapyd.net'
      : 'https://sandboxcheckouttoolkit.rapyd.net';
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
  const add = (name, cls, fmt) => window.addEventListener(name, e => {
    logEvent(name, fmt ? fmt(e.detail || {}) : '', cls);
    if (name === 'onCheckoutPaymentSuccess') setStatus('Paid', 'ok');
    if (name === 'onCheckoutPaymentFailure') setStatus('Failed', 'error');
    if (name === 'onCheckoutPaymentPending') setStatus('Pending · 3DS', 'action');
  });
  add('onLoading', '', d => `loading: ${d.loading}`);
  add('onCheckoutPaymentPending', 'action', d => `${d.status || ''} ${d.next_action || ''}`.trim());
  add('onCheckoutPaymentSuccess', 'ok', d => `${d.status || ''} · paid:${d.paid}`);
  add('onCheckoutPaymentFailure', 'err', d => (d.error && (d.error.message || d.error)) || 'failure');
}

function renderToolkit(checkoutId) {
  const accent = VERTICALS[state.vertical].dot;
  const config = {
    id: checkoutId,
    pay_button_text: 'Pay Now',
    pay_button_color: accent,
    wait_on_payment_confirmation: true,
    wait_on_payment_redirect: true,
    close_on_complete: true,
    page_type: 'collection',
    digital_wallets_buttons_only: mode === 'wallets',
    digital_wallets_include_methods: ['google_pay', 'apple_pay'],
  };
  bindToolkitEvents();
  try {
    const checkout = new RapydCheckoutToolkit(config);
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
    const { httpStatus, data } = await createCheckoutSession(postBody());
    lastSession = data;
    renderResponse();
    setActiveTab('response');
    const id = data?.data?.id;
    const redirect = data?.data?.redirect_url;
    if (!id) throw new Error(data?.message || 'No checkout id returned');
    logEvent('session created', id, 'ok');

    if (mode === 'hosted') {
      setStatus('Redirect ready', 'action');
      $('#tk-area').innerHTML = `
        <div class="tk-redirect">
          <div class="tk-redirect-title">Hosted checkout ready</div>
          <div class="tk-redirect-desc">In production the customer is redirected to Rapyd's hosted page. Opening in a new tab here keeps the demo alive.</div>
          <button class="co-cta" id="tk-open">Open hosted checkout ↗</button>
        </div>`;
      $('#tk-open').addEventListener('click', () => window.open(redirect, '_blank', 'noopener'));
    } else {
      await loadToolkitScript();
      $('#tk-area').innerHTML = `<div id="rapyd-checkout"></div>`;
      renderToolkit(id);
      setStatus('Toolkit rendered', 'processing');
    }
  } catch (err) {
    lastSession = { error: 'error', message: err.message };
    renderResponse();
    setStatus('Error', 'error');
    btn.disabled = false;
    btn.textContent = `${VERTICALS[state.vertical].cta}`;
  }
}

/* ── Mount ───────────────────────────────────────────────── */
export function mount() {
  renderRequest();
  events = [];
  lastSession = null;

  $('#tk-area').querySelectorAll('.tk-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      mode = chip.dataset.mode;
      $('#tk-area').querySelectorAll('.tk-chip').forEach(c => c.classList.toggle('active', c === chip));
    });
  });
  $('#tk-tds').addEventListener('change', e => { tds = e.target.checked; renderRequest(); });
  $('#tk-launch').addEventListener('click', launch);
}
