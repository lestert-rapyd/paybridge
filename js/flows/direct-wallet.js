/* ─────────────────────────────────────────────────────────────
   Direct Apple Pay / Google Pay — the page side of the SIMULATION
   (the rules, payloads and sequence live in js/direct-wallet.js).

   left  · the merchant's OWN Apple Pay / Google Pay buttons on its own
           checkout (Own Card Fields: above "Pay by card"; Checkout
           Toolkit: in the order summary, encrypted only). A click opens a
           neutral, OS-like wallet sheet over the page — Apple's / Google's
           surface, so it gets the grey third-party seam marker, never the
           skin and never Rapyd's — then a skinned success screen with a
           "Simulated — no payment was made" tag.
   right · the whole sequence: Apple / Google / merchant steps as one-line
           boxes OUTSIDE Rapyd (each links the wallet's own docs), then the
           simulated POST /v1/payments in full and its simulated answer —
           dashed cards with a "Simulated" badge.

   Nothing is sent anywhere: no backend call, no Rapyd call, no webhook
   watch, no ledger entry (the ledger mirrors payments that exist at
   Rapyd). The cart stays as it was — nothing was bought.

   Buttons (brand): no official Apple / Google artwork is embedded. Both are
   black buttons with the wallet's NAME as text (Apple HIG and Google's brand
   guidelines both allow a black button; their official marks would replace
   the text in a real integration —
   developer.apple.com/design/human-interface-guidelines/apple-pay,
   developers.google.com/pay/api/web/guides/brand-guidelines).
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, activeProduct, customerCharge, chargeText, fxSnapshot, orderItems } from '../verticals.js';
import { setActiveTab, setStatus, esc } from '../ui.js';
import { currencyDecimals } from '../sync.js';
import { renderJSONView, highlightPaths } from '../json-view.js';
import { beatCardHTML } from '../customer-beat.js';
import { renderProcessing, renderSuccess } from '../screens.js';
import { seamExtWrapHTML, walletSheetLabel } from '../seam.js';
import {
  WALLETS, WALLET_ORDER, SIM_MARK, SIM_LAST4, effectiveWalletIntegration, isDirect,
  directPaymentBody, simulatedResponse, walletSteps, walletDataPaths, leafPathsUnder,
} from '../direct-wallet.js';
import { amountProblem } from './shared.js';

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
    '<code>details.token</code> — the PaymentData object, unchanged; its <code>tokenizationData.token</code> is a JSON string encrypted for Rapyd. <code>details.type</code> — <code>CARD</code>.',
  ],
  'google:decrypted': [
    '<code>payment_method.type</code> — the card’s method type (here <code>gb_visa_card</code>).',
    '<code>details.decrypted_data</code> — the decrypted message: <code>gatewayMerchantId</code>, <code>messageExpiration</code>, <code>messageId</code>, <code>paymentMethod</code>, and <code>paymentMethodDetails</code> (<code>pan</code>, <code>expirationMonth</code>, <code>expirationYear</code>, <code>authMethod</code>, <code>cryptogram</code>, <code>eciIndicator</code>).',
    '<code>details.brand_data</code> — <code>cardDetails</code> (last 4) + <code>cardNetwork</code>.',
  ],
};
const TDS_NOTE = {
  apple: 'The token carries the wallet’s own cryptogram (<code>paymentDataType: "3DSecure"</code>) — Rapyd’s documented flow has no separate 3DS step.',
  google: '<code>CRYPTOGRAM_3DS</code> (simulated here) carries a cryptogram and answers <code>CLO</code> at once; a <code>PAN_ONLY</code> card comes back <code>ACT</code> with <code>next_action: 3d_verification</code> — Rapyd’s own 3DS.',
};

/* ── The run ─────────────────────────────────────────────────
   One simulated payment: { wallet, variant, model, phase, body, response,
   amountText, merchant }. phase: 'sheet' (waiting on the shopper) →
   'authorising' (the merchant's server "calls Rapyd") → 'done' | 'cancelled'.
   Reset with the checkout (app.js renderCheckout). */
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
      <div class="dw-sheet-note">Simulated wallet sheet — no ${esc(w.party)} session, no real card.</div>
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
    wallet, variant, model: state.model, phase: 'sheet',
    merchant: v.merchant, amountText: chargeText(charge),
    body: buildBody(wallet, variant, p, charge), response: null,
  };
  removeSheet();
  $('.browser-body')?.insertAdjacentHTML('beforeend', sheetHTML(run));
  $('#dw-overlay .dw-sheet')?.scrollIntoView({ block: 'nearest' });
  setStatus(`${WALLETS[wallet].label} sheet · simulated`, 'action');
  setActiveTab('request');
  paintPanels();
}

function buildBody(wallet, variant, p, charge) {
  const amount = charge.amount ?? p.amount;
  const body = directPaymentBody({
    wallet, variant, model: state.model, env: state.env,
    amount: p.amount, currency: p.currency,
    charge: { amount, currency: charge.currency }, decimals: currencyDecimals(charge.currency),
    description: p.name, reference: `${SIM_MARK}-pb_${state.vertical}`,
  });
  if (state.fx.enabled && state.fx.requestedCurrency) {
    body.requested_currency = state.fx.requestedCurrency;
    body.fixed_side = state.fx.fixedSide;
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

function confirm() {
  if (!run || run.phase !== 'sheet') return;
  const r = run;
  r.phase = 'authorising';
  removeSheet();
  renderProcessing(`${WALLETS[r.wallet].label} approved`, 'Completing your payment…');
  setStatus('Simulating POST /v1/payments', 'processing');
  paintPanels();
  setTimeout(() => {
    if (run !== r) return; // reset under it
    r.phase = 'done';
    r.response = simulatedResponse(r.body);
    paintPanels();
    setActiveTab('response');
    setStatus('Simulated · no payment made', 'ok');
    const p = activeProduct();
    const v = VERTICALS[state.vertical];
    const charge = customerCharge();
    state.lastPayment = {
      descriptor: v.descriptor, amount: charge.amount ?? p.amount, currency: charge.currency,
      last4: SIM_LAST4, network: WALLETS[r.wallet].label, fx: fxSnapshot(),
      note: p.successNote || v.successNote, simulated: true,
    };
    const items = orderItems(p).map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(', ');
    renderSuccess({}, { simulated: true, items });
  }, 900);
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
    const sentish = r.phase === 'authorising' || r.phase === 'done';
    req.innerHTML = `
      <div class="ext-who dw-intro"><span class="sim-badge">Simulated</span>Direct ${esc(w.label)} · ${r.variant === 'encrypted' ? 'encrypted token — Rapyd decrypts' : 'decrypted by the merchant — DPAN + cryptogram'}. Nothing is sent to ${esc(w.party)}, the backend or Rapyd.</div>
      <div class="dw-steps">${boxes}</div>
      ${beatCardHTML({
        id: 'beat-dw-pay', n: String(rapydIndex + 1), method: 'POST', path: '/v1/payments', sim: true,
        badge: 'Simulated', badgeKind: 'sim',
        inner: `
          <div class="ext-who"><span class="sim-badge">Simulated</span>Rapyd · the merchant’s server → Rapyd. Not sent: no signature is computed, no payment is created.</div>
          <ul class="dw-guide">${FIELD_GUIDE[key].map((li) => `<li>${li}</li>`).join('')}</ul>
          <div class="dw-guide-3ds"><b>3DS</b> ${TDS_NOTE[r.wallet]}</div>
          <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${sentish ? 'after the sheet returned' : 'once the shopper approves'} · dummy values</span><span class="hint"><span class="inject-key"></span>from the wallet</span></div>
          <div id="req-json-dw">${renderJSONView(r.body)}</div>
          <div class="beat-foot">Signed like any <code>POST /v1/payments</code> (access_key, salt, timestamp, signature). Prerequisite: ${esc(w.label)} activated for the account in the Client Portal. Reference: <a href="${esc(RAPYD_DOCS[key])}" target="_blank" rel="noopener noreferrer">Rapyd docs ↗</a></div>`,
      })}`;
    highlightPaths($('#req-json-dw'), leafPathsUnder(r.body, walletDataPaths(r.wallet, r.variant)), 'inject-hit');
  }
  const res = $('#panel-response');
  if (res) {
    res.innerHTML = beatCardHTML({
      id: 'beat-dw-res', n: String(rapydIndex + 1), method: 'POST', path: '/v1/payments', sim: true,
      badge: 'Simulated', badgeKind: 'sim',
      inner: r.response
        ? `
          <div class="ext-who"><span class="sim-badge">Simulated</span>A made-up answer in Rapyd’s shape — every id is fake.</div>
          ${renderJSONView(r.response)}
          <div class="beat-foot">No payment exists at Rapyd: no webhook will arrive and nothing is recorded in the ledger or the back office.</div>`
        : `<div class="ext-wait">${r.phase === 'sheet' ? 'Waiting for the shopper to approve in the sheet…' : 'Simulating Rapyd’s answer…'}</div>`,
    });
  }
}
