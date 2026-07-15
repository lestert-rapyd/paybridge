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
     · digital_wallets_include_methods (AP / GP include chips)
     · digital_wallets_buttons_customization (AP / GP color + type)
   The same config is mirrored live in the Request tab. Toolkit
   lifecycle events stream to the Console tab. The left success /
   error screen is driven by the terminal webhook.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, activeProduct } from '../verticals.js';
import { createCheckoutSession } from '../api.js';
import { renderJSONView } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';
import { startWebhookWatch, setWatchPaymentId } from '../webhooks.js';
import { renderProcessing, renderSuccess, renderError } from '../screens.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';

const $ = (s, r = document) => r.querySelector(s);

let mode = 'embedded';        // embedded | wallets | hosted
let tds = true;               // payment_method_options.3d_required
let tdsFlow = 'iframe';       // iframe | redirect  (wait_on_payment_redirect)
let payBtn = 'rapyd';         // rapyd | custom     (hide_submit_button)
const custom = {
  btnText: 'Pay Now',         // pay_button_text (max 16 chars) — Rapyd's button
  btnColor: null,             // pay_button_color — null = vertical accent
  ownText: 'Complete purchase', // label of the merchant's own (custom) button
  ap: { button_color: 'black', button_type: 'buy' },
  gp: { button_color: 'black', button_type: 'buy' },
};
const wallets = { apple_pay: true, google_pay: true }; // digital_wallets_include_methods
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
  const p = activeProduct();
  return {
    amount: Number(p.amount),
    capture: true,
    currency: p.currency,
    // demo corridor: everything flows through DE regardless of vertical skin
    // (US/MT aren't enabled on this sandbox MID and fail the session)
    country: 'DE',
    description: p.name,
    statement_descriptor: v.descriptor,
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
    digital_wallets_include_methods: ['apple_pay', 'google_pay'].filter(m => wallets[m]),
    digital_wallets_buttons_customization: {
      ...(wallets.apple_pay && { apple_pay: { ...custom.ap } }),
      ...(wallets.google_pay && { google_pay: { ...custom.gp } }),
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
  const p = activeProduct();
  const [c1, c2] = p.thumb;
  const glyph = { ecommerce: '🪑', crypto: '₿', gaming: '🎲' }[state.vertical] || '◆';
  const feeLabel = p.delivery ? 'Delivery' : 'Fees';
  const feeValue = p.delivery || 'Free';
  return `
    <aside class="tk-summary">
      <div class="tk-brand">
        <span class="tk-brand-mark" style="background:linear-gradient(135deg,${c1},${c2})">${v.merchant[0]}</span>
        <span>${v.merchant}</span>
      </div>
      <div class="tk-sum-label">Your order</div>
      <div class="co-order">
        <div class="co-thumb" style="background:linear-gradient(135deg,${c1},${c2})">${glyph}</div>
        <div class="co-order-info">
          <div class="co-order-name">${p.name}</div>
          <div class="co-order-desc">${p.desc}</div>
        </div>
      </div>
      <div class="co-totals">
        <div class="co-line"><span>Subtotal</span><span>${p.symbol}${p.amount}</span></div>
        <div class="co-line"><span>${feeLabel}</span><span class="${feeValue === 'Free' ? 'free' : ''}">${feeValue}</span></div>
        <div class="co-line total"><span>Total</span><span class="co-total-amt">${p.symbol}${p.amount}</span></div>
      </div>
      <div class="tk-secure">
        <div class="tk-secure-head">🔒 Secure checkout</div>
        <p>Payments are encrypted end-to-end and processed by Rapyd. Card details never touch ${v.merchant}'s servers.</p>
        <div class="tk-badges"><span class="b-visa">VISA</span><span class="b-mc">MC</span></div>
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

const APPLE_SVG = `<svg viewBox="0 0 384 512" width="13" height="13" fill="#000" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;
const GOOGLE_SVG = `<svg viewBox="0 0 48 48" width="13" height="13" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function row(label, param, control, attrs = '') {
  return `
    <div class="tkc-row" ${attrs}>
      <div class="tkc-lab">${label}<code>${param}</code></div>
      ${control}
    </div>`;
}

function configPanelHTML() {
  return `
    <div class="tk-config" id="tk-config">
      <div class="tkc-head"><span class="tkc-title">Toolkit config</span><span class="tkc-hint">updates the request →</span></div>

      <div class="tkc-sec">
        <div class="tkc-sec-label">Integration mode</div>
        ${seg('mode', [['embedded', 'Full toolkit'], ['wallets', 'Wallet buttons'], ['hosted', 'Hosted page']], mode)}
      </div>

      <div class="tkc-sec" id="tkc-paybtn">
        <div class="tkc-sec-label">Payment button</div>
        ${row('Style', 'hide_submit_button', seg('payBtn', [['rapyd', "Rapyd's"], ['custom', 'Custom']], payBtn))}
        ${row('Label', 'pay_button_text', `<input type="text" class="tkc-input" id="dc-btn-text" maxlength="16" value="${custom.btnText}" placeholder="Pay Now" />`, 'id="tkc-row-label"')}
        ${row('Color', 'pay_button_color', `<input type="color" class="tkc-color" id="dc-btn-color" value="${accent()}" />`, 'id="tkc-row-color"')}
        ${row('Button label', 'your own button · demo', `<input type="text" class="tkc-input" id="dc-own-text" value="${custom.ownText}" />`, 'id="tkc-row-own" hidden')}
      </div>

      <div class="tkc-sec" id="tkc-3ds">
        <div class="tkc-sec-label">3-D Secure</div>
        ${row('Require 3-D Secure', 'payment_method_options.3d_required',
          `<label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="tk-tds" ${tds ? 'checked' : ''} /></label>`)}
        ${row('Challenge', 'wait_on_payment_redirect', seg('tdsFlow', [['iframe', 'In iframe'], ['redirect', 'Redirect']], tdsFlow), `id="tkc-row-challenge" ${tds ? '' : 'hidden'}`)}
      </div>

      <div class="tkc-sec" id="tkc-wallets">
        <div class="tkc-sec-label">Digital wallets<span class="tkc-sec-hint">digital_wallets_buttons_customization</span></div>
        ${row('Include', 'digital_wallets_include_methods', `
          <div class="tkc-seg tkc-multi" id="dc-dw-include">
            <button data-val="apple_pay" class="${wallets.apple_pay ? 'active' : ''}">Apple Pay</button>
            <button data-val="google_pay" class="${wallets.google_pay ? 'active' : ''}">Google Pay</button>
          </div>`)}
        <div class="tkc-row" id="tkc-row-ap" ${wallets.apple_pay ? '' : 'hidden'}>
          <div class="tkc-wallet"><span class="dw-logo apple">${APPLE_SVG}</span>Apple Pay</div>
          <span class="tkc-selects">${selectEl('dc-ap-color', AP_COLORS, custom.ap.button_color)}${selectEl('dc-ap-type', AP_TYPES, custom.ap.button_type)}</span>
        </div>
        <div class="tkc-row" id="tkc-row-gp" ${wallets.google_pay ? '' : 'hidden'}>
          <div class="tkc-wallet"><span class="dw-logo google">${GOOGLE_SVG}</span>Google Pay</div>
          <span class="tkc-selects">${selectEl('dc-gp-color', GP_COLORS, custom.gp.button_color)}${selectEl('dc-gp-type', GP_TYPES, custom.gp.button_type)}</span>
        </div>
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
  const walletsOnly = mode === 'wallets';
  const isCustom = payBtn === 'custom';
  $('#tkc-paybtn')?.toggleAttribute('hidden', hosted || walletsOnly);
  $('#tkc-wallets')?.toggleAttribute('hidden', hosted);
  // Custom style: Rapyd's label/color give way to the merchant button's own label
  $('#tkc-row-label')?.toggleAttribute('hidden', isCustom);
  $('#tkc-row-color')?.toggleAttribute('hidden', isCustom);
  $('#tkc-row-own')?.toggleAttribute('hidden', !isCustom);
  // Challenge placement only matters when a 3DS challenge can occur
  $('#tkc-row-challenge')?.toggleAttribute('hidden', hosted || !tds);
  // Customization rows only for wallets that are actually included
  $('#tkc-row-ap')?.toggleAttribute('hidden', !wallets.apple_pay);
  $('#tkc-row-gp')?.toggleAttribute('hidden', !wallets.google_pay);
  const launch = $('#tk-launch');
  if (launch) launch.textContent = hosted ? 'Create session →' : 'Render toolkit →';
}

/* ── Right: request / response / console ─────────────────── */
function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  const st = newSaltTimestamp();
  const body = displayBody();
  const tkSection = mode === 'hosted' ? '' : `
    <div class="req-bodylabel" style="margin-top:18px"><p class="eng-label">Toolkit config · client-side JS</p><span class="hint">updates with toolkit.config on the left</span></div>
    ${renderJSONView(toolkitConfig(lastSession?.data?.id))}`;
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/checkout</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">no card data — collected by the iframe</span></div>
    ${renderJSONView(body)}
    ${tkSection}`;
  fillSignature(el, 'post', '/v1/checkout', st, body); // live — recomputes with the body
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
    document.getElementById('tk-own-pay')?.remove(); // payment sent for authorisation
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
    document.getElementById('tk-own-pay')?.remove(); // payment sent for authorisation
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
  {
    const v = VERTICALS[state.vertical];
    const p = activeProduct();
    // snapshot for the success screen's bank-statement view (fx reserved
    // for when FX fields are configured in the demo; last4 arrives via webhook)
    state.lastPayment = { descriptor: v.descriptor, amount: p.amount, currency: p.currency, last4: null, fx: null };
  }
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
        ? `<button class="co-cta" id="tk-own-pay" style="background:${accent()}">${custom.ownText}</button>`
        : '';
      area.innerHTML = `<div id="rapyd-checkout"></div>${ownBtn}`;
      $('#tk-own-pay')?.addEventListener('click', () => {
        const iframe = document.querySelector('#rapyd-checkout iframe');
        if (!iframe) return;
        iframe.contentWindow.postMessage({ type: 'CHECKOUT_SUBMIT_PAYMENT' }, '*');
        logEvent('CHECKOUT_SUBMIT_PAYMENT', 'postMessage from custom button', 'action');
        // NOT removed here — the toolkit may reject the submit (required-field
        // validation). It leaves once the payment is accepted for authorisation
        // (onCheckoutPaymentPending / onCheckoutPaymentSuccess).
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

  panel.querySelectorAll('.tkc-seg[data-opt]').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      if (row.dataset.opt === 'mode') mode = btn.dataset.val;
      if (row.dataset.opt === 'tdsFlow') tdsFlow = btn.dataset.val;
      if (row.dataset.opt === 'payBtn') payBtn = btn.dataset.val;
      row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      syncControlVisibility();
      renderRequest();
    });
  });

  $('#tk-tds').addEventListener('change', e => {
    tds = e.target.checked;
    syncControlVisibility();
    renderRequest();
  });
  // Include chips are independent toggles, not a single-select seg
  $('#dc-dw-include').addEventListener('click', e => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    const m = btn.dataset.val;
    wallets[m] = !wallets[m];
    btn.classList.toggle('active', wallets[m]);
    syncControlVisibility();
    renderRequest();
  });
  $('#dc-btn-text').addEventListener('input', e => { custom.btnText = e.target.value || 'Pay Now'; renderRequest(); });
  $('#dc-btn-color').addEventListener('input', e => { custom.btnColor = e.target.value; renderRequest(); });
  $('#dc-own-text').addEventListener('input', e => { custom.ownText = e.target.value || 'Complete purchase'; });
  const wire = (id, obj, key) => $(`#${id}`).addEventListener('change', e => { obj[key] = e.target.value; renderRequest(); });
  wire('dc-ap-color', custom.ap, 'button_color');
  wire('dc-ap-type', custom.ap, 'button_type');
  wire('dc-gp-color', custom.gp, 'button_color');
  wire('dc-gp-type', custom.gp, 'button_type');

  $('#tk-launch').addEventListener('click', launch);
}
