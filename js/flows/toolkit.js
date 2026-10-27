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
   error screen is driven by the terminal webhook — a TRUSTED one
   (signature-verified, or confirmed via Retrieve Payment; see
   webhooks.js). The toolkit's own failure/expired browser events
   end the payment too, and update the ledger like success does.

   This is the flow to use in LIVE: the card never touches PayBridge
   (own-fields refuses to collect one in live).
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, activeProduct, customerCharge, fxSnapshot, productCta, orderItems } from '../verticals.js';
import { createCheckoutSession, createDirectPayment, newReference } from '../api.js';
import { profileEwallet } from '../profiles.js';
import { clientDetails } from '../client-details.js';
import { renderJSONView } from '../json-view.js';
import { setActiveTab, setStatus, esc } from '../ui.js';
import { startWebhookWatch, setWatchPaymentId } from '../webhooks.js';
import { renderProcessing, render3DS, renderError } from '../screens.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import * as ledger from '../ledger.js';
import * as customers from '../customers.js';
import { identityMode, usesCustomer, refreshIdentityChooser } from '../identity.js';
import { stepRailHTML } from '../steps.js';
import { thumbHTML } from '../site/chrome.js';
import {
  accountPanelHTML, beatCardHTML, customerRequestCardHTML, customerResponseCardHTML,
  fillCustomerSignature, fireCreateCustomer, refreshAccountPanel,
} from '../customer-beat.js';
import {
  productTotalsHTML, fxCardHTML, paymentResponseCardHTML, httpLabel, httpOk,
  amountProblem, bodyAmount, LIVE_GATE_ERRORS, failureStatusText, httpsUrl, sendIdempotent, isUnknownOutcome,
  terminalHandler, cardSaveSlot, pendingCardSave,
} from './shared.js';

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
let lastSessionStatus = 0;    // HTTP status of the POST /v1/checkout that produced lastSession

/* Card on file (non-PCI): the HCP saves the card_*** against the session
   cus_*** — a customer is a PREREQUISITE for saving through this route.
   Whether a customer is attached is now the CUSTOMER's choice, made in the
   shared identity chooser (js/identity.js) rather than by an SE switch here —
   two controls for one decision could contradict each other. The config row
   below reflects it read-only. */
let saveDefault = true;     // custom_elements.save_card_default
let requireCvv = false;     // require_card_cvv (CVV re-entry on saved-card reuse)
const cofSlot = cardSaveSlot(); // snapshot between launch and the trusted terminal event
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

/* Where the hosted page sends the customer afterwards. This site ships its
   own complete/ and cancel/ pages; Rapyd requires https, so:
     1. served over https → this deployment's own pages;
     2. else (http://localhost, file://) → the https deployment named in
        <meta name="paybridge-public-url" content="https://…/"> (index.html);
     3. else the legacy fixed URL, only so the call still validates — NOTE
        rapydtoolkit.com currently 404s (Vercel DEPLOYMENT_NOT_FOUND); set the
        meta tag to fix local runs. */
const LEGACY_RETURN_ORIGIN = 'https://rapydtoolkit.com/';
function publicUrl() {
  try {
    const v = document.querySelector('meta[name="paybridge-public-url"]')?.getAttribute('content')?.trim();
    if (v && new URL(v).protocol === 'https:') return v.endsWith('/') ? v : `${v}/`;
  } catch { /* malformed — ignore */ }
  return null;
}
function returnUrl(page) {
  try {
    if (typeof location !== 'undefined' && location.protocol === 'https:') return new URL(`${page}/`, location.href).href;
    const pub = publicUrl();
    if (pub) return new URL(`${page}/`, pub).href;
  } catch { /* fall through */ }
  return `${LEGACY_RETURN_ORIGIN}${page}`;
}

/* The toolkit script, per environment. Its iframe is the only window the
   custom pay button's postMessage may reach — never '*'. */
const TOOLKIT_SRC = { sandbox: 'https://sandboxcheckouttoolkit.rapyd.net', live: 'https://checkouttoolkit.rapyd.net' };
const toolkitSrc = (env) => (env === 'live' ? TOOLKIT_SRC.live : TOOLKIT_SRC.sandbox);
let launchEnv = 'sandbox';   // env the rendered toolkit was created in
/** The iframe's own origin when it's a Rapyd host, else the toolkit's. */
function toolkitOrigin(iframe) {
  try {
    const o = new URL(iframe.src, location.href).origin;
    if (/^https:\/\/([a-z0-9-]+\.)*rapyd\.net$/i.test(o)) return o;
  } catch { /* srcdoc / about:blank — use the script's origin */ }
  return new URL(toolkitSrc(launchEnv)).origin;
}

/* ── Request body (server-side POST /v1/checkout) ────────── */
function displayBody() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const cofOn = effectiveCof();
  return {
    amount: bodyAmount(p), // raw text while invalid — launch is gated on it
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
    complete_checkout_url: returnUrl('complete'),
    cancel_checkout_url: returnUrl('cancel'),
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
    amount: bodyAmount(p),
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
    <div class="tk-express" data-cred="${esc(c.ref)}">
      <div class="tk-express-head">Express checkout</div>
      <div class="cof-chip active static">
        <span class="cof-chip-brand">${esc(c.brand || 'Card')}</span>
        <span class="cof-chip-num">···· ${esc(c.last4 || '····')}</span>
        <span class="cof-chip-exp">${esc(exp)}</span>
      </div>
      <button type="button" class="co-cta tk-express-pay" id="tk-express-pay"${amountProblem() ? ` disabled title="${esc(amountProblem())}"` : ''}>${esc(productCta())} with saved card</button>
      <div class="tk-express-alt">Or enter a new card on the right.</div>
    </div>`;
}

function summaryHTML() {
  const p = activeProduct();
  // The merchant's name is in the site header above (steps.js stepRailHTML),
  // so the summary opens on the order itself.
  return `
    <aside class="tk-summary">
      ${accountPanelHTML()}
      <div class="tk-sum-label">Your order</div>
      <div class="co-order">
        ${thumbHTML(p)}
        <div class="co-order-info">
          <div class="co-order-name">${esc(p.name)}</div>
          <div class="co-order-desc">${esc(p.desc)}</div>
        </div>
        <button type="button" class="fx-trigger${state.fx.enabled ? ' configured' : ''}" id="fx-trigger" title="Configure currency conversion">FX</button>
      </div>
      <div class="co-totals" id="tk-order-totals">${productTotalsHTML()}</div>
      <div id="tk-express-slot">${expressHTML()}</div>
      <div class="tk-secure">
        <div class="tk-secure-head">🔒 Secure checkout</div>
        <p>Payments are encrypted end-to-end and processed by Rapyd.</p>
        <div class="tk-badges"><span class="b-visa">VISA</span><span class="b-mc">MC</span></div>
      </div>
    </aside>`;
}
/** Repaint the order totals when the FX quote arrives/changes (called by
    app.js refreshCharge via FLOWS[model].refreshSummary). No-op once the
    summary has been swapped for the live iframe. Re-gates the launch button
    too: the amount (an own-fields tile edit carries over) may be invalid. */
export function refreshSummary() {
  const el = $('#tk-order-totals');
  if (el) el.innerHTML = productTotalsHTML();
  refreshLaunchValidity();
}

/** Launch / express are gated on a sendable amount (sync.js validAmount). */
function refreshLaunchValidity() {
  const bad = amountProblem();
  for (const btn of [$('#tk-launch'), $('#tk-express-pay')]) {
    if (!btn || btn.dataset.busy) continue;
    btn.disabled = !!bad;
    btn.title = bad || '';
  }
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

/* The mono slot holds a REAL API field name or nothing at all. Prose in it
   ("chosen on the checkout") reads as a parameter that doesn't exist, which is
   the one thing this panel can't afford — naming the real key is what makes it
   credible (design system §1, §6). */
function row(label, param, control, attrs = '') {
  return `
    <div class="tkc-row" ${attrs}>
      <div class="tkc-lab">${label}${param ? `<code>${param}</code>` : ''}</div>
      ${control}
    </div>`;
}

function configPanelHTML() {
  return `
    <div class="tk-config" id="tk-config">
      <div class="tkc-head"><span class="tkc-title">Toolkit config</span></div>

      <div class="tkc-sec">
        <div class="tkc-sec-label">Integration mode</div>
        ${seg('mode', [['embedded', 'Full toolkit'], ['wallets', 'Wallet buttons'], ['hosted', 'Hosted page']], mode)}
      </div>

      <div class="tkc-sec" id="tkc-paybtn">
        <div class="tkc-sec-label">Payment button</div>
        ${row('Style', 'hide_submit_button', seg('payBtn', [['rapyd', "Rapyd's"], ['custom', 'Custom']], payBtn))}
        ${row('Label', 'pay_button_text', `<input type="text" class="tkc-input" id="dc-btn-text" maxlength="16" value="${esc(custom.btnText)}" placeholder="Pay Now" />`, 'id="tkc-row-label"')}
        ${row('Color', 'pay_button_color', `
          <div class="tkc-colorfield">
            <input type="color" class="tkc-color" id="dc-btn-color" value="${esc(accent())}" />
            <input type="text" class="tkc-input tkc-hex" id="dc-btn-color-hex" maxlength="7" value="${esc(accent())}" placeholder="#5600ef" />
          </div>`, 'id="tkc-row-color"')}
        ${row('Button label', 'pay_button_text', `<input type="text" class="tkc-input" id="dc-own-text" value="${esc(custom.ownText)}" />`, 'id="tkc-row-own" hidden')}
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
        ${row('Identity', '',
          `<span class="tkc-fixed"><code>${identityMode()}</code></span>`)}
        ${row('Save box pre-ticked', 'custom_elements.save_card_default',
          `<label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="tk-savedef" ${saveDefault ? 'checked' : ''} /></label>`, `id="tkc-row-savedef" ${effectiveCof() ? '' : 'hidden'}`)}
        ${row('CVV on reuse', 'require_card_cvv',
          `<label class="tkc-switch-wrap"><input type="checkbox" class="tkc-switch" id="tk-reqcvv" ${requireCvv ? 'checked' : ''} /></label>`, `id="tkc-row-reqcvv" ${effectiveCof() ? '' : 'hidden'}`)}
        ${row('Purpose', 'recurrence_type', `<span class="tkc-fixed"><code>${recurrence()}</code></span>`, `id="tkc-row-rec" ${effectiveCof() ? '' : 'hidden'}`)}
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
  // belongs to the page (the merchant site's header + back link), not to the order.
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
  }) + fxCardHTML() + tkSection;
  fillCustomerSignature();
  fillSignature($('#beat-checkout'), 'post', '/v1/checkout', st, body); // live — recomputes with the body
}

function renderResponse() {
  const el = $('#panel-response');
  if (!el) return;
  const cusCard = customerResponseCardHTML();
  let card = '';
  if (lastSession) {
    // The real status, not a guessed 200/400 — a 401 live-gate refusal and a
    // 504 timeout read very differently.
    const ok = !lastSession.error && httpOk(lastSessionStatus);
    const label = ok ? 'CHECKOUT CREATED' : String(lastSession.error || 'ERROR'); // text — escaped below / by beatCardHTML
    card = beatCardHTML({
      id: 'beat-checkout-res', n: cusCard ? 2 : null, method: 'POST', path: '/v1/checkout',
      badge: label, badgeKind: ok ? 'ok' : 'err',
      inner: `
        <div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">${httpLabel(lastSessionStatus)}</span><span class="wh-pill ${ok ? 'success' : 'failure'}">${esc(label)}</span></div>
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
  const cusCard = customerResponseCardHTML();
  el.innerHTML = cusCard + paymentResponseCardHTML({ id: 'beat-express-res', n: cusCard ? 2 : null, httpStatus, data });
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

// Terminal-style log, tagged like a real dev console: HH:MM:SS  tag  message.
// Messages carry server / toolkit-event text (error messages, ids) — escaped.
const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour12: false });
function logLineHTML(e) {
  return `
    <div class="cl-line">
      <span class="cl-time">${fmtTime(e.at)}</span>
      <span class="cl-tag cl-${esc(e.tag)}">${esc(e.tag)}</span>
      <span class="cl-msg${e.kind ? ` cl-${esc(e.kind)}` : ''}">${esc(e.name)}${e.detail ? ` <span class="cl-detail">${esc(e.detail)}</span>` : ''}</span>
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

/* ── Terminal (trusted webhook or Retrieve) → left screen ─────
   shared.js terminalHandler(): webhooks.js only fires it with a TRUSTED event
   (never PAYMENT_SUCCEEDED, never an unverified webhook). The HCP saved the
   card during this payment — the harvest pulls the card_*** out of the
   completed payment (webhook raw.data, or the retrieve-derived event's), then
   lets the list endpoint backfill expiry etc. */
const cofHooks = {
  onCardSaved: (cardId, ps) => logEvent('card saved', `${cardId} · recurrence ${ps.recurrence_type}`, 'tk', 'ok'),
  onSync: () => logEvent('GET /v1/customers/{id}/payment_methods', 'syncing saved cards', 'api'),
};
const onTerminalFor = (reference) => terminalHandler({ reference, paidLabel: 'Paid', slot: cofSlot, hooks: cofHooks });

/** The toolkit's own failure / expiry events end the payment client-side —
    the ledger has to hear about it like it does a success, or the back office
    shows it pending until its 30-minute window lapses. */
function toolkitEnded(phase) {
  if (!state.reference) return;
  ledger.updateStatus(state.reference, { status: 'failed', phase });
  cofSlot.clear(state.reference);
}

/* ── Toolkit script + render ─────────────────────────────── */
function loadToolkitScript(env) {
  return new Promise(resolve => {
    const url = toolkitSrc(env);
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
    const redirect = httpsUrl(e.detail?.redirect_url);
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
    renderProcessing('Payment received', 'Just a moment while we confirm your payment…');
    ledger.updateStatus(state.reference, { phase: 'awaiting_confirmation' });
  });
  window.addEventListener('onCheckoutPaymentFailure', e => {
    const err = e.detail?.error;
    logEvent('onCheckoutPaymentFailure', (err && (err.message || (typeof err === 'string' ? err : JSON.stringify(err)))) || 'failure', 'tk', 'err');
    setStatus('Failed', 'error');
    renderError({ status: 'ERR', message: 'The payment couldn’t be completed. Please try again.' });
    toolkitEnded('failed');
  });
  window.addEventListener('onCheckoutPaymentExpired', e => {
    logEvent('onCheckoutPaymentExpired', e.detail?.status || 'checkout page expired', 'tk', 'err');
    setStatus('Expired', 'error');
    renderError({ status: 'EXP', message: 'The checkout session expired.' });
    toolkitEnded('expired');
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
const launchLabel = () => (mode === 'hosted' ? 'Create session →' : 'Render toolkit →');

/** A failure launch()/expressPay() didn't anticipate — their click handlers'
    promises would otherwise reject unhandled with the button stuck busy. */
let flowRef = null;         // the reference the in-flight launch/express created — a crash marks only that one
let flowDispatched = false; // its POST went out — from here the session/payment may exist at Rapyd

function flowCrashed(err) {
  console.error('toolkit flow failed:', err);
  // launch() set busy before its first await; a throw before it clears it
  // would leave the button stuck on "Creating session…" (refreshLaunchValidity
  // skips busy buttons). expressPay's own flag is cleared by its finally.
  const btn = $('#tk-launch');
  if (btn) delete btn.dataset.busy;
  try {
    if (btn) btn.textContent = launchLabel();
    refreshLaunchValidity();
  } catch { /* the crash may be in these very helpers — the error UI below still matters */ }
  setStatus('Error', 'error');
  logEvent('client error', err?.message || String(err), 'app', 'err');
  renderError({ status: 'ERR' });
  // Only a request that never left the browser is known to have failed; once
  // dispatched, the ledger poller (by reference) and the armed card-on-file
  // slot are left to settle it. No flowRef = nothing of this click's was armed.
  if (flowRef && !flowDispatched) {
    ledger.updateStatus(flowRef, { status: 'failed', phase: 'error' });
    cofSlot.clear(flowRef);
  }
}

async function launch() {
  const btn = $('#tk-launch');
  if (!btn || btn.dataset.busy) return;
  flowRef = null;
  flowDispatched = false;
  // Amount gate — never send '' (Number('') = 0) or more decimals than the currency has.
  const badAmount = amountProblem();
  if (badAmount) {
    refreshLaunchValidity();
    logEvent('POST /v1/checkout', `not sent — ${badAmount}`, 'api', 'err');
    setStatus('Invalid amount', 'error');
    return;
  }
  btn.disabled = true;
  btn.dataset.busy = '1'; // a double click must not create a second session
  btn.textContent = 'Creating session…';
  setStatus('Creating session…', 'processing');
  events = [];
  lastHeartbeat = null;
  lastSession = null;
  lastSessionStatus = 0;
  lastExpress = null;
  renderConsole();
  const restoreBtn = () => {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.textContent = launchLabel();
  };

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
      renderError({ status: 'ERR', message: 'We couldn’t start your payment. Please try again.' });
      restoreBtn();
      return;
    }
    logEvent('POST /v1/customers', `${customers.getCustomerId()} · created (enriched)`, 'api', 'ok');
  }

  state.reference = newReference(`pb_${state.vertical}_tk`); // unguessable — it's the webhook read key
  const reference = state.reference; // the session this click owns
  flowRef = reference;
  launchEnv = state.env;             // the toolkit script + postMessage origin follow it
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
      credential_label: effectiveCof() ? 'Yes' : null,
      initiation_type: 'customer_present',
      note: p.successNote || v.successNote,
    };
    ledger.recordPayment(reference, {
      model: 'toolkit', vertical: state.vertical, amount: p.amount, currency: p.currency,
      requested_currency: fxOn ? state.fx.requestedCurrency : null, fixed_side: fxOn ? state.fx.fixedSide : null,
      origin: 'client', initiation_type: 'customer_present', profile: state.profile,
      items: orderItems(p),
    });
    // Armed synchronously before the POST — captures this session's reference
    // and customer bucket (env:profile) against a mid-flight profile switch.
    cofSlot.arm(effectiveCof() ? pendingCardSave({
      token: true, recurrence_type: recurrence(), aft: false,
      origin_model: 'toolkit', origin_product: p.id,
    }) : null);
  }
  renderRequest();
  setActiveTab('request');

  // One Idempotency-Key for this launch; an unknown outcome is re-sent once
  // under the same key (shared.js) — a retry can't mint a second session.
  const reqBody = postBody();
  flowDispatched = true;
  const { httpStatus, data } = await sendIdempotent(createCheckoutSession, reqBody, {
    onRetry: (r) => logEvent('POST /v1/checkout', `${httpLabel(r.httpStatus)} — retrying with the same Idempotency-Key`, 'api', 'err'),
  });
  lastSession = data ?? { error: 'NO_BODY', message: 'Empty response' };
  lastSessionStatus = httpStatus;
  delete btn.dataset.busy;
  renderRequest(); // config now shows the real checkout id
  renderResponse();
  setActiveTab('response');
  const id = data?.data?.id;
  const redirect = httpsUrl(data?.data?.redirect_url);

  // api.js never throws: transport failures are httpStatus 0 + NETWORK_ERROR,
  // and the live gate's refusals (LIVE_*) arrive as ordinary errors.
  if (!id || data?.error || !httpOk(httpStatus)) {
    const msg = data?.message || data?.error || 'No checkout id returned';
    setStatus(failureStatusText(data, 'Error'), 'error');
    logEvent('POST /v1/checkout', LIVE_GATE_ERRORS.has(data?.error) ? `${data.error} · ${msg}` : msg, 'api', 'err');
    renderError({ status: data?.error || 'ERR' });
    ledger.updateStatus(reference, { status: 'failed', phase: 'error' });
    cofSlot.clear(reference);
    return;
  }

  logEvent('POST /v1/checkout', `${id} · ${httpStatus}`, 'api', 'ok');
  startWebhookWatch({ reference, onTerminal: onTerminalFor(reference), onPoll: () => { lastHeartbeat = new Date(); renderConsole(); } });

  // Only #tk-area is replaced below, so the summary column survives the
  // launch — including its profile row. Refresh it, or the row painted before
  // the session was created sits beside the live iframe for the whole payment.
  refreshAccountPanel();

  const area = $('#tk-area');
  if (!area) return; // the page was reset while the session was being created
  if (mode === 'hosted') {
    setStatus('Redirect ready', 'action');
    area.innerHTML = `
      <div class="tk-redirect">
        <div class="tk-redirect-title">Ready to pay</div>
        <div class="tk-redirect-desc">You’ll finish paying on a secure payment page, then come back here.</div>
        <button class="co-cta" id="tk-open"${redirect ? '' : ' disabled title="No https redirect_url in the response"'}>Continue to payment ↗</button>
      </div>`;
    $('#tk-open').addEventListener('click', () => { if (redirect) window.open(redirect, '_blank', 'noopener'); });
  } else {
    await loadToolkitScript(launchEnv);
    if (state.reference !== reference || !$('#tk-area')) return; // reset while the script loaded
    // The page shape stays put — the config panel swaps for the iframe.
    const ownBtn = payBtn === 'custom' && mode !== 'wallets'
      ? `<button class="co-cta" id="tk-own-pay" style="background:${esc(accent())}">${esc(custom.ownText)}</button>`
      : '';
    $('#tk-area').innerHTML = `<div id="rapyd-checkout"></div>${ownBtn}`;
    $('#tk-own-pay')?.addEventListener('click', () => {
      const iframe = document.querySelector('#rapyd-checkout iframe');
      if (!iframe?.contentWindow) return;
      // Addressed to the toolkit's origin only — '*' would hand the message
      // to whatever document the frame happened to be showing.
      iframe.contentWindow.postMessage({ type: 'CHECKOUT_SUBMIT_PAYMENT' }, toolkitOrigin(iframe));
      logEvent('CHECKOUT_SUBMIT_PAYMENT', 'postMessage from custom button', 'tk', 'action');
      // NOT removed here — the toolkit may reject the submit (required-field
      // validation). It leaves once the payment is accepted for authorisation
      // (onCheckoutPaymentPending / onCheckoutPaymentSuccess).
    });
    renderToolkit(id);
    setStatus('Toolkit rendered', 'processing');
    setActiveTab('console');
  }
}

/* ── Express S2S token charge ────────────────────────────── */
let expressBusy = false; // a double click must not fire a second charge

async function expressPay(credRef) {
  if (expressBusy) return;
  const cred = customers.getCredential(credRef);
  if (!cred || !cred.card_id) return;
  const badAmount = amountProblem();
  if (badAmount) {
    refreshLaunchValidity();
    logEvent('POST /v1/payments', `not sent — ${badAmount}`, 'api', 'err');
    setStatus('Invalid amount', 'error');
    return;
  }
  expressBusy = true;
  flowRef = null;
  flowDispatched = false;
  try {
    await expressCharge(cred);
  } finally {
    expressBusy = false;
  }
}

async function expressCharge(cred) {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  setStatus('Processing…', 'processing');
  state.reference = newReference(`pb_${state.vertical}_xp`);
  const reference = state.reference;
  flowRef = reference;
  const body = expressBody(cred);
  body.merchant_reference_id = reference;

  const fxOn = state.fx.enabled && state.fx.requestedCurrency;
  const charge = customerCharge();
  state.lastPayment = {
    descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency,
    last4: cred.last4, network: cred.brand, fx: fxSnapshot(),
    customer_id: customers.getCustomerId(),
    initiation_type: 'customer_present',
    aft: !!p.aft, is_direct_purchase: p.aft ? true : null,
    note: p.successNote || v.successNote,
  };
  ledger.recordPayment(reference, {
    model: 'toolkit', vertical: state.vertical, amount: p.amount, currency: p.currency,
    requested_currency: fxOn ? state.fx.requestedCurrency : null, fixed_side: fxOn ? state.fx.fixedSide : null,
    last4: cred.last4, brand: cred.brand,
    origin: 'client', initiation_type: 'customer_present', profile: state.profile,
    credential: { kind: 'token', label: `${cred.brand} ···${cred.last4}` },
    aft: !!p.aft,
    items: orderItems(p),
  });
  cofSlot.clear(); // a token reuse saves nothing — no stale launch save may harvest from it

  lastExpress = { body, httpStatus: null, data: null };
  paintExpressRequest(body);
  setActiveTab('request');
  logEvent('POST /v1/payments', `express · ${cred.card_id}`, 'api');
  renderProcessing('Charging your saved card…', 'No card details needed — we’ll use the card you saved.');

  flowDispatched = true;
  const { httpStatus, data } = await sendIdempotent(createDirectPayment, { ...body, env: state.env, profile: state.profile }, {
    onRetry: (r) => logEvent('POST /v1/payments', `${httpLabel(r.httpStatus)} — retrying with the same Idempotency-Key`, 'api', 'err'),
  });
  lastExpress = { body, httpStatus, data };
  paintExpressResponse(httpStatus, data);
  setActiveTab('response');
  const d = data?.data;
  // Still no answer after the same-key retry: the card_*** charge may exist —
  // not a decline. Leave it pending and let the watch settle it (own-fields).
  if (isUnknownOutcome(httpStatus)) {
    setStatus('Outcome unknown · confirming', 'processing');
    logEvent('POST /v1/payments', `${httpLabel(httpStatus)} — outcome unknown, confirming via webhook / Retrieve Payment`, 'api', 'err');
    renderProcessing('Confirming payment…', 'We didn’t hear back in time — checking whether your payment went through. Please don’t pay again.');
    ledger.updateStatus(reference, { phase: 'unconfirmed' });
    startWebhookWatch({ reference, onTerminal: onTerminalFor(reference), onPoll: () => { lastHeartbeat = new Date(); renderConsole(); } });
    return;
  }
  // api.js never throws — httpStatus 0 + NETWORK_ERROR is the transport failure.
  if (!d || data?.error || !httpOk(httpStatus)) {
    setStatus(failureStatusText(data, httpStatus === 0 ? 'Error' : 'Declined'), 'error');
    logEvent('POST /v1/payments', data?.message || data?.error || 'declined', 'api', 'err');
    renderError({ status: data?.error || 'ERR' });
    ledger.updateStatus(reference, { status: 'failed', phase: httpStatus === 0 ? 'error' : 'declined' });
    return;
  }
  ledger.setPaymentId(reference, d.id);
  logEvent('POST /v1/payments', `${d.id} · ${d.status}`, 'api', 'ok');
  if (d.status === 'ACT' && d.next_action === '3d_verification') {
    setStatus('3DS challenge', 'action');
    render3DS(httpsUrl(d.redirect_url) || 'about:blank');
    ledger.updateStatus(reference, { phase: 'pending_3ds' });
  } else {
    setStatus('Confirming…', 'processing');
    renderProcessing('Payment received', 'Just a moment while we confirm your payment…');
    ledger.updateStatus(reference, { phase: 'awaiting_confirmation' });
  }
  startWebhookWatch({ reference, payment_id: d.id, onTerminal: onTerminalFor(reference), onPoll: () => { lastHeartbeat = new Date(); renderConsole(); } });
}

/* ── Mount ───────────────────────────────────────────────── */
export function mount() {
  const panel = $('#tk-config');
  if (!panel) return;
  renderRequest();
  events = [];
  lastHeartbeat = null;
  lastSession = null;
  lastSessionStatus = 0;
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
      if (slot?.dataset.cred) expressPay(slot.dataset.cred).catch(flowCrashed);
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

  $('#tk-launch').addEventListener('click', () => { launch().catch(flowCrashed); });
  refreshLaunchValidity();
}

// Tokens landing (webhook harvest / list backfill / profile re-key) surface
// the express block without disturbing the rest of the page.
customers.subscribeCustomers(() => {
  if (state.model !== 'toolkit' || state.leftView !== 'client') return;
  refreshIdentityChooser(); // a new card can unlock "Returning" (or a re-key withdraw it)
  const slot = $('#tk-express-slot');
  if (slot) slot.innerHTML = expressHTML();
});
