/* ─────────────────────────────────────────────────────────────
   The merchant site's "Add a card" page — the payment-methods page's
   call to action. Signed-in only (a card is always filed under the
   shopper's cus_***). HOW the card gets saved follows the drawer's
   integration path — the same switch the checkout follows — so the SE
   picks the story there, never on the shopper's page:

     Checkout Toolkit (non-PCI) — the Hosted Tokenisation Page (HTP):
       POST /v1/hosted/collect/card → hp_card_***, then
         · Hosted page mode       → full redirect to the page's redirect_url
                                    (opened in a new tab; the frame shows a
                                    labelled stand-in on Rapyd's domain)
         · Full toolkit / Wallets → the card-token toolkit (RapydToolkit,
                                    page_type "card_token") in the frame
       Rapyd collects + verifies the card (its 3DS included) and files the
       card_*** under the customer. Allowed in live: no card data here.

     Own Card Fields (PCI) — sandbox only (a raw card on the merchant's
     servers), by the MID's 3DS provider (profiles.js tds):
         · Rapyd 3DS (SC1, SC3)   → $0-auth: POST /v1/payments, amount 0,
                                    capture false, save_payment_method,
                                    3d_required → Rapyd's 3DS in the frame
                                    → the payment's card_***
         · external 3DS (SC2)     → the merchant's own provider first
                                    (simulated, js/ext3ds.js); only a pass
                                    calls Rapyd: POST /v1/customers/{id}/
                                    payment_methods with the results in
                                    payment_method_options (3d_version,
                                    cavv, eci, ds_trans_id) → card_*** at
                                    once. A fail never reaches Rapyd.
       (Rapyd's "create a customer with a card and external 3DS data" is
       the same body on POST /v1/customers; the shopper here already HAS a
       customer, so the card is added to it instead. Rapyd checked
       2026-11-05: SC2 answers card_*** with next_action not_applicable;
       on a Rapyd-3DS MID the same call is sent to Rapyd's 3DS.)

   Every route ends the same way: GET /v1/customers/{id}/payment_methods
   confirms the card at Rapyd, and it joins customers.js's store with the
   purpose the shopper picked ("Checkout" = unscheduled, "Subscriptions" =
   recurring — card_fields / fields.recurrence_type).

   Docs: docs.rapyd.net/en/create-card-token.html,
   …/hosted-save-card-details-page.html (toolkit: toolkit.rapyd.net,
   RapydToolkit, displayToolkit(), onSaveCardDetails* events), …/payments
   ($0-auth), …/creating-a-card-payment-with-an-external-3ds-provider.html.

   Markup, beats and orchestration; js/steps.js routes, wires and paints.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import * as customers from '../customers.js';
import {
  createCardTokenPage, addCustomerPaymentMethod, createDirectPayment, retrievePayment,
  listCustomerPaymentMethods, fetchCustomerWebhooks, newReference, newIdempotencyKey,
} from '../api.js';
import { profileEwallet } from '../profiles.js';
import { clientDetails } from '../client-details.js';
import { usesExternal3DS, simulateExternal3DS, ext3dsDecision, ext3dsPreset, authRequestSummary } from '../ext3ds.js';
import { beatCardHTML } from '../customer-beat.js';
import { renderJSONView } from '../json-view.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import { setActiveTab, setStatus, esc } from '../ui.js';
import { detectBrand, brandLabel, formatNumber, formatExpiry, parseExpiry, luhn, expiryValid } from '../sync.js';
import { render3DS, renderExternal3DS } from '../screens.js';
import { eventCardHTML } from '../webhooks.js';
import { seamWrapHTML, SEAM_LABELS, hostedAddress, setAddress, pagePath } from '../seam.js';
import { logConsole, returnUrl, sharedToolkitMode } from '../flows/toolkit-common.js';
import { siteHeaderHTML, backLinkHTML } from './chrome.js';

const $ = (s, r = document) => r.querySelector(s);

/* ── Which route ─────────────────────────────────────────── */
export const ADD_CARD_METHODS = {
  'htp-redirect': 'Hosted tokenisation page · full redirect',
  'htp-toolkit': 'Hosted tokenisation page · toolkit',
  's2s-rapyd': 'Direct S2S · $0-auth with Rapyd 3DS',
  's2s-external': 'Direct S2S · merchant’s own 3DS',
};

/** The route for this context (pure). Own Card Fields can't take a raw card
    in live, so live falls back to the toolkit — Rapyd's page, no card here. */
export function addCardMethod({ model, env, profile, toolkitMode = 'embedded' } = {}) {
  if (model === 'toolkit') return toolkitMode === 'hosted' ? 'htp-redirect' : 'htp-toolkit';
  if (env === 'live') return 'htp-toolkit';
  return usesExternal3DS({ env, profile, model }) ? 's2s-external' : 's2s-rapyd';
}
const methodNow = () => addCardMethod({ model: state.model, env: state.env, profile: state.profile, toolkitMode: sharedToolkitMode() });
const isHtp = (m) => m.startsWith('htp');

/* ── Request bodies (pure — tests/unit.js) ───────────────── */
const PAGE_LIFETIME_S = 3600; // page_expiration: an hour is plenty for a demo

/** POST /v1/hosted/collect/card. `urls` = { complete, cancel } return pages. */
export function htpBody({ customer, country, recurrence_type = 'unscheduled', urls, now = Date.now() } = {}) {
  return {
    customer,
    country,
    language: 'en',
    complete_url: urls.complete,
    cancel_url: urls.cancel,
    complete_payment_url: urls.complete,
    error_payment_url: urls.cancel,
    page_expiration: Math.floor(now / 1000) + PAGE_LIFETIME_S,
    card_fields: { recurrence_type },
  };
}

/** The card as Rapyd's `fields` (from the form's raw values). */
export function cardFields(card, recurrence_type) {
  const { month, year } = parseExpiry(card.expiry);
  return {
    number: String(card.number || '').replace(/\D/g, ''),
    expiration_month: month,
    expiration_year: year,
    cvv: card.cvv,
    name: card.name,
    recurrence_type,
  };
}

/** $0-auth with Rapyd 3DS — POST /v1/payments. 3DS is mandatory for card
    verification; address, receipt_email and client_details feed it. */
export function zeroAuthBody({ card, recurrence_type, customer, currency, reference, descriptor, ewallet, address, email, client, urls }) {
  const body = {
    amount: 0,
    currency,
    capture: false,
    customer,
    merchant_reference_id: reference,
    statement_descriptor: descriptor,
    description: 'Card verification',
    complete_payment_url: urls.complete,
    error_payment_url: urls.cancel,
    payment_method: { type: detectBrand(card.number).type, fields: cardFields(card, recurrence_type) },
    initiation_type: 'customer_present',
    payment_method_options: { '3d_required': true },
    address,
    receipt_email: email,
    client_details: client,
    save_payment_method: true,
  };
  if (ewallet) body.ewallet = ewallet;
  return body;
}

/** Add a card with the merchant's own 3DS results — POST /v1/customers/{id}/
    payment_methods. `customer` travels in the body to our backend, which
    moves it into the path. `tds` = ext3ds.js externalTdsOptions(), or the
    placeholder while the provider hasn't answered. */
export function externalAddBody({ card, recurrence_type, customer, tds, urls }) {
  return {
    customer,
    type: detectBrand(card.number).type,
    fields: cardFields(card, recurrence_type),
    complete_payment_url: urls.complete, // Rapyd may verify the card with a payment
    error_payment_url: urls.cancel,
    payment_method_options: tds,
  };
}

/* ── Page state (module-local; survives repaints, not reloads) ── */
const card = { number: '', expiry: '', cvv: '', name: '' };
let use = 'unscheduled';       // 'unscheduled' (Checkout) | 'recurring' (Subscriptions)
let formError = null;
/* The run: { method, key, cus, phase, startAt, create, auth, verify, list,
   cardId, cardLabel, error, redirect, ext } — each beat is
   { method, path, salt, body, status: 'sending'|'done', httpStatus, data }.
   phase: creating | toolkit | away | 3ds | authenticating | sending |
          confirming | done | failed | cancelled */
let run = null;
let seq = 0;
const IN_FLIGHT = new Set(['creating', 'toolkit', 'away', '3ds', 'authenticating', 'sending', 'confirming']);
const inFlight = () => !!run && IN_FLIGHT.has(run.phase);

/* steps.js hands over its repainters (it imports this module, so the reverse
   import would be a cycle). Both no-op unless this page is on screen. */
let hooks = { page: () => {}, panels: () => {} };
export function setAddCardHooks(h) { hooks = { ...hooks, ...h }; }
const onPage = () => state.step === 'add-card' && state.leftView === 'client';
const repaintPage = () => { if (onPage()) hooks.page(); };
const repaintPanels = () => { if (onPage()) hooks.panels(); };

/** A fresh visit: a finished run is history; one in flight is kept. */
export function enterAddCard() {
  if (!inFlight()) { run = null; formError = null; }
}
/** Flow reset (skin / path / env / profile): drop everything. */
export function resetAddCard() {
  seq++;
  run = null;
  formError = null;
  stopWatches();
}

const urlsNow = () => ({ complete: returnUrl('complete', 'for=card'), cancel: returnUrl('cancel', 'for=card') });
const currencyNow = () => VERTICALS[state.vertical].products?.[0]?.currency || 'USD';
const countryNow = () => customers.demoAddress().country || 'GB';
const ok = (b) => b && b.status === 'done' && b.httpStatus >= 200 && b.httpStatus < 400 && !b.data?.error;

/* ── Left: the page ──────────────────────────────────────── */
function useHTML(disabled) {
  return `
    <div class="ac-use">
      <div class="ac-use-label">Use this card for</div>
      <div class="cof-dp" id="ac-use">
        <button type="button" data-ac-use="unscheduled" class="${use === 'unscheduled' ? 'active' : ''}" ${disabled}>Checkout</button>
        <button type="button" data-ac-use="recurring" class="${use === 'recurring' ? 'active' : ''}" ${disabled}>Subscriptions</button>
      </div>
    </div>`;
}

function formHTML() {
  return `
    <div class="ac-form">
      <div class="ac-form-head"><span>Card details</span><button type="button" class="use-test" id="ac-test">Use test card</button></div>
      <div class="co-field">
        <label for="ac-number">Card number</label>
        <div class="co-input"><input id="ac-number" inputmode="numeric" autocomplete="cc-number" placeholder="4111 1111 1111 1111" maxlength="23" value="${esc(card.number)}" /></div>
      </div>
      <div class="co-row">
        <div class="co-field">
          <label for="ac-expiry">Expiry</label>
          <div class="co-input"><input id="ac-expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="12 / 27" maxlength="7" value="${esc(card.expiry)}" /></div>
        </div>
        <div class="co-field">
          <label for="ac-cvv">CVV</label>
          <div class="co-input"><input id="ac-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" value="${esc(card.cvv)}" /></div>
        </div>
      </div>
      <div class="co-field">
        <label for="ac-name">Name on card</label>
        <div class="co-input"><input id="ac-name" autocomplete="cc-name" placeholder="Jordan Taylor" value="${esc(card.name)}" /></div>
      </div>
    </div>`;
}

function introHTML(method) {
  const v = VERTICALS[state.vertical];
  if (isHtp(method)) {
    return `
      <div class="ac-intro">
        <div class="ac-intro-t">Your card details stay with our payment partner</div>
        <p>You’ll enter your card on a secure page from our payment provider — ${esc(v.merchant)} never sees your card number. Your bank may ask you to confirm it’s you. You won’t be charged.</p>
      </div>`;
  }
  return `<p class="ac-note">We’ll check this card with your bank — you won’t be charged.</p>`;
}

function ctaLabel(method) {
  if (method === 'htp-redirect') return 'Continue to secure page';
  if (method === 'htp-toolkit') return 'Add card';
  return 'Save card';
}

function idleHTML() {
  const method = methodNow();
  return `
    <div class="site-titles">
      <h1 class="site-h1">Add a card</h1>
      <p class="site-sub">Save a card for faster checkout.</p>
    </div>
    ${useHTML('')}
    ${isHtp(method) ? '' : formHTML()}
    ${introHTML(method)}
    ${formError ? `<div class="acct-err" role="alert">${esc(formError)}</div>` : ''}
    <button type="button" class="co-cta site-cta" id="ac-go">${esc(ctaLabel(method))}</button>`;
}

function waitHTML(title, sub) {
  return `
    <div class="screen proc" role="status" aria-live="polite">
      <div class="proc-spinner" aria-hidden="true"></div>
      <div class="proc-title">${esc(title)}</div>
      <div class="proc-sub">${esc(sub)}</div>
    </div>`;
}

function resultHTML() {
  const done = run.phase === 'done';
  const cancelled = run.phase === 'cancelled';
  const title = done ? 'Card saved' : cancelled ? 'No card added' : 'We couldn’t add this card';
  const sub = done
    ? `${run.cardLabel || 'Your card'} is ready for ${use === 'recurring' ? 'your subscriptions' : 'faster checkout'}.`
    : cancelled ? 'You left the secure page — nothing was saved.'
      : (run.error || 'Your bank didn’t confirm this card. Nothing was saved — try again, or use a different card.');
  return `
    <div class="screen ac-result ${done ? 'ok' : 'bad'}">
      <div class="ac-result-badge ${done ? 'ok' : 'bad'}" aria-hidden="true">${done ? '✓' : '✕'}</div>
      <div class="proc-title">${esc(title)}</div>
      <div class="proc-sub">${esc(sub)}</div>
      <div class="screen-actions">
        ${done ? '' : `<button type="button" class="cs-secondary" id="ac-retry">Try again</button>`}
        <button type="button" class="co-cta site-cta" data-nav="methods">Back to payment methods</button>
      </div>
    </div>`;
}

function toolkitStageHTML() {
  return seamWrapHTML('<div id="rapyd-toolkit"></div>', SEAM_LABELS.cardToken, 'seam-iframe');
}

function awayHTML() {
  const addr = hostedAddress(run.redirect, state.env);
  const v = VERTICALS[state.vertical];
  return `
    <div class="hp-stage">
      ${seamWrapHTML(`
        <div class="hp-away" id="ac-away">
          <div class="hp-away-host">${esc(addr.host)}</div>
          <div class="hp-away-title">Adding a card on Rapyd’s secure page</div>
          <div class="hp-away-sub">Rapyd’s real page is open in a new tab — the shopper enters the card there. When they finish, Rapyd sends them back to ${esc(v.merchant)}.</div>
          <div class="hp-away-actions">
            <button type="button" class="hp-btn" id="ac-reopen">Reopen secure page ↗</button>
            <button type="button" class="hp-link" id="ac-back" title="What Rapyd’s back link does — cancel_url">‹ Back to ${esc(v.merchant)}</button>
          </div>
        </div>`, SEAM_LABELS.hostedCard, 'seam-page')}
    </div>`;
}

/** The whole page. Frames Rapyd owns (the 3DS challenge, the toolkit, the
    external provider) are written by the run itself; a repaint landing while
    one is up shows a neutral wait instead of reloading the iframe. */
export function addCardPageHTML() {
  let inner;
  if (!run) inner = idleHTML();
  else if (run.phase === 'away') return awayHTML(); // Rapyd's domain — no merchant header
  else if (run.phase === 'toolkit') inner = `${titlesHTML('Add a card', 'Enter your card below — it goes straight to our payment provider.')}${toolkitStageHTML()}`;
  else if (['done', 'failed', 'cancelled'].includes(run.phase)) inner = resultHTML();
  else inner = waitHTML(...waitCopy());
  return `
    ${siteHeaderHTML('add-card')}
    <main class="site-main site-narrow">
      ${run && run.phase !== 'idle' ? '' : backLinkHTML('methods', 'Payment methods')}
      ${inner}
    </main>`;
}
function titlesHTML(t, s) {
  return `<div class="site-titles"><h1 class="site-h1">${esc(t)}</h1><p class="site-sub">${esc(s)}</p></div>`;
}
function waitCopy() {
  switch (run?.phase) {
    case 'creating': return ['Opening the secure page…', 'This only takes a moment.'];
    case '3ds': return ['Confirming with your bank…', 'Finish the check your bank asked for.'];
    case 'authenticating': return ['Confirming with your bank…', 'This only takes a moment.'];
    case 'confirming': return ['Saving your card…', 'Just a moment while we confirm it.'];
    default: return ['Saving your card…', 'This only takes a moment.'];
  }
}

/* The frames, written straight into the client host (no repaint). */
const host = () => document.getElementById('checkout');
function paintFrame() {
  const el = host();
  if (!el || !onPage()) return;
  document.querySelector('.browser')?.classList.remove('wide-tk', 'wide-3ds');
  el.innerHTML = addCardPageHTML();
}

/* ── Form wiring (steps.js delegates) ────────────────────── */
export function setAddCardUse(v) { if (!inFlight() && (v === 'unscheduled' || v === 'recurring')) use = v; }
export function setAddCardField(id, raw) {
  if (id === 'ac-number') card.number = formatNumber(raw);
  else if (id === 'ac-expiry') card.expiry = formatExpiry(raw);
  else if (id === 'ac-cvv') card.cvv = String(raw || '').replace(/\D/g, '').slice(0, 4);
  else if (id === 'ac-name') card.name = String(raw || '');
  else return null;
  formError = null;
  return id === 'ac-name' ? card.name : id === 'ac-number' ? card.number : id === 'ac-expiry' ? card.expiry : card.cvv;
}
export function fillAddCardTestCard() {
  card.number = '4111 1111 1111 1111';
  card.expiry = '12 / 27';
  card.cvv = '123';
  card.name = customers.getIdentity().name || 'Jordan Taylor';
  formError = null;
}
export function retryAddCard() { if (!inFlight()) { run = null; formError = null; } }

function cardProblem() {
  const digits = card.number.replace(/\D/g, '');
  if (digits.length < 12 || !luhn(digits)) return 'Check the card number.';
  const { month, year } = parseExpiry(card.expiry);
  if (!month || !year || !expiryValid(month, year)) return 'Check the expiry date.';
  if (!/^\d{3,4}$/.test(card.cvv)) return 'Check the CVV.';
  if (!card.name.trim()) return 'Add the name on the card.';
  return null;
}

/* ── The run ─────────────────────────────────────────────── */
function beat(method, path, body) {
  return { method, path, body, salt: newSaltTimestamp(), status: 'sending', httpStatus: null, data: null };
}
async function send(b, call, payload) {
  let res;
  try { res = await call(payload, { idempotencyKey: newIdempotencyKey() }); }
  catch (err) { res = { httpStatus: 0, data: { error: 'NETWORK_ERROR', message: err?.message || 'request failed' } }; }
  b.status = 'done';
  b.httpStatus = res?.httpStatus ?? 0;
  b.data = res?.data ?? null;
  return b;
}
const shopperError = (b) => (b?.data?.error && /^(LIVE_|UNKNOWN_PROFILE$|MISSING_)/.test(b.data.error))
  ? 'Card saving isn’t available right now. Please try again later.'
  : null;

/** The page's one action. Never rejects. */
export async function startAddCard() {
  if (inFlight()) return;
  const cus = customers.getCustomerId();
  if (!cus) return;
  const method = methodNow();
  if (!isHtp(method)) {
    const bad = cardProblem();
    if (bad) { formError = bad; repaintPage(); return; }
  }
  const mySeq = ++seq;
  run = {
    method, key: customers.bucketKey(), cus, env: state.env, profile: state.profile,
    phase: 'creating', startAt: Date.now(), use,
    create: null, auth: null, verify: null, list: null, ext: null,
    cardId: null, cardLabel: null, error: null, redirect: null, baseline: null,
  };
  const r = run;
  const alive = () => mySeq === seq && run === r;
  setStatus('Adding a card…', 'processing');
  setActiveTab('response');
  watchWebhooks(r);
  try {
    if (isHtp(method)) await runHtp(r, alive);
    else if (method === 's2s-rapyd') await runZeroAuth(r, alive);
    else await runExternal(r, alive);
  } catch (err) {
    if (!alive()) return;
    finish(r, 'failed', 'Something went wrong on our side. Please try again.');
    logConsole('client error', err?.message || String(err), 'app', 'err');
  }
}

function finish(r, phase, error = null) {
  r.phase = phase;
  r.error = error;
  stopPolls();
  if (phase === 'done') setStatus('Card saved', 'ok');
  else if (phase === 'cancelled') setStatus('Cancelled', 'idle');
  else setStatus('Card not saved', 'error');
  setAddress(VERTICALS[state.vertical].domain, pagePath('add-card'));
  document.querySelector('.browser')?.classList.remove('wide-3ds');
  paintFrame();
  repaintPanels();
}

/* The card's identity, filed with the shopper's chosen purpose — then the list
   call fills in the rest (expiry, NRID) and is the page's last beat. */
async function confirmCard(r, alive, { cardId, type = null, last4 = null }) {
  if (r.cardId) return; // the toolkit event and the list poll can both find it
  r.cardId = cardId;
  customers.upsertTokenCredential({
    card_id: cardId, type, brand: type ? brandLabel(type) : null, last4,
    recurrence_type: r.use, aft: false,
    origin_vertical: state.vertical, origin_model: state.model, origin_product: null,
  }, { key: r.key });
  r.list = beat('GET', `/v1/customers/${r.cus}/payment_methods?category=card`, null);
  repaintPanels();
  logConsole('GET /v1/customers/{id}/payment_methods', 'confirming the saved card', 'api');
  const { httpStatus, data } = await customers.refreshTokens({ key: r.key });
  if (!alive()) return;
  r.list.status = 'done';
  r.list.httpStatus = httpStatus;
  r.list.data = data;
  const saved = customers.credentials().find((c) => c.card_id === cardId);
  r.cardLabel = saved ? `${saved.brand || 'Card'} •••• ${saved.last4 || '····'}` : null;
  logConsole('card saved', `${cardId} · recurrence ${r.use}`, 'api', 'ok');
  finish(r, 'done');
}

/* ── Hosted Tokenisation Page ── */
async function runHtp(r, alive) {
  const body = htpBody({ customer: r.cus, country: countryNow(), recurrence_type: r.use, urls: urlsNow() });
  r.create = beat('POST', '/v1/hosted/collect/card', body);
  r.baseline = new Set(customers.credentials().filter((c) => c.card_id).map((c) => c.card_id));
  paintFrame();
  repaintPanels();
  logConsole('POST /v1/hosted/collect/card', 'creating the hosted tokenisation page', 'api');
  await send(r.create, createCardTokenPage, { ...body, env: r.env, profile: r.profile });
  if (!alive()) return;
  const d = r.create.data?.data;
  if (!ok(r.create) || !d?.id) {
    logConsole('POST /v1/hosted/collect/card', r.create.data?.message || r.create.data?.error || 'failed', 'api', 'err');
    finish(r, 'failed', shopperError(r.create) || 'We couldn’t open the secure page. Please try again.');
    return;
  }
  logConsole('POST /v1/hosted/collect/card', `${d.id} · ${d.status || 'NEW'}`, 'api', 'ok');
  r.redirect = d.redirect_url;
  if (r.method === 'htp-redirect') goAway(r, alive);
  else await renderCardToolkit(r, alive, d.id);
}

function goAway(r, alive) {
  r.phase = 'away';
  const addr = hostedAddress(r.redirect, r.env);
  setAddress(addr.host, addr.path, true);
  paintFrame();
  repaintPanels();
  setStatus('On Rapyd’s secure page', 'action');
  logConsole('redirect → hosted tokenisation page', addr.host, 'tk', 'action');
  openRedirect(r);
  listenForReturn();
  // The return page tells this tab over a BroadcastChannel when it's served
  // from the same origin; the list poll also notices the card by itself.
  pollForCard(r, alive);
}
function openRedirect(r) { if (r?.redirect) window.open(r.redirect, '_blank', 'noopener'); }

let returnChannel = null;
function listenForReturn() {
  if (returnChannel || typeof BroadcastChannel === 'undefined') return;
  try {
    returnChannel = new BroadcastChannel('rapyd-demo-hosted');
    returnChannel.onmessage = (e) => {
      if (e.data?.for !== 'card' || !run) return;
      if (e.data.page === 'cancel') returnFromRapyd('cancel', 'return page');
      if (e.data.page === 'complete') returnFromRapyd('complete', 'return page');
    };
  } catch { /* no channel — the list poll still finds the card */ }
}

/** Back on the merchant's site from Rapyd's page (back link or return page). */
export function returnFromRapyd(page, via = 'back link') {
  const r = run;
  if (!r || (r.phase !== 'away' && r.phase !== '3ds')) return;
  if (page === 'cancel') {
    logConsole('cancel_url', `shopper back on ${VERTICALS[state.vertical].domain} · ${via}`, 'tk');
    finish(r, r.phase === '3ds' ? 'failed' : 'cancelled', r.phase === '3ds' ? 'Your bank didn’t confirm this card. Nothing was saved.' : null);
    return;
  }
  logConsole('complete_url', `shopper back on ${VERTICALS[state.vertical].domain} · ${via}`, 'tk', 'ok');
  if (r.phase === 'away') {
    r.phase = 'confirming';
    setAddress(VERTICALS[state.vertical].domain, pagePath('add-card'));
    paintFrame();
  }
}
export function reopenAddCardPage() { openRedirect(run); }

/* Poll the customer's cards until one appears that wasn't there before. */
let pollTimer = null;
function stopPolls() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function pollForCard(r, alive, { every = 4000, until = Date.now() + 10 * 60000 } = {}) {
  stopPolls();
  const tick = async () => {
    if (!alive() || r.cardId || !['away', 'toolkit', '3ds', 'confirming'].includes(r.phase)) return;
    const res = await listCustomerPaymentMethods(r.cus, { env: r.env, profile: r.profile }).catch(() => null);
    if (!alive()) return;
    const fresh = (res?.data?.data || []).find((c) => /^card_/.test(c?.id || '') && !r.baseline.has(c.id));
    if (fresh) { await confirmCard(r, alive, { cardId: fresh.id, type: fresh.type, last4: fresh.last4 }); return; }
    if (Date.now() > until) { finish(r, 'failed', 'We didn’t hear back from the secure page. Nothing was saved.'); return; }
    pollTimer = setTimeout(tick, every);
  };
  pollTimer = setTimeout(tick, every);
}

/* The card-token toolkit — Rapyd's page inside the merchant's frame. */
const CARD_TOOLKIT_SRC = { sandbox: 'https://sandboxtoolkit.rapyd.net', live: 'https://toolkit.rapyd.net' };
function loadCardToolkit(env) {
  const url = env === 'live' ? CARD_TOOLKIT_SRC.live : CARD_TOOLKIT_SRC.sandbox;
  return new Promise((resolve) => {
    if (typeof window.RapydToolkit === 'function') return resolve(true);
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(typeof window.RapydToolkit === 'function');
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

/** The toolkit's client-side config (also shown in the engine room). */
export function cardToolkitConfig(id, accent) {
  return {
    id: id || '(data.id from the response — hp_card_…)',
    page_type: 'card_token',
    button_text: 'Save card',
    button_color: accent,
    close_on_complete: true,
    wait_on_payment_redirect: true, // 3DS stays in the iframe; success carries the card
  };
}
const accentNow = () => VERTICALS[state.vertical].dot;

let toolkitListeners = false;
function bindCardToolkitEvents() {
  if (toolkitListeners) return;
  toolkitListeners = true;
  const mine = () => run && run.method === 'htp-toolkit' && state.step === 'add-card';
  window.addEventListener('onLoading', (e) => { if (mine()) logConsole('onLoading', `loading: ${e.detail?.loading}`, 'tk'); });
  window.addEventListener('onSaveCardDetailsPending', (e) => {
    if (!mine()) return;
    logConsole('onSaveCardDetailsPending', e.detail?.next_action || '3DS', 'tk', 'action');
    setStatus('Pending · 3DS', 'action');
  });
  window.addEventListener('onSaveCardDetailsSuccess', (e) => {
    if (!mine() || run.phase !== 'toolkit') return;
    const d = e.detail || {};
    // wait_on_payment_redirect: the customer payment method (card_***);
    // otherwise the verification payment, whose payment_method is the card.
    const cardId = /^card_/.test(d.id || '') ? d.id : (typeof d.payment_method === 'string' ? d.payment_method : d.payment_method_data?.id);
    logConsole('onSaveCardDetailsSuccess', cardId || 'saved', 'tk', 'ok');
    const r = run;
    const s = seq;
    r.phase = 'confirming';
    paintFrame();
    if (cardId) confirmCard(r, () => s === seq && run === r, { cardId, type: d.type || d.payment_method_type || null, last4: d.last4 || null });
    else pollForCard(r, () => s === seq && run === r, { every: 2500, until: Date.now() + 60000 });
  });
  window.addEventListener('onSaveCardDetailsFailure', (e) => {
    if (!mine() || run.phase !== 'toolkit') return;
    const err = e.detail?.error;
    logConsole('onSaveCardDetailsFailure', (err && (err.message || (typeof err === 'string' ? err : JSON.stringify(err)))) || 'failure', 'tk', 'err');
    finish(run, 'failed');
  });
}

async function renderCardToolkit(r, alive, id) {
  r.toolkitConfig = cardToolkitConfig(id, accentNow());
  const loaded = await loadCardToolkit(r.env);
  if (!alive()) return;
  if (!loaded) {
    logConsole('toolkit error', 'the card-token toolkit script didn’t load', 'tk', 'err');
    finish(r, 'failed', 'We couldn’t open the secure form. Please try again.');
    return;
  }
  r.phase = 'toolkit';
  paintFrame();
  repaintPanels();
  bindCardToolkitEvents();
  setStatus('Card-token toolkit rendered', 'action');
  try {
    const toolkit = new window.RapydToolkit(r.toolkitConfig);
    toolkit.displayToolkit();
    logConsole('displayToolkit()', 'card-token iframe rendering', 'tk');
  } catch (err) {
    logConsole('toolkit error', err?.message || String(err), 'tk', 'err');
    finish(r, 'failed', 'We couldn’t open the secure form. Please try again.');
    return;
  }
  // Belt and braces: if the success event never reaches this page, the
  // card still shows up at Rapyd.
  pollForCard(r, alive, { every: 6000 });
}

/* ── Direct S2S · $0-auth with Rapyd 3DS ── */
async function runZeroAuth(r, alive) {
  const v = VERTICALS[state.vertical];
  const body = zeroAuthBody({
    card, recurrence_type: r.use, customer: r.cus, currency: currencyNow(),
    reference: newReference(`pb_${state.vertical}_card`), descriptor: v.descriptor,
    ewallet: profileEwallet(), address: customers.demoAddress(), email: customers.getIdentity().email,
    client: clientDetails(), urls: urlsNow(),
  });
  r.auth = beat('POST', '/v1/payments', body);
  r.phase = 'sending';
  paintFrame();
  repaintPanels();
  await send(r.auth, createDirectPayment, { ...body, env: r.env, profile: r.profile });
  if (!alive()) return;
  const d = r.auth.data?.data;
  if (!ok(r.auth) || !d?.id) {
    finish(r, 'failed', shopperError(r.auth));
    return;
  }
  if (d.next_action === '3d_verification' && d.redirect_url) {
    r.phase = '3ds';
    setStatus('3DS challenge', 'action');
    render3DS(d.redirect_url);
    repaintPanels();
    listenForReturn(); // complete_payment_url / error_payment_url → our return pages
  }
  await settleZeroAuth(r, alive, d);
}

/* Follow the $0-auth to its end with Retrieve Payment: 3DS done → the card. */
async function settleZeroAuth(r, alive, first) {
  const until = Date.now() + 15 * 60000; // 3DS must finish within 15 minutes
  let p = first;
  while (alive()) {
    if (['ERR', 'DEC', 'CAN', 'EXP'].includes(p?.status)) { finish(r, 'failed'); return; }
    const cardId = typeof p?.payment_method === 'string' && /^card_/.test(p.payment_method) ? p.payment_method : null;
    if (cardId && p.next_action !== '3d_verification') {
      r.phase = 'confirming';
      paintFrame();
      await confirmCard(r, alive, { cardId, type: p.payment_method_type || p.payment_method_data?.type || null, last4: p.payment_method_data?.last4 || null });
      return;
    }
    if (Date.now() > until) { finish(r, 'failed', 'The bank check timed out. Nothing was saved.'); return; }
    await new Promise((res) => { pollTimer = setTimeout(res, 3000); });
    if (!alive()) return;
    const res = await retrievePayment(first.id, r.env, r.profile).catch(() => null);
    if (!alive()) return;
    if (res?.data?.data) {
      p = res.data.data;
      r.verify = { ...beat('GET', `/v1/payments/${first.id}`, null), status: 'done', httpStatus: res.httpStatus, data: res.data };
      repaintPanels();
    }
  }
}

/* ── Direct S2S · merchant's own 3DS, then add the card ── */
const EXT_PLACEHOLDER = { '3d_version': '(from the 3DS provider)', cavv: '(from the 3DS provider)', eci: '(from the 3DS provider)', ds_trans_id: '(from the 3DS provider)' };
async function runExternal(r, alive) {
  const v = VERTICALS[state.vertical];
  const digits = card.number.replace(/\D/g, '');
  const network = brandLabel(digits);
  r.ext = {
    request: authRequestSummary({ last4: digits.slice(-4), brand: network, amount: '0.00', currency: currencyNow(), merchant: v.merchant }),
    result: null,
  };
  r.phase = 'authenticating';
  repaintPanels();
  setStatus('3DS · merchant’s provider', 'action');
  const choice = await new Promise((resolve) => {
    const preset = ext3dsPreset();
    renderExternal3DS(
      { merchant: v.merchant, amount: 'Card check · no charge', card: `${network} •••• ${digits.slice(-4)}` },
      { auto: preset === 'challenge' ? null : preset, onChoice: resolve },
    );
  });
  if (!alive()) return;
  setAddress(v.domain, pagePath('add-card'));
  r.ext.result = simulateExternal3DS(choice, network);
  const { callRapyd, payment_method_options: tds } = ext3dsDecision(r.ext.result);
  if (!callRapyd) {
    // The merchant stops: no Rapyd call, nothing saved anywhere.
    logConsole('3DS failed', 'merchant stops — Rapyd not called', 'app', 'err');
    finish(r, 'failed', 'Your bank didn’t confirm this card. Nothing was saved — try again, or use a different card.');
    return;
  }
  const body = externalAddBody({ card, recurrence_type: r.use, customer: r.cus, tds, urls: urlsNow() });
  r.auth = beat('POST', `/v1/customers/${r.cus}/payment_methods`, body);
  r.phase = 'sending';
  paintFrame();
  repaintPanels();
  await send(r.auth, addCustomerPaymentMethod, { ...body, env: r.env, profile: r.profile });
  if (!alive()) return;
  const d = r.auth.data?.data;
  if (!ok(r.auth) || !d) { finish(r, 'failed', shopperError(r.auth)); return; }
  if (d.next_action === '3d_verification' && d.redirect_url) {
    // This MID ran Rapyd's 3DS anyway (it isn't set up for external results).
    r.phase = '3ds';
    setStatus('3DS challenge', 'action');
    render3DS(d.redirect_url);
    repaintPanels();
    r.baseline = new Set(customers.credentials().filter((c) => c.card_id).map((c) => c.card_id));
    listenForReturn();
    pollForCard(r, alive);
    return;
  }
  await confirmCard(r, alive, { cardId: d.id, type: d.type, last4: d.last4 });
}

/* ── Webhooks: what Rapyd sent about this customer since the run began ── */
let whTimer = null;
let whEvents = [];
let whConfigured = null;
function watchWebhooks(r) {
  stopWatches();
  whEvents = [];
  whConfigured = null;
  const s = seq;
  const until = r.startAt + 5 * 60000;
  const tick = async () => {
    if (s !== seq || run !== r) return;
    const { events, configured, ok: good } = await fetchCustomerWebhooks(r.cus, { env: r.env });
    if (s !== seq || run !== r) return;
    if (typeof configured === 'boolean') whConfigured = configured;
    if (good) whEvents = events.filter((e) => (e.received_at || 0) >= r.startAt - 2000);
    repaintPanels();
    if (Date.now() < until) whTimer = setTimeout(tick, 3000);
  };
  whTimer = setTimeout(tick, 1500);
}
function stopWatches() {
  if (whTimer) clearTimeout(whTimer);
  whTimer = null;
  stopPolls();
}

export function addCardWebhooksHTML() {
  if (!run) return '';
  const label = `<div class="wh-beat-label">Add a card · <code>${esc(run.cus)}</code></div>`;
  if (whConfigured === false) return `${label}<div class="wh-note">Webhook receiver not configured — add Vercel KV + register <code>/api/webhook</code>.</div>`;
  if (!whEvents.length) return `${label}<div class="wh-waiting">Waiting for Rapyd to POST an event (<code>CUSTOMER_PAYMENT_METHOD_CREATED</code>, <code>PAYMENT_*</code>) to <code>/api/webhook</code>…</div>`;
  return label + whEvents.map((e, i) => eventCardHTML(e, i === 0)).join('');
}

/* ── Engine room ─────────────────────────────────────────── */
const badgeOf = (b) => (b.status === 'sending' ? ['sending…', 'live'] : ok(b) ? ['signed &amp; sent', 'ok'] : ['failed', 'err']);

function preparedBody(method) {
  const cus = customers.getCustomerId();
  const urls = urlsNow();
  if (isHtp(method)) return htpBody({ customer: cus, country: countryNow(), recurrence_type: use, urls });
  if (method === 's2s-rapyd') {
    return zeroAuthBody({
      card, recurrence_type: use, customer: cus, currency: currencyNow(), reference: '(assigned on save)',
      descriptor: VERTICALS[state.vertical].descriptor, ewallet: profileEwallet(), address: customers.demoAddress(),
      email: customers.getIdentity().email, client: clientDetails(), urls,
    });
  }
  return externalAddBody({ card, recurrence_type: use, customer: cus, tds: EXT_PLACEHOLDER, urls });
}
const preparedPath = (method, cus) => (isHtp(method) ? '/v1/hosted/collect/card'
  : method === 's2s-rapyd' ? '/v1/payments' : `/v1/customers/${cus}/payment_methods`);
const hintOf = (method) => (isHtp(method) ? 'no card data — Rapyd’s page collects it'
  : method === 's2s-rapyd' ? '$0-auth · capture false · save_payment_method' : 'the card + the merchant’s own 3DS results');

let painted = []; // [{ id, method, path, salt, body }] — signed after paint
function cardHTML(id, n, b, hint) {
  const [badge, kind] = b.status === 'prepared' ? ['prepared', ''] : badgeOf(b);
  painted.push({ id, method: (b?.method || 'POST').toLowerCase(), path: b.path, salt: b.salt, body: b.body });
  return beatCardHTML({
    id, n: String(n), method: b.method, path: b.path, badge, badgeKind: kind,
    inner: `
      ${headersHTML(b.salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${b.body ? esc(hint) : 'a GET carries none'}</span></div>
      ${b.body ? renderJSONView(b.body) : ''}`,
  });
}

/** Request panel: the route's beats, or the prepared first call. */
export function addCardRequestCardsHTML() {
  painted = [];
  const method = run?.method || methodNow();
  const intro = `<div class="ext-who">Add a card · <b>${esc(ADD_CARD_METHODS[method])}</b> — follows the drawer’s integration path${isHtp(method) ? '' : ' and the MID’s 3DS provider'}.</div>`;
  if (!run) {
    const prepared = { method: 'POST', path: preparedPath(method, customers.getCustomerId()), salt: preparedSalt(), body: preparedBody(method), status: 'prepared' };
    let html = intro + cardHTML('beat-ac-1', 1, prepared, hintOf(method));
    if (method === 'htp-toolkit') html += toolkitConfigHTML(null);
    return html;
  }
  let n = 0;
  let html = intro;
  if (run.ext) html += extCardHTML(++n);
  const first = run.create || run.auth;
  if (first) html += cardHTML('beat-ac-1', ++n, first, hintOf(run.method));
  if (run.method === 'htp-toolkit' && run.toolkitConfig) html += toolkitConfigHTML(run.toolkitConfig);
  if (run.verify) html += cardHTML('beat-ac-verify', ++n, run.verify, '');
  if (run.list) html += cardHTML('beat-ac-list', ++n, run.list, '');
  return html;
}
let preparedSt = null;
function preparedSalt() { preparedSt = preparedSt || newSaltTimestamp(); return preparedSt; }

function toolkitConfigHTML(cfg) {
  return `
    <div class="req-bodylabel" style="margin-top:18px"><p class="eng-label">Toolkit config · client-side JS</p><span class="hint">new RapydToolkit(…).displayToolkit()</span></div>
    ${renderJSONView(cfg || cardToolkitConfig(null, accentNow()))}`;
}

function extCardHTML(n) {
  const res = run.ext.result;
  return beatCardHTML({
    id: 'beat-ac-ext', n: String(n), method: 'AUTH', path: 'merchant’s 3DS provider', sim: true,
    badge: res ? (res.transStatus === 'Y' ? 'Simulated · passed' : 'Simulated · failed') : 'Simulated', badgeKind: 'sim',
    inner: `
      <div class="ext-who"><span class="sim-badge">Simulated</span>Outside Rapyd · the merchant authenticates the card with its own provider before calling Rapyd.</div>
      <div class="req-bodylabel"><p class="eng-label">Authentication request</p></div>
      ${renderJSONView(run.ext.request)}
      ${res ? `<div class="req-bodylabel"><p class="eng-label">Provider result</p></div>${renderJSONView(res)}` : ''}`,
  });
}

/** Sign the painted cards over their own salts. */
export function fillAddCardSignatures() {
  for (const p of painted) {
    const el = document.getElementById(p.id);
    if (el && p.salt) fillSignature(el, p.method, p.path, p.salt, p.body, p.id);
  }
}

function responseHTML(id, n, b, okLabel) {
  if (!b || b.status !== 'done') return '';
  const good = ok(b);
  const code = b.httpStatus ? `HTTP ${esc(b.httpStatus)}` : 'NO RESPONSE';
  const label = good ? okLabel : String(b.data?.error || 'failed');
  return beatCardHTML({
    id, n: String(n), method: b.method, path: b.path, badge: label, badgeKind: good ? 'ok' : 'err',
    inner: `
      <div class="eng-pillrow"><span class="wh-pill ${good ? 'success' : 'failure'}">${code}</span><span class="wh-pill ${good ? 'success' : 'failure'}">${esc(label)}</span></div>
      ${renderJSONView(b.data ?? { error: 'no response body' })}`,
  });
}

/** Response panel: '' until the first call has answered. */
export function addCardResponseCardsHTML() {
  if (!run) return '';
  let n = run.ext ? 1 : 0;
  const first = run.create || run.auth;
  let html = '';
  if (first) {
    const d = first.data?.data;
    const label = run.create ? 'PAGE CREATED' : run.method === 's2s-rapyd'
      ? (d?.next_action === '3d_verification' ? 'ACT · 3DS' : String(d?.status || 'OK'))
      : (d?.id ? 'CARD ADDED' : 'OK');
    html += responseHTML('beat-ac-1-res', ++n, first, label);
  }
  if (run.verify) html += responseHTML('beat-ac-verify-res', ++n, run.verify, run.verify.data?.data?.payment_method ? 'CARD SAVED' : String(run.verify.data?.data?.status || 'OK'));
  if (run.list) html += responseHTML('beat-ac-list-res', ++n, run.list, 'SAVED CARDS');
  return html;
}
