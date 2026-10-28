/* ─────────────────────────────────────────────────────────────
   The client page as a MERCHANT SITE — one page per beat.

   The client pane used to be four wizard frames; it is now a small
   generic storefront (js/site/) that every skin paints with its own
   tokens. The customer beat is still separated in TIME, not just in
   space, so the engine room only ever shows the call the current page
   is about:

     account-q · sign in / create an account / guest → no call (the
                  merchant's own login never calls Rapyd) — except
                  "sign in with a customer ID"   → GET /v1/customers/{id}
     account   · register: the account form          → POST /v1/customers
     shop      · catalog, one-off vs subscriptions    → no call
     product   · a product page                       → no call
     bag       · the bag and its rules                → no call
     checkout  · the cart (owned by app.js/flow)      → POST /v1/payments …
     orders    · the shopper's orders (ledger.js)     → no call
     methods   · saved cards (customers.js)           → GET …/payment_methods
     wallet    · balance, deposit, withdraw            → deposit: the checkout's
                 (packs with a `wallet` rule only)        POST /v1/payments …;
                                                          withdraw: GET payout
                                                          method types → GET
                                                          required fields →
                                                          POST /v1/payouts

   This module is the router: it draws pages 1–3 and the account pages
   from the js/site/ builders, paints the engine room for them, and
   wires every site control (document-delegated, once at load).

   Two invariants this module must not break:

   · A page change writes #panel-request ONLY — except the pages whose
     subject IS a response (the register page's POST /v1/customers, the
     payment-methods page's list call, the wallet page's payout once one
     was sent — whose PAYOUT_* events webhooks.js paints as a section of
     its own while the wallet is on screen). #panel-response and #panel-webhooks
     otherwise keep the last real call and its events.
   · A page change never calls setActiveTab(). Only the SE firing a call
     moves the tab (design system §5: never steal the tab mid-narration).
   ───────────────────────────────────────────────────────────── */

import { state, setState } from './state.js';
import { VERTICALS, activeWallet, depositFor } from './verticals.js';
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
import {
  signInWithCustomerId, lookupStatus, lookupRequestCardHTML, lookupResponseCardHTML, fillLookupSignature,
} from './site/lookup.js';
import { clearPendingDeposit } from './site/wallet.js';
import { repaintWebhooks, setExtraWebhookSection } from './webhooks.js';
import {
  walletPageHTML, refreshWalletRegions, setWalletTab, setWalletAmount, pickWalletChip, pickWalletDest,
  startDeposit, fireWithdraw, walletRequestCardsHTML, fillWalletSignatures, walletResponseCardsHTML,
  walletWebhooksHTML, resetWalletPage, syncWalletStatus,
} from './site/wallet-page.js';

const $ = (s, r = document) => r.querySelector(s);

export const STEPS = ['account-q', 'account', 'shop', 'product', 'bag', 'checkout', 'orders', 'methods', 'wallet'];
/* Pages that need a signed-in shopper; anyone else lands on sign-in. */
const MEMBERS_ONLY = new Set(['orders', 'methods', 'wallet']);

/* Whether the sign-in page has actually been answered — state.identityMode
   defaults to 'guest', which would otherwise render as a choice the SE never
   made. */
let answered = false;
/* The sign-in page's last refusal (shopper copy), cleared on any navigation. */
let signinError = null;
/* The customer-ID sign-in's last refusal, and what was typed (kept across the
   repaints the lookup drives). */
let cusIdError = null;
let cusIdDraft = '';
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
/** Repaint the whole client page in place (header included) — for a change
    that reaches beyond one region, e.g. the shopper signing out mid-checkout. */
export function repaintSite() { if (state.leftView === 'client') repaintClient(); }

export function goStep(step) {
  if (!STEPS.includes(step)) return;
  if (step === 'wallet' && !activeWallet()) step = 'shop'; // this pack runs no wallet
  if (MEMBERS_ONLY.has(step) && !isSignedIn()) step = 'account-q';
  // A wallet deposit only lives on its checkout — any other page drops it, so
  // the bag (and the shop) charge what they say again.
  if (step !== 'checkout') clearPendingDeposit();
  resultShown = false;
  signinError = null;
  cusIdError = null;
  const same = step === state.step;
  state.step = step;   // direct mutation — a page change is not a flow reset
  if (step === 'methods' && !same) syncMethods();
  repaintClient();
}

/* A merchant's account page reads saved cards from its PSP: ONCE per visit of
   the payment-methods page (on entry — never on a repaint), or when the
   shopper hits Refresh. The page repaints as the call answers. */
function syncMethods() {
  fireMethodsSync(() => { if (state.step === 'methods' && state.leftView === 'client') repaintClient(); });
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
  const landed = landing;
  let next = landing || 'account-q';
  landing = null;
  if (next === 'wallet' && !activeWallet()) next = 'shop';
  if (MEMBERS_ONLY.has(next) && !isSignedIn()) next = 'shop';
  if (next !== 'checkout') clearPendingDeposit();
  // A real reset (skin / path / env) forgets the last withdrawal's beats; a
  // result screen's "Back to wallet" keeps them (a landing was requested).
  if (!landed) resetWalletPage();
  state.step = next;
}

/* After an identity answer, carry on where the shopper was heading: the bag if
   it holds anything, else the shop. */
const onward = () => (cartCount() ? 'bag' : 'shop');

/* ── Pages ───────────────────────────────────────────────── */

/** The checkout page's top: the site header plus its way back (to the bag, or
    to the wallet for a deposit). Shared with app.js's own-fields shell and the
    toolkit's stage. */
export function stepRailHTML() {
  const back = depositFor() ? backLinkHTML('wallet', 'Back to wallet') : backLinkHTML('bag', 'Back to bag');
  return `${siteHeaderHTML('checkout')}<div class="site-rail">${back}</div>`;
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
      ${cusIdHTML()}
    </div>`;
}

/* Sign in with a Rapyd customer ID — reaches a customer that exists at Rapyd
   but not in this tab (an earlier session, another laptop, the dashboard). */
function cusIdHTML() {
  const sending = lookupStatus() === 'sending';
  return `
    <details class="site-cusid" ${cusIdError || cusIdDraft || sending ? 'open' : ''}>
      <summary>Sign in with a customer ID</summary>
      <div class="site-cusid-row">
        <div class="co-input"><input id="site-cusid" autocomplete="off" spellcheck="false" placeholder="cus_…" value="${esc(cusIdDraft)}" ${sending ? 'disabled' : ''} /></div>
        <button type="button" class="site-btn-soft" id="site-cusid-go" ${sending ? 'disabled' : ''}>${sending ? 'Looking up…' : 'Sign in'}</button>
      </div>
      ${cusIdError ? `<div class="acct-err" role="alert">${esc(cusIdError)}</div>` : ''}
    </details>`;
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
    case 'wallet':   return walletPageHTML();
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
    // A customer-ID sign-in is this page's one real call: it owns the panels
    // while it's in flight and after it answered (its response IS the subject).
    const lookupCard = lookupRequestCardHTML();
    if (lookupCard) {
      req.innerHTML = lookupCard;
      fillLookupSignature();
      const resCard = lookupResponseCardHTML();
      if (res && resCard) res.innerHTML = resCard;
      return;
    }
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

  if (state.step === 'wallet') { paintWalletPanels(); return; }

  // shop / product / bag / orders — browsing calls nothing; earlier beats stay inspectable.
  req.innerHTML = customerRequestCardHTML() || emptyRequestHTML();
  fillCustomerSignature();
}

/* The wallet page: the withdrawal's beats (or the prepared POST /v1/payouts on
   the Withdraw tab) own Request; Response and Webhooks only once a withdrawal
   has answered — before that they keep the last real call's. */
function paintWalletPanels() {
  const req = $('#panel-request');
  const res = $('#panel-response');
  req.innerHTML = walletRequestCardsHTML() || customerRequestCardHTML() || emptyRequestHTML();
  fillWalletSignatures();
  fillCustomerSignature();
  const resCards = walletResponseCardsHTML();
  if (res && resCards) res.innerHTML = resCards;
  repaintWebhooks(); // webhooks.js stays the one writer — the payout section is registered below
}
setExtraWebhookSection(() => (state.step === 'wallet' ? walletWebhooksHTML() : ''));

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
  if (state.leftView !== 'client') return;
  // The checkout page is the flow's — never repainted wholesale from here (a
  // toolkit iframe or a 3DS challenge may be on it) — but its site header
  // still has to follow a customer arriving or being forgotten.
  if (isCheckout()) { if (changed) refreshSiteHeader(); return; }
  if (changed || state.step === 'methods') repaintClient();
});

/** Swap just the site header in place — the account links and the bag badge
    follow the session without disturbing the page under them. */
export function refreshSiteHeader() {
  const head = $('#checkout .site-head');
  if (head) head.outerHTML = siteHeaderHTML(state.step);
}

/* Orders follow the ledger (a payment settling, a refund landing); the wallet
   repaints its ledger-driven regions (never the amount being typed) and its
   engine room (a payout settling, PAYOUT_* events arriving). */
subscribeLedger(() => {
  if (state.leftView !== 'client') return;
  if (state.step === 'orders') repaintClient();
  if (state.step === 'wallet') { refreshWalletRegions(); paintWalletPanels(); syncWalletStatus(); }
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
  if (t.closest('#pm-refresh')) { syncMethods(); return; }

  // Sign in with a customer ID.
  if (t.closest('#site-cusid-go')) { lookupCustomer(); return; }

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
    return;
  }

  // Wallet.
  const wtab = t.closest('[data-wal-tab]');
  if (wtab) { setWalletTab(wtab.dataset.walTab); repaintClient(); return; }
  const chip = t.closest('[data-wal-chip]');
  if (chip) {
    pickWalletChip(chip.dataset.walChip);
    const input = $('#wal-amount');
    if (input) input.value = chip.dataset.walChip;
    refreshWalletRegions();
    paintWalletPanels();
    return;
  }
  const dest = t.closest('[data-wal-dest]');
  if (dest) { pickWalletDest(dest.dataset.walDest); refreshWalletRegions(); paintWalletPanels(); return; }
  if (t.closest('#wal-deposit')) {
    if (startDeposit()) goStep('checkout');
    else refreshWalletRegions();
    return;
  }
  if (t.closest('#wal-withdraw')) {
    fireWithdraw(() => {
      if (state.step !== 'wallet' || state.leftView !== 'client') return;
      refreshWalletRegions();
      paintWalletPanels();
    });
  }
});

async function lookupCustomer() {
  cusIdDraft = $('#site-cusid')?.value.trim() || '';
  cusIdError = null;
  const paint = () => { if (state.step === 'account-q' && state.leftView === 'client') repaintClient(); };
  const err = await signInWithCustomerId(cusIdDraft, paint);
  if (err) { cusIdError = err; paint(); return; }
  // Rapyd knows them: they're this site's signed-in shopper now, with
  // whatever cards Rapyd holds for them (the list call fills them in).
  cusIdDraft = '';
  answered = true;
  markSignedIn();
  setIdentityMode('account');
  customers.markResynced();
  fireMethodsSync(() => { promoteToReturning(); if (state.leftView === 'client' && !isCheckout()) repaintClient(); });
  if (state.step === 'account-q') goStep(onward());
}

// Enter in the sign-in fields signs in (there is no <form>: nothing here is a
// credential a browser should offer to save).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'site-cusid') { $('#site-cusid-go')?.click(); return; }
  if (e.target.id === 'wal-amount') { ($('#wal-deposit') || $('#wal-withdraw'))?.click(); return; }
  if (!e.target.closest?.('#checkout .site-form')) return;
  $('#site-signin')?.click();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'site-cusid') cusIdDraft = e.target.value;
  if (e.target.id === 'wal-amount') {
    setWalletAmount(e.target.value);
    // only the regions that follow the amount — the input keeps its caret
    refreshWalletRegions();
    if (state.leftView === 'client') paintWalletPanels();
  }
});
