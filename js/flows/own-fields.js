/* ─────────────────────────────────────────────────────────────
   Own Card Fields flow (PCI-DSS model).
   Merchant fields collect the card; submit fires the real Rapyd
   POST /v1/payments. Focus/typing highlights + updates the live
   request body. The final success/error screen is driven by the
   real webhook (with a Retrieve-Payment fallback). 3DS renders inline.

   Stored-credential additions (card-on-file / recurring / AFT):
   · First payment — a customer-facing "save my card" checkbox plus an
     SE strategy deck (#demo-controls): storage vault/token/both and the
     product-driven recurrence_type (one-time → unscheduled, subscription
     → recurring). Token saves run a TWO-BEAT submit: POST /v1/customers
     (enriched — AFT-ready) then POST /v1/payments with customer +
     save_payment_method. card_*** and network_reference_id are harvested
     from the PAYMENT_COMPLETED webhook (never PAYMENT_SUCCEEDED).
   · Returning customer — saved-card chips replace the form for one-time
     products; charge modes per credential: PAN+CVV re-entry, CVV-less
     PAN+network_reference_id (PCI), or the card_*** token. All CIT:
     initiation_type stays customer_present.
   · AFT (crypto products) — enriched customer + payment_method_options
     {aft, purpose_code, special_condition_indicator, is_direct_purchase};
     the is_direct_purchase fork is a customer-facing toggle (buy now vs
     fund the fiat wallet). MIT recurring charges live in the back office,
     NOT here.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, activeProduct, customerCharge, chargeText, fxSnapshot, productCta } from '../verticals.js';
import { createDirectPayment, createCustomer } from '../api.js';
import { profileEwallet, nridAvailable, activeProfile } from '../profiles.js';
import { clientDetails } from '../client-details.js';
import { renderJSONView, highlightPaths } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';
import { startWebhookWatch } from '../webhooks.js';
import { renderProcessing, render3DS, renderSuccess, renderError } from '../screens.js';
import {
  FIELD_MAP, detectBrand,
  formatNumber, formatExpiry, parseExpiry,
} from '../sync.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import * as ledger from '../ledger.js';
import * as customers from '../customers.js';

const $ = (s, r = document) => r.querySelector(s);

const card = { number: '', expiry: '', cvv: '', name: '' };
let tds = false;
let focusedId = null;
let sent = false;

/* stored-credential state (module-local — survives tab switches, resets only
   with the flow, matching `tds`) */
let save = false;              // customer-facing "save my card"
let storage = 'token';         // SE deck: 'vault' | 'token' | 'both'
let chargeMode = null;         // returning: 'cvv' | 'nrid' | 'token' (validated per credential)
let selectedCredRef = null;    // returning: which chip is active
let useDifferentCard = false;  // returning: fall back to the blank form
let directPurchase = true;     // AFT is_direct_purchase (customer-facing fork)
let pendingSave = null;        // snapshot between submit and PAYMENT_COMPLETED

/* ── stored-credential helpers ───────────────────────────── */
const isSubscription = () => activeProduct().billing === 'subscription';
const recurrenceType = () => (isSubscription() ? 'recurring' : 'unscheduled');
// Subscribing inherently stores the card — the checkbox locks on.
const effectiveSave = () => save || isSubscription();

function returningCreds() {
  // The returning view is CIT-only: one-time products reusing `unscheduled`
  // credentials. Subscription products always run a fresh first payment here
  // (their MIT reuse lives in the back office).
  return activeProduct().billing === 'one_time' ? customers.credentialsFor('unscheduled') : [];
}
const isReturning = () => !useDifferentCard && returningCreds().length > 0;
function activeCredential() {
  const creds = returningCreds();
  return creds.find(c => c.ref === selectedCredRef) || creds[creds.length - 1] || null;
}
function modesFor(cred) {
  if (!cred) return [];
  if (cred.kind === 'token') return ['token'];
  const m = ['cvv'];
  if (cred.network_reference_id && nridAvailable()) m.push('nrid');
  return m;
}
function currentMode() {
  const modes = modesFor(activeCredential());
  return modes.includes(chargeMode) ? chargeMode : (modes[0] || null);
}
const isDirectPurchase = () => (isSubscription() ? true : directPurchase);

/* ── Request bodies ──────────────────────────────────────── */
function displayBody() {
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const returning = isReturning();
  const cred = returning ? activeCredential() : null;
  const mode = returning ? currentMode() : null;
  const aft = !!p.aft;
  const saveToken = !returning && effectiveSave() && storage !== 'vault';
  const cus = customers.getCustomerId();

  const body = {
    amount: Number(p.amount),
    currency: p.currency,
  };
  // No-FX flows must omit all three fields entirely — sending any of them
  // without the others errors the call. FX config lives on state.fx —
  // edited via the popover beside app.js's price tile, not on this page.
  const fx = state.fx;
  if (fx.enabled && fx.requestedCurrency) {
    body.requested_currency = fx.requestedCurrency;
    body.fixed_side = fx.fixedSide;
    body.expiration = Math.floor(Date.now() / 1000) + 24 * 3600; // silent — not an SE-facing control
  }
  body.capture = true;
  // Collection wallet — the active sandbox profile's; live is injected server-side.
  const wallet = profileEwallet();
  if (wallet) body.ewallet = wallet;

  // customer: token saves/charges always reference the session cus_***;
  // a token-less AFT carries the enriched customer INLINE instead — both
  // documented shapes get demonstrated.
  if (saveToken || (returning && cred?.kind === 'token')) {
    body.customer = cus || '(created on submit)';
  } else if (aft) {
    body.customer = cus || customers.enrichedCustomerBody();
  }

  body.merchant_reference_id = state.reference || '(assigned on submit)';
  // NO complete/error_payment_url here: those are for full-redirect flows.
  // With the embedded 3DS iframe they'd render inside the frame after the
  // ACS and flash before the webhook-driven success screen takes over.
  body.statement_descriptor = v.descriptor;
  body.description = p.name; // human-readable mirror of merchant_reference_id

  if (returning && cred?.kind === 'token') {
    body.payment_method = cred.card_id; // the token IS the payment method — no card data
  } else if (returning && cred) {
    // PCI vault reuse — the merchant re-sends its stored PAN; the customer
    // either re-types the CVV or the stored network_reference_id replaces it.
    const fields = {
      number: cred.number,
      expiration_month: cred.expiration_month,
      expiration_year: cred.expiration_year,
    };
    if (mode === 'nrid') fields.network_reference_id = cred.network_reference_id || '(from first payment)';
    else fields.cvv = card.cvv;
    fields.name = cred.name;
    body.payment_method = { type: cred.type, fields };
  } else {
    const { type } = detectBrand(card.number);
    const { month, year } = parseExpiry(card.expiry);
    const fields = {
      number: card.number.replace(/\s/g, ''),
      expiration_month: month,
      expiration_year: year,
      cvv: card.cvv,
      name: card.name,
    };
    // Authorising the card for reuse — the product's billing nature picks the
    // scheme intent (one-time → unscheduled, subscription → recurring).
    if (effectiveSave()) fields.recurrence_type = recurrenceType();
    body.payment_method = { type, fields };
  }

  // Everything on this page is customer-present (CIT) — MIT lives in back office.
  body.initiation_type = 'customer_present';

  const pmo = {};
  if (tds) pmo['3d_required'] = true;
  if (aft) {
    pmo.aft = true;
    pmo.is_direct_purchase = isDirectPurchase();
    pmo.purpose_code = p.purpose_code;
    pmo.special_condition_indicator = p.special_condition_indicator;
  }
  if (Object.keys(pmo).length) body.payment_method_options = pmo;

  // 3DS can trigger even when 3d_required is false (SCA cards) — carry the
  // context that optimises it on every customer-present call. Dummy address,
  // harvested client_details; ip_address is injected server-side.
  body.address = customers.demoAddress();
  body.client_details = clientDetails();

  if (saveToken) body.save_payment_method = true; // token path only — vault adds NO fields
  return body;
}
function postBody() {
  const b = displayBody();
  b.merchant_reference_id = state.reference;
  return { ...b, env: state.env, profile: state.profile };
}

/* ── Left panel markup ───────────────────────────────────── */
function directPurchaseHTML() {
  // Customer-facing AFT fork — direct purchase vs funding the fiat balance.
  return `
    <div class="cof-dp" id="cof-dp">
      <button type="button" data-dp="1" class="${directPurchase ? 'active' : ''}">Buy BTC now</button>
      <button type="button" data-dp="0" class="${!directPurchase ? 'active' : ''}">Add funds, buy later</button>
    </div>`;
}

function chipHTML(c, active) {
  const exp = c.expiration_month && c.expiration_year ? `${c.expiration_month}/${c.expiration_year}` : '··/··';
  const kindLabel = c.kind === 'token'
    ? (c.card_id ? `${c.card_id.slice(0, 9)}…` : 'card_ token')
    : 'merchant vault';
  return `
    <button type="button" class="cof-chip ${active ? 'active' : ''}" data-cred="${c.ref}">
      <span class="cof-chip-brand">${c.brand || 'Card'}</span>
      <span class="cof-chip-num">···· ${c.last4 || '····'}</span>
      <span class="cof-chip-exp">${exp}</span>
      <span class="cof-chip-kind ${c.kind}">${kindLabel}</span>
      ${c.network_reference_id ? '<span class="cof-chip-nri">NRI ✓</span>' : ''}
    </button>`;
}

function returningHTML() {
  const p = activeProduct();
  const creds = returningCreds();
  const cred = activeCredential();
  const mode = currentMode();
  const first = customers.getIdentity().name.split(' ')[0];
  return `
    <div class="cof-returning" id="cof-returning">
      <div class="cof-head">
        <span class="cof-welcome">Welcome back, ${first}</span>
        <button type="button" class="cof-link" id="cof-different">Use a different card</button>
      </div>
      <div class="cof-chips">${creds.map(c => chipHTML(c, c.ref === cred?.ref)).join('')}</div>
      ${mode === 'cvv' ? `
        <div class="co-row cof-cvvrow">
          <div class="co-field cof-cvv">
            <label>CVV</label>
            <div class="co-input"><input id="f-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" /></div>
          </div>
          <div class="cof-cvv-note">Just confirm it’s you — your card is on file.</div>
        </div>` : `
        <div class="cof-nocvv">${mode === 'nrid'
          ? 'No CVV needed — the card’s original network reference verifies this payment.'
          : 'No card details needed — your saved card token is charged directly.'}</div>`}
      ${p.aft ? directPurchaseHTML() : ''}
      <label class="co-tds">
        <input type="checkbox" id="f-tds" ${tds ? 'checked' : ''} />
        <span>Require 3-D Secure</span>
      </label>
      <button class="co-cta" id="pay-btn">${productCta()} ${p.amount} ${p.currency}</button>
      <div class="cof-foot"><button type="button" class="cof-link subtle" id="cof-forget">Not ${first}? Forget this profile</button></div>
    </div>`;
}

export function renderPaymentHTML() {
  const p = activeProduct();
  if (isReturning()) return returningHTML();
  return `
    <div class="co-field">
      <label>Card number</label>
      <div class="co-input">
        <span class="field-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2.5" fill="#e8e3f7"></rect><rect x="2" y="8" width="20" height="3" fill="#7c3aed"></rect><rect x="5" y="14" width="6" height="2" rx="1" fill="#b8a9e6"></rect></svg></span>
        <input id="f-number" inputmode="numeric" autocomplete="cc-number" placeholder="4111 1111 1111 1111" maxlength="23" />
        <span class="card-brand" id="card-brand"></span>
      </div>
    </div>
    <div class="co-row">
      <div class="co-field">
        <label>Expiry</label>
        <div class="co-input"><input id="f-expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="12 / 27" maxlength="7" /></div>
      </div>
      <div class="co-field">
        <label>CVV</label>
        <div class="co-input"><input id="f-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" /></div>
      </div>
    </div>
    <div class="co-field">
      <label>Name on card</label>
      <div class="co-input"><input id="f-name" autocomplete="cc-name" placeholder="Jordan Taylor" /></div>
    </div>
    ${p.aft && !isSubscription() ? directPurchaseHTML() : ''}
    <label class="co-tds">
      <input type="checkbox" id="f-save" ${effectiveSave() ? 'checked' : ''} ${isSubscription() ? 'disabled' : ''} />
      <span>${isSubscription() ? 'Card saved for your subscription' : 'Save card for future purchases'}</span>
    </label>
    <label class="co-tds">
      <input type="checkbox" id="f-tds" ${tds ? 'checked' : ''} />
      <span>Require 3-D Secure</span>
    </label>
    <button class="co-cta" id="pay-btn">${productCta()} ${p.amount} ${p.currency}</button>`;
}

/* ── SE strategy deck (#demo-controls, outside the fake site) ──
   Real API keys on the labels; repainted in place as save/returning
   context changes. Never part of the customer-facing page. */
export function renderControlsHTML() {
  return `<div class="se-deck" id="of-deck"></div>`;
}

function deckHTML() {
  const returning = isReturning();
  if (!returning) {
    if (!effectiveSave()) {
      return `<div class="se-deck-empty">Tick <b>“save card”</b> on the checkout to configure the stored-credential strategy${customers.hasCredentials() ? '' : ' — the returning-customer view unlocks after the first saved payment'}.</div>`;
    }
    const sc3 = !nridAvailable();
    return `
      <div class="se-deck-head">Stored-credential strategy<span class="se-deck-hint">SE controls · not part of the client site</span></div>
      <div class="se-row">
        <div class="se-lab">Storage<code>save_payment_method</code></div>
        <div class="se-seg" data-opt="storage">
          <button type="button" data-val="vault" class="${storage === 'vault' ? 'active' : ''}">Merchant vault (PCI)</button>
          <button type="button" data-val="token" class="${storage === 'token' ? 'active' : ''}">Rapyd token</button>
          <button type="button" data-val="both" class="${storage === 'both' ? 'active' : ''}">Both</button>
        </div>
      </div>
      <div class="se-row">
        <div class="se-lab">Purpose<code>payment_method.fields.recurrence_type</code></div>
        <div class="se-fixed"><code>${recurrenceType()}</code><span class="se-note">${isSubscription()
          ? 'subscription product → recurring · MIT charges run from the back office'
          : 'one-time product → unscheduled · customer-present reuse on this page'}</span></div>
      </div>
      ${storage !== 'token' && sc3 ? `<div class="se-warn">${activeProfile().label} does not return <code>network_reference_id</code> — vault reuse will require CVV re-entry.</div>` : ''}`;
  }
  const cred = activeCredential();
  if (!cred) return '';
  if (cred.kind === 'token') {
    return `
      <div class="se-deck-head">Charge with<span class="se-deck-hint">stored credential</span></div>
      <div class="se-row">
        <div class="se-lab">Mode<code>payment_method</code></div>
        <div class="se-fixed"><code>${cred.card_id || 'card_***'}</code><span class="se-note">Rapyd token — no card data in the request</span></div>
      </div>`;
  }
  const nridOk = !!cred.network_reference_id && nridAvailable();
  const nridTitle = !nridAvailable()
    ? `This profile (${activeProfile().label}) does not return network_reference_id`
    : 'No network_reference_id captured yet for this card';
  const mode = currentMode();
  return `
    <div class="se-deck-head">Charge with<span class="se-deck-hint">stored credential</span></div>
    <div class="se-row">
      <div class="se-lab">Mode<code>payment_method.fields</code></div>
      <div class="se-seg" data-opt="mode">
        <button type="button" data-val="cvv" class="${mode === 'cvv' ? 'active' : ''}">PAN + CVV</button>
        <button type="button" data-val="nrid" class="${mode === 'nrid' ? 'active' : ''}" ${nridOk ? '' : `disabled title="${nridTitle}"`}>PAN + network_reference_id</button>
      </div>
    </div>`;
}
function renderDeck() {
  const el = $('#of-deck');
  if (el) el.innerHTML = deckHTML();
}

/* ── Request panel ───────────────────────────────────────── */
function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  const st = newSaltTimestamp();
  const body = displayBody();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/payments</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${sent ? 'signed &amp; sent' : 'updates as you type'}</span></div>
    <div id="req-json">${renderJSONView(body)}</div>`;
  fillSignature(el, 'post', '/v1/payments', st, body); // live — recomputes with the body
  applyHighlight();
}
function applyHighlight() {
  highlightPaths($('#req-json'), focusedId ? (FIELD_MAP[focusedId] || []) : []);
}

/* Step 1 of a two-beat token save: the enriched customer create. */
function paintCustomerRequest(body) {
  const el = $('#panel-request');
  if (!el) return;
  const st = newSaltTimestamp();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/customers</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">step 1 of 2 — create the customer (enriched · AFT-ready)</span></div>
    <div id="req-json">${renderJSONView(body)}</div>`;
  fillSignature(el, 'post', '/v1/customers', st, body);
}

/* ── Response panel ──────────────────────────────────────── */
function respBadge(httpStatus, data) {
  const d = data?.data;
  if (d?.status === 'CLO' && d?.paid) return ['PAID · CLO', 'success'];
  if (d?.status === 'ACT')           return ['ACTION · ACT', 'pending'];
  if (data?.error)                   return [String(data.error), 'failure'];
  if (typeof d?.id === 'string' && d.id.startsWith('cus_')) return ['CUSTOMER CREATED', 'success'];
  if (d?.status)                     return [d.status, 'pending'];
  return [`HTTP ${httpStatus}`, httpStatus < 400 ? 'success' : 'failure'];
}
function renderResponseSending() {
  $('#panel-response').innerHTML = `<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>`;
}
let lastResponse = null; // persisted so switching back from back office can repaint without resetting anything
function renderResponse(httpStatus, data) {
  lastResponse = { httpStatus, data };
  const [badge, kind] = respBadge(httpStatus, data);
  $('#panel-response').innerHTML = `
    <div class="eng-pillrow">
      <span class="wh-pill ${httpStatus < 400 ? 'success' : 'failure'}">HTTP ${httpStatus}</span>
      <span class="wh-pill ${kind}">${badge}</span>
    </div>
    ${renderJSONView(data ?? { error: 'no response body' })}`;
}

/** Back office may have repainted #panel-request/#panel-response while this
    flow's own state kept changing in the background (a client watcher tick
    can't touch these — see webhooks.js's leftView guard — but this flow's own
    request/response are plain innerHTML writes with no such guard, so they
    need to be explicitly restored when the SE switches back to Client Site). */
export function refreshRightPanel() {
  renderRequest();
  if (lastResponse) renderResponse(lastResponse.httpStatus, lastResponse.data);
}

/** Profile switch (SC1/SC2/SC3): credentials re-key per MID, NRID gating and
    the body's ewallet change — repaint without resetting the flow. */
export function refreshProfile() {
  const region = $('#pay-region');
  if (region && state.model === 'own-fields') rerenderPayRegion();
  else renderRequest();
  renderDeck();
}

/* ── Terminal (webhook or fallback) → left screen ────────── */
function handleTerminal(ev) {
  // ev is a terminal PAYMENT_COMPLETED/PAYMENT_FAILED webhook, or the poll
  // fallback's status object (CLO+paid) when no webhook was delivered.
  const success = /COMPLETED|CAPTURE/.test((ev.type || '').toUpperCase()) || (ev.status === 'CLO' && ev.paid);
  if (success) {
    setStatus('Paid · CLO', 'ok'); renderSuccess(ev); toast('✅ Confirmed by webhook');
    ledger.updateStatus(state.reference, { status: 'completed', phase: 'completed' });
    harvestCredentials(ev);
  } else {
    setStatus('Failed', 'error'); renderError(ev); toast('❌ Payment failed', 'err');
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'failed' });
    pendingSave = null; // nothing was authorised for reuse
  }
}

/** Pull the stored credential(s) out of the PAYMENT_COMPLETED webhook.
    card_*** arrives as the payment's payment_method; network_reference_id in
    payment_method_data. The list endpoint then silently backfills anything
    the webhook didn't carry (expiry etc.). */
function harvestCredentials(ev) {
  const ps = pendingSave;
  pendingSave = null;
  const d = ev.raw?.data;
  if (!ps || !d) return;
  const pmd = d.payment_method_data || {};
  const nri = pmd.network_reference_id || null;
  if (ps.vault) {
    const ref = customers.addVaultCredential({
      ...ps.snapshot,
      recurrence_type: ps.recurrence_type, aft: ps.aft,
      origin_vertical: state.vertical, origin_model: 'own-fields', origin_product: ps.origin_product,
    });
    if (nri) customers.setNetworkReferenceId(ref, nri);
  }
  if (ps.token) {
    const cardId =
      (typeof d.payment_method === 'string' && /^card_/.test(d.payment_method) && d.payment_method) ||
      (typeof pmd.id === 'string' && /^card_/.test(pmd.id) && pmd.id) || null;
    if (cardId) {
      const ref = customers.upsertTokenCredential({
        card_id: cardId, type: pmd.type || ps.snapshot.type, brand: ps.snapshot.brand,
        last4: pmd.last4 || ps.snapshot.last4,
        expiration_month: ps.snapshot.expiration_month, expiration_year: ps.snapshot.expiration_year,
        recurrence_type: ps.recurrence_type, aft: ps.aft,
        origin_vertical: state.vertical, origin_model: 'own-fields', origin_product: ps.origin_product,
      });
      if (nri) customers.setNetworkReferenceId(ref, nri);
    }
    customers.refreshTokens(); // silent backfill — the webhook harvest is primary
  }
}

/* ── Submit ──────────────────────────────────────────────── */
async function createSessionCustomer() {
  // Two-beat choreography: the customer must exist before the payment body
  // can reference it. If this beat fails we STOP — no payment, no ledger entry.
  setStatus('Creating customer…', 'processing');
  const body = customers.enrichedCustomerBody();
  paintCustomerRequest(body);
  setActiveTab('request');
  try {
    const { httpStatus, data } = await createCustomer({ ...body, env: state.env, profile: state.profile });
    renderResponse(httpStatus, data);
    setActiveTab('response');
    const id = data?.data?.id;
    if (httpStatus >= 400 || data?.error || !id) {
      setStatus('Error', 'error');
      toast(`❌ ${data?.message || data?.error || 'Customer creation failed'}`, 'err');
      return false;
    }
    customers.setCustomerId(id);
    return true;
  } catch (err) {
    renderResponse(0, { error: 'network_error', message: err.message });
    setStatus('Error', 'error');
    toast(`❌ ${err.message}`, 'err');
    return false;
  }
}

async function pay() {
  const btn = $('#pay-btn');
  const v = VERTICALS[state.vertical];
  const p = activeProduct();
  const returning = isReturning();
  const cred = returning ? activeCredential() : null;
  const mode = returning ? currentMode() : null;

  if (returning && mode === 'cvv' && !card.cvv) {
    $('#f-cvv')?.focus();
    toast('Enter the CVV to confirm it’s you', 'err');
    return;
  }

  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Processing…';
  setStatus('Processing…', 'processing');

  // Beat 1 (only when a token save/charge needs a customer that doesn't exist
  // yet — vault-only saves and inline-AFT calls skip it entirely).
  const needsCustomer = !customers.getCustomerId() &&
    !returning && effectiveSave() && storage !== 'vault';
  if (needsCustomer) {
    const ok = await createSessionCustomer();
    if (!ok) { btn.disabled = false; btn.textContent = btnLabel; return; }
  }

  state.reference = `pb_${state.vertical}_${Date.now()}`;
  {
    const digits = card.number.replace(/\D/g, '');
    const brandName = detectBrand(card.number).brand; // 'VISA' | 'MASTERCARD' | ''
    const network = cred ? cred.brand : (brandName ? brandName[0] + brandName.slice(1).toLowerCase() : null);
    const last4 = cred ? cred.last4 : digits.slice(-4);
    const fx = state.fx;
    // amount/currency = what the CUSTOMER paid (converted under 'buy'), so the
    // success screen + bank statement match the checkout; fx carries the legs.
    const charge = customerCharge();
    const note = p.aft && !isSubscription() && !directPurchase ? (p.fundedNote || p.successNote) : (p.successNote || v.successNote);
    state.lastPayment = {
      descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency,
      last4, network, fx: fxSnapshot(),
      customer_id: customers.getCustomerId(),
      credential_label: cred ? `${cred.brand} ···${cred.last4} (${cred.kind === 'token' ? 'token' : 'vault'})` : (effectiveSave() ? `saving · ${recurrenceType()}` : null),
      initiation_type: 'customer_present',
      aft: !!p.aft, is_direct_purchase: p.aft ? isDirectPurchase() : null,
      note,
    };
    ledger.recordPayment(state.reference, {
      model: 'own-fields', vertical: state.vertical, amount: p.amount, currency: p.currency,
      requested_currency: fx.enabled ? fx.requestedCurrency : null, fixed_side: fx.enabled ? fx.fixedSide : null,
      last4, brand: network,
      origin: 'client', initiation_type: 'customer_present', profile: state.profile,
      credential: cred ? { kind: cred.kind, label: `${cred.brand} ···${cred.last4}` } : null,
      aft: !!p.aft,
    });
    pendingSave = (!returning && effectiveSave()) ? {
      vault: storage === 'vault' || storage === 'both',
      token: storage === 'token' || storage === 'both',
      recurrence_type: recurrenceType(),
      aft: !!p.aft,
      origin_product: p.id,
      snapshot: {
        type: detectBrand(card.number).type,
        number: card.number.replace(/\s/g, ''),
        expiration_month: parseExpiry(card.expiry).month,
        expiration_year: parseExpiry(card.expiry).year,
        name: card.name,
        brand: network || 'Card',
        last4: digits.slice(-4),
      },
    } : null;
  }
  sent = true;
  renderRequest(); // fresh salt/timestamp/signature for the send
  setActiveTab('response');
  renderResponseSending();

  try {
    const { httpStatus, data } = await createDirectPayment(postBody());
    renderResponse(httpStatus, data);
    const d = data?.data;

    if (!d || data?.error) {
      setStatus('Declined', 'error');
      toast(`❌ ${data?.message || data?.error || 'Payment failed'}`, 'err');
      renderError({ status: data?.error || 'ERR', message: data?.message || 'The payment was declined.' });
      ledger.updateStatus(state.reference, { status: 'failed', phase: 'declined' });
      pendingSave = null;
      return;
    }

    ledger.setPaymentId(state.reference, d.id);

    if (d.status === 'ACT' && d.next_action === '3d_verification') {
      setStatus('3DS challenge', 'action');
      render3DS(d.redirect_url);
      ledger.updateStatus(state.reference, { phase: 'pending_3ds' });
    } else if (d.status === 'CLO' && d.paid) {
      setStatus('Authorized · confirming', 'processing');
      renderProcessing('Payment authorized', 'Waiting for the confirmation webhook…');
      ledger.updateStatus(state.reference, { phase: 'awaiting_confirmation' });
    } else {
      renderProcessing('Processing…');
    }
    startWebhookWatch({ reference: state.reference, payment_id: d.id, onTerminal: handleTerminal });
  } catch (err) {
    renderResponse(0, { error: 'network_error', message: err.message });
    setStatus('Error', 'error');
    renderError({ status: 'ERR', message: err.message });
    ledger.updateStatus(state.reference, { status: 'failed', phase: 'error' });
    pendingSave = null;
  } finally {
    sent = false;
  }
}

/* ── Fields ──────────────────────────────────────────────── */
function updateBrand() { const el = $('#card-brand'); if (el) el.textContent = detectBrand(card.number).brand; }

function fillTestCard() {
  const set = (id, val) => { const el = $(`#${id}`); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('f-number', '4111 1111 1111 1111');
  set('f-expiry', '12 / 27');
  set('f-cvv', '123');
  set('f-name', 'Jordan Taylor');
}

/* Repaint ONLY the payment region (chips/CVV/form) — the shell (tile, totals,
   FX badge) stays put, so an SE narration isn't disturbed. */
function rerenderPayRegion() {
  const region = $('#pay-region');
  if (!region) return; // checkout replaced by a screen
  if (isReturning()) card.cvv = ''; // CVV is fresh per payment
  region.innerHTML = renderPaymentHTML();
  wirePayRegion();
  renderDeck();
  renderRequest();
  const payBtn = $('#pay-btn');
  if (payBtn) payBtn.textContent = `${productCta()} ${chargeText(customerCharge())}${isSubscription() ? ' /mo' : ''}`;
}

function wirePayRegion() {
  const useTest = $('#use-test');
  if (useTest) useTest.style.display = isReturning() ? 'none' : '';

  if (isReturning()) {
    const root = $('#cof-returning');
    if (!root) return;
    root.addEventListener('click', e => {
      const chip = e.target.closest('.cof-chip');
      if (chip) {
        if (selectedCredRef !== chip.dataset.cred) { selectedCredRef = chip.dataset.cred; chargeMode = null; rerenderPayRegion(); }
        return;
      }
      if (e.target.closest('#cof-different')) { useDifferentCard = true; rerenderPayRegion(); return; }
      if (e.target.closest('#cof-forget')) { customers.forgetCustomer(); useDifferentCard = false; rerenderPayRegion(); return; }
      const dp = e.target.closest('#cof-dp button[data-dp]');
      if (dp) { directPurchase = dp.dataset.dp === '1'; rerenderPayRegion(); return; }
    });
    const cvv = $('#f-cvv');
    cvv?.addEventListener('input', () => {
      cvv.value = cvv.value.replace(/\D/g, '').slice(0, 4);
      card.cvv = cvv.value;
      setStatus('Drafting request', 'drafting');
      renderRequest();
    });
    $('#f-tds')?.addEventListener('change', e => { tds = e.target.checked; renderRequest(); });
    $('#pay-btn')?.addEventListener('click', pay);
    return;
  }

  const els = { number: $('#f-number'), expiry: $('#f-expiry'), cvv: $('#f-cvv'), name: $('#f-name') };
  if (!els.number) return; // checkout replaced by a screen
  els.number.value = card.number;
  els.expiry.value = card.expiry;
  els.cvv.value = card.cvv;
  els.name.value = card.name;
  updateBrand();

  const wire = (key, el, formatter) => {
    el.addEventListener('input', () => {
      if (formatter) el.value = formatter(el.value);
      card[key] = el.value;
      if (key === 'number') updateBrand();
      setStatus('Drafting request', 'drafting');
      renderRequest();
    });
  };
  wire('number', els.number, formatNumber);
  wire('expiry', els.expiry, formatExpiry);
  wire('cvv', els.cvv, v => v.replace(/\D/g, '').slice(0, 4));
  wire('name', els.name, null);

  $('#f-save')?.addEventListener('change', e => { save = e.target.checked; renderDeck(); renderRequest(); });
  $('#f-tds')?.addEventListener('change', e => { tds = e.target.checked; renderRequest(); });
  const dpSeg = $('#cof-dp');
  dpSeg?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-dp]');
    if (!btn) return;
    directPurchase = btn.dataset.dp === '1';
    dpSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderRequest();
  });
  $('#pay-btn').addEventListener('click', pay);
  $('#use-test')?.addEventListener('click', fillTestCard);
}

export function mount() {
  sent = false;
  useDifferentCard = false; // returning view is the default whenever credentials exist
  wirePayRegion();
  renderDeck();
  renderRequest();
}

// Highlight sync — delegated on `document` via focusin/focusout (which,
// unlike focus/blur, bubble) so it's wired exactly ONCE at module load and
// keeps working regardless of how often the underlying element gets
// recreated: card fields on every own-fields mount(), the price tile on
// every vertical/model/env reset, the FX popover's fields on every popover
// re-render (app.js rebuilds #fx-popover's innerHTML far more often than
// mount() runs — a per-element listener there would silently go stale).
document.addEventListener('focusin', e => {
  if (!(e.target.id in FIELD_MAP)) return;
  focusedId = e.target.id;
  applyHighlight();
});
document.addEventListener('focusout', e => {
  if (!(e.target.id in FIELD_MAP)) return;
  focusedId = null;
  applyHighlight();
});

// SE deck interactions — same once-at-module-load delegation (the deck's
// innerHTML is rebuilt far more often than mount() runs).
document.addEventListener('click', e => {
  const btn = e.target.closest('#of-deck .se-seg button[data-val]');
  if (!btn || btn.disabled) return;
  const opt = btn.closest('.se-seg').dataset.opt;
  if (opt === 'storage') { storage = btn.dataset.val; renderDeck(); renderRequest(); }
  if (opt === 'mode') { chargeMode = btn.dataset.val; rerenderPayRegion(); }
});

// Credentials changing (webhook harvest, list backfill, profile re-key) —
// refresh the deck and the chips if they're on screen.
customers.subscribeCustomers(() => {
  if (state.model !== 'own-fields' || state.leftView !== 'client') return;
  renderDeck();
  if ($('#cof-returning')) rerenderPayRegion(); // NRI badges / new tokens
});

/* ── Toast ───────────────────────────────────────────────── */
function toast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
