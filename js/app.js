/* ─────────────────────────────────────────────────────────────
   PayBridge Demo Suite — bootstrap (on-brand redesign)
   ───────────────────────────────────────────────────────────── */

import { VERTICALS, VERTICAL_ORDER, activeProduct } from './verticals.js';
import { state, setState, subscribe } from './state.js';
import { setActiveTab, setStatus } from './ui.js';
import { stopWebhookWatch } from './webhooks.js';
import { formatAmount } from './sync.js';
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
function totalsHTML(p, feeLabel, feeValue) {
  return `
    <div class="co-line"><span>Subtotal</span><span>${p.amount} ${p.currency}</span></div>
    <div class="co-line"><span>${feeLabel}</span><span class="${feeValue === 'Free' ? 'free' : ''}">${feeValue}</span></div>
    <div class="co-line total"><span>Total</span><span class="co-total-amt">${p.amount} ${p.currency}</span></div>`;
}
function ensureFxCurrencyValid() {
  const options = CURRENCIES.filter(c => c !== activeProduct().currency);
  if (!options.includes(state.fx.requestedCurrency)) state.fx.requestedCurrency = options[0];
}
function fxPopoverHTML() {
  const fx = state.fx;
  return `
    <div class="fx-popover-head">
      <span>Settlement FX</span>
      <button type="button" class="fx-popover-x" id="fx-popover-close" aria-label="Close">×</button>
    </div>
    <label class="co-tds">
      <input type="checkbox" id="fx-enable" ${fx.enabled ? 'checked' : ''} />
      <span>Enable FX</span>
    </label>
    <div class="fx-popover-body" id="fx-popover-body" ${fx.enabled ? '' : 'hidden'}>
      <div>
        <div class="fx-popover-label">Requested currency · <code>requested_currency</code></div>
        <button type="button" class="cur-trigger" id="fx-currency">${fx.requestedCurrency || ''}<span class="cur-caret">▾</span></button>
      </div>
      <div>
        <div class="fx-popover-label">Fixed side · <code>fixed_side</code></div>
        <div class="co-fx-seg" id="fx-side">
          <button type="button" data-val="sell" class="${fx.fixedSide === 'sell' ? 'active' : ''}">Sell · merchant risk</button>
          <button type="button" data-val="buy" class="${fx.fixedSide === 'buy' ? 'active' : ''}">Buy · customer risk</button>
        </div>
      </div>
    </div>`;
}
function renderFxPopover() {
  ensureFxCurrencyValid();
  // The requested_currency trigger button is about to be torn down and
  // rebuilt — drop any open currency dropdown pointed at it first, or it'd
  // be left floating with a stale/detached trigger reference.
  if (curDropdownTarget === 'fx') closeCurDropdown();
  $('#fx-popover').innerHTML = fxPopoverHTML();
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
  const p = activeProduct();
  const feeLabel = p.delivery ? 'Delivery' : 'Fees';
  const feeValue = p.delivery ? p.delivery : 'Free';
  const totalsEl = $('#order-totals');
  if (totalsEl) totalsEl.innerHTML = totalsHTML(p, feeLabel, feeValue);
  const payBtn = $('#pay-btn');
  if (payBtn) payBtn.textContent = `${VERTICALS[state.vertical].cta} ${p.amount} ${p.currency}`;
  const popover = $('#fx-popover');
  if (popover && !popover.hidden) renderFxPopover();
  FLOWS[state.model].refreshRightPanel?.();
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
  state.productOverride = { vertical: state.vertical, amount: filtered, currency };
  refreshAfterEdit();
}

/* ── Left: checkout ──────────────────────────────────────── */
function renderCheckout() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const flow = FLOWS[state.model];
  const host = $('#checkout');
  const [c1, c2] = p.thumb;

  closeFxPopover(); // never lingers open across a vertical/model/env reset
  closeCurDropdown();

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

      <div class="co-order">
        <div class="co-thumb" style="background:linear-gradient(135deg,${c1},${c2})">${THUMB_GLYPH[state.vertical]}</div>
        <div class="co-order-info">
          <div class="co-order-name">${p.name}</div>
          <div class="co-order-desc">${p.desc}</div>
        </div>
        <div class="co-order-price">
          <input type="text" inputmode="decimal" class="tile-field tile-amount" id="tile-amount" value="${p.amount}" title="Click to edit the charged amount" />
          <button type="button" class="tile-field tile-currency cur-trigger" id="tile-currency" data-currency="${p.currency}" title="Click to edit the charge currency">${p.currency}<span class="cur-caret">▾</span></button>
        </div>
        <button type="button" class="fx-trigger" id="fx-trigger" title="Configure settlement FX">FX</button>
      </div>

      <div class="co-totals" id="order-totals">${totalsHTML(p, feeLabel, feeValue)}</div>

      ${payLabel}
      ${flow.renderPaymentHTML()}`;
  }

  // Clear out-of-window annotations (bank-app view) on any re-render.
  const off = $('#offstage');
  off.innerHTML = '';
  off.hidden = true;

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
  // the SE was away — repaint them from the client flow's own persisted
  // state on the way back (webhooks.js already guards its own panel).
  else FLOWS[state.model].refreshRightPanel?.();
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
  $('#left-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.left-tab');
    if (btn && btn.dataset.view !== state.leftView) setState({ leftView: btn.dataset.view });
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
    }
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
backOffice.mount();
renderAll();
