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
import { VERTICALS, activeProduct, customerCharge, chargeText, fxSnapshot, productCta } from '../verticals.js';
import { createCheckoutSession, createDirectPayment } from '../api.js';
import { profileEwallet } from '../profiles.js';
import { clientDetails } from '../client-details.js';
import { renderJSONView } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';
import { startWebhookWatch, setWatchPaymentId } from '../webhooks.js';
import { renderProcessing, render3DS, renderSuccess, renderError } from '../screens.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import * as ledger from '../ledger.js';
import * as customers from '../customers.js';
import { identityMode, usesCustomer, promoteToReturning, refreshIdentityChooser } from '../identity.js';
import { stepRailHTML } from '../steps.js';
import {
  accountPanelHTML, beatCardHTML, customerRequestCardHTML, customerResponseCardHTML,
  fillCustomerSignature, fireCreateCustomer, refreshAccountPanel,
} from '../customer-beat.js';

const $ = (s, r = document) => r.querySelector(s);

let mode = 'embedded';        // embedded | wallets | hosted
let tds = true;               // payment_method_options.3d_required
let tdsFlow = 'iframe';       // iframe | redirect  (wait_on_payment_redirect)
let payBtn = 'rapyd';         // rapyd | custom     (hide_submit_button)

// FX config is shared with the direct flow: it lives on state.fx, edited via
// the popover behind the price tile's FX corner badge (see app.js), not on a
// control in this page. requested_currency + fixed_side must be absent
// entirely on a no-FX call (sending them errors it); `expiration` is computed
// silently, never exposed as a control.
const custom = {
  btnText: 'Pay Now',         // pay_button_text (max 16 chars) — Rapyd's button
  btnColor: null,             // pay_button_color — null = vertical accent
  ownText: 'Complete purchase', // label of the merchant's own (custom) button
  ap: { button_color: 'black', button_type: 'buy' },
  gp: { button_color: 'black', button_type: 'buy' },
};
const wallets = { apple_pay: true, google_pay: true }; // digital_wallets_include_methods
let events = [];
let lastHeartbeat = null;
let listenersBound = false;
let lastSession = null;

/* Card on file (non-PCI): the HCP saves the card_*** against the session
   cus_*** — a customer is a PREREQUISITE for saving through this route.
   Whether a customer is attached is now the CUSTOMER's choice, made in the
   shared identity chooser (js/identity.js) rather than by an SE switch here —
   two controls for one decision could contradict each other. The config row
   below reflects it read-only. */
let saveDefault = true;     // custom_elements.save_card_default
let requireCvv = false;     // require_card_cvv (CVV re-entry on saved-card reuse)
let pendingCof = null;      // snapshot between launch and PAYMENT_COMPLETED
let lastExpress = null;     // persisted express S2S request/response for refreshRightPanel

const isSubscription = () => activeProduct().billing === 'subscription';
const recurrence = () => (isSubscription() ? 'recurring' : 'unscheduled');
// Guest → no customer on the session; account/returning → attach one.
// (identityMode() already coerces a subscription off guest.)
const effectiveCof = () => usesCustomer();

const AP_TYPES = ['add-money', 'book', 'buy', 'check-out', 'contribute', 'donate', 'order', 'plain', 'reload', 'rent', 'subscribe', 'support', 'tip', 'top-up'];
const GP_TYPES = ['book', 'buy', 'checkout', 'donate', 'order', 'pay', 'subscribe'];
const AP_COLORS = ['black', 'white', 'white-outline'];
const GP_COLORS = ['black', 'white'];

const accent = () => custom.btnColor || VERTICALS[state.vertical].dot;

/* ── Request body (server-side POST /v1/checkout) ────────── */
function displayBody() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const cofOn = effectiveCof();
  return {
    amount: Number(p.amount),
    capture: true,
    currency: p.currency,
    // demo corridor: everything flows through DE regardless of vertical skin
    // (US/MT aren't enabled on this sandbox MID and fail the session)
    country: 'DE',
    // Card on file: `customer` alone gives the hosted page its save-card
    // option AND lists the customer's saved cards on a return visit.
    ...(cofOn ? {
      customer: customers.getCustomerId() || '(created on launch)',
      require_card_cvv: requireCvv,
      recurrence_type: recurrence(),
      // scheme rule: recurring/installment saves must set save_payment_method
      ...(recurrence() === 'recurring' ? { save_payment_method: true } : {}),
    } : {}),
    description: p.name,
    statement_descriptor: v.descriptor,
    merchant_reference_id: state.reference || '(assigned on launch)',
    // real pages — the vertical domains (shop.paybridge.com etc.) are display-only fiction
    complete_checkout_url: 'https://rapydtoolkit.com/complete',
    cancel_checkout_url: 'https://rapydtoolkit.com/cancel',
    custom_elements: { display_description: true, ...(cofOn ? { save_card_default: saveDefault } : {}) },
    payment_method_type_categories: ['card'],
    payment_method_options: { '3d_required': tds },
    // No-FX flows must omit all three fields entirely — sending any of them
    // without the others errors the call.
    ...(state.fx.enabled && state.fx.requestedCurrency ? {
      requested_currency: state.fx.requestedCurrency,
      fixed_side: state.fx.fixedSide,
      expiration: Math.floor(Date.now() / 1000) + 24 * 3600, // silent — not an SE-facing control
    } : {}),
  };
}
function postBody() {
  const b = displayBody();
  b.merchant_reference_id = state.reference;
  return { ...b, env: state.env, profile: state.profile };
}

/* Express S2S token charge — the non-PCI merchant's OTHER reuse path:
   a direct POST /v1/payments with the saved card_*** (no card data ever
   touches the merchant, so this is open to non-PCI integrations too). */
function expressBody(cred) {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const body = {
    amount: Number(p.amount),
    currency: p.currency,
  };
  if (state.fx.enabled && state.fx.requestedCurrency) {
    body.requested_currency = state.fx.requestedCurrency;
    body.fixed_side = state.fx.fixedSide;
    body.expiration = Math.floor(Date.now() / 1000) + 24 * 3600;
  }
  body.capture = true;
  const wallet = profileEwallet();
  if (wallet) body.ewallet = wallet;
  body.customer = customers.getCustomerId();
  body.merchant_reference_id = state.reference || '(assigned on pay)';
  body.statement_descriptor = v.descriptor;
  body.description = p.name;
  body.payment_method = cred.card_id;
  body.initiation_type = 'customer_present'; // the customer clicked — still CIT
  const pmo = {};
  if (tds) pmo['3d_required'] = true;
  if (p.aft) {
    pmo.aft = true;
    pmo.is_direct_purchase = true;
    pmo.purpose_code = p.purpose_code;
    pmo.special_condition_indicator = p.special_condition_indicator;
  }
  if (Object.keys(pmo).length) body.payment_method_options = pmo;
  body.address = customers.demoAddress();
  body.client_details = clientDetails(); // ip_address injected server-side
  return body;
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
// Customer-facing order totals — reflects what the customer actually pays
// (the converted requested-currency figure under 'buy'), ISO codes only to
// match the rest of the demo. Kept in its own fn so refreshSummary() can
// repaint just this block when the FX quote lands.
function tkTotalsHTML() {
  const p = activeProduct();
  const c = customerCharge();
  const feeLabel = p.delivery ? 'Delivery' : 'Fees';
  const feeValue = p.delivery || 'Free';
  const amt = chargeText(c);
  const mo = p.billing === 'subscription' ? ' <span class="per-mo">/mo</span>' : '';
  return `
    <div class="co-line"><span>Subtotal</span><span>${amt}</span></div>
    <div class="co-line"><span>${feeLabel}</span><span class="${feeValue === 'Free' ? 'free' : ''}">${feeValue}</span></div>
    <div class="co-line total"><span>Total</span><span class="co-total-amt">${amt}${mo}</span></div>`;
}
/* Express slot content — rendered whenever the customer has a token saved for
   customer-present reuse (one-time products only; subscriptions bill from the
   back office). Repainted in place by the customers subscription. */
function expressHTML() {
  const p = activeProduct();
  if (p.billing !== 'one_time') return '';
  if (identityMode() !== 'returning') return ''; // express IS the returning path
  const creds = customers.credentialsFor('unscheduled').filter(c => c.kind === 'token');
  if (!creds.length) return '';
  const c = creds[creds.length - 1];
  const exp = c.expiration_month && c.expiration_year ? `${c.expiration_month}/${c.expiration_year}` : '··/··';
  return `
    <div class="tk-express" data-cred="${c.ref}">
      <div class="tk-express-head">Express checkout</div>
      <div class="cof-chip active static">
        <span class="cof-chip-brand">${c.brand || 'Card'}</span>
        <span class="cof-chip-num">···· ${c.last4 || '····'}</span>
        <span class="cof-chip-exp">${exp}</span>
        <span class="cof-chip-kind token">${c.card_id ? `${c.card_id.slice(0, 9)}…` : 'card_ token'}</span>
      </div>
      <button type="button" class="co-cta tk-express-pay" id="tk-express-pay">${productCta()} with saved card</button>
      <div class="tk-express-alt">S2S <code>card_***</code> charge — or use the checkout on the right for a new card</div>
    </div>`;
}

function summaryHTML() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const [c1, c2] = p.thumb;
  const glyph = p.glyph || { ecommerce: '🪑', crypto: '₿', gaming: '🎲' }[state.vertical] || '◆';
  return `
    <aside class="tk-summary">
      <div class="tk-brand">
        <span class="tk-brand-mark" style="background:linear-gradient(135deg,${c1},${c2})">${v.merchant[0]}</span>
        <span>${v.merchant}</span>
      </div>
      ${accountPanelHTML()}
      <div class="tk-sum-label">Your order</div>
      <div class="co-order">
        <div class="co-thumb" style="background:linear-gradient(135deg,${c1},${c2})">${glyph}</div>
        <div class="co-order-info">
          <div class="co-order-name">${p.name}</div>
          <div class="co-order-desc">${p.desc}</div>
        </div>
        <button type="button" class="fx-trigger${state.fx.enabled ? ' configured' : ''}" id="fx-trigger" title="Configure currency conversion">FX</button>
      </div>
      <div class="co-totals" id="tk-order-totals">${tkTotalsHTML()}</div>
      <div id="tk-express-slot">${expressHTML()}</div>
      <div class="tk-secure">
        <div class="tk-secure-head">🔒 Secure checkout</div>
        <p>Payments are encrypted end-to-end and processed by Rapyd. Card details never touch ${v.merchant}'s servers.</p>
        <div class="tk-badges"><span class="b-visa">VISA</span><span class="b-mc">MC</span></div>
      </div>
    </aside>`;
}
/** Repaint the order totals when the FX quote arrives/changes (called by
    app.js refreshCharge via FLOWS[model].refreshSummary). No-op once the
    summary has been swapped for the live iframe. */
export function refreshSummary() {
  const el = $('#tk-order-totals');
  if (el) el.innerHTML = tkTotalsHTML();
}

/* ── toolkit.config panel (pre-render, dark / code-styled) ── */
function seg(key, options, current) {
  return `
    <div class="tkc-seg" data-opt="${key}">${options.map(([val, text]) =>
      `<button data-val="${val}" class="${current === val ? 'active' : ''}">${text}</button>`).join('')}
    </div>`;
}
// "white-outline" → "White Outline" — display only, the option's value (sent to the API) is untouched
const humanize = s => s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
function selectEl(id, values, current) {
  return `<select class="tkc-select" id="${id}">${values.map(o =>
    `<option value="${o}" ${o === current ? 'selected' : ''}>${humanize(o)}</option>`).join('')}</select>`;
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
        ${row('Color', 'pay_button_color', `
          <div class="tkc-colorfield">
            <input type="color" class="tkc-color" id="dc-btn-color" value="${accent()}" />
            <input type="text" class="tkc-input tkc-hex" id="dc-btn-color-hex" maxlength="7" value="${accent()}" placeholder="#5600ef" />
          </div>`, 'id="tkc-row-color"')}
        ${row('Button label', 'your own button · demo', `<input type="text" class="tkc-input" id="dc-own-text" value="${custom.ownText}" />`, 'id="tkc-row-own" hidden')}
      </div>

      <div class="tkc-sec" id="tkc-3ds">
        <div class="tkc-sec-label">3-D Secure</div>
        ${row('Require 3-D Secure', 'payment_method_options.3d_required',
          `<label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="tk-tds" ${tds ? 'checked' : ''} /></label>`)}
        ${row('Challenge', 'wait_on_payment_redirect', seg('tdsFlow', [['iframe', 'In iframe'], ['redirect', 'Redirect']], tdsFlow), `id="tkc-row-challenge" ${tds ? '' : 'hidden'}`)}
      </div>

      <div class="tkc-sec" id="tkc-cof">
        <div class="tkc-sec-label">Card on file</div>
        ${row('Attach customer', 'customer',
          `<span class="tkc-fixed"><code>${effectiveCof() ? 'attached' : 'none'}</code></span>`)}
        ${row('Identity', 'chosen on the checkout',
          `<span class="tkc-fixed"><code>${identityMode()}</code></span>`)}
        ${row('Save box pre-ticked', 'custom_elements.save_card_default',
          `<label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="tk-savedef" ${saveDefault ? 'checked' : ''} /></label>`, `id="tkc-row-savedef" ${effectiveCof() ? '' : 'hidden'}`)}
        ${row('CVV on reuse', 'require_card_cvv',
          `<label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="tk-reqcvv" ${requireCvv ? 'checked' : ''} /></label>`, `id="tkc-row-reqcvv" ${effectiveCof() ? '' : 'hidden'}`)}
        ${row('Purpose', 'recurrence_type', `<span class="tkc-fixed"><code>${recurrence()}</code></span>`, `id="tkc-row-rec" ${effectiveCof() ? '' : 'hidden'}`)}
        ${isSubscription() ? `<div class="tkc-note">Subscription product — the card must be stored; MIT charges run from the back office.</div>` : ''}
      </div>

      <div class="tkc-sec" id="tkc-wallets">
        <div class="tkc-sec-label">Digital wallets<span class="tkc-sec-hint">digital_wallets_include_methods</span></div>

        <div class="tkc-row">
          <div class="tkc-wallet"><span class="dw-logo apple">${APPLE_SVG}</span>Apple Pay</div>
          <label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="dc-ap-toggle" ${wallets.apple_pay ? 'checked' : ''} /></label>
        </div>
        <div class="tkc-row tkc-wallet-custom" id="tkc-cust-ap" ${wallets.apple_pay ? '' : 'hidden'}>
          <div class="tkc-lab">Style<code>digital_wallets_buttons_customization.apple_pay</code></div>
          <span class="tkc-selects">${selectEl('dc-ap-color', AP_COLORS, custom.ap.button_color)}${selectEl('dc-ap-type', AP_TYPES, custom.ap.button_type)}</span>
        </div>

        <div class="tkc-row">
          <div class="tkc-wallet"><span class="dw-logo google">${GOOGLE_SVG}</span>Google Pay</div>
          <label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="dc-gp-toggle" ${wallets.google_pay ? 'checked' : ''} /></label>
        </div>
        <div class="tkc-row tkc-wallet-custom" id="tkc-cust-gp" ${wallets.google_pay ? '' : 'hidden'}>
          <div class="tkc-lab">Style<code>digital_wallets_buttons_customization.google_pay</code></div>
          <span class="tkc-selects">${selectEl('dc-gp-color', GP_COLORS, custom.gp.button_color)}${selectEl('dc-gp-type', GP_TYPES, custom.gp.button_type)}</span>
        </div>
      </div>

      <button class="co-cta tkc-cta" id="tk-launch">${mode === 'hosted' ? 'Create session →' : 'Render toolkit →'}</button>
    </div>`;
}

export function renderPageHTML() {
  // The rail sits above the two-column stage, not inside the summary — it
  // belongs to the page (frame 4 of four), not to the order.
  return `
    ${stepRailHTML()}
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
  $('#tkc-cust-ap')?.toggleAttribute('hidden', !wallets.apple_pay);
  $('#tkc-cust-gp')?.toggleAttribute('hidden', !wallets.google_pay);
  const launch = $('#tk-launch');
  if (launch) launch.textContent = hosted ? 'Create session →' : 'Render toolkit →';
}

/* ── Right: request / response / console ─────────────────────
   Beat 1 (the customer create) stacks above this flow's own card — same shell
   as own-fields. It used to be a console line only, so the body and response of
   the call that makes the hosted page's save-card option possible were never
   visible. The client-side toolkit.config JSON stays OUTSIDE the cards: it
   isn't an API call. */
function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  const st = newSaltTimestamp();
  const body = displayBody();
  const cusCard = customerRequestCardHTML();
  const tkSection = mode === 'hosted' ? '' : `
    <div class="req-bodylabel" style="margin-top:18px"><p class="eng-label">Toolkit config · client-side JS</p><span class="hint">updates with toolkit.config on the left</span></div>
    ${renderJSONView(toolkitConfig(lastSession?.data?.id))}`;
  el.innerHTML = cusCard + beatCardHTML({
    id: 'beat-checkout', n: cusCard ? 2 : null, method: 'POST', path: '/v1/checkout',
    badge: lastSession?.data?.id ? 'signed &amp; sent' : '', badgeKind: lastSession?.data?.id ? 'ok' : '',
    inner: `
      ${headersHTML(st)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">no card data — collected by the iframe</span></div>
      ${renderJSONView(body)}`,
  }) + tkSection;
  fillCustomerSignature();
  fillSignature($('#beat-checkout'), 'post', '/v1/checkout', st, body); // live — recomputes with the body
}

function renderResponse() {
  const el = $('#panel-response');
  if (!el) return;
  const cusCard = customerResponseCardHTML();
  let card = '';
  if (lastSession) {
    const ok = !lastSession.error;
    card = beatCardHTML({
      id: 'beat-checkout-res', n: cusCard ? 2 : null, method: 'POST', path: '/v1/checkout',
      badge: ok ? 'CHECKOUT CREATED' : 'ERROR', badgeKind: ok ? 'ok' : 'err',
      inner: `
        <div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${ok ? 200 : 400}</span><span class="wh-pill ${ok ? 'success' : 'failure'}">${ok ? 'CHECKOUT CREATED' : 'ERROR'}</span></div>
        ${renderJSONView(lastSession)}`,
    });
  }
  if (!cusCard && !card) return; // nothing sent yet — leave app.js's empty state
  el.innerHTML = cusCard + card;
}

/* Express S2S request/response paints — the right panel flips from
   POST /v1/checkout to POST /v1/payments when the saved token is charged. */
function paintExpressRequest(body) {
  const el = $('#panel-request');
  if (!el) return;
  const st = newSaltTimestamp();
  const cusCard = customerRequestCardHTML();
  el.innerHTML = cusCard + beatCardHTML({
    id: 'beat-express', n: cusCard ? 2 : null, method: 'POST', path: '/v1/payments',
    badge: 'express', badgeKind: '',
    inner: `
      ${headersHTML(st)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">express · saved card_*** token — no card data</span></div>
      ${renderJSONView(body)}`,
  });
  fillCustomerSignature();
  fillSignature($('#beat-express'), 'post', '/v1/payments', st, body);
}
function paintExpressResponse(httpStatus, data) {
  const el = $('#panel-response');
  if (!el) return;
  const d = data?.data;
  const ok = httpStatus < 400 && !data?.error;
  const badge = d?.status === 'CLO' && d?.paid ? 'PAID · CLO' : d?.status === 'ACT' ? 'ACTION · ACT' : ok ? (d?.status || 'OK') : String(data?.error || 'ERROR');
  const cusCard = customerResponseCardHTML();
  el.innerHTML = cusCard + beatCardHTML({
    id: 'beat-express-res', n: cusCard ? 2 : null, method: 'POST', path: '/v1/payments',
    badge, badgeKind: ok ? (d?.status === 'ACT' ? 'live' : 'ok') : 'err',
    inner: `
      <div class="eng-pillrow">
        <span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${httpStatus}</span>
        <span class="wh-pill ${ok ? (d?.status === 'ACT' ? 'pending' : 'success') : 'failure'}">${badge}</span>
      </div>
      ${renderJSONView(data ?? { error: 'no response body' })}`,
  });
}

/** See own-fields.js's refreshRightPanel — same reasoning. renderResponse()
    here already reads off persisted `lastSession`, so it's idempotent. An
    express charge supersedes the session panels until the next launch. */
export function refreshRightPanel() {
  if (lastExpress) {
    paintExpressRequest(lastExpress.body);
    if (lastExpress.httpStatus != null) paintExpressResponse(lastExpress.httpStatus, lastExpress.data);
    return;
  }
  renderRequest();
  renderResponse();
}

/** Profile switch (SC1/SC2/SC3): the express slot and body signing identity
    change; repaint without resetting the page. */
export function refreshProfile() {
  refreshIdentityChooser(); // the new bucket may hold no cards → "Returning" withdraws
  refreshAccountPanel();    // …and no customer → the account step's create form returns
  const slot = $('#tk-express-slot');
  if (slot) slot.innerHTML = expressHTML();
  refreshRightPanel();
}

// Terminal-style log, tagged like a real dev console: HH:MM:SS  tag  message
const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour12: false });
function logLineHTML(e) {
  return `
    <div class="cl-line">
      <span class="cl-time">${fmtTime(e.at)}</span>
      <span class="cl-tag cl-${e.tag}">${e.tag}</span>
      <span class="cl-msg${e.kind ? ` cl-${e.kind}` : ''}">${e.name}${e.detail ? ` <span class="cl-detail">${e.detail}</span>` : ''}</span>
    </div>`;
}

function renderConsole() {
  const el = $('#panel-console');
  if (!el) return;
  if (!events.length && !lastHeartbeat) {
    el.innerHTML = `<div class="eng-empty"><div class="ee-ico">▸</div><div class="ee-text">Toolkit lifecycle events stream here once the toolkit renders.</div></div>`;
    return;
  }
  const lines = events.map(logLineHTML).join('');
  const heartbeat = lastHeartbeat ? logLineHTML({ name: 'heartbeat', tag: 'poll', at: lastHeartbeat }) : '';
  el.innerHTML = `<div class="tk-console">${lines}${heartbeat}<span class="cl-cursor">▏</span></div>`;
}

function logEvent(name, detail = '', tag = 'tk', kind = '') {
  events.push({ name, detail, tag, kind, at: new Date() });
  renderConsole();
}

/* ── Terminal (webhook / fallback) → left screen ─────────── */
function handleTerminal(ev) {
  // Terminal PAYMENT_COMPLETED/PAYMENT_FAILED webhook, or the poll fallback's
  // status object (CLO+paid). Never confirmed off PAYMENT_SUCCEEDED.
  const success = /COMPLETED|CAPTURE/.test((ev.type || '').toUpperCase()) || (ev.status === 'CLO' && ev.paid);
  if (success) {
    setStatus('Paid', 'ok'); renderSuccess(ev);
    ledger.updateStatus(state.reference, { status: 'completed', phase: 'completed' });
    harvestCofToken(ev);
  } else {
    setStatus('Failed', 'error'); renderError(ev);
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'failed' });
    pendingCof = null;
  }
}

/** The HCP saved the card during this payment — pull the card_*** out of the
    PAYMENT_COMPLETED webhook (never PAYMENT_SUCCEEDED), then let the list
    endpoint backfill expiry etc. */
function harvestCofToken(ev) {
  const pc = pendingCof;
  pendingCof = null;
  const d = ev.raw?.data;
  if (!pc || !d) return;
  const pmd = d.payment_method_data || {};
  const cardId =
    (typeof d.payment_method === 'string' && /^card_/.test(d.payment_method) && d.payment_method) ||
    (typeof pmd.id === 'string' && /^card_/.test(pmd.id) && pmd.id) || null;
  if (cardId) {
    const brand = /visa/i.test(pmd.type || '') ? 'Visa' : /master/i.test(pmd.type || '') ? 'Mastercard' : 'Card';
    const ref = customers.upsertTokenCredential({
      card_id: cardId, type: pmd.type || null, brand, last4: pmd.last4 || null,
      expiration_month: null, expiration_year: null,
      recurrence_type: pc.recurrence, aft: false,
      origin_vertical: state.vertical, origin_model: 'toolkit', origin_product: pc.product,
    });
    if (pmd.network_reference_id) customers.setNetworkReferenceId(ref, pmd.network_reference_id);
    logEvent('card saved', `${cardId} · recurrence ${pc.recurrence}`, 'tk', 'ok');
  }
  logEvent('GET /v1/customers/{id}/payment_methods', 'syncing saved cards', 'api');
  customers.refreshTokens();
  // A card is now on file — the arc's next phase is the returning customer.
  promoteToReturning();
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
  window.addEventListener('onLoading', e => logEvent('onLoading', `loading: ${e.detail?.loading}`, 'tk'));
  window.addEventListener('onCheckoutPaymentPending', e => {
    if (e.detail?.id) { setWatchPaymentId(e.detail.id); ledger.setPaymentId(state.reference, e.detail.id); }
    document.getElementById('tk-own-pay')?.remove(); // payment sent for authorisation
    logEvent('onCheckoutPaymentPending', `${e.detail?.status || ''} ${e.detail?.next_action || ''}`.trim(), 'tk', 'action');
    setStatus('Pending · 3DS', 'action');
    ledger.updateStatus(state.reference, { phase: 'pending_3ds' });
    // Redirect scenario: the merchant page handles the 3DS challenge itself.
    const redirect = e.detail?.redirect_url;
    if (tdsFlow === 'redirect' && redirect) {
      window.open(redirect, 'rapyd-3ds', 'width=480,height=720');
      logEvent('3DS redirect opened', 'window.open(redirect_url)', 'tk', 'action');
    }
  });
  window.addEventListener('onCheckoutPaymentSuccess', e => {
    if (e.detail?.id) { setWatchPaymentId(e.detail.id); ledger.setPaymentId(state.reference, e.detail.id); }
    document.getElementById('tk-own-pay')?.remove(); // payment sent for authorisation
    logEvent('onCheckoutPaymentSuccess', `${e.detail?.status || ''} · paid:${e.detail?.paid}`, 'tk', 'ok');
    setStatus('Confirming…', 'processing');
    renderProcessing('Payment received', 'Confirming via webhook…');
    ledger.updateStatus(state.reference, { phase: 'awaiting_confirmation' });
  });
  window.addEventListener('onCheckoutPaymentFailure', e => {
    logEvent('onCheckoutPaymentFailure', (e.detail?.error && (e.detail.error.message || e.detail.error)) || 'failure', 'tk', 'err');
    setStatus('Failed', 'error');
    renderError({ status: 'ERR', message: 'The payment failed in the toolkit.' });
  });
  window.addEventListener('onCheckoutPaymentExpired', e => {
    logEvent('onCheckoutPaymentExpired', e.detail?.status || 'checkout page expired', 'tk', 'err');
    setStatus('Expired', 'error');
    renderError({ status: 'EXP', message: 'The checkout session expired.' });
  });
  // Card-on-file lifecycle — logged for later save/update/delete-card demos.
  window.addEventListener('onCheckoutUpdateCardSuccess', e => {
    logEvent('onCheckoutUpdateCardSuccess', e.detail?.id || '', 'tk', 'ok');
  });
  window.addEventListener('onCheckoutDeleteCardSuccess', e => {
    logEvent('onCheckoutDeleteCardSuccess', e.detail?.id || '', 'tk', 'ok');
  });
}

function renderToolkit(checkoutId) {
  bindToolkitEvents();
  try {
    const checkout = new RapydCheckoutToolkit(toolkitConfig(checkoutId));
    checkout.displayCheckout();
    logEvent('displayCheckout()', 'iframe rendering', 'tk');
  } catch (err) {
    logEvent('toolkit error', err.message, 'tk', 'err');
  }
}

/* ── Launch ──────────────────────────────────────────────── */
async function launch() {
  const btn = $('#tk-launch');
  btn.disabled = true;
  btn.textContent = 'Creating session…';
  setStatus('Creating session…', 'processing');
  events = [];
  lastHeartbeat = null;
  lastSession = null;
  lastExpress = null;
  renderConsole();

  // Card on file: a cus_*** is a PREREQUISITE for saving a card through the
  // hosted route — create it first (two-beat). Fails → STOP, nothing recorded.
  // The shared beat paints its own request/response cards (it used to be this
  // console line only); the account step on the left fires the same call
  // explicitly, in which case this short-circuits.
  if (effectiveCof() && !customers.getCustomerId()) {
    logEvent('POST /v1/customers', 'card on file needs a customer first', 'api');
    const ok = await fireCreateCustomer();
    if (!ok) {
      setStatus('Error', 'error');
      logEvent('POST /v1/customers', 'failed', 'api', 'err');
      renderError({ status: 'ERR', message: 'Customer creation failed — see the Response tab.' });
      btn.disabled = false;
      btn.textContent = mode === 'hosted' ? 'Create session →' : 'Render toolkit →';
      return;
    }
    logEvent('POST /v1/customers', `${customers.getCustomerId()} · created (enriched)`, 'api', 'ok');
  }

  state.reference = `pb_${state.vertical}_tk_${Date.now()}`;
  {
    const v = VERTICALS[state.vertical];
    const p = activeProduct();
    // snapshot for the success screen's bank-statement view (last4 arrives via
    // webhook). amount/currency = what the CUSTOMER paid, so the statement
    // matches the checkout; fx carries the legs (charged / base / receive).
    const fxOn = state.fx.enabled && state.fx.requestedCurrency;
    const charge = customerCharge();
    state.lastPayment = {
      descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency, last4: null, fx: fxSnapshot(),
      customer_id: effectiveCof() ? customers.getCustomerId() : null,
      credential_label: effectiveCof() ? `saving · ${recurrence()}` : null,
      initiation_type: 'customer_present',
      note: p.successNote || v.successNote,
    };
    ledger.recordPayment(state.reference, {
      model: 'toolkit', vertical: state.vertical, amount: p.amount, currency: p.currency,
      requested_currency: fxOn ? state.fx.requestedCurrency : null, fixed_side: fxOn ? state.fx.fixedSide : null,
      origin: 'client', initiation_type: 'customer_present', profile: state.profile,
    });
    pendingCof = effectiveCof() ? { recurrence: recurrence(), product: p.id } : null;
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
    logEvent('POST /v1/checkout', `${id} · 201`, 'api', 'ok');
    startWebhookWatch({ reference: state.reference, onTerminal: handleTerminal, onPoll: () => { lastHeartbeat = new Date(); renderConsole(); } });

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
        logEvent('CHECKOUT_SUBMIT_PAYMENT', 'postMessage from custom button', 'tk', 'action');
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
    logEvent('POST /v1/checkout', err.message, 'api', 'err');
    renderError({ status: 'ERR', message: err.message });
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'error' });
  }
}

/* ── Express S2S token charge ────────────────────────────── */
async function expressPay(credRef) {
  const cred = customers.getCredential(credRef);
  if (!cred || !cred.card_id) return;
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  setStatus('Processing…', 'processing');
  state.reference = `pb_${state.vertical}_xp_${Date.now()}`;
  const body = expressBody(cred);
  body.merchant_reference_id = state.reference;

  const fxOn = state.fx.enabled && state.fx.requestedCurrency;
  const charge = customerCharge();
  state.lastPayment = {
    descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency,
    last4: cred.last4, network: cred.brand, fx: fxSnapshot(),
    customer_id: customers.getCustomerId(),
    credential_label: `${cred.brand} ···${cred.last4} (token)`,
    initiation_type: 'customer_present',
    aft: !!p.aft, is_direct_purchase: p.aft ? true : null,
    note: p.successNote || v.successNote,
  };
  ledger.recordPayment(state.reference, {
    model: 'toolkit', vertical: state.vertical, amount: p.amount, currency: p.currency,
    requested_currency: fxOn ? state.fx.requestedCurrency : null, fixed_side: fxOn ? state.fx.fixedSide : null,
    last4: cred.last4, brand: cred.brand,
    origin: 'client', initiation_type: 'customer_present', profile: state.profile,
    credential: { kind: 'token', label: `${cred.brand} ···${cred.last4}` },
    aft: !!p.aft,
  });

  lastExpress = { body, httpStatus: null, data: null };
  paintExpressRequest(body);
  setActiveTab('request');
  logEvent('POST /v1/payments', `express · ${cred.card_id}`, 'api');
  renderProcessing('Charging your saved card…', 'No card entry needed — the token references the stored card.');

  try {
    const { httpStatus, data } = await createDirectPayment({ ...body, env: state.env, profile: state.profile });
    lastExpress = { body, httpStatus, data };
    paintExpressResponse(httpStatus, data);
    setActiveTab('response');
    const d = data?.data;
    if (!d || data?.error) {
      setStatus('Declined', 'error');
      logEvent('POST /v1/payments', data?.message || data?.error || 'declined', 'api', 'err');
      renderError({ status: data?.error || 'ERR', message: data?.message || 'The payment was declined.' });
      ledger.updateStatus(state.reference, { status: 'failed', phase: 'declined' });
      return;
    }
    ledger.setPaymentId(state.reference, d.id);
    logEvent('POST /v1/payments', `${d.id} · ${d.status}`, 'api', 'ok');
    if (d.status === 'ACT' && d.next_action === '3d_verification') {
      setStatus('3DS challenge', 'action');
      render3DS(d.redirect_url);
      ledger.updateStatus(state.reference, { phase: 'pending_3ds' });
    } else {
      setStatus('Confirming…', 'processing');
      renderProcessing('Payment received', 'Confirming via webhook…');
      ledger.updateStatus(state.reference, { phase: 'awaiting_confirmation' });
    }
    startWebhookWatch({ reference: state.reference, payment_id: d.id, onTerminal: handleTerminal, onPoll: () => { lastHeartbeat = new Date(); renderConsole(); } });
  } catch (err) {
    lastExpress = { body, httpStatus: 0, data: { error: 'network_error', message: err.message } };
    paintExpressResponse(0, lastExpress.data);
    setStatus('Error', 'error');
    logEvent('POST /v1/payments', err.message, 'api', 'err');
    renderError({ status: 'ERR', message: err.message });
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'error' });
  }
}

/* ── Mount ───────────────────────────────────────────────── */
export function mount() {
  const panel = $('#tk-config');
  if (!panel) return;
  renderRequest();
  events = [];
  lastHeartbeat = null;
  lastSession = null;
  logEvent(`${state.env} session started`, '', 'sys');
  logEvent('toolkit.mount(inline) ok', '', 'app');
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
  // Card on file — "attach customer" is no longer a switch here (the identity
  // chooser owns it); these two still mirror straight into the body.
  $('#tk-savedef')?.addEventListener('change', e => { saveDefault = e.target.checked; renderRequest(); });
  $('#tk-reqcvv')?.addEventListener('change', e => { requireCvv = e.target.checked; renderRequest(); });
  // Express S2S — delegated on the page root (the express slot repaints as
  // tokens land, but the root lives for the whole page).
  $('.tk-checkout')?.addEventListener('click', e => {
    if (e.target.closest('#tk-express-pay')) {
      const slot = e.target.closest('.tk-express');
      if (slot?.dataset.cred) expressPay(slot.dataset.cred);
    }
  });
  // Each wallet is its own on/off switch, independent of the other
  const wireWallet = (id, key) => $(`#${id}`).addEventListener('change', e => {
    wallets[key] = e.target.checked;
    syncControlVisibility();
    renderRequest();
  });
  wireWallet('dc-ap-toggle', 'apple_pay');
  wireWallet('dc-gp-toggle', 'google_pay');
  $('#dc-btn-text').addEventListener('input', e => { custom.btnText = e.target.value || 'Pay Now'; renderRequest(); });
  $('#dc-btn-color').addEventListener('input', e => {
    custom.btnColor = e.target.value;
    $('#dc-btn-color-hex').value = e.target.value;
    renderRequest();
  });
  $('#dc-btn-color-hex').addEventListener('input', e => {
    const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    custom.btnColor = v;
    $('#dc-btn-color').value = v;
    renderRequest();
  });
  $('#dc-own-text').addEventListener('input', e => { custom.ownText = e.target.value || 'Complete purchase'; });
  const wire = (id, obj, key) => $(`#${id}`).addEventListener('change', e => { obj[key] = e.target.value; renderRequest(); });
  wire('dc-ap-color', custom.ap, 'button_color');
  wire('dc-ap-type', custom.ap, 'button_type');
  wire('dc-gp-color', custom.gp, 'button_color');
  wire('dc-gp-type', custom.gp, 'button_type');

  $('#tk-launch').addEventListener('click', launch);
}

// Tokens landing (webhook harvest / list backfill / profile re-key) surface
// the express block without disturbing the rest of the page.
customers.subscribeCustomers(() => {
  if (state.model !== 'toolkit' || state.leftView !== 'client') return;
  refreshIdentityChooser(); // a new card can unlock "Returning" (or a re-key withdraw it)
  const slot = $('#tk-express-slot');
  if (slot) slot.innerHTML = expressHTML();
});
