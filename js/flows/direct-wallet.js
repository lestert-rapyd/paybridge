/* ─────────────────────────────────────────────────────────────
   Direct Apple Pay / Google Pay — the page side. The wallet is mock, the
   payment is real (sandbox): the rules, payloads and sequence live in
   js/direct-wallet.js.

   left  · the merchant's OWN Apple Pay / Google Pay buttons on its own
           checkout (Own Card Fields: above "Pay by card"; Checkout
           Toolkit: in the order summary, encrypted only). A click opens a
           neutral, OS-like wallet sheet over the page — Apple's / Google's
           surface, so it gets the grey third-party seam marker, never the
           skin and never Rapyd's. Approving it sends the mock token to
           Rapyd for real, and the payment ends like any other: processing,
           Rapyd's 3DS if it asks, then the webhook-confirmed result.
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

import { state } from '../state.js';
import { VERTICALS, activeProduct, customerCharge, chargeText, fxSnapshot, orderItems } from '../verticals.js';
import { createDirectPayment, newReference } from '../api.js';
import { profileEwallet } from '../profiles.js';
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

/* The Rapyd fields, explained — Rapyd's part gets the full detail. Text with
   <code> only (literals here, no data). */
const FIELD_GUIDE = {
  'apple:encrypted': [
    '<code>payment_method.type</code> — the card’s method type (here <code>gb_visa_card</code>); there is no Apple Pay method type.',
    '<code>digital_wallet.type</code> — <code>apple_pay</code>.',
    '<code>details.token</code> — the whole token from <code>onpaymentauthorized</code> (<code>paymentData</code>, <code>paymentMethod</code>, <code>transactionIdentifier</code>), unchanged. Rapyd decrypts it.',
    '<code>metadata.digital_wallet</code> — <code>apple_pay</code>, as in Rapyd’s sample (the merchant’s own label).',
  ],
  'apple:decrypted': [
    '<code>payment_method.type</code> — the card’s method type (here <code>gb_visa_card</code>).',
    '<code>details.decrypted_data</code> — the decrypted <code>token.paymentData</code>: <code>applicationPrimaryAccountNumber</code> (the DPAN), <code>applicationExpirationDate</code> (YYMMDD), <code>currencyCode</code> (ISO 4217 numeric), <code>transactionAmount</code>, <code>deviceManufacturerIdentifier</code>, <code>paymentDataType</code>.',
    '<code>decrypted_data.paymentData</code> — <code>onlinePaymentCryptogram</code> + <code>eciIndicator</code>.',
    '<code>details.brand_data</code> — <code>token.paymentMethod</code> as is (<code>displayName</code>, <code>network</code>, <code>type</code>).',
  ],
  'google:encrypted': [
    '<code>payment_method.type</code> — the card’s method type (here <code>gb_visa_card</code>); there is no Google Pay method type.',
    '<code>digital_wallet.type</code> — <code>google_pay</code>.',
    '<code>details.token</code> — <code>apiVersion</code> 2, <code>apiVersionMinor</code> 0 and <code>paymentMethodData</code> (<code>description</code>, <code>info</code>, <code>tokenizationData</code> type <code>PAYMENT_GATEWAY</code>), its <code>token</code> encrypted for Rapyd. <code>details.type</code> — <code>CARD</code>.',
    '<code>metadata.digital_wallet</code> — <code>google_pay</code>, as in Rapyd’s sample.',
  ],
  'google:decrypted': [
    '<code>payment_method.type</code> — the card’s method type (here <code>gb_visa_card</code>).',
    '<code>details.decrypted_data</code> — the decrypted message: <code>gatewayMerchantId</code>, <code>messageExpiration</code>, <code>messageId</code>, <code>paymentMethod</code>, and <code>paymentMethodDetails</code> (<code>pan</code>, <code>expirationMonth</code>, <code>expirationYear</code>, <code>authMethod</code>; <code>cryptogram</code> + <code>eciIndicator</code> for <code>CRYPTOGRAM_3DS</code> only).',
    '<code>gatewayMerchantId</code> — the merchant’s Rapyd <b>access key</b>. The browser never holds it: the backend writes it in before signing, so the body here shows a placeholder.',
    '<code>details.brand_data</code> — <code>cardDetails</code> (last 4) + <code>cardNetwork</code>.',
  ],
};
const TDS_NOTE = {
  apple: 'The token carries the wallet’s own cryptogram (<code>paymentDataType: "3DSecure"</code>) — Rapyd’s documented flow has no separate 3DS step.',
  google: '<code>CRYPTOGRAM_3DS</code> carries the wallet’s cryptogram + ECI. <code>PAN_ONLY</code> (a card on file in the Google account) carries neither, so Rapyd may answer <code>ACT</code> with <code>next_action: 3d_verification</code> — its own 3DS, which this page then follows. Pick the method in the drawer.',
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

export function resetDirectWallet() {
  run = null;
  removeSheet();
}

const ctx = () => ({ model: state.model, env: state.env });
const variantNow = () => effectiveWalletIntegration(ctx());

/* ── Left: the merchant's buttons ──────────────────────────── */
/** The express block for the active checkout, or '' when no direct variant
    applies (Checkout (real), live, a subscription). */
export function directWalletBlockHTML() {
  const variant = variantNow();
  if (!isDirect(variant)) return '';
  const p = activeProduct();
  if (p.billing === 'subscription') return '';
  const disabled = amountProblem(p) ? 'disabled' : '';
  const own = state.model === 'own-fields';
  return `
    <div class="dw-express">
      <div class="dw-express-label">Express checkout</div>
      <div class="dw-buttons">
        ${WALLET_ORDER.map((id) => `<button type="button" class="dw-btn dw-btn-${esc(id)}" data-dw-wallet="${esc(id)}" ${disabled} aria-label="Pay with ${esc(WALLETS[id].label)}">${esc(WALLETS[id].label)}</button>`).join('')}
      </div>
      ${own ? `<div class="dw-or"><span>or pay by card</span></div>` : ''}
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
  });
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
  state.lastPayment = {
    descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency,
    last4: SIM_LAST4, network: w.label, fx: fxSnapshot(),
    initiation_type: 'customer_present', note: p.successNote || v.successNote,
  };
  ledger.recordPayment(reference, {
    model: state.model, vertical: state.vertical, amount: p.amount, currency: p.currency,
    requested_currency: fx.enabled ? fx.requestedCurrency : null, fixed_side: fx.enabled ? fx.fixedSide : null,
    last4: SIM_LAST4, brand: w.label,
    origin: 'client', initiation_type: 'customer_present', profile: state.profile,
    aft: !!p.aft, items: orderItems(p), customer_id: null,
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
        badge: sent ? 'Sent · sandbox' : 'Sandbox', badgeKind: sent ? 'live' : '',
        inner: `
          <div class="ext-who">Rapyd · the merchant’s server → Rapyd. A real, signed call to the sandbox; only the wallet data inside is mock.</div>
          <ul class="dw-guide">${FIELD_GUIDE[key].map((li) => `<li>${li}</li>`).join('')}</ul>
          <div class="dw-guide-3ds"><b>3DS</b> ${TDS_NOTE[r.wallet]}</div>
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
