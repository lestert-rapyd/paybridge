/* ─────────────────────────────────────────────────────────────
   Checkout Toolkit flow (non-PCI model).
   Rapyd's hosted iframe collects the card. We make the real
   POST /v1/checkout call, then render the toolkit into the right
   column of a stable two-panel client page (summary | payment).

   Pre-render, that right column holds a dark `toolkit.config`
   panel — controls labelled with the REAL config keys:
     · integration_mode  full_toolkit / wallet / hosted
     · 3d_required + wait_on_payment_redirect (in iframe / redirect)
     · hide_submit_button (Rapyd's / custom one-shot button that
       fires postMessage CHECKOUT_SUBMIT_PAYMENT then removes itself)
     · pay_button_text / pay_button_color
     · digital_wallets_buttons_customization (AP / GP color + type)
   The same config is mirrored live in the Request tab. Toolkit
   lifecycle events stream to the Console tab. The left success /
   error screen is driven by the terminal webhook.
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
let tds = true;               // payment_method_options.3d_required
let tdsFlow = 'iframe';       // iframe | redirect  (wait_on_payment_redirect)
let payBtn = 'rapyd';         // rapyd | custom     (hide_submit_button)
const custom = {
  btnText: 'Pay Now',         // pay_button_text (max 16 chars)
  btnColor: null,             // pay_button_color — null = vertical accent
  ap: { button_color: 'black', button_type: 'buy' },
  gp: { button_color: 'black', button_type: 'buy' },
};
let events = [];
let listenersBound = false;
let lastSession = null;

const AP_TYPES = ['add-money', 'book', 'buy', 'check-out', 'contribute', 'donate', 'order', 'plain', 'reload', 'rent', 'subscribe', 'support', 'tip', 'top-up'];
const GP_TYPES = ['book', 'buy', 'checkout', 'donate', 'order', 'pay', 'subscribe'];
const AP_COLORS = ['black', 'white', 'white-outline'];
const GP_COLORS = ['black', 'white'];

const accent = () => custom.btnColor || VERTICALS[state.vertical].dot;

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

/* ── Client-side toolkit config (mirrors the panel) ──────── */
function toolkitConfig(checkoutId) {
  return {
    id: checkoutId || '(data.id from the response)',
    pay_button_text: custom.btnText,
    pay_button_color: accent(),
    hide_submit_button: payBtn === 'custom' && mode !== 'wallets',
    digital_wallets_buttons_only: mode === 'wallets',
    digital_wallets_include_methods: ['google_pay', 'apple_pay'],
    digital_wallets_buttons_customization: {
      apple_pay: { ...custom.ap },
      google_pay: { ...custom.gp },
    },
    wait_on_payment_confirmation: true,
    wait_on_payment_redirect: tdsFlow === 'iframe',
    close_on_complete: true,
    page_type: 'collection',
  };
}

/* ── Client page: stable two-panel stage ─────────────────── */
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

/* ── toolkit.config panel (pre-render, dark / code-styled) ── */
function seg(key, options, current) {
  return `
    <div class="tkc-seg" data-opt="${key}">${options.map(([val, text]) =>
      `<button data-val="${val}" class="${current === val ? 'active' : ''}">${text}</button>`).join('')}
    </div>`;
}
function selectEl(id, values, current) {
  return `<select class="tkc-select" id="${id}">${values.map(o =>
    `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
}

function configPanelHTML() {
  return `
    <div class="tk-config" id="tk-config">
      <div class="tkc-head"><span class="tkc-chev">▸</span><span class="tkc-name">toolkit.config</span><span class="tkc-hint">// iframe not yet mounted</span></div>

      <div class="tkc-sec">
        <div class="tkc-com">// integration</div>
        <div class="tkc-key">integration_mode</div>
        ${seg('mode', [['embedded', 'full_toolkit'], ['wallets', 'wallet'], ['hosted', 'hosted']], mode)}
      </div>

      <div class="tkc-sec" id="tkc-3ds">
        <div class="tkc-com">// 3d_secure</div>
        <div class="tkc-row">
          <span class="tkc-key">3d_required</span>
          <label class="tkc-switch-wrap"><span class="tkc-bool" id="tkc-tds-val">${tds}</span>
            <input type="checkbox" class="tkc-switch" id="tk-tds" ${tds ? 'checked' : ''} />
          </label>
        </div>
        <div class="tkc-row" id="tkc-tdsflow">
          <span class="tkc-key">wait_on_payment_redirect</span>
          ${seg('tdsFlow', [['iframe', 'true · in iframe'], ['redirect', 'false · redirect']], tdsFlow)}
        </div>
      </div>

      <div class="tkc-sec" id="tkc-paybtn">
        <div class="tkc-com">// payment_button</div>
        <div class="tkc-key">hide_submit_button</div>
        ${seg('payBtn', [['rapyd', "false · Rapyd's"], ['custom', 'true · custom']], payBtn)}
        <div class="tkc-row">
          <span class="tkc-key">pay_button_text <em>/ _color</em></span>
          <span class="tkc-inline">
            <input type="text" class="tkc-input" id="dc-btn-text" maxlength="16" value="${custom.btnText}" placeholder="Pay Now" />
            <input type="color" class="tkc-color" id="dc-btn-color" value="${accent()}" title="pay_button_color" />
          </span>
        </div>
      </div>

      <div class="tkc-sec" id="tkc-wallets">
        <div class="tkc-com">// digital_wallets_buttons_customization</div>
        <div class="tkc-key">apple_pay</div>
        <div class="tkc-row selects">${selectEl('dc-ap-color', AP_COLORS, custom.ap.button_color)}${selectEl('dc-ap-type', AP_TYPES, custom.ap.button_type)}</div>
        <div class="tkc-key">google_pay</div>
        <div class="tkc-row selects">${selectEl('dc-gp-color', GP_COLORS, custom.gp.button_color)}${selectEl('dc-gp-type', GP_TYPES, custom.gp.button_type)}</div>
      </div>

      <button class="co-cta tkc-cta" id="tk-launch">${mode === 'hosted' ? 'Create session →' : 'Render toolkit →'}</button>
    </div>`;
}

export function renderPageHTML() {
  return `
    <div class="tk-checkout">
      ${summaryHTML()}
      <div class="tk-paycol" id="tk-area">${configPanelHTML()}</div>
    </div>`;
}

function syncControlVisibility() {
  const hosted = mode === 'hosted';
  const wallets = mode === 'wallets';
  $('#tkc-tdsflow')?.toggleAttribute('hidden', hosted);
  $('#tkc-paybtn')?.toggleAttribute('hidden', hosted || wallets);
  $('#tkc-wallets')?.toggleAttribute('hidden', hosted);
  const launch = $('#tk-launch');
  if (launch) launch.textContent = hosted ? 'Create session →' : 'Render toolkit →';
}

/* ── Right: request / response / console ─────────────────── */
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
    <div class="req-bodylabel" style="margin-top:18px"><p class="eng-label">Toolkit config · client-side JS</p><span class="hint">updates with toolkit.config on the left</span></div>
    ${renderJSONView(toolkitConfig(lastSession?.data?.id))}`;
  el.innerHTML = `
    ${headerRows()}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">no card data — collected by the iframe</span></div>
    ${renderJSONView(displayBody())}
    ${tkSection}`;
}

function renderResponse() {
  const el = $('#panel-response');
  if (!el || !lastSession) return;
  const ok = !lastSession.error;
  el.innerHTML = `
    <div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${ok ? 200 : 400}</span><span class="wh-pill ${ok ? 'success' : 'failure'}">${ok ? 'CHECKOUT CREATED' : 'ERROR'}</span></div>
    ${renderJSONView(lastSession)}`;
}

function renderConsole() {
  const el = $('#panel-console');
  if (!el) return;
  if (!events.length) {
    el.innerHTML = `<div class="eng-empty"><div class="ee-ico">▸</div><div class="ee-text">Toolkit lifecycle events stream here once the toolkit renders.</div></div>`;
    return;
  }
  el.innerHTML = `<p class="eng-label">Toolkit lifecycle</p><div class="tk-events">` + events.map(e => `
    <div class="tk-event ${e.cls || ''}">
      <span class="tke-name">${e.name}</span>
      ${e.detail ? `<span class="tke-detail">${e.detail}</span>` : ''}
    </div>`).join('') + `</div>`;
}

function logEvent(name, detail = '', cls = '') {
  events.push({ name, detail, cls });
  renderConsole();
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
    // Redirect scenario: the merchant page handles the 3DS challenge itself.
    const redirect = e.detail?.redirect_url;
    if (tdsFlow === 'redirect' && redirect) {
      window.open(redirect, 'rapyd-3ds', 'width=480,height=720');
      logEvent('3DS redirect opened', 'window.open(redirect_url)', 'action');
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
  window.addEventListener('onCheckoutPaymentExpired', e => {
    logEvent('onCheckoutPaymentExpired', e.detail?.status || 'checkout page expired', 'err');
    setStatus('Expired', 'error');
    renderError({ status: 'EXP', message: 'The checkout session expired.' });
  });
  // Card-on-file lifecycle — logged for later save/update/delete-card demos.
  window.addEventListener('onCheckoutUpdateCardSuccess', e => {
    logEvent('onCheckoutUpdateCardSuccess', e.detail?.id || '', 'ok');
  });
  window.addEventListener('onCheckoutDeleteCardSuccess', e => {
    logEvent('onCheckoutDeleteCardSuccess', e.detail?.id || '', 'ok');
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
  renderConsole();
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

    const area = $('#tk-area');
    if (mode === 'hosted') {
      setStatus('Redirect ready', 'action');
      area.innerHTML = `
        <div class="tk-redirect">
          <div class="tk-redirect-title">Hosted checkout ready</div>
          <div class="tk-redirect-desc">In production the customer is redirected to Rapyd's hosted page. Opening in a new tab here keeps the demo alive — the outcome returns via webhook.</div>
          <button class="co-cta" id="tk-open">Open hosted checkout ↗</button>
        </div>`;
      $('#tk-open').addEventListener('click', () => window.open(redirect, '_blank', 'noopener'));
    } else {
      await loadToolkitScript();
      // The page shape stays put — the config panel swaps for the iframe.
      const ownBtn = payBtn === 'custom' && mode !== 'wallets'
        ? `<button class="co-cta" id="tk-own-pay" style="background:${accent()}">${custom.btnText}</button>`
        : '';
      area.innerHTML = `<div id="rapyd-checkout"></div>${ownBtn}`;
      $('#tk-own-pay')?.addEventListener('click', function () {
        const iframe = document.querySelector('#rapyd-checkout iframe');
        if (!iframe) return;
        iframe.contentWindow.postMessage({ type: 'CHECKOUT_SUBMIT_PAYMENT' }, '*');
        logEvent('CHECKOUT_SUBMIT_PAYMENT', 'postMessage from custom button', 'action');
        this.remove(); // one-shot: the button leaves once payment is submitted
      });
      renderToolkit(id);
      setStatus('Toolkit rendered', 'processing');
      setActiveTab('console');
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
  const panel = $('#tk-config');
  if (!panel) return;
  renderRequest();
  events = [];
  lastSession = null;
  renderConsole();
  syncControlVisibility();

  panel.querySelectorAll('.tkc-seg').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      if (row.dataset.opt === 'mode') { mode = btn.dataset.val; syncControlVisibility(); }
      if (row.dataset.opt === 'tdsFlow') tdsFlow = btn.dataset.val;
      if (row.dataset.opt === 'payBtn') payBtn = btn.dataset.val;
      row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      renderRequest();
    });
  });

  $('#tk-tds').addEventListener('change', e => {
    tds = e.target.checked;
    const v = $('#tkc-tds-val');
    if (v) v.textContent = tds;
    renderRequest();
  });
  $('#dc-btn-text').addEventListener('input', e => { custom.btnText = e.target.value || 'Pay Now'; renderRequest(); });
  $('#dc-btn-color').addEventListener('input', e => { custom.btnColor = e.target.value; renderRequest(); });
  const wire = (id, obj, key) => $(`#${id}`).addEventListener('change', e => { obj[key] = e.target.value; renderRequest(); });
  wire('dc-ap-color', custom.ap, 'button_color');
  wire('dc-ap-type', custom.ap, 'button_type');
  wire('dc-gp-color', custom.gp, 'button_color');
  wire('dc-gp-type', custom.gp, 'button_type');

  $('#tk-launch').addEventListener('click', launch);
}
