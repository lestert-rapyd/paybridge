/* ─────────────────────────────────────────────────────────────
   The client page as a MERCHANT SITE — one page per beat.

   The client pane used to be four wizard frames; it is now a small
   generic storefront (js/site/) that every skin paints with its own
   tokens. The customer beat is still separated in TIME, not just in
   space, so the engine room only ever shows the call the current page
   is about:

     account-q · sign in / create an account / guest → no call (the
                  merchant's own login never calls Rapyd)
     account   · register: the account form          → POST /v1/customers
     shop      · catalog, one-off vs subscriptions    → no call
     product   · a product page                       → no call
     bag       · the bag and its rules                → no call
     checkout  · the cart (owned by app.js/flow)      → POST /v1/payments …
     orders    · the shopper's orders (ledger.js)     → no call
     methods   · saved cards (customers.js)           → GET …/payment_methods

   This module is the router: it draws pages 1–3 and the account pages
   from the js/site/ builders, paints the engine room for them, and
   wires every site control (document-delegated, once at load).

   Two invariants this module must not break:

   · A page change writes #panel-request ONLY — except the two pages whose
     subject IS a response (the register page's POST /v1/customers, the
     payment-methods page's list call). #panel-response and #panel-webhooks
     otherwise keep the last real call and its events.
   · A page change never calls setActiveTab(). Only the SE firing a call
     moves the tab (design system §5: never steal the tab mid-narration).
   ───────────────────────────────────────────────────────────── */

import { state, setState } from './state.js';
import { VERTICALS } from './verticals.js';
import { setIdentityMode, identityChooserHTML, promoteToReturning } from './identity.js';
import {
  accountPanelHTML, accountCtaState, customerRowHTML, customerRequestCardHTML,
  customerResponseCardHTML, fillCustomerSignature, beatCardHTML,
} from './customer-beat.js';
import * as customers from './customers.js';
import { subscribeLedger } from './ledger.js';
import { headersHTML, fillSignature, newSaltTimestamp } from './signing.js';
import { esc } from './ui.js';
import { addToCart, setLineQty, removeLine, cartLines, cartCount } from './site/cart.js';
import { siteHeaderHTML, backLinkHTML } from './site/chrome.js';
import { isSignedIn, signIn, signOut, markSignedIn } from './site/session.js';
import {
  shopPageHTML, productPageHTML, bagPageHTML, bagBlocker, setShopTab, viewProduct,
} from './site/shop.js';
import {
  ordersPageHTML, methodsPageHTML, fireMethodsSync,
  methodsRequestCardHTML, methodsResponseCardHTML, fillMethodsSignature,
} from './site/account.js';

const $ = (s, r = document) => r.querySelector(s);

export const STEPS = ['account-q', 'account', 'shop', 'product', 'bag', 'checkout', 'orders', 'methods'];
/* Pages that need a signed-in shopper; anyone else lands on sign-in. */
const MEMBERS_ONLY = new Set(['orders', 'methods']);

/* Whether the sign-in page has actually been answered — state.identityMode
   defaults to 'guest', which would otherwise render as a choice the SE never
   made. */
let answered = false;
/* The sign-in page's last refusal (shopper copy), cleared on any navigation. */
let signinError = null;
/* A terminal screen (screens.js success/decline) is on show: leaving it must
   reset the flow (new reference, fresh watch), not just swap the page. */
let resultShown = false;
/* Where the next flow reset lands — "Continue shopping" lands on the shop,
   "Try a different card" back on the checkout. One-shot. */
let landing = null;

export const isCheckout = () => state.step === 'checkout';

/* app.js owns the client page (the checkout is its shell + the flow's), so it
   supplies the repainter — same arrangement as customer-beat's panel hook. */
let repaintClient = () => {};
export function setClientRepainter(fn) { repaintClient = fn; }

export function goStep(step) {
  if (!STEPS.includes(step)) return;
  if (MEMBERS_ONLY.has(step) && !isSignedIn()) step = 'account-q';
  resultShown = false;
  signinError = null;
  const same = step === state.step;
  state.step = step;   // direct mutation — a page change is not a flow reset
  if (step === 'methods' && !same) {
    // A merchant's account page reads saved cards from its PSP. Fired on
    // ENTRY only (never on a repaint); the page repaints as it answers.
    fireMethodsSync(() => { if (state.step === 'methods' && state.leftView === 'client') repaintClient(); });
  }
  repaintClient();
}

/** Leave the current page for `step`. From a terminal screen that's a flow
    reset landing on `step`; anywhere else it's a plain page change. */
export function navigate(step) {
  if (resultShown) { landOn(step); setState({}); return; }
  goStep(step);
}

/** screens.js marks its terminal screens so the header's links reset. */
export function markResultShown() { resultShown = true; }
/** Pick the page the next flow reset lands on (one-shot). */
export function landOn(step) { landing = STEPS.includes(step) ? step : null; }

/** A flow reset (vertical/model/env, or a result screen's button) starts over
    at the sign-in page — which shows the signed-in view by itself when the
    customer survived — unless a landing was requested. */
export function resetSteps() {
  answered = false;
  signinError = null;
  resultShown = false;
  let next = landing || 'account-q';
  landing = null;
  if (MEMBERS_ONLY.has(next) && !isSignedIn()) next = 'shop';
  state.step = next;
}

/* After an identity answer, carry on where the shopper was heading: the bag if
   it holds anything, else the shop. */
const onward = () => (cartCount() ? 'bag' : 'shop');

/* ── Pages ───────────────────────────────────────────────── */

/** The checkout page's top: the site header plus its way back. Shared with
    app.js's own-fields shell and the toolkit's stage. */
export function stepRailHTML() {
  return `${siteHeaderHTML('checkout')}<div class="site-rail">${backLinkHTML('bag', 'Back to bag')}</div>`;
}

function signedInHTML() {
  return `
    <div class="frame">
      <div class="site-titles">
        <h1 class="site-h1">Welcome back</h1>
        <p class="site-sub">You’re signed in. Your saved details are below.</p>
      </div>
      ${customerRowHTML()}
      <button type="button" class="co-cta site-cta" id="step-continue">Continue</button>
      <button type="button" class="cs-secondary" id="step-guest">Check out as guest instead</button>
    </div>`;
}

/* Sign in · or · the identity question. The merchant's login is merchant-side
   (no Rapyd call); "create an account" is the route card whose consequence is
   the POST /v1/customers beat on the next page. */
function signInHTML() {
  const id = customers.getIdentity();
  return `
    <div class="frame">
      <div class="site-titles">
        <h1 class="site-h1">Welcome!</h1>
        <p class="site-sub">Sign in, or pick how you’d like to check out.</p>
      </div>
      <div class="site-form">
        <label class="acct-field"><span>Email address</span>
          <div class="co-input"><input id="site-email" type="email" autocomplete="off" value="${esc(id.email)}" /></div></label>
        <label class="acct-field"><span>Password</span>
          <div class="co-input"><input id="site-pw" type="password" autocomplete="off" placeholder="••••••••" /></div></label>
        ${signinError ? `<div class="acct-err" role="alert">${esc(signinError)}</div>` : ''}
        <button type="button" class="co-cta site-cta" id="site-signin">Sign in</button>
      </div>
      <div class="site-or"><span>or</span></div>
      ${identityChooserHTML(answered, 'New here?')}
    </div>`;
}

function accountQPageHTML() {
  return `
    ${siteHeaderHTML('account-q')}
    <main class="site-main site-narrow">${isSignedIn() ? signedInHTML() : signInHTML()}</main>`;
}

function accountPageHTML() {
  const cus = customers.getCustomerId();
  const cta = accountCtaState();
  return `
    ${siteHeaderHTML('account')}
    <main class="site-main site-narrow">
      ${backLinkHTML('account-q', 'Back')}
      <div class="frame">
        <div class="site-titles">
          <h1 class="site-h1">${cus ? 'You’re all set' : 'Hey there!'}</h1>
          <p class="site-sub">${cus ? 'Your account is ready.' : 'Let’s get you all set up.'}</p>
        </div>
        ${accountPanelHTML()}
        ${cus
          ? `<button type="button" class="co-cta site-cta" id="step-continue">Continue</button>`
          : `<div class="frame-actions">
               <button type="button" class="cs-secondary" id="step-skip">Skip for now</button>
               <button type="button" class="co-cta site-cta" id="acct-create" ${cta.sending ? 'disabled' : ''}>${cta.label}</button>
             </div>`}
      </div>
    </main>`;
}

/** Every page but the checkout (app.js renders that one with the flow). */
export function frameHTML() {
  switch (state.step) {
    case 'account':  return accountPageHTML();
    case 'shop':     return shopPageHTML();
    case 'product':  return productPageHTML();
    case 'bag':      return bagPageHTML();
    case 'orders':   return ordersPageHTML();
    case 'methods':  return methodsPageHTML();
    default:         return accountQPageHTML();
  }
}

/* The signed-in page PREPARES the retrieve so its shape is inspectable, but
   nothing on the storefront fires it: a shopper has no "re-read my customer
   record" button, and the one we had yanked the SE's tab to Response mid-
   sentence. The back office fires this same call from its customer view, which
   is where a merchant-side action belongs. */
let getPainted = null;
function customerGetCardHTML(cus) {
  const salt = newSaltTimestamp();
  getPainted = { salt, path: `/v1/customers/${cus}` };
  return beatCardHTML({
    // the cus_*** came back from Rapyd — beatCardHTML escapes the path text
    id: 'beat-cus-get', method: 'GET', path: getPainted.path, badge: 'prepared', badgeKind: '',
    inner: `
      ${headersHTML(salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">a GET carries none</span></div>`,
  });
}

/** Paint the engine room for every page but the checkout.

    No prose. A page that calls nothing shows the empty state the panel already
    ships with, plus whatever earlier beats are still inspectable — the SE says
    what the page is about. Writes #panel-request always; touches
    #panel-response ONLY where a response is the page's subject (register,
    payment methods) — anywhere else a write could clobber a payment response
    the SE stepped back from. */
export function renderStepPanels() {
  const req = $('#panel-request');
  if (!req) return;
  const cus = customers.getCustomerId();
  const res = $('#panel-response');

  if (state.step === 'account') {
    req.innerHTML = customerRequestCardHTML();
    fillCustomerSignature();
    const resCard = customerResponseCardHTML();
    if (res && resCard) res.innerHTML = resCard;
    return;
  }

  if (state.step === 'account-q') {
    const signedIn = isSignedIn();
    req.innerHTML = signedIn ? customerGetCardHTML(cus) : emptyRequestHTML();
    if (signedIn) fillSignature($('#beat-cus-get'), 'get', getPainted.path, getPainted.salt, null, 'beat-cus-get');
    return;
  }

  if (state.step === 'methods') {
    const listCard = methodsRequestCardHTML();
    req.innerHTML = (listCard + customerRequestCardHTML()) || emptyRequestHTML();
    fillMethodsSignature();
    fillCustomerSignature();
    const resCard = methodsResponseCardHTML();
    if (res && resCard) res.innerHTML = resCard;
    return;
  }

  // shop / product / bag / orders — browsing calls nothing; earlier beats stay inspectable.
  req.innerHTML = customerRequestCardHTML() || emptyRequestHTML();
  fillCustomerSignature();
}

/* The Request tab's own resting state, matching app.js's other empty panels. */
function emptyRequestHTML() {
  return `<div class="eng-empty"><div class="ee-ico">◇</div><div class="ee-text">The request body appears here as it's drafted.</div></div>`;
}

/* Pages that follow the customer store. The register page's footer changes
   with the beat (Skip → Continue), and fireCreateCustomer() only repaints
   #acct-block — so it follows the ID CHANGING, not every notification: typing
   in the form also notifies (setIdentity), and repainting mid-keystroke would
   take the cursor with it. A NEW customer is a signed-in shopper, wherever it
   was created (register page or the lazy beat at Pay). The payment-methods
   page repaints on any change (a sync landing, a harvest). */
let lastSeenCustomer = customers.getCustomerId();
customers.subscribeCustomers(() => {
  const cus = customers.getCustomerId();
  const changed = cus !== lastSeenCustomer;
  lastSeenCustomer = cus;
  if (changed && cus) markSignedIn();
  if (state.leftView !== 'client' || isCheckout()) return;
  if (changed || state.step === 'methods') repaintClient();
});

/* Orders follow the ledger (a payment settling, a refund landing). */
subscribeLedger(() => {
  if (state.step === 'orders' && state.leftView === 'client') repaintClient();
});

/* ── Wiring — document-delegated once at module load, like the rest of the
   app: every page's innerHTML is rebuilt far more often than any mount().
   Scoped to #checkout, the client site's root. ── */
document.addEventListener('click', (e) => {
  if (!e.target.closest('#checkout')) return;
  const t = e.target;

  // Site links and header (wordmark, nav, sign in, bag, back links).
  const nav = t.closest('[data-nav]');
  if (nav) { navigate(nav.dataset.nav); return; }
  if (t.closest('#site-signout')) { signOut(); navigate('account-q'); return; }

  // Sign-in page.
  if (t.closest('#site-signin')) {
    const err = signIn($('#site-email')?.value);
    if (err) { signinError = err; repaintClient(); return; }
    answered = true;
    goStep(onward());
    return;
  }
  const answer = t.closest('.id-block [data-answer]');
  if (answer) {
    const a = answer.dataset.answer;
    answered = true;
    setIdentityMode(a === 'guest' ? 'guest' : 'account');
    if (a !== 'guest' && customers.getCustomerId()) markSignedIn(); // the account exists — use it
    goStep(a === 'guest' ? onward() : 'account');
    return;
  }
  if (t.closest('#step-guest')) { answered = true; signOut(); goStep(onward()); return; }
  if (t.closest('#step-skip'))  { goStep(onward()); return; }   // mode stays 'account' → lazy beat 1
  if (t.closest('#step-makeaccount')) { setIdentityMode('account'); goStep('account'); return; }
  if (t.closest('#step-continue')) {
    // Leaving the signed-in page: a card on file makes this a returning
    // customer, which is what unlocks the saved-card view on the checkout.
    if (state.step === 'account-q') promoteToReturning();
    goStep(onward());
    return;
  }

  // Shop.
  const tab = t.closest('[data-shop-tab]');
  if (tab) { setShopTab(tab.dataset.shopTab); repaintClient(); return; }
  if (t.closest('#site-add')) {
    const id = t.closest('#site-add').dataset.product;
    const p = VERTICALS[state.vertical].products.find((x) => x.id === id);
    if (!p) return;
    addToCart(id, { isSubscription: p.billing === 'subscription' });
    goStep('bag');
    return;
  }
  const card = t.closest('.shop-card[data-product]');
  if (card) { viewProduct(card.dataset.product); goStep('product'); return; }

  // Bag.
  const qty = t.closest('[data-qty]');
  if (qty) {
    const line = cartLines().find((l) => l.productId === qty.dataset.qty);
    if (line) setLineQty(line.productId, line.qty + Number(qty.dataset.delta));
    repaintClient();
    return;
  }
  const rm = t.closest('[data-remove]');
  if (rm) { removeLine(rm.dataset.remove); repaintClient(); return; }
  if (t.closest('#site-checkout')) {
    if (!bagBlocker()) goStep('checkout');
  }
});

// Enter in the sign-in fields signs in (there is no <form>: nothing here is a
// credential a browser should offer to save).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest?.('#checkout .site-form')) return;
  $('#site-signin')?.click();
});
