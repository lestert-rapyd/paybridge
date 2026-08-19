/* ─────────────────────────────────────────────────────────────
   PayBridge Demo Suite — bootstrap (on-brand redesign)
   ───────────────────────────────────────────────────────────── */

import { VERTICALS, VERTICAL_ORDER, activeProduct, customerCharge, fxQuoteKey, chargeText, productCta } from './verticals.js';
import { PROFILES, PROFILE_ORDER } from './profiles.js';
import { accountPanelHTML, syncCustomerBeat, setPanelRepainter, setHighlightHook } from './customer-beat.js';
import {
  frameHTML, stepRailHTML, isCheckout, renderStepPanels, resetSteps, setClientRepainter,
} from './steps.js';
import { state, setState, subscribe } from './state.js';
import { setActiveTab, setStatus } from './ui.js';
import { clearPaymentWatch, repaintWebhooks } from './webhooks.js';
import { formatAmount } from './sync.js';
import { getFxRate } from './api.js';
import * as ownFields from './flows/own-fields.js';
import * as toolkit from './flows/toolkit.js';
import * as backOffice from './flows/back-office.js';

// Patch keys that mean "the customer's flow/context actually changed" —
// only these trigger the full client-flow reset (mount() etc). Everything
// else (leftView toggling, ledger updates, in-flow bookkeeping) must be able
// to re-render its own surface without disturbing an in-progress checkout.
const RESET_KEYS = ['vertical', 'model', 'env'];

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FLOWS = { 'own-fields': ownFields, 'toolkit': toolkit };

const MODEL_DESC = {
  'own-fields': "Merchant collects the card and calls POST /v1/payments directly — a PCI-DSS path.",
  'toolkit':    "Rapyd's iframe collects the card — zero PCI scope for the merchant.",
};

const THUMB_GLYPH = { ecommerce: '🪑', crypto: '₿', gaming: '🎲' };

// Own-fields' editable price tile + the FX popover it opens beside — shared
// curated list for both the tile's charge currency and the popover's
// requested_currency (they mutually exclude each other's current value).
const CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD'];

/* ── Own-fields price tile + FX popover ──────────────────────
   The tile is the single editable source of truth for amount/currency
   (state.productOverride); the popover beside it configures settlement FX
   (state.fx). Both are plain data mutated directly — see state.js. */
// `c` is a customerCharge() object — the amount the customer actually pays,
// which is the base price under 'sell' but the converted requested-currency
// figure under 'buy'. Subtotal and Total both reflect it (Option 2).
// Subscription products carry a small "/mo" on the total line.
function totalsHTML(c, feeLabel, feeValue, perMonth = false) {
  const amt = chargeText(c);
  const mo = perMonth ? ' <span class="per-mo">/mo</span>' : '';
  return `
    <div class="co-line"><span>Subtotal</span><span>${amt}</span></div>
    <div class="co-line"><span>${feeLabel}</span><span class="${feeValue === 'Free' ? 'free' : ''}">${feeValue}</span></div>
    <div class="co-line total"><span>Total</span><span class="co-total-amt">${amt}${mo}</span></div>`;
}
function ensureFxCurrencyValid() {
  const options = CURRENCIES.filter(c => c !== activeProduct().currency);
  if (!options.includes(state.fx.requestedCurrency)) state.fx.requestedCurrency = options[0];
}
function fxPopoverHTML() {
  const fx = state.fx;
  // requested_currency is always the FLOATING side. Under 'sell' the customer's
  // charge is fixed and the merchant's payout floats → it's what you receive;
  // under 'buy' the payout is fixed and the customer's charge floats → it's the
  // currency the customer pays. Label it for whichever side it actually is.
  const reqLabel = fx.fixedSide === 'buy' ? 'Currency the customer pays' : 'Currency you receive';
  return `
    <div class="fx-popover-head">
      <span>Currency conversion</span>
      <button type="button" class="fx-popover-x" id="fx-popover-close" aria-label="Close">×</button>
    </div>
    <label class="co-tds">
      <input type="checkbox" id="fx-enable" ${fx.enabled ? 'checked' : ''} />
      <span>Enable FX</span>
    </label>
    <div class="fx-popover-body" id="fx-popover-body" ${fx.enabled ? '' : 'hidden'}>
      <div>
        <div class="fx-popover-label">${reqLabel}</div>
        <button type="button" class="cur-trigger" id="fx-currency">${fx.requestedCurrency || ''}<span class="cur-caret">▾</span></button>
      </div>
      <div>
        <div class="fx-popover-label">Who bears the FX</div>
        <div class="co-fx-seg" id="fx-side">
          <button type="button" data-val="sell" class="${fx.fixedSide === 'sell' ? 'active' : ''}">You</button>
          <button type="button" data-val="buy" class="${fx.fixedSide === 'buy' ? 'active' : ''}">Customer</button>
        </div>
      </div>
      <div class="fx-preview" id="fx-preview" aria-live="polite"></div>
    </div>`;
}
function renderFxPopover() {
  ensureFxCurrencyValid();
  // The requested_currency trigger button is about to be torn down and
  // rebuilt — drop any open currency dropdown pointed at it first, or it'd
  // be left floating with a stale/detached trigger reference.
  if (curDropdownTarget === 'fx') closeCurDropdown();
  $('#fx-popover').innerHTML = fxPopoverHTML();
  syncFx();
}

/* ── Live FX + customer-charge sync ──────────────────────────
   FX drives more than the popover: the whole customer-facing checkout (totals
   + pay button, and the toolkit summary) must show what the customer ACTUALLY
   pays, never the stale base. One live Rapyd fx_rates quote — cached on
   state.fx.quote, read by verticals.js customerCharge()/merchantReceive() —
   feeds every surface. The tile's amount/currency is always the base (Rapyd's
   `amount` is in units of `currency`); requested_currency is the other side;
   fixed_side picks who's fixed ('sell' fixes the customer's charge, 'buy' the
   merchant's payout). Rapyd's buy_ side = merchant funds, sell_ = customer.
   syncFx() repaints from the current quote and fetches when it's missing/stale
   — it runs on every edit AND on render, so a pre-enabled (cross-flow) FX
   config resolves even if the popover is never opened. */
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
    `<div class="fx-preview-row"><span>${label}</span><span class="${fixed ? 'fixed' : 'vary'}">${chargeText({ ...c, approx: !fixed })}</span></div>`;
  return `
    ${row('Customer pays', { amount: q.sellAmount, currency: q.sellCurrency }, customerFixed)}
    ${row('You receive', { amount: q.buyAmount, currency: q.buyCurrency }, !customerFixed)}
    <div class="fx-preview-rate">Rate ${Number(q.rate).toFixed(4)} · <span class="guar">${customerFixed ? 'customer amount guaranteed' : 'your payout guaranteed'}</span></div>`;
}
function renderFxPreview() {
  const el = $('#fx-preview');
  if (!el) return;
  if (!state.fx.enabled || !state.fx.requestedCurrency) { el.innerHTML = ''; return; }
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
  const key = fxQuoteKey();
  if (state.fx.quote && state.fx.quote.key === key) return; // already fresh
  const p = activeProduct();
  if (!(Number(p.amount) > 0) || p.currency === state.fx.requestedCurrency) return;
  const params = fxRequestParams();
  const seq = ++fxSeq;
  clearTimeout(fxTimer);
  fxTimer = setTimeout(async () => {
    let resp = null;
    try { resp = await getFxRate(params); } catch { /* network */ }
    if (seq !== fxSeq) return; // superseded by a newer edit
    const d = resp?.data?.data;
    state.fx.quote = (resp?.ok && d && d.buy_amount != null && d.sell_amount != null)
      ? { key, sellAmount: d.sell_amount, sellCurrency: d.sell_currency, buyAmount: d.buy_amount, buyCurrency: d.buy_currency, rate: d.rate }
      : { key, error: true };
    renderFxPreview();
    refreshCharge();
  }, 250);
}
// Single entry point: repaint the popover preview + the checkout charge from
// the current quote, then fetch if the quote is missing/stale for this config.
function syncFx() {
  // Keep requested_currency != base even when the popover is closed (a vertical
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
  FLOWS[state.model].refreshSummary?.();
}
function openFxPopover() {
  const trigger = $('#fx-trigger');
  const popover = $('#fx-popover');
  if (!trigger || !popover) return;
  renderFxPopover();
  popover.hidden = false;
  trigger.classList.add('active');
  const rect = trigger.getBoundingClientRect();
  const top = Math.min(rect.top, window.innerHeight - popover.offsetHeight - 12);
  popover.style.top = `${Math.max(12, top)}px`;
  popover.style.left = `${rect.right + 10}px`;
}
function closeFxPopover() {
  $('#fx-popover').hidden = true;
  $('#fx-trigger')?.classList.remove('active');
  if (curDropdownTarget === 'fx') closeCurDropdown();
}

/* ── Self-designed currency picker (portal) ──────────────────
   Replaces native <select> for both the tile's currency and the FX
   popover's requested_currency — a native select's open dropdown list is
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
// popover edit — never touches the tile's own input/select DOM (that would
// disrupt an actively-typing cursor) or the card fields.
function refreshAfterEdit() {
  const popover = $('#fx-popover');
  // renderFxPopover() rebuilds the popover controls AND calls syncFx(); when
  // it's closed we still need syncFx() to repaint the charge + (re)fetch a
  // quote (e.g. the tile amount/currency changed, invalidating the old one).
  if (popover && !popover.hidden) renderFxPopover();
  else syncFx();
  syncFxTrigger();
  FLOWS[state.model].refreshRightPanel?.();
}
// The FX corner badge carries a persistent "configured" tint whenever FX is
// enabled, so it reads as switched-on at a glance even after the popover
// closes. Shared by both flows — the badge lives on whichever price tile the
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
    currencyBtn.innerHTML = `${currencyOverride}<span class="cur-caret">▾</span>`;
  }
  // keyed by product too — an edited price never leaks onto a sibling product
  state.productOverride = { vertical: state.vertical, productId: activeProduct().id, amount: filtered, currency };
  refreshAfterEdit();
}

/* ── Left: the client page ────────────────────────────────────
   Four frames (js/steps.js). Frames 1–3 are model-independent — the identity
   question, the account step and the product choice belong to the client, not
   to the integration — so only the checkout frame forks per flow. */
function renderCheckout() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const flow = FLOWS[state.model];
  const host = $('#checkout');
  const [c1, c2] = p.thumb;

  closeFxPopover(); // never lingers open across a vertical/model/env reset
  closeCurDropdown();

  // Clear out-of-window annotations (bank-app view) on any re-render.
  const off = $('#offstage');
  off.innerHTML = '';
  off.hidden = true;

  if (!isCheckout()) {
    host.innerHTML = frameHTML();
    $('.browser').classList.remove('wide-tk', 'wide-3ds');
    $('#demo-controls').innerHTML = '';
    $('#demo-controls').hidden = true;
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
    host.innerHTML = `
      <div class="co-merchant">${v.merchant}</div>
      <div class="co-tagline"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#a8a297" stroke-width="2.6"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>${v.headline.toUpperCase()}</div>
      ${stepRailHTML()}

      ${accountPanelHTML()}

      <div class="co-order">
        <div class="co-thumb" style="background:linear-gradient(135deg,${c1},${c2})">${p.glyph || THUMB_GLYPH[state.vertical]}</div>
        <div class="co-order-info">
          <div class="co-order-name">${p.name}</div>
          <div class="co-order-desc">${p.desc}</div>
        </div>
        <div class="co-order-price">
          <input type="text" inputmode="decimal" class="tile-field tile-amount" id="tile-amount" value="${p.amount}" title="Click to edit the charged amount" />
          <button type="button" class="tile-field tile-currency cur-trigger" id="tile-currency" data-currency="${p.currency}" title="Click to edit the charge currency">${p.currency}<span class="cur-caret">▾</span></button>
        </div>
        <button type="button" class="fx-trigger${state.fx.enabled ? ' configured' : ''}" id="fx-trigger" title="Configure currency conversion">FX</button>
      </div>

      <div class="co-totals" id="order-totals">${totalsHTML(customerCharge(), feeLabel, feeValue, p.billing === 'subscription')}</div>

      ${payLabel}
      <div id="pay-region">${flow.renderPaymentHTML()}</div>`;
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

/* ── Left-pane tabs (Client Site / Client Back Office) ───────
   Toggling this NEVER touches the client flow's DOM — it only shows/hides
   already-rendered sections, so an in-progress checkout (e.g. mid-3DS)
   resumes exactly where it was when the SE switches back. */
function toggleLeftView() {
  const isBackoffice = state.leftView === 'backoffice';
  $$('.left-tab').forEach(b => b.classList.toggle('active', b.dataset.view === state.leftView));
  $('.browser').hidden = isBackoffice;
  $('#offstage').hidden = isBackoffice || !$('#offstage').innerHTML;
  $('#demo-controls').hidden = isBackoffice || !FLOWS[state.model].renderControlsHTML;
  $('#backoffice').hidden = !isBackoffice;
  if (isBackoffice) backOffice.render();
  // Back office may have repainted the right panel's Request/Response while
  // the SE was away — repaint them from the client page's own persisted
  // state on the way back (webhooks.js already guards its own panel).
  else if (isCheckout()) FLOWS[state.model].refreshRightPanel?.();
  else renderStepPanels();
}

/* ── Sandbox key-profile switch (subbar, sandbox only) ───────
   Minimal selector over the three sandbox MIDs. Switching a profile is a
   DIRECT state mutation (never a reset — invariant: an in-flight checkout
   survives); the affected surfaces repaint explicitly. Feature badges make
   the MID differences part of the demo (3DS provider, NRID availability). */
// The credential picker is a UI-only popover (open state lives here, not in
// the reactive store) folded into the Sandbox button of the env switch.
let credPanelOpen = false;

const redactKey = k => k ? `${k.slice(0, 4)}····${k.slice(-4)}` : '';

function credRowsHTML() {
  return PROFILE_ORDER.map(id => {
    const pf = PROFILES[id];
    const active = id === state.profile;
    return `<button type="button" class="cred-row ${active ? 'active' : ''}" data-profile="${id}" title="access_key ${pf.access_key}">
      <span class="cred-radio"></span>
      <span class="cred-main">
        <span class="cred-id">${id}</span>
        <span class="cred-sub">3DS ${pf.tds === 'rapyd' ? 'Rapyd' : 'External'} · AFT ${pf.aft ? '✓' : '✗'}</span>
        <span class="cred-key">${redactKey(pf.access_key)}</span>
      </span>
      <span class="cred-flags">
        <span class="cred-flag ${pf.nrid ? 'on' : 'off'}">NRID ${pf.nrid ? '✓' : '✗'}</span>
      </span>
    </button>`;
  }).join('');
}

/* ── Sandbox credential picker (folded into the Sandbox/Live toggle) ──
   The Sandbox button shows the active SC tag; clicking it opens this panel
   over the three MIDs. Selection is a DIRECT state mutation (never a reset —
   an in-flight checkout survives), same invariant as the old subbar switch. */
function renderCredPanel() {
  const tag = $('#env-cred-tag');
  if (tag) tag.textContent = state.env === 'sandbox' ? state.profile : '';
  const panel = $('#cred-panel');
  const picker = $('#env-picker');
  if (!panel || !picker) return;
  const open = credPanelOpen && state.env === 'sandbox';
  picker.classList.toggle('open', open);
  panel.hidden = !open;
  if (open) {
    panel.innerHTML = `
      <div class="cred-panel-head">Sandbox credentials<span class="cph-note">MID keys signing your calls</span></div>
      ${credRowsHTML()}`;
  }
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
  renderCredPanel(); // the SC tag + panel track the env switch
}

/* ── Wiring ──────────────────────────────────────────────── */
function wire() {
  $('#vertical-pills').addEventListener('click', e => {
    const btn = e.target.closest('button[data-vertical]');
    if (btn && btn.dataset.vertical !== state.vertical) setState({ vertical: btn.dataset.vertical });
  });
  $('#env-switch').addEventListener('click', e => {
    const btn = e.target.closest('button[data-env]');
    if (!btn) return;
    if (btn.dataset.env === 'live') {
      credPanelOpen = false;
      if (state.env !== 'live') setState({ env: 'live' }); else renderCredPanel();
      return;
    }
    // Sandbox: arriving from Live opens the picker; clicking it again toggles.
    if (state.env !== 'sandbox') { credPanelOpen = true; setState({ env: 'sandbox' }); }
    else { credPanelOpen = !credPanelOpen; renderCredPanel(); }
  });
  $('#model-switch').addEventListener('click', e => {
    const btn = e.target.closest('.model-btn');
    if (btn && btn.dataset.model !== state.model) setState({ model: btn.dataset.model });
  });
  $('.rtabs').addEventListener('click', e => {
    const btn = e.target.closest('.rtab');
    if (btn) setActiveTab(btn.dataset.tab);
  });
  $('#left-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.left-tab');
    if (btn && btn.dataset.view !== state.leftView) setState({ leftView: btn.dataset.view });
  });
  // Sandbox credential picker — direct mutation + targeted repaints (the
  // client flow's DOM is never reset; per-profile stores re-key themselves).
  // Picking a credential also dismisses the panel.
  $('#cred-panel').addEventListener('click', e => {
    const btn = e.target.closest('button[data-profile]');
    if (!btn) return;
    if (btn.dataset.profile !== state.profile) {
      state.profile = btn.dataset.profile;
      FLOWS[state.model].refreshProfile?.();
      if (state.leftView === 'backoffice') backOffice.render();
    }
    credPanelOpen = false;
    renderCredPanel();
  });
  // Dismiss the picker on an outside click or Escape (the handlers above run
  // first and stopPropagation isn't needed — they sit inside #env-picker).
  document.addEventListener('click', e => {
    if (credPanelOpen && !e.target.closest('#env-picker')) { credPanelOpen = false; renderCredPanel(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && credPanelOpen) { credPanelOpen = false; renderCredPanel(); }
  });

  // Price tile + FX popover — delegated on stable containers (#checkout,
  // #fx-popover and #cur-dropdown never get destroyed, only their innerHTML
  // gets rebuilt), so this is wired exactly once regardless of how many
  // times the flow remounts.
  $('#checkout').addEventListener('input', e => { if (e.target.id === 'tile-amount') commitTileEdit(); });
  $('#checkout').addEventListener('click', e => {
    const curBtn = e.target.closest('#tile-currency');
    if (curBtn) { toggleCurDropdown('tile', curBtn); return; }
    if (e.target.closest('#fx-trigger')) {
      $('#fx-popover').hidden ? openFxPopover() : closeFxPopover();
      return;
    }
    // The identity answer and the product choice are frames now — js/steps.js
    // owns both, and advancing a frame is what repaints the client page.
  });
  $('#fx-popover').addEventListener('change', e => {
    if (e.target.id === 'fx-enable') { state.fx.enabled = e.target.checked; renderFxPopover(); refreshAfterEdit(); }
  });
  $('#fx-popover').addEventListener('click', e => {
    if (e.target.closest('#fx-popover-close')) { closeFxPopover(); return; }
    const curBtn = e.target.closest('#fx-currency');
    if (curBtn) { toggleCurDropdown('fx', curBtn); return; }
    const seg = e.target.closest('#fx-side button[data-val]');
    if (seg) {
      state.fx.fixedSide = seg.dataset.val;
      renderFxPopover();
      refreshAfterEdit();
    }
  });
  $('#cur-dropdown').addEventListener('click', e => {
    const opt = e.target.closest('.cur-opt');
    if (opt) selectCurrency(opt.dataset.val);
  });
  // Outside-click close, for both the FX popover and the currency dropdown.
  // Uses composedPath() (frozen at dispatch time) rather than .contains() —
  // a click on a control that re-renders its own container (e.g. the
  // fixed_side toggle calling renderFxPopover()) detaches e.target from the
  // DOM mid-dispatch, which made a later .contains(e.target) check wrongly
  // read false and close the popover right after every interaction.
  document.addEventListener('click', e => {
    const path = e.composedPath();
    const dropdown = $('#cur-dropdown');
    if (!dropdown.hidden && !path.includes(dropdown) && !path.includes($('#tile-currency')) && !path.includes($('#fx-currency'))) {
      closeCurDropdown();
    }
    const popover = $('#fx-popover');
    // #cur-dropdown is portalled as a sibling of #fx-popover, not nested
    // inside it — a click on one of its options is otherwise indistinguishable
    // from a genuine outside click, which closed the popover on every
    // requested_currency selection.
    if (!popover.hidden && !path.includes(popover) && !path.includes($('#fx-trigger')) && !path.includes(dropdown)) {
      closeFxPopover();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeCurDropdown();
    closeFxPopover();
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

  clearPaymentWatch(); // the customer's webhook section survives; this payment's doesn't
  resetSteps();        // back to frame 1 — which shows the signed-in view if the customer survived
  syncControlStates();
  setActiveTab('request');
  setStatus('Awaiting input', 'idle');
  renderBackend();
  renderCheckout();
  // renderBackend() wipes #panel-webhooks back to its empty state, but the
  // customer (and its beat) survives a flow reset — put its section back.
  repaintWebhooks();
}

subscribe(renderAll);

// steps.js advances the frame; only this module knows how to draw the client
// page (frame 4 is its own shell plus the flow's), so it supplies the repainter.
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
renderVerticalPills();
wire();
backOffice.mount();
renderAll();
