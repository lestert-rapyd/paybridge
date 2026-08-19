/* ─────────────────────────────────────────────────────────────
   The client page as FOUR FRAMES.

   The customer beat used to be separated in space (its own panel, its own
   card) but not in TIME: the account fields, the product choice and the cart
   all rendered at once, so `POST /v1/customers` still read as part of the
   checkout rather than before it. One frame per beat fixes that — and the
   engine room then only ever shows the call the current frame is about:

     1 · account-q  · would you like an account?      → no call yet
     2 · account    · name + email, fire the beat     → POST /v1/customers
     3 · product    · one-time or subscription?       → no call
     4 · checkout   · the cart (owned by app.js/flow) → POST /v1/payments

   Two invariants this module must not break:

   · A frame change writes #panel-request ONLY. #panel-response and
     #panel-webhooks hold beat 1's real response and its delivered events —
     stepping around the demo must never destroy them.
   · A frame change never calls setActiveTab(). Only FIRING a call moves the
     SE's tab (design system §5: never steal the tab while they narrate).

   Answers are route cards (`.bo-route`, §04.4b) because each carries a money
   consequence to narrate. Nothing here is a new component.
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';
import { VERTICALS, productColumnsHTML } from './verticals.js';
import {
  setIdentityMode, chosenGuest, canGuestSubscribe, guestSubscribeBlocker,
  identityChooserHTML, promoteToReturning,
} from './identity.js';
import {
  accountPanelHTML, accountCtaState, customerRowHTML, customerRequestCardHTML,
  customerResponseCardHTML, fillCustomerSignature, beatCardHTML,
} from './customer-beat.js';
import * as customers from './customers.js';
import { retrieveCustomer } from './api.js';
import { renderJSONView } from './json-view.js';
import { headersHTML, fillSignature, newSaltTimestamp } from './signing.js';
import { setActiveTab, setStatus } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);

export const STEPS = ['account-q', 'account', 'product', 'checkout'];

/* Where Back goes — the frames the SE actually came through, not a fixed
   order (a guest skips frame 2 entirely, so "the previous step" isn't
   the previous entry in STEPS). */
let history = [];
/* A subscription picked as a guest with no storage route: the frame states why
   instead of greying the option out. Cleared on any navigation. */
let blocked = null;
/* Whether frame 1 has actually been answered — state.identityMode defaults to
   'guest', which would otherwise render as a choice the SE never made. */
let answered = false;

export const currentStep = () => state.step;
export const isCheckout = () => state.step === 'checkout';

/* app.js owns the client page (frame 4 is its shell + the flow's), so it
   supplies the repainter — same arrangement as customer-beat's panel hook. */
let repaintClient = () => {};
export function setClientRepainter(fn) { repaintClient = fn; }

export function goStep(step) {
  if (!STEPS.includes(step) || step === state.step) return;
  history.push(state.step);
  state.step = step;   // direct mutation — a step is not a flow reset
  blocked = null;
  repaintClient();
}
function back() {
  const prev = history.pop();
  if (!prev) return;
  state.step = prev;
  blocked = null;
  repaintClient();
}
/** A flow reset (vertical/model/env, or "Run another payment") starts over at
    frame 1 — which shows the signed-in view by itself when the customer
    survived, so "returning" needs no special case. */
export function resetSteps() {
  history = [];
  blocked = null;
  answered = false;
  state.step = 'account-q';
}

/* ── Frames ──────────────────────────────────────────────── */
const LOCK_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#a8a297" stroke-width="2.6"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>`;

/** The store's own header — every frame keeps it, so the left pane still reads
    as the merchant's site and not as a wizard. Shared with app.js's frame 4. */
export function storeHeadHTML() {
  const v = VERTICALS[state.vertical];
  return `
    <div class="co-merchant">${v.merchant}</div>
    <div class="co-tagline">${LOCK_SVG}${v.headline.toUpperCase()}</div>`;
}

function railHTML() {
  const n = STEPS.indexOf(state.step) + 1;
  return `
    <div class="step-rail">
      <span class="step-rail-n">Step ${n} of ${STEPS.length}</span>
      ${history.length ? `<button type="button" class="step-back" id="step-back">← Back</button>` : ''}
    </div>`;
}

function signedInFrameHTML(cus) {
  return `
    <div class="frame">
      <div class="frame-q">Welcome back</div>
      <div class="frame-sub">You're signed in. Your saved details are below.</div>
      ${customerRowHTML(cus)}
      <button type="button" class="co-cta" id="step-continue">Continue</button>
      <div class="frame-alts">
        <button type="button" class="cs-secondary" id="cus-get-send">Refresh my details</button>
        <button type="button" class="cs-secondary" id="step-guest">Check out as guest instead</button>
      </div>
    </div>`;
}

function accountQFrameHTML() {
  const cus = customers.getCustomerId();
  if (cus) return signedInFrameHTML(cus);
  return `
    <div class="frame">
      ${identityChooserHTML(answered)}
    </div>`;
}

function accountFrameHTML() {
  const cus = customers.getCustomerId();
  const cta = accountCtaState();
  return `
    <div class="frame">
      <div class="frame-q">Create your account</div>
      <div class="frame-sub">Save your details once and check out in two taps next time.</div>
      ${accountPanelHTML()}
      ${cus
        ? `<button type="button" class="co-cta" id="step-continue">Continue</button>`
        : `<div class="frame-actions">
             <button type="button" class="co-cta" id="acct-create" ${cta.sending ? 'disabled' : ''}>${cta.label}</button>
             <button type="button" class="cs-secondary" id="step-skip">Skip for now</button>
           </div>`}
    </div>`;
}

function blockerHTML() {
  if (!blocked) return '';
  const p = VERTICALS[state.vertical].products.find((x) => x.id === blocked);
  if (!p) return '';
  // Shopper-true only. WHY it can't stay a guest checkout is the SE's line, and
  // the engine room carries the detail (see renderStepPanels).
  return `
    <div class="frame-block">
      <div class="frame-block-t">${p.name} needs an account</div>
      <div class="frame-block-n">So we can charge your card each renewal.</div>
      <button type="button" class="cs-secondary" id="step-makeaccount">Create an account</button>
    </div>`;
}

function productFrameHTML() {
  return `
    <div class="frame">
      <div class="frame-q">What would you like to buy?</div>
      ${productColumnsHTML()}
      ${blockerHTML()}
    </div>`;
}

/** Frames 1–3. Frame 4 is app.js's checkout shell + the active flow. */
export function frameHTML() {
  const body =
    state.step === 'account'  ? accountFrameHTML()  :
    state.step === 'product'  ? productFrameHTML()  :
    accountQFrameHTML();
  return storeHeadHTML() + railHTML() + body;
}

/** The rail alone, for frame 4 (app.js renders the cart under it). */
export function stepRailHTML() { return railHTML(); }

/* ── Right pane on the frames that call nothing ───────────── */
function plateHTML(text) {
  return `<div class="eng-empty"><div class="ee-ico">◇</div><div class="ee-text">${text}</div></div>`;
}

/* The signed-in frame's one available call: re-read the customer from Rapyd.
   Prepared on render, fired from the LEFT — the engine room has no buttons of
   its own (design system §04.1 allows four variants, none of them Layer B) and
   §5 puts the firing click on the client surface. */
let getPainted = null;
function customerGetCardHTML(cus) {
  const salt = newSaltTimestamp();
  getPainted = { salt, path: `/v1/customers/${cus}` };
  return beatCardHTML({
    id: 'beat-cus-get', method: 'GET', path: getPainted.path, badge: 'prepared', badgeKind: '',
    inner: `
      ${headersHTML(salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">a GET carries none</span></div>`,
  });
}

async function fireRetrieve() {
  const cus = customers.getCustomerId();
  if (!cus) return;
  const btn = $('#cus-get-send');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  setStatus('Retrieving customer…', 'processing');
  let httpStatus = 0, data = null;
  try {
    ({ httpStatus, data } = await retrieveCustomer(cus, state.env, state.profile));
  } catch (err) {
    // An undeployed route answers without CORS headers — fetch rejects, and
    // leaving the button spinning forever would read as a hung demo.
    httpStatus = 0;
    data = { error: 'network_error', message: err.message };
  }
  const ok = httpStatus >= 200 && httpStatus < 400 && !data?.error;
  setStatus(ok ? 'Customer retrieved' : 'Error', ok ? 'ok' : 'error');
  const res = $('#panel-response');
  if (res) {
    res.innerHTML = beatCardHTML({
      id: 'beat-cus-get-res', method: 'GET', path: `/v1/customers/${cus}`,
      badge: ok ? 'CUSTOMER' : String(data?.error || 'ERROR'), badgeKind: ok ? 'ok' : 'err',
      inner: `
        <div class="eng-pillrow">
          <span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${httpStatus}</span>
        </div>
        ${renderJSONView(data ?? { error: 'no response body' })}`,
    });
  }
  setActiveTab('response'); // the SE asked for this call — following it is correct
  if (btn) { btn.disabled = false; btn.textContent = 'Refresh my details'; }
}

/** Paint the engine room for frames 1–3. Writes #panel-request always; touches
    #panel-response ONLY on the account frame, where beat 1's response IS the
    subject — anywhere else a write could clobber a payment response the SE
    stepped back from. */
export function renderStepPanels() {
  const req = $('#panel-request');
  if (!req) return;
  const cus = customers.getCustomerId();

  if (state.step === 'account') {
    req.innerHTML = customerRequestCardHTML()
      || plateHTML(`Pick <b>Create an account</b> to draft <code>POST /v1/customers</code>.`);
    fillCustomerSignature();
    const res = $('#panel-response');
    const resCard = customerResponseCardHTML();
    if (res && resCard) res.innerHTML = resCard;
    return;
  }

  if (state.step === 'account-q') {
    req.innerHTML = cus
      ? plateHTML(`This session already holds <code>${cus}</code>. Nothing needs creating — but you can re-read it.`) + customerGetCardHTML(cus)
      : plateHTML(`Nothing is called yet. <b>Create an account</b> makes <code>POST /v1/customers</code> beat 1; <b>guest</b> goes straight to <code>POST /v1/payments</code>.`);
    if (cus) fillSignature($('#beat-cus-get'), 'get', getPainted.path, getPainted.salt, null, 'beat-cus-get');
    return;
  }

  // product — choosing calls nothing; beat 1 stays inspectable below the plate.
  // A blocked guest subscription puts its REASON here, in the engine room: the
  // storefront just says an account is needed, the truth layer says why.
  req.innerHTML = plateHTML(blocked
    ? `No storable credential for a guest subscription. ${guestSubscribeBlocker()}`
    : `Choosing a product calls nothing. Next: <code>POST /v1/payments</code>, on the checkout.`)
    + customerRequestCardHTML();
  fillCustomerSignature();
}

/* The account frame's own footer changes with the beat (Skip → Continue), and
   fireCreateCustomer() only repaints #acct-block — so the frame has to follow
   the customer itself. Keyed on the ID CHANGING, not on any notification:
   typing in the form also notifies (setIdentity), and repainting the frame
   mid-keystroke would take the cursor with it. */
let lastSeenCustomer = customers.getCustomerId();
customers.subscribeCustomers(() => {
  const cus = customers.getCustomerId();
  if (cus === lastSeenCustomer) return;
  lastSeenCustomer = cus;
  if (state.leftView === 'client' && !isCheckout()) repaintClient();
});

/* ── Wiring — document-delegated once at module load, like the rest of the
   app: every frame's innerHTML is rebuilt far more often than any mount(). ── */
document.addEventListener('click', (e) => {
  if (e.target.closest('#step-back')) { back(); return; }

  // Frame 1's two answers.
  const answer = e.target.closest('.id-block [data-answer]');
  if (answer) {
    const a = answer.dataset.answer;
    answered = true;
    setIdentityMode(a === 'guest' ? 'guest' : 'account');
    goStep(a === 'guest' ? 'product' : 'account');
    return;
  }
  if (e.target.closest('#step-guest')) { answered = true; setIdentityMode('guest'); goStep('product'); return; }
  if (e.target.closest('#step-skip'))  { goStep('product'); return; }   // mode stays 'account' → lazy beat 1
  if (e.target.closest('#step-makeaccount')) { setIdentityMode('account'); goStep('account'); return; }
  if (e.target.closest('#step-continue')) {
    // Leaving the signed-in frame: a card on file makes this a returning
    // customer, which is what unlocks the saved-card view on the checkout.
    if (state.step === 'account-q') promoteToReturning();
    goStep('product');
    return;
  }
  if (e.target.closest('#cus-get-send')) { fireRetrieve(); return; }

  // Frame 3's product cards.
  const prod = e.target.closest('.prod-cols [data-product]');
  if (prod) {
    const id = prod.dataset.product;
    const p = VERTICALS[state.vertical].products.find((x) => x.id === id);
    if (!p) return;
    // A guest subscription is fine when the merchant can vault the PAN itself
    // (own-fields + NRID). Otherwise say why, and offer the account.
    if (p.billing === 'subscription' && chosenGuest() && !canGuestSubscribe()) {
      blocked = id;
      repaintClient();
      return;
    }
    state.selectedProduct = { vertical: state.vertical, productId: id };
    goStep('checkout');
  }
});
