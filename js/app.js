/* ─────────────────────────────────────────────────────────────
   Rapyd Demo — bootstrap: the shell, the price tile + FX, the
   demo-controls drawer, the live gate and the render orchestration.
   ───────────────────────────────────────────────────────────── */

import { VERTICALS, VERTICAL_ORDER, activeProduct, pricedProduct, customerCharge, fxQuoteKey, chargeText, productCta, setFxBeat } from './verticals.js';
import { PROFILES, PROFILE_ORDER, activeProfile } from './profiles.js';
import { applySkin } from './skins.js';
import { PACKS } from './packs.js';
import { accountPanelHTML, syncCustomerBeat, setPanelRepainter, setHighlightHook } from './customer-beat.js';
import {
  frameHTML, stepRailHTML, isCheckout, renderStepPanels, resetSteps, setClientRepainter,
} from './steps.js';
import * as customers from './customers.js';
import { fireMethodsSync } from './site/account.js';
import { state, setState, subscribe } from './state.js';
import { setActiveTab, setStatus, esc } from './ui.js';
import { clearPaymentWatch, repaintWebhooks } from './webhooks.js';
import { formatAmount, validAmount, currencyDecimals } from './sync.js';
import { getFxRate, getLiveToken, setLiveToken } from './api.js';
import { redactKey } from './signing.js';
import * as ownFields from './flows/own-fields.js';
import * as toolkit from './flows/toolkit.js';
import * as backOffice from './flows/back-office.js';
import { totalsHTML } from './flows/shared.js';
import { thumbHTML } from './site/chrome.js';
import { SEAM_PATHS, seamPathKey, seamLinesHTML, seamStripHTML, setAddress, pagePath, isSeamOn, setSeamOn, applySeam } from './seam.js';
import { EXT3DS_OUTCOMES, ext3dsPreset, setExt3dsPreset } from './ext3ds.js';

// Patch keys that mean "the customer's flow/context actually changed" —
// only these trigger the full client-flow reset (mount() etc). Everything
// else (leftView toggling, ledger updates, in-flow bookkeeping) must be able
// to re-render its own surface without disturbing an in-progress checkout.
const RESET_KEYS = ['vertical', 'model', 'env'];

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FLOWS = { 'own-fields': ownFields, 'toolkit': toolkit };

// The path's own description (and its seam: who hosts what, PCI scope,
// redirects) comes from js/seam.js — one copy, shared with the engine room.
const seamKey = () => seamPathKey(state.model, toolkit.toolkitMode());
// The MID's 3DS provider, for the seam's 3DS line — sandbox only (live has no
// profile, and Own Card Fields are off there).
const seamOpts = () => ({ tds: state.env === 'sandbox' ? activeProfile().tds : null });
// Shown INSTEAD of the seam summary in live, so the restriction is on screen, not
// just in the SE's head (kept short — the sub-bar is one line). Own fields:
// the backend refuses raw card data in live (LIVE_RAW_CARD_FORBIDDEN).
const LIVE_DESC = {
  'own-fields': 'LIVE · restricted — raw card numbers are refused; 0.01 charges only.',
  'toolkit':    'LIVE · restricted — charges a real card; 0.01 charges only.',
};

// The checkout's editable price tile + the drawer's FX controls — shared
// curated list for both the tile's charge currency and FX's
// requested_currency (they mutually exclude each other's current value).
const CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD'];

/* ── Price tile + FX controls ────────────────────────────────
   The tile is the single editable source of truth for amount/currency
   (state.productOverride); the FX controls — in the demo-controls drawer's
   Payment behaviour section, opened from the tile's FX badge — configure
   settlement FX (state.fx). Both are plain data mutated directly — see
   state.js. Order totals: flows/shared.js totalsHTML(c, feeLabel, feeValue,
   perMonth) — the one (fully escaped) copy, shared with the flows. */
function ensureFxCurrencyValid() {
  const options = CURRENCIES.filter(c => c !== activeProduct().currency);
  if (!options.includes(state.fx.requestedCurrency)) state.fx.requestedCurrency = options[0];
}
function fxSectionHTML() {
  const fx = state.fx;
  // requested_currency is always the FLOATING side. Under 'sell' the customer's
  // charge is fixed and the merchant's payout floats → it's what you receive;
  // under 'buy' the payout is fixed and the customer's charge floats → it's the
  // currency the customer pays. Label it for whichever side it actually is.
  const reqLabel = fx.fixedSide === 'buy' ? 'Currency the customer pays' : 'Currency you receive';
  return `
    <div class="dc-card">
      <div class="dc-card-head">
        <span class="dc-card-title">Currency conversion</span>
        <label class="dc-switch"><input type="checkbox" id="fx-enable" ${fx.enabled ? 'checked' : ''} /><span class="sr">Enable FX</span></label>
      </div>
      <code class="dc-params">requested_currency · fixed_side · expiration</code>
      <div class="dc-fx" id="fx-body" ${fx.enabled ? '' : 'hidden'}>
        <div class="dc-field">
          <div class="dc-label">${reqLabel}</div>
          <button type="button" class="cur-trigger dc-select" id="fx-currency">${esc(fx.requestedCurrency || '')}<span class="cur-caret">▾</span></button>
        </div>
        <div class="dc-field">
          <div class="dc-label">Who bears the FX</div>
          <div class="dc-seg" id="fx-side">
            <button type="button" data-val="sell" class="${fx.fixedSide === 'sell' ? 'active' : ''}">You (merchant)</button>
            <button type="button" data-val="buy" class="${fx.fixedSide === 'buy' ? 'active' : ''}">Customer</button>
          </div>
        </div>
        <div class="fx-preview" id="fx-preview" aria-live="polite"></div>
      </div>
    </div>`;
}

/* ── Live FX + customer-charge sync ──────────────────────────
   FX drives more than the drawer: the whole customer-facing checkout (totals
   + pay button, and the toolkit summary) must show what the customer ACTUALLY
   pays, never the stale base. One live Rapyd fx_rates quote — cached on
   state.fx.quote, read by verticals.js customerCharge()/merchantReceive() —
   feeds every surface. The tile's amount/currency is always the base (Rapyd's
   `amount` is in units of `currency`); requested_currency is the other side;
   fixed_side picks who's fixed ('sell' fixes the customer's charge, 'buy' the
   merchant's payout). Rapyd's buy_ side = merchant funds, sell_ = customer.
   syncFx() repaints from the current quote and fetches when it's missing/stale
   — it runs on every edit AND on render, so a pre-enabled (cross-flow) FX
   config resolves even if the drawer is never opened. */
let fxSeq = 0;
let fxTimer = null;

function fxRequestParams() {
  const p = activeProduct();
  const cur = p.currency, req = state.fx.requestedCurrency, side = state.fx.fixedSide;
  return {
    buyCurrency:  side === 'buy'  ? cur : req,  // Rapyd buy side = merchant funds
    sellCurrency: side === 'sell' ? cur : req,  // sell side = customer funds
    amount: p.amount,                            // always in `currency` = fixed side
    fixedSide: side,
    env: state.env,
  };
}
function fxPreviewHTML(q) {
  const customerFixed = state.fx.fixedSide === 'sell'; // customer's charge is the fixed side
  const row = (label, c, fixed) =>
    `<div class="fx-preview-row"><span>${label}</span><span class="${fixed ? 'fixed' : 'vary'}">${esc(chargeText({ ...c, approx: !fixed }))}</span></div>`;
  return `
    ${row('Customer pays', { amount: q.sellAmount, currency: q.sellCurrency }, customerFixed)}
    ${row('You receive', { amount: q.buyAmount, currency: q.buyCurrency }, !customerFixed)}
    <div class="fx-preview-rate">Rate ${esc(Number(q.rate).toFixed(4))} · <span class="guar">${customerFixed ? 'customer amount guaranteed' : 'your payout guaranteed'}</span></div>`;
}
function renderFxPreview() {
  const el = $('#fx-preview');
  if (!el) return;
  if (!state.fx.enabled || !state.fx.requestedCurrency) { el.innerHTML = ''; return; }
  // Configurable from the drawer on any page, but the rate is only quoted
  // where there's a price on screen to quote it for (maybeFetchFxQuote).
  if (!isCheckout()) { el.innerHTML = `<div class="fx-preview-note">The live rate is quoted on the checkout page.</div>`; return; }
  const q = state.fx.quote;
  if (q && q.key === fxQuoteKey()) {
    el.innerHTML = q.error
      ? `<div class="fx-preview-note err">Live rate unavailable right now.</div>`
      : fxPreviewHTML(q);
  } else {
    el.innerHTML = `<div class="fx-preview-note">Fetching live rate…</div>`;
  }
}
function maybeFetchFxQuote() {
  if (!state.fx.enabled || !state.fx.requestedCurrency) return;
  if (!isCheckout()) return; // no price on screen — the checkout fetches on render
  const key = fxQuoteKey();
  if (state.fx.quote && state.fx.quote.key === key) return; // already fresh
  const p = activeProduct();
  if (!(Number(p.amount) > 0) || p.currency === state.fx.requestedCurrency) return;
  const params = fxRequestParams();
  const seq = ++fxSeq;
  clearTimeout(fxTimer);
  fxTimer = setTimeout(async () => {
    const resp = await getFxRate(params); // never throws — a dead network is httpStatus 0
    if (seq !== fxSeq) return; // superseded by a newer edit
    const d = resp?.data?.data;
    state.fx.quote = (resp?.ok && d && d.buy_amount != null && d.sell_amount != null)
      ? { key, sellAmount: d.sell_amount, sellCurrency: d.sell_currency, buyAmount: d.buy_amount, buyCurrency: d.buy_currency, rate: d.rate }
      : { key, error: true };
    renderFxPreview();
    refreshCharge();
    // This was the one Rapyd call with NO engine-room surface: its whole UI was
    // the FX preview. Record it so the flows can show it as a
    // card like every other beat — the SE can point at the rate they quoted.
    setFxBeat({ params, httpStatus: resp?.httpStatus ?? 0, data: resp?.data ?? null });
    FLOWS[state.model].refreshRightPanel?.();
  }, 250);
}
// Single entry point: repaint the FX preview + the checkout charge from
// the current quote, then fetch if the quote is missing/stale for this config.
function syncFx() {
  // Keep requested_currency != base even when the drawer is closed (a vertical
  // switch can leave them equal), so the charge never gets stuck "pending".
  ensureFxCurrencyValid();
  renderFxPreview();
  refreshCharge();
  maybeFetchFxQuote();
}
// Repaint every customer-facing "what you pay" figure from customerCharge().
// own-fields' totals/pay button live in the shared shell (#order-totals /
// #pay-btn); the toolkit flow owns its summary, repainted via refreshSummary().
function refreshCharge() {
  const c = customerCharge();
  const p = activeProduct();
  const sub = p.billing === 'subscription';
  const totalsEl = $('#order-totals');
  if (totalsEl) totalsEl.innerHTML = totalsHTML(c, p.delivery ? 'Delivery' : 'Fees', p.delivery || 'Free', sub);
  const payBtn = $('#pay-btn');
  if (payBtn) payBtn.textContent = `${productCta()} ${chargeText(c)}${sub ? ' /mo' : ''}`;
  syncAmountGate();
  FLOWS[state.model].refreshSummary?.();
}
/* Keep #pay-btn disabled while the tile holds an invalid amount (F13). The
   flow owns the button's card-validity gating, so this only ever ADDS a block
   and, when the amount is fixed, hands control back: to the flow's own
   refreshPayValidity() when it exports one, else to the disabled state the
   button had before the block. The flows also check state.amountInvalid in
   pay() — this is the visible half, not the only guard. */
function syncAmountGate() {
  const btn = $('#pay-btn');
  if (!btn) return;
  if (state.amountInvalid) {
    if (!btn.dataset.amountBlocked) btn.dataset.amountBlocked = btn.disabled ? 'was-disabled' : 'was-enabled';
    btn.disabled = true;
    return;
  }
  const was = btn.dataset.amountBlocked;
  if (!was) return;
  delete btn.dataset.amountBlocked;
  const flow = FLOWS[state.model];
  if (flow.refreshPayValidity) flow.refreshPayValidity();
  else btn.disabled = was === 'was-disabled';
}
/* ── Self-designed currency picker (portal) ──────────────────
   Replaces native <select> for both the tile's currency and the drawer's FX
   requested_currency — a native select's open dropdown list is
   OS-rendered and can't be themed to match the demo's design language.
   One portal element is shared by both triggers; curDropdownTarget tracks
   which one currently owns it. */
let curDropdownTarget = null;   // 'tile' | 'fx' | null
let curDropdownTriggerEl = null;

function curDropdownOptions() {
  return curDropdownTarget === 'tile'
    ? CURRENCIES
    : CURRENCIES.filter(c => c !== activeProduct().currency);
}
function curDropdownCurrent() {
  return curDropdownTarget === 'tile' ? activeProduct().currency : state.fx.requestedCurrency;
}
function renderCurDropdown() {
  const current = curDropdownCurrent();
  $('#cur-dropdown').innerHTML = curDropdownOptions()
    .map(c => `<button type="button" class="cur-opt ${c === current ? 'active' : ''}" data-val="${c}">${c}</button>`)
    .join('');
}
function positionCurDropdown(trigger) {
  const el = $('#cur-dropdown');
  const rect = trigger.getBoundingClientRect();
  const top = Math.min(rect.bottom + 6, window.innerHeight - el.offsetHeight - 12);
  el.style.top = `${Math.max(12, top)}px`;
  el.style.left = `${Math.min(rect.left, window.innerWidth - el.offsetWidth - 12)}px`;
}
function toggleCurDropdown(target, trigger) {
  const el = $('#cur-dropdown');
  if (!el.hidden && curDropdownTriggerEl === trigger) { closeCurDropdown(); return; }
  closeCurDropdown();
  curDropdownTarget = target;
  curDropdownTriggerEl = trigger;
  renderCurDropdown();
  el.hidden = false;
  trigger.classList.add('active');
  positionCurDropdown(trigger);
}
function closeCurDropdown() {
  $('#cur-dropdown').hidden = true;
  curDropdownTriggerEl?.classList.remove('active');
  curDropdownTarget = null;
  curDropdownTriggerEl = null;
}
function selectCurrency(val) {
  if (curDropdownTarget === 'tile') {
    commitTileEdit(val);
  } else if (curDropdownTarget === 'fx') {
    state.fx.requestedCurrency = val;
    refreshAfterEdit();
  }
  closeCurDropdown();
}
// Re-syncs everything that reads activeProduct()/state.fx after a tile or
// FX edit — never touches the tile's own input DOM (that would disrupt an
// actively-typing cursor) or the card fields.
function refreshAfterEdit() {
  syncFx();       // repaint the charge + (re)fetch a quote for the new config
  renderDrawer(); // the FX controls' labels/options follow (no-op when closed)
  syncFxTrigger();
  // The FX config lives in the payment body — repaint it only where the flow
  // owns the engine room (the checkout); other pages keep their own panels.
  if (isCheckout()) FLOWS[state.model].refreshRightPanel?.();
}
// The FX corner badge carries a persistent "configured" tint whenever FX is
// enabled, so it reads as switched-on at a glance with the drawer closed. Shared by both flows — the badge lives on whichever price tile the
// active flow rendered into #checkout.
function syncFxTrigger() {
  $('#fx-trigger')?.classList.toggle('configured', !!state.fx.enabled);
}
function commitTileEdit(currencyOverride) {
  const amountEl = $('#tile-amount');
  const currencyBtn = $('#tile-currency');
  if (!amountEl || !currencyBtn) return;
  const filtered = formatAmount(amountEl.value);
  if (filtered !== amountEl.value) amountEl.value = filtered;
  // The button's clean currency code lives in data-currency, not textContent
  // (textContent also includes the caret glyph — see the button's markup).
  const currency = currencyOverride || currencyBtn.dataset.currency;
  if (currencyOverride) {
    currencyBtn.dataset.currency = currencyOverride;
    currencyBtn.innerHTML = `${esc(currencyOverride)}<span class="cur-caret">▾</span>`;
  }
  // F13: blank, "0", or more decimals than the currency allows ("149.999")
  // never reach state. The tile keeps what was typed — flagged — while
  // productOverride keeps the last VALID amount, so every request body (in
  // either flow; the override isn't per-model) stays sendable. In live the
  // tile is read-only and shows the 0.01 clamp, so a currency pick there keeps
  // the pre-clamp price (pricedProduct) rather than storing '0.01'.
  const live = state.env === 'live';
  const valid = live || validAmount(filtered, currency);
  const amount = valid && !live ? filtered : pricedProduct().amount;
  state.amountInvalid = !valid;
  setTileValidity(amountEl, valid, currency);
  // keyed by product too — an edited price never leaks onto a sibling product
  state.productOverride = { vertical: state.vertical, productId: activeProduct().id, amount, currency };
  refreshAfterEdit();
}
function setTileValidity(amountEl, valid, currency) {
  amountEl.classList.toggle('input-invalid', !valid);
  amountEl.setAttribute('aria-invalid', valid ? 'false' : 'true');
  amountEl.title = valid
    ? 'Click to edit the charged amount'
    : `Enter an amount above 0 with at most ${decimalsText(currencyDecimals(currency))} for ${currency} — Pay stays disabled until then`;
}
const decimalsText = (n) => (n === 0 ? 'no decimals' : n === 1 ? '1 decimal' : `${n} decimals`);

/* ── Left: the client page ────────────────────────────────────
   The merchant site (js/steps.js routes it, js/site/ draws it). Every page but
   the checkout is model-independent — signing in, the shop and the bag belong
   to the client, not to the integration — so only the checkout forks per flow.
   `.site` on the frame gives the whole site one width and lets its header run
   edge to edge; the 3DS/toolkit width classes still win where they apply. */
function renderCheckout() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const flow = FLOWS[state.model];
  const host = $('#checkout');

  closeCurDropdown();
  // The tile is about to be rebuilt from activeProduct() — always a valid
  // amount — so any invalid draft the SE left in the old one is gone with it.
  state.amountInvalid = false;

  // Clear out-of-window annotations (bank-app view) on any re-render.
  const off = $('#offstage');
  off.innerHTML = '';
  off.hidden = true;

  // Every site page is on the merchant's domain — the hosted flow moves the
  // address to Rapyd's (and back) itself (js/seam.js).
  setAddress(v.domain, pagePath(state.step));

  if (!isCheckout()) {
    host.innerHTML = frameHTML();
    $('.browser').classList.remove('wide-tk', 'wide-3ds');
    $('.browser').classList.add('site');
    // No pay region exists on these frames: flow.mount() would wire #pay-btn
    // (a bare addEventListener) and syncFx() would fetch a quote for a price
    // that isn't on screen. Neither runs until the checkout frame.
    renderStepPanels();
    syncCustomerBeat();
    return;
  }

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
    // The site header + "Back to bag", then the checkout column. The order row
    // is the BAG folded into one product (verticals.js activeProduct): the item
    // itself for a single line, "3 items" + their names for more.
    host.innerHTML = `
      ${stepRailHTML()}
      <main class="site-main site-narrow">
      <h1 class="site-h1 co-h1">Checkout</h1>
      <div class="co-tagline"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>${esc(v.headline.toUpperCase())}</div>

      ${accountPanelHTML()}

      <div class="co-order">
        ${thumbHTML(p)}
        <div class="co-order-info">
          <div class="co-order-name">${esc(p.name)}</div>
          <div class="co-order-desc">${esc(p.desc)}</div>
        </div>
        <div class="co-order-price">
          ${state.env === 'live'
            // Live clamps every charge to 0.01 (activeProduct), so an editable
            // amount would be a control that does nothing.
            ? `<input type="text" class="tile-field tile-amount" id="tile-amount" value="${esc(p.amount)}" readonly title="Live charges are fixed at 0.01" />`
            : `<input type="text" inputmode="decimal" class="tile-field tile-amount" id="tile-amount" value="${esc(p.amount)}" aria-invalid="false" title="Click to edit the charged amount" />`}
          <button type="button" class="tile-field tile-currency cur-trigger" id="tile-currency" data-currency="${esc(p.currency)}" title="Click to edit the charge currency">${esc(p.currency)}<span class="cur-caret">▾</span></button>
        </div>
        <button type="button" class="fx-trigger${state.fx.enabled ? ' configured' : ''}" id="fx-trigger" title="Configure currency conversion">FX</button>
      </div>

      <div class="co-totals" id="order-totals">${totalsHTML(customerCharge(), feeLabel, feeValue, p.billing === 'subscription')}</div>

      ${payLabel}
      <div id="pay-region">${flow.renderPaymentHTML()}</div>
      </main>`;
  }

  // width classes (JS-toggled; see main.css note on :has())
  const browser = $('.browser');
  browser.classList.toggle('wide-tk', !!flow.renderPageHTML);
  browser.classList.remove('wide-3ds');
  browser.classList.add('site');

  flow.mount();
  // The webhook panel's customer section tracks the identity mode (guest has no
  // beat) and the active MID — a mode switch re-renders through here.
  syncCustomerBeat();
  // Resolve the customer charge now (fetches a quote if FX is already on from a
  // prior flow/session) so the freshly-rendered totals aren't left stale.
  syncFx();
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

/* ── Left-pane tabs (Client Site / Back Office) ───────
   Toggling this NEVER touches the client flow's DOM — it only shows/hides
   already-rendered sections, so an in-progress checkout (e.g. mid-3DS)
   resumes exactly where it was when the SE switches back. */
function toggleLeftView() {
  const isBackoffice = state.leftView === 'backoffice';
  $$('.left-tab').forEach(b => b.classList.toggle('active', b.dataset.view === state.leftView));
  $('.browser').hidden = isBackoffice;
  $('#offstage').hidden = isBackoffice || !$('#offstage').innerHTML;
  $('#backoffice').hidden = !isBackoffice;
  if (isBackoffice) backOffice.render();
  // Back office may have repainted the right panel's Request/Response while
  // the SE was away — repaint them from the client page's own persisted
  // state on the way back (webhooks.js already guards its own panel).
  else if (isCheckout()) FLOWS[state.model].refreshRightPanel?.();
  // Any other page is cheap and stateless to redraw — and must be, if the
  // SE switched credentials or forgot the customer from the back office.
  else renderCheckout();
}

/* ── Demo-controls drawer ─────────────────────────────────────
   ONE drawer for every SE control, toggled by the ` key (ignored while
   typing) or the header button; Esc closes it. Four sections:

     Customer          · whose site — the skin (state.vertical)
     Integration path  · Own Card Fields / Checkout Toolkit (state.model) and
                         the toolkit's mode (full toolkit / wallets / hosted)
     Account           · Sandbox / Live (the live-token dialog gates Live),
                         the SC1–SC3 credential picker with its feature
                         badges, the MID's 3DS provider (fixed by the MID;
                         for an external provider, its simulated answer)
                         and the remembered customer
     Payment behaviour · FX (state.fx) and the stored-credential strategy

   It only RE-HOMES controls that already existed (the old header pills, the
   env switch + credential popover, the model sub-bar, the FX and strategy
   popovers); every handler below keeps the old semantics: skin/model/env are
   RESET_KEYS (setState), everything else is a direct mutation plus targeted
   repaints so an in-flight checkout survives. The drawer's body is rebuilt
   from state on every change (renderDrawer); listeners are delegated once on
   the stable #demo-drawer element. */
let drawerOpen = false;

const SECTION_IDS = { customer: 'dc-sec-customer', path: 'dc-sec-path', account: 'dc-sec-account', behaviour: 'dc-sec-behaviour' };

/* "E-commerce · Home & living", or just "Crypto" when the two agree. */
function industryLabel(v) {
  const pack = PACKS[v.pack]?.label;
  return pack && pack !== v.label ? `${v.label} · ${pack}` : v.label;
}

function skinCardsHTML() {
  return VERTICAL_ORDER.map(id => {
    const v = VERTICALS[id];
    const on = id === state.vertical;
    return `
      <button type="button" class="dc-option ${on ? 'active' : ''}" data-vertical="${esc(id)}" aria-pressed="${on}">
        <span class="dc-radio"></span>
        <span class="dc-option-main">
          <span class="dc-option-title">${esc(v.merchant)}</span>
          <span class="dc-option-sub">${esc(industryLabel(v))}</span>
        </span>
        <span class="dc-option-tag">${esc(v.domain)}</span>
      </button>`;
  }).join('');
}

function pathHTML() {
  const live = state.env === 'live';
  const seg = (val, label, tag) =>
    `<button type="button" data-model="${val}" class="${state.model === val ? 'active' : ''}"><span class="dc-seg-tag">${tag}</span>${label}</button>`;
  const key = seamKey();
  // The toolkit's PCI tag doesn't depend on its mode (all three are SAQ A).
  return `
    <div class="dc-seg dc-seg-lg" id="dc-model">
      ${seg('own-fields', 'Own Card Fields', esc(SEAM_PATHS['own-fields'].tag))}
      ${seg('toolkit', 'Checkout Toolkit', esc(SEAM_PATHS.embedded.tag))}
    </div>
    <p class="dc-note ${live ? 'warn' : ''}">${esc(live ? LIVE_DESC[state.model] : SEAM_PATHS[key].summary)}</p>
    ${state.model === 'toolkit' ? `
      <div class="dc-field">
        <div class="dc-label">Toolkit mode<code>integration_mode</code></div>
        <div class="dc-seg" id="dc-tkmode">
          ${toolkit.TOOLKIT_MODES.map(([val, label]) => `<button type="button" data-val="${val}" class="${toolkit.toolkitMode() === val ? 'active' : ''}">${label}</button>`).join('')}
        </div>
      </div>` : ''}
    <div class="dc-card dc-seam">
      <div class="dc-card-head">
        <span class="dc-card-title">Show seam</span>
        <label class="dc-switch"><input type="checkbox" id="dc-seam" ${isSeamOn() ? 'checked' : ''} /><span class="sr">Show seam</span></label>
      </div>
      <p class="dc-note">Outlines where Rapyd begins inside the site — turn off for a clean customer view.</p>
      ${seamLinesHTML(key, seamOpts())}
    </div>`;
}

function credRowsHTML() {
  return PROFILE_ORDER.map(id => {
    const pf = PROFILES[id];
    const active = id === state.profile;
    // Redacted everywhere — the full key is a public identifier, but nothing
    // on screen needs more than the design-system form.
    return `<button type="button" class="dc-option cred-row ${active ? 'active' : ''}" data-profile="${esc(id)}" aria-pressed="${active}">
      <span class="dc-radio"></span>
      <span class="dc-option-main">
        <span class="dc-option-title mono">${esc(id)}</span>
        <span class="dc-option-sub">3DS ${pf.tds === 'rapyd' ? 'Rapyd' : 'External'} · <span class="mono">${esc(redactKey(pf.access_key))}</span></span>
      </span>
      <span class="cred-flags">
        <span class="cred-flag ${pf.aft ? 'on' : 'off'}">AFT ${pf.aft ? '✓' : '✗'}</span>
        <span class="cred-flag ${pf.nrid ? 'on' : 'off'}">NRID ${pf.nrid ? '✓' : '✗'}</span>
      </span>
    </button>`;
  }).join('');
}

/* The MID's 3-D Secure provider. The PROVIDER is the MID's real configuration
   (profiles.js, mirrored from the backend) — it isn't switchable here, because
   forcing "external" onto a Rapyd-3DS MID (or the reverse) would show a flow
   that MID can't actually run. What the SE CAN choose is what the simulated
   external provider answers (js/ext3ds.js), so the run is preset before the
   room; Rapyd-3DS MIDs keep the checkout's own "Require 3-D Secure" box. */
function tdsCardHTML(pf) {
  const ext = pf.tds === 'external';
  const own = state.model === 'own-fields';
  const outcome = ext3dsPreset();
  return `
    <div class="dc-card dc-tds">
      <div class="dc-card-head">
        <span class="dc-card-title">3-D Secure provider</span>
        <span class="dc-pill ${ext ? '' : 'accent'}">${ext ? 'External 3DS' : 'Rapyd 3DS'}</span>
      </div>
      <p class="dc-note">${ext
        ? `${esc(pf.label)} uses the merchant’s own 3DS provider (simulated). On Own Card Fields it authenticates first; a pass sends its results in <code>payment_method_options</code>, a fail never calls Rapyd.`
        : `${esc(pf.label)} runs Rapyd’s own 3DS — when it’s required, Rapyd returns a <code>redirect_url</code> and its challenge renders inside the checkout.`}</p>
      ${ext ? `
        <div class="dc-field">
          <div class="dc-label">Provider answers<span class="dc-label-note">simulated outcome</span></div>
          <div class="dc-seg" id="dc-ext3ds">
            ${EXT3DS_OUTCOMES.map(([val, label]) => `<button type="button" data-val="${esc(val)}" class="${outcome === val ? 'active' : ''}">${esc(label)}</button>`).join('')}
          </div>
        </div>
        ${own ? '' : `<p class="dc-note">Not on the Checkout Toolkit — Rapyd hosts the card form there, so Rapyd runs 3DS itself.</p>`}` : ''}
      <p class="dc-note fine">Set by the MID — the provider isn’t switchable here.</p>
    </div>`;
}

function accountHTML() {
  const live = state.env === 'live';
  const pf = activeProfile();
  const cus = customers.getCustomerId();
  const id = customers.getIdentity();
  const remembered = customers.isRemembered();
  return `
    <div class="dc-seg" id="dc-env">
      <button type="button" data-env="sandbox" class="${!live ? 'active' : ''}">Sandbox</button>
      <button type="button" data-env="live" class="${live ? 'active live' : ''}" title="Restricted — needs a live access token; charges a real card (0.01 only)">Live<svg class="env-lock" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg></button>
    </div>
    ${live
      ? `<p class="dc-note warn">Live charges a real card through the production account — every charge is 0.01.</p>`
      : `<div class="dc-label">Sandbox credentials<span class="dc-label-note">MID keys signing your calls</span></div>
         <div class="dc-options" id="dc-creds">${credRowsHTML()}</div>
         ${tdsCardHTML(pf)}`}
    <div class="dc-card">
      <div class="dc-card-head"><span class="dc-card-title">Session customer</span>${cus ? `<span class="dc-pill ${remembered ? 'ok' : ''}">${remembered ? 'Remembered' : live ? 'This tab only' : 'Not saved'}</span>` : ''}</div>
      ${cus
        ? `<div class="dc-cus"><b>${esc(id.name)}</b><span class="mono">${esc(cus)}</span></div>
           <p class="dc-note">${live
             ? 'Live customers are never saved — this one is forgotten when the tab closes.'
             : 'Kept on this browser per credential, so a returning-customer demo survives a reload. Card numbers and CVVs are never saved.'}</p>
           <button type="button" class="dc-btn danger" id="dc-forget">Forget saved customer</button>`
        : `<p class="dc-note">No customer for ${live ? 'live' : esc(state.profile)} yet. Create an account on the site, or sign in there with a customer ID.</p>`}
    </div>`;
}

function behaviourHTML() {
  const strategy = state.model === 'own-fields'
    ? ownFields.strategyHTML()
    : `<div class="se-deck-empty">The hosted page’s save-card options (<code>customer</code>, <code>save_card_default</code>, <code>require_card_cvv</code>) are set in the toolkit config on the checkout page.</div>`;
  return `
    ${fxSectionHTML()}
    <div class="dc-card" id="dc-strategy">
      <div class="dc-card-head"><span class="dc-card-title">Tokenisation · saved cards</span></div>
      ${strategy}
    </div>`;
}

function drawerBodyHTML() {
  const sec = (key, title, body) => `
    <section class="dc-sec" id="${SECTION_IDS[key]}">
      <h3 class="dc-sec-title">${title}</h3>
      ${body}
    </section>`;
  return sec('customer', 'Customer', `<div class="dc-options" id="dc-skins">${skinCardsHTML()}</div>`)
    + sec('path', 'Integration path', pathHTML())
    + sec('account', 'Account', accountHTML())
    + sec('behaviour', 'Payment behaviour', behaviourHTML());
}

function renderDrawer() {
  const body = $('#dc-body');
  if (!body || !drawerOpen) return;
  // The FX currency trigger is about to be rebuilt — drop a dropdown pointed at it.
  if (curDropdownTarget === 'fx') closeCurDropdown();
  const top = body.scrollTop;
  body.innerHTML = drawerBodyHTML();
  body.scrollTop = top;
  ensureFxCurrencyValid();
  renderFxPreview();
}

function openDrawer(section) {
  drawerOpen = true;
  const el = $('#demo-drawer');
  el.hidden = false;
  document.body.classList.add('drawer-open');
  $('#drawer-btn')?.setAttribute('aria-expanded', 'true');
  renderDrawer();
  if (section && SECTION_IDS[section]) {
    const target = $(`#${SECTION_IDS[section]}`);
    target?.scrollIntoView({ block: 'start' });
    target?.classList.add('flash');
    setTimeout(() => target?.classList.remove('flash'), 900);
  }
}
function closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  closeCurDropdown();
  $('#demo-drawer').hidden = true;
  document.body.classList.remove('drawer-open');
  $('#drawer-btn')?.setAttribute('aria-expanded', 'false');
}
const toggleDrawer = () => (drawerOpen ? closeDrawer() : openDrawer());

/* ── Header ──────────────────────────────────────────────── */
function renderHeaderContext() {
  const v = VERTICALS[state.vertical];
  const live = state.env === 'live';
  const ctx = $('#drawer-ctx');
  if (ctx) {
    ctx.innerHTML = `<span>${esc(v.merchant)}</span><span class="sep">·</span><span>${state.model === 'own-fields' ? 'Own Card Fields' : 'Checkout Toolkit'}</span><span class="sep">·</span><span class="${live ? 'is-live' : ''}">${live ? 'Live' : `Sandbox ${esc(state.profile)}`}</span>`;
  }
  const flag = $('#live-flag');
  if (flag) {
    flag.hidden = !live;
    flag.textContent = live ? LIVE_DESC[state.model] : '';
  }
}

function syncControlStates() {
  document.documentElement.dataset.vertical = state.vertical;
  applySkin(state.vertical);
  setAddress(VERTICALS[state.vertical].domain, pagePath(state.step));
  renderHeaderContext();
  renderDrawer();
  renderSeamStrip();
}

/* The engine room's seam strip (js/seam.js) — follows the path and the
   toolkit's mode; keeps its open/closed state across repaints. */
function renderSeamStrip() {
  const host = $('#seam-strip-host');
  if (!host) return;
  const open = !!host.querySelector('details')?.open;
  host.innerHTML = seamStripHTML(seamKey(), open, seamOpts());
}

/* A remembered customer (customers.js) comes back from storage with the cards
   it had — re-read them from Rapyd the first time its bucket is used, through
   the same list call the payment-methods page fires (so it's in the engine
   room when the SE opens that page). */
function resyncRememberedCustomer() {
  if (!customers.needsResync()) return;
  customers.markResynced();
  fireMethodsSync(() => { if (state.step === 'methods' && state.leftView === 'client') renderCheckout(); });
}

/* Sandbox credential switch — a DIRECT state mutation (never a reset: an
   in-flight checkout survives); the per-profile stores re-key themselves and
   the affected surfaces repaint explicitly. */
function switchProfile(id) {
  if (id === state.profile || !PROFILES[id]) return;
  state.profile = id;
  customers.useBucketIdentity(); // greet whoever this MID's customer is
  if (state.leftView === 'backoffice') backOffice.render();
  // On the checkout the flow repaints itself in place (an in-flight payment
  // survives); any other page simply redraws — header and signed-in state
  // follow the new bucket, and the engine room shows that page's own panels.
  if (isCheckout()) FLOWS[state.model].refreshProfile?.();
  else if (state.leftView === 'client') renderCheckout();
  resyncRememberedCustomer();
  renderHeaderContext();
  renderDrawer();
  renderSeamStrip(); // the seam's 3DS line follows the MID's provider
}

/* Sandbox ⇄ Live. Live is gated server-side (X-PayBridge-Live-Token): no token
   for this tab yet → the live dialog asks first; cancelling stays in sandbox. */
function switchEnv(env) {
  if (env === state.env) return;
  if (env === 'live') {
    if (getLiveToken()) { hideBanner(); setState({ env: 'live' }); }
    else openLiveDialog();
    return;
  }
  setState({ env: 'sandbox' });
}

/* ── Wiring ──────────────────────────────────────────────── */
const isTyping = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

function wire() {
  $('.rtabs').addEventListener('click', e => {
    const btn = e.target.closest('.rtab');
    if (btn) setActiveTab(btn.dataset.tab);
  });
  $('#left-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.left-tab');
    if (btn && btn.dataset.view !== state.leftView) setState({ leftView: btn.dataset.view });
  });

  // The drawer: header button, ` to toggle, Esc to close.
  $('#drawer-btn').addEventListener('click', toggleDrawer);
  $('#dc-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target) && $('#live-dialog')?.hidden !== false) {
      e.preventDefault();
      toggleDrawer();
      return;
    }
    if (e.key !== 'Escape') return;
    if (!$('#live-dialog')?.hidden) return;            // the dialog's own Esc handler runs
    if (!$('#cur-dropdown').hidden) { closeCurDropdown(); return; } // innermost first
    closeDrawer();
  });
  // Other modules ask for the drawer (own-fields' "Strategy" link) or tell it
  // their controls changed (the strategy deck, the toolkit's own mode switch).
  document.addEventListener('demo:open-controls', e => openDrawer(e.detail?.section));
  document.addEventListener('demo:controls-changed', () => { renderDrawer(); renderSeamStrip(); });
  customers.subscribeCustomers(() => renderDrawer());

  const drawer = $('#demo-drawer');
  drawer.addEventListener('click', e => {
    const t = e.target;
    const skin = t.closest('button[data-vertical]');
    if (skin) { if (skin.dataset.vertical !== state.vertical) setState({ vertical: skin.dataset.vertical }); return; }
    const model = t.closest('#dc-model button[data-model]');
    if (model) { if (model.dataset.model !== state.model) setState({ model: model.dataset.model }); return; }
    const tk = t.closest('#dc-tkmode button[data-val]');
    if (tk) { toolkit.setToolkitMode(tk.dataset.val); renderDrawer(); renderSeamStrip(); return; }
    const env = t.closest('#dc-env button[data-env]');
    if (env) { switchEnv(env.dataset.env); return; }
    const prof = t.closest('#dc-creds button[data-profile]');
    if (prof) { switchProfile(prof.dataset.profile); return; }
    // External 3DS: the simulated provider's default answer — read when Pay runs.
    const ext = t.closest('#dc-ext3ds button[data-val]');
    if (ext) { setExt3dsPreset(ext.dataset.val); renderDrawer(); return; }
    if (t.closest('#dc-forget')) {
      // Demo-side forget — the cus_*** keeps existing at Rapyd (worth saying);
      // this browser just stops remembering it. Every subscriber repaints.
      customers.resetIdentity(); // the next account starts from the demo shopper again
      customers.forgetCustomer();
      if (state.leftView === 'backoffice') backOffice.render();
      return;
    }
    const curBtn = t.closest('#fx-currency');
    if (curBtn) { toggleCurDropdown('fx', curBtn); return; }
    const side = t.closest('#fx-side button[data-val]');
    if (side) { state.fx.fixedSide = side.dataset.val; refreshAfterEdit(); }
  });
  drawer.addEventListener('change', e => {
    if (e.target.id === 'fx-enable') { state.fx.enabled = e.target.checked; refreshAfterEdit(); }
    // Show seam: CSS-only, so a live iframe / 3DS / hosted view isn't re-rendered.
    if (e.target.id === 'dc-seam') setSeamOn(e.target.checked);
  });

  // Price tile — delegated on #checkout (never destroyed, only its innerHTML
  // is rebuilt), so this is wired exactly once however often the flow remounts.
  $('#checkout').addEventListener('input', e => { if (e.target.id === 'tile-amount') commitTileEdit(); });
  $('#checkout').addEventListener('click', e => {
    const curBtn = e.target.closest('#tile-currency');
    if (curBtn) { toggleCurDropdown('tile', curBtn); return; }
    // The FX badge opens the drawer at the FX controls.
    if (e.target.closest('#fx-trigger')) { openDrawer('behaviour'); }
  });
  $('#cur-dropdown').addEventListener('click', e => {
    const opt = e.target.closest('.cur-opt');
    if (opt) selectCurrency(opt.dataset.val);
  });
  // Outside-click close for the currency dropdown. composedPath() (frozen at
  // dispatch time) rather than .contains(): a control that re-renders its own
  // container detaches e.target mid-dispatch.
  document.addEventListener('click', e => {
    const path = e.composedPath();
    const dropdown = $('#cur-dropdown');
    if (!dropdown.hidden && !path.includes(dropdown) && !path.includes($('#tile-currency')) && !path.includes($('#fx-currency'))) {
      closeCurDropdown();
    }
  });
}

/* ── Live unlock (F1) ────────────────────────────────────────
   The backend refuses every env:'live' call without the shared
   X-PayBridge-Live-Token, so switching to Live first asks for it. The token
   goes straight into api.js setLiveToken (sessionStorage for this tab, memory
   fallback) — it's never rendered, logged or put in a URL; the input is a
   password field that's cleared on every close. A wrong token isn't detected
   here (there's no free live call to test it with): the first live request
   comes back 401/403, api.js clears the token and raises
   `paybridge:live-auth-failed`, and the listener below drops back to sandbox. */
let liveDialogReturnFocus = null;

function openLiveDialog() {
  const dlg = $('#live-dialog');
  if (!dlg) {
    // Markup missing (older index.html) — the plain prompt still gates it.
    const t = window.prompt('Live mode is restricted. Enter the live access token:');
    const token = (t || '').trim();
    if (token && validTokenShape(token)) { setLiveToken(token); setState({ env: 'live' }); }
    return;
  }
  liveDialogReturnFocus = document.activeElement;
  $('#live-token').value = '';
  setLiveDialogError('');
  dlg.hidden = false;
  $('#live-token').focus();
}
function closeLiveDialog() {
  const dlg = $('#live-dialog');
  if (!dlg || dlg.hidden) return;
  $('#live-token').value = ''; // never leave the token sitting in the DOM
  dlg.hidden = true;
  liveDialogReturnFocus?.focus?.();
  liveDialogReturnFocus = null;
}
function setLiveDialogError(msg) {
  const el = $('#live-dialog-err');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}
// Header values must be printable ASCII — anything else makes fetch() throw,
// which api.js reports as NETWORK_ERROR rather than an auth failure, leaving
// the SE stuck in live with every call failing for no visible reason.
const validTokenShape = (t) => /^[\x21-\x7e]{1,512}$/.test(t);

function submitLiveDialog() {
  const token = $('#live-token').value.trim();
  if (!token) { setLiveDialogError('Enter the live access token, or stay in sandbox.'); return; }
  if (!validTokenShape(token)) { setLiveDialogError('That doesn’t look like a token — no spaces or special characters.'); return; }
  setLiveToken(token);
  closeLiveDialog();
  hideBanner();
  setState({ env: 'live' });
}

/* Top-of-page notice for things the SE must see even mid-narration (live auth
   failures). Plain text only — the message can come from the backend. */
let bannerTimer = null;
function showBanner(title, message, kind = 'error') {
  const el = $('#pb-banner');
  if (!el) return;
  el.className = `pb-banner pb-notice ${kind}`;
  $('#pb-banner-title').textContent = title;
  $('#pb-banner-msg').textContent = message || '';
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 12000);
}
function hideBanner() {
  clearTimeout(bannerTimer);
  const el = $('#pb-banner');
  if (el) el.hidden = true;
}

function onLiveAuthFailed(e) {
  const { error, message } = e.detail || {};
  const title = error === 'LIVE_DISABLED'
    ? 'Live mode is disabled on this backend'
    : 'Live token rejected';
  const fallback = error === 'LIVE_DISABLED'
    ? 'The backend has no PAYBRIDGE_LIVE_TOKEN configured, so it refuses every live call.'
    : 'The live access token was missing or wrong. Pick Live in Demo controls to enter it again.';
  // Deferred one macrotask: api.js raises this event BEFORE its request()
  // resolves, so the failing flow's own continuation (status pill, error
  // screen, ledger) still runs after the await. Resetting synchronously let
  // that continuation paint "Payment declined" over the fresh sandbox page.
  setTimeout(() => {
    // Several in-flight live calls can fail together; only the first switches.
    if (state.env === 'live') setState({ env: 'sandbox' }); // a RESET_KEY — the live flow is abandoned
    setStatus('Back in sandbox — live auth failed', 'error');
    showBanner(`${title} — back in sandbox`, message || fallback, 'error');
  }, 0);
}

function wireLiveGate() {
  window.addEventListener('paybridge:live-auth-failed', onLiveAuthFailed);
  $('#pb-banner-x')?.addEventListener('click', hideBanner);
  const form = $('#live-dialog-form');
  if (!form) return;
  form.addEventListener('submit', (e) => { e.preventDefault(); submitLiveDialog(); });
  $('#live-dialog-cancel').addEventListener('click', closeLiveDialog);
  $('#live-dialog-x').addEventListener('click', closeLiveDialog);
  $('#live-token').addEventListener('input', () => setLiveDialogError(''));
  // Backdrop click / Escape = cancel (stay in sandbox).
  $('#live-dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'live-dialog') closeLiveDialog(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#live-dialog').hidden) closeLiveDialog();
  });
}

/* ── Render orchestration ────────────────────────────────── */
function renderAll(_state, patch) {
  const isInitial = !patch;
  // An explicit empty patch — setState({}) — is the "reset the client flow"
  // signal (e.g. "Run another payment" on the success screen); treat it like
  // an initial render. Otherwise only vertical/model/env resets the flow.
  const touchesClientFlow = isInitial || Object.keys(patch).length === 0 || Object.keys(patch).some(k => RESET_KEYS.includes(k));

  if (!touchesClientFlow) {
    // e.g. a leftView toggle — re-sync only what that actually affects.
    if ('leftView' in patch) toggleLeftView();
    return;
  }

  // An env switch re-keys the customer bucket — greet that bucket's customer.
  if (isInitial || 'env' in patch) customers.useBucketIdentity();
  clearPaymentWatch(); // the customer's webhook section survives; this payment's doesn't
  resetSteps();        // back to sign-in (or a requested landing) — signed-in view if the customer survived
  syncControlStates();
  setActiveTab('request');
  setStatus('Awaiting input', 'idle');
  renderBackend();
  renderCheckout();
  // renderBackend() wipes #panel-webhooks back to its empty state, but the
  // customer (and its beat) survives a flow reset — put its section back.
  repaintWebhooks();
  resyncRememberedCustomer(); // a customer restored from storage re-reads its cards once
}

subscribe(renderAll);

// steps.js advances the frame; only this module knows how to draw the client
// page (the checkout is its own shell plus the flow's), so it supplies the repainter.
setClientRepainter(renderCheckout);
// The customer beat can be fired from the account frame (outside any flow), and
// it has to repaint whichever surface owns the right panel. This module is the
// only one that knows the flow registry, so it supplies the repainter — which
// has to be step-aware: on the account frame the payment card must NOT appear,
// or firing beat 1 would immediately undo the separation of the two beats.
setPanelRepainter(() => {
  if (isCheckout()) FLOWS[state.model].refreshRightPanel?.();
  else renderStepPanels();
});
// Same reasoning for the field↔JSON highlight: rebuilding the customer card
// drops its .sync-hit classes, and only the flow knows what's focused.
setHighlightHook(() => FLOWS[state.model].applyHighlight?.());

document.documentElement.dataset.vertical = state.vertical;
applySkin(state.vertical);
applySeam();
wire();
wireLiveGate();
backOffice.mount();
renderAll();
