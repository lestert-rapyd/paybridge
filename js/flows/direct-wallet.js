/* ─────────────────────────────────────────────────────────────
   Direct Apple Pay / Google Pay — the page side. The wallet is mock, the
   payment is real (sandbox): the rules, payloads and sequence live in
   js/direct-wallet.js.

   left  · the merchant's OWN Apple Pay / Google Pay buttons on its own
           checkout, above "Pay by card" (Own Card Fields — PCI-DSS
           merchants — only). A click opens a
           neutral, OS-like wallet sheet over the page — Apple's / Google's
           surface, so it gets the grey third-party seam marker, never the
           skin and never Rapyd's. Approving it sends the mock token to
           Rapyd for real, and the payment ends like any other: processing,
           Rapyd's 3DS for Google Pay PAN_ONLY only (everything else already
           had the wallet's SCA), then the webhook-confirmed result.
   right · the whole sequence: Apple / Google / merchant steps as one-line
           boxes OUTSIDE Rapyd (each links the wallet's own docs), then the
           POST /v1/payments in full and Rapyd's real answer.

   The payment is real — a ledger entry, a webhook watch, a paid bag — like
   own-fields' pay() (flows/own-fields.js), minus the card form, the saved
   card and external 3DS: the wallet's cryptogram stands in for the
   latter. Nothing goes to Apple or Google.

   Buttons (brand): no official Apple / Google artwork is embedded. Both are
   black buttons with the wallet's NAME as text (Apple HIG and Google's brand
   guidelines both allow a black button; their official marks would replace
   the text in a real integration —
   developer.apple.com/design/human-interface-guidelines/apple-pay,
   developers.google.com/pay/api/web/guides/brand-guidelines).
   ───────────────────────────────────────────────────────────── */

import { beatBadge } from '../tags/resolve.js';
import { state } from '../state.js';
import { VERTICALS, activeProduct, customerCharge, chargeText, fxSnapshot, orderItems } from '../verticals.js';
import { createDirectPayment, newReference } from '../api.js';
import { profileEwallet } from '../profiles.js';
import { clientDetails } from '../client-details.js';
import * as customers from '../customers.js';
import { usesCustomer } from '../identity.js';
import { setActiveTab, setStatus, esc } from '../ui.js';
import { currencyDecimals } from '../sync.js';
import { renderJSONView, highlightPaths } from '../json-view.js';
import { beatCardHTML } from '../customer-beat.js';
import { renderProcessing, render3DS, renderError } from '../screens.js';
import { startWebhookWatch } from '../webhooks.js';
import { seamExtWrapHTML, walletSheetLabel } from '../seam.js';
import * as ledger from '../ledger.js';
import {
  WALLETS, WALLET_ORDER, SIM_LAST4, effectiveWalletIntegration, isDirect, googleAuthMethod,
  directPaymentBody, walletSteps, walletDataPaths, leafPathsUnder,
} from '../direct-wallet.js';
import {
  amountProblem, sendIdempotent, isUnknownOutcome, failureStatusText, httpsUrl, terminalHandler,
  paymentResponseCardHTML,
} from './shared.js';

const $ = (s, r = document) => r.querySelector(s);

/* Rapyd's own page per wallet × variant — the Rapyd part's reference. */
const RAPYD_DOCS = {
  'apple:encrypted': 'https://docs.rapyd.net/en/creating-a-payment-with-apple-pay--encrypted-.html',
  'apple:decrypted': 'https://docs.rapyd.net/en/creating-a-payment-with-apple-pay--decrypted-.html',
  'google:encrypted': 'https://docs.rapyd.net/en/creating-a-payment-with-google-pay---encrypted-.html',
  'google:decrypted': 'https://docs.rapyd.net/en/creating-a-payment-with-google-pay---decrypted-.html',
};

/* ── The run ─────────────────────────────────────────────────
   One wallet payment: { wallet, variant, phase, body, reference, httpStatus,
   response, amountText, merchant }. phase: 'sheet' (waiting on the shopper)
   → 'sending' (the merchant's server calls Rapyd) → 'done' | 'cancelled'.
   Reset with the checkout (app.js renderCheckout); a payment already sent
   keeps settling through its ledger entry and webhook watch. */
let run = null;
let repaintFlowPanels = () => {};
/** app.js hands over the active flow's own panel painter, for when the run ends. */
export function setDirectWalletRepainter(fn) { repaintFlowPanels = fn; }
/** While a run is up the engine room is the run's — the flows defer to it. */
export const ownsPanel = () => !!run && run.phase !== 'cancelled';

/* The AFT "buy now / fund the wallet" fork lives on the card checkout
   (own-fields.js), which hands its reader over at load — the wallet buttons
   sit on that same page, so the shopper's choice applies to both. */
let directPurchase = () => true;
export function setDirectPurchaseSource(fn) { directPurchase = fn; }

export function resetDirectWallet() {
  run = null;
  removeSheet();
}

const ctx = () => ({ model: state.model, env: state.env });
const variantNow = () => effectiveWalletIntegration(ctx());

/* ── Left: the merchant's buttons ──────────────────────────── */
/** The express block for the active checkout, or '' when no direct variant
    applies (Off, the toolkit, live, a subscription). */
export function directWalletBlockHTML() {
  const variant = variantNow();
  if (!isDirect(variant)) return '';
  const p = activeProduct();
  if (p.billing === 'subscription') return '';
  const disabled = amountProblem(p) ? 'disabled' : '';
  return `
    <div class="dw-express">
      <div class="dw-express-label">Express checkout</div>
      <div class="dw-buttons">
        ${WALLET_ORDER.map((id) => `<button type="button" class="dw-btn dw-btn-${esc(id)}" data-dw-wallet="${esc(id)}" ${disabled} aria-label="Pay with ${esc(WALLETS[id].label)}">${esc(WALLETS[id].label)}</button>`).join('')}
      </div>
      <div class="dw-or"><span>or pay by card</span></div>
    </div>`;
}
/** Repaint the slot(s) after a drawer change — the rest of the page stays. */
export function refreshDirectSlot() {
  document.querySelectorAll('.dw-slot').forEach((el) => { el.innerHTML = directWalletBlockHTML(); });
}

/* ── The sheet (Apple's / Google's surface, simulated) ───── */
function removeSheet() {
  document.getElementById('dw-overlay')?.remove();
}
function sheetHTML(r) {
  const w = WALLETS[r.wallet];
  const apple = r.wallet === 'apple';
  const sheet = `
    <div class="dw-sheet" role="dialog" aria-label="${esc(w.label)} (simulated)">
      <div class="dw-sheet-head">
        <span class="dw-sheet-title">${esc(w.label)}</span>
        <span class="dw-sim">Simulated</span>
        <button type="button" class="dw-cancel" data-dw-sheet="cancel">Cancel</button>
      </div>
      <div class="dw-sheet-rows">
        <div><span>Card</span><span class="mono">Visa •••• ${esc(SIM_LAST4)}</span></div>
        <div><span>Pay</span><span>${esc(r.merchant)}</span></div>
        <div class="total"><span>Total</span><span>${esc(r.amountText)}</span></div>
      </div>
      <div class="dw-sheet-foot">
        <button type="button" class="dw-confirm" data-dw-sheet="confirm"><i class="${apple ? 'icon-fingerprint' : 'icon-lock'}"></i>${apple ? 'Confirm with Touch ID' : 'Continue'}</button>
      </div>
      <div class="dw-sheet-note">Simulated wallet sheet — no ${esc(w.party)} session; a mock token goes to the Rapyd sandbox.</div>
    </div>`;
  return `<div class="dw-overlay" id="dw-overlay"><div class="dw-sheet-wrap">${seamExtWrapHTML(sheet, walletSheetLabel(w.label))}</div></div>`;
}

function start(wallet) {
  const variant = variantNow();
  if (!isDirect(variant) || !WALLETS[wallet] || ownsPanel()) return;
  const p = activeProduct();
  if (amountProblem(p)) return;
  const v = VERTICALS[state.vertical];
  const charge = customerCharge();
  run = {
    wallet, variant, phase: 'sheet',
    merchant: v.merchant, amountText: chargeText(charge),
    body: buildBody(wallet, variant, p, charge), reference: null, httpStatus: null, response: null,
  };
  removeSheet();
  $('.browser-body')?.insertAdjacentHTML('beforeend', sheetHTML(run));
  $('#dw-overlay .dw-sheet')?.scrollIntoView({ block: 'nearest' });
  setStatus(`${WALLETS[wallet].label} sheet`, 'action');
  setActiveTab('request');
  paintPanels();
}

function buildBody(wallet, variant, p, charge) {
  const amount = charge.amount ?? p.amount;
  const body = directPaymentBody({
    wallet, variant, model: state.model, env: state.env,
    amount: p.amount, currency: p.currency,
    charge: { amount, currency: charge.currency }, decimals: currencyDecimals(charge.currency),
    description: p.name, reference: '(assigned on approval)',
    descriptor: VERTICALS[state.vertical].descriptor,
    ewallet: profileEwallet(), // sandbox profile's collection wallet
    authMethod: googleAuthMethod(),
    aft: p.aft ? { is_direct_purchase: directPurchase(), purpose_code: p.purpose_code, special_condition_indicator: p.special_condition_indicator } : null,
  });
  // The rest of a customer-present card payment, as the card checkout sends
  // it (own-fields.js displayBody): the customer — the session cus_***, or,
  // for an AFT with none (a guest included — an AFT always needs its
  // sender), the enriched sender inline — then CIT, and the 3DS-context
  // address + client_details.
  const cus = usesCustomer() ? customers.getCustomerId() : null;
  if (cus) body.customer = cus;
  else if (p.aft) body.customer = customers.enrichedCustomerBody();
  body.initiation_type = 'customer_present';
  body.address = customers.demoAddress();
  body.client_details = clientDetails(); // ip_address injected server-side
  if (state.fx.enabled && state.fx.requestedCurrency) {
    body.requested_currency = state.fx.requestedCurrency;
    body.fixed_side = state.fx.fixedSide;
    body.expiration = Math.floor(Date.now() / 1000) + 24 * 3600; // as own-fields sends it
  }
  return body;
}

function cancel() {
  if (!run || run.phase !== 'sheet') return;
  removeSheet();
  run = null; // nothing happened — the flow's own engine room comes back
  setStatus('Awaiting input', 'idle');
  repaintFlowPanels();
}

/* The shopper approved: the merchant's server sends the token to Rapyd.
   Mirrors own-fields' pay() — ledger entry first, one Idempotency-Key with a
   same-key retry on an unknown outcome, then the webhook watch settles it. */
async function confirm() {
  if (!run || run.phase !== 'sheet') return;
  const r = run;
  const w = WALLETS[r.wallet];
  const p = activeProduct();
  const v = VERTICALS[state.vertical];
  const charge = customerCharge();
  const fx = state.fx;
  r.phase = 'sending';
  removeSheet();

  state.reference = newReference(`pb_${state.vertical}`); // unguessable — it's the webhook read key
  const reference = state.reference;
  r.reference = reference;
  r.body.merchant_reference_id = reference;
  const funded = p.aft && r.body.payment_method_options?.is_direct_purchase === false;
  state.lastPayment = {
    descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency,
    last4: SIM_LAST4, network: w.label, fx: fxSnapshot(), customer_id: r.body.customer && typeof r.body.customer === 'string' ? r.body.customer : null,
    initiation_type: 'customer_present', aft: !!p.aft, is_direct_purchase: p.aft ? !funded : null,
    note: funded ? (p.fundedNote || p.successNote) : (p.successNote || v.successNote),
  };
  ledger.recordPayment(reference, {
    model: state.model, vertical: state.vertical, amount: p.amount, currency: p.currency,
    requested_currency: fx.enabled ? fx.requestedCurrency : null, fixed_side: fx.enabled ? fx.fixedSide : null,
    last4: SIM_LAST4, brand: w.label,
    origin: 'client', initiation_type: 'customer_present', profile: state.profile,
    aft: !!p.aft, items: orderItems(p),
    customer_id: typeof r.body.customer === 'string' ? r.body.customer : null,
  });

  renderProcessing(`${w.label} approved`, 'Completing your payment…');
  setStatus('Processing…', 'processing');
  setActiveTab('response');
  paintPanels();

  const { httpStatus, data } = await sendIdempotent(createDirectPayment, { ...r.body, env: state.env, profile: state.profile }, {
    onRetry: () => setStatus('Retrying…', 'processing'),
  });
  const current = run === r; // a checkout reset leaves the screen to the new page; the ledger still settles
  r.phase = 'done';
  r.httpStatus = httpStatus;
  r.response = data;
  if (current) paintPanels();
  const d = data?.data;
  const onTerminal = terminalHandler({ reference, paidLabel: 'Paid · CLO' });

  if (isUnknownOutcome(httpStatus)) {
    ledger.updateStatus(reference, { phase: 'unconfirmed' });
    if (current) {
      setStatus('Outcome unknown · confirming', 'processing');
      renderProcessing('Confirming payment…', 'We didn’t hear back in time — checking whether your payment went through. Please don’t pay again.');
    }
    startWebhookWatch({ reference, onTerminal });
    return;
  }
  if (!d || data?.error || httpStatus >= 400 || httpStatus === 0) {
    ledger.updateStatus(reference, { status: 'failed', phase: httpStatus === 0 ? 'error' : 'declined' });
    if (current) {
      setStatus(failureStatusText(data, httpStatus === 0 ? 'Error' : 'Declined'), 'error');
      renderError({ status: data?.error || 'ERR' });
    }
    return;
  }

  ledger.setPaymentId(reference, d.id);
  if (d.status === 'ACT' && d.next_action === '3d_verification') {
    ledger.updateStatus(reference, { phase: 'pending_3ds' });
    if (current) { setStatus('3DS challenge', 'action'); render3DS(httpsUrl(d.redirect_url) || 'about:blank'); }
  } else if (d.status === 'CLO' && d.paid) {
    ledger.updateStatus(reference, { phase: 'awaiting_confirmation' });
    if (current) { setStatus('Authorized · confirming', 'processing'); renderProcessing('Payment authorized', 'Confirming your payment…'); }
  } else if (current) {
    renderProcessing('Processing…');
  }
  startWebhookWatch({ reference, payment_id: d.id, onTerminal });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dw-wallet]');
  if (btn && !btn.disabled) { start(btn.dataset.dwWallet); return; }
  const s = e.target.closest('[data-dw-sheet]');
  if (s) { if (s.dataset.dwSheet === 'confirm') confirm(); else cancel(); }
});

/* ── Right: the sequence ─────────────────────────────────── */
const PARTY = { apple: 'Apple', google: 'Google', merchant: 'Merchant' };

function stepState(i, sheetIndex, rapydIndex, phase) {
  // Before the shopper approves: setup (+ Apple's validation) have happened —
  // the sheet is up; the token and what the merchant does with it come after.
  const reached = phase === 'sheet' ? sheetIndex : rapydIndex;
  return i < reached ? 'done' : i === reached ? 'now' : 'todo';
}

function stepBoxHTML(s, state_) {
  return `
    <div class="dw-step party-${esc(s.party)} ${state_}">
      <div class="dw-step-head">
        <span class="dw-party">${esc(PARTY[s.party])} · outside Rapyd</span>
        <b>${esc(s.title)}</b>
        ${s.pci ? '<span class="dw-pci">PCI scope</span>' : ''}
      </div>
      <p>${esc(s.line)}</p>
      ${s.link ? `<a href="${esc(s.link.href)}" target="_blank" rel="noopener noreferrer">${esc(s.link.label)} ↗</a>` : ''}
      ${s.rapydNote ? `<div class="dw-step-note">${esc(s.rapydNote)}</div>` : ''}
    </div>`;
}

export function paintPanels() {
  if (!run) return;
  const r = run;
  const key = `${r.wallet}:${r.variant}`;
  const w = WALLETS[r.wallet];
  const steps = walletSteps(r.wallet, r.variant);
  const rapydIndex = steps.findIndex((s) => s.party === 'rapyd');
  const sheetIndex = steps.findIndex((s) => s.sheet);
  const req = $('#panel-request');
  if (req) {
    const boxes = steps.slice(0, rapydIndex).map((s, i) => stepBoxHTML(s, stepState(i, sheetIndex, rapydIndex, r.phase))).join('');
    const sent = r.phase !== 'sheet';
    const pmt = r.wallet === 'google' && r.variant === 'decrypted' ? ` · ${esc(r.body.payment_method.digital_wallet.details.decrypted_data.paymentMethodDetails.authMethod)}` : '';
    req.innerHTML = `
      <div class="ext-who dw-intro"><span class="sim-badge">Mock token</span>Direct ${esc(w.label)} · ${r.variant === 'encrypted' ? 'encrypted token — Rapyd decrypts' : 'decrypted by the merchant — DPAN + cryptogram'}${pmt}. The ${esc(w.party)} side is simulated; the payment is created for real in the Rapyd sandbox.</div>
      <div class="dw-steps">${boxes}</div>
      ${beatCardHTML({
        id: 'beat-dw-pay', n: String(rapydIndex + 1), method: 'POST', path: '/v1/payments',
        ...beatBadge(sent ? 'wallet.sent' : 'wallet.sandbox'),
        inner: `
          <div class="ext-who">Rapyd · the merchant’s server → Rapyd. A real, signed call to the sandbox; only the wallet data inside is mock.</div>
          <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${sent ? 'sent after the sheet returned' : 'sent once the shopper approves'} · mock wallet values</span><span class="hint"><span class="inject-key"></span>from the wallet</span></div>
          <div id="req-json-dw">${renderJSONView(r.body)}</div>
          <div class="beat-foot">Signed like any <code>POST /v1/payments</code> (access_key, salt, timestamp, signature). Prerequisite: ${esc(w.label)} activated for the account in the Client Portal${r.variant === 'encrypted' && r.wallet === 'apple' ? ', and Apple’s payment processing certificate registered with Rapyd so it can decrypt' : ''}. The sandbox accepts mock wallet payloads and charges its own test card. Reference: <a href="${esc(RAPYD_DOCS[key])}" target="_blank" rel="noopener noreferrer">Rapyd docs ↗</a></div>`,
      })}`;
    highlightPaths($('#req-json-dw'), leafPathsUnder(r.body, walletDataPaths(r.wallet, r.variant)), 'inject-hit');
  }
  const res = $('#panel-response');
  if (res) {
    res.innerHTML = r.response
      ? paymentResponseCardHTML({ id: 'beat-dw-res', n: String(rapydIndex + 1), httpStatus: r.httpStatus, data: r.response })
      : beatCardHTML({
        id: 'beat-dw-res', n: String(rapydIndex + 1), method: 'POST', path: '/v1/payments',
        inner: `<div class="ext-wait">${r.phase === 'sheet' ? 'Waiting for the shopper to approve in the sheet…' : 'Waiting for Rapyd…'}</div>`,
      });
  }
}
