/* ─────────────────────────────────────────────────────────────
   Client Back Office — the merchant-ops surface. Lists every payment
   made this session (from either flow), lets an SE drill into one and
   fire refunds against its captured FX position.

   Two sub-views, tracked module-locally so a tab-switch away and back
   restores exactly where the SE was (the locked left-panel persistence
   rule): a LIST of payment tiles, and a DETAIL view of one payment with
   its refund form.

   Right-panel choreography (reuses the shared engine-room panels — the
   panel doesn't care who initiated the call; only paints while this tab
   is the active left view, mirroring webhooks.js's guard):
     · hover a tile   → prepared  GET  /v1/payments/{id}   (Request)
     · click a tile   → fires it, shows the payment object  (Response)
     · open/edit form → prepared  POST /v1/refunds, live    (Request)
     · fire refund    → response + REFUND_COMPLETED card     (Response, Webhooks)

   Amounts follow the product-wide convention: 3-letter ISO code, no
   currency symbol (matches the API and the checkout tile).
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import { createRefund, createDirectPayment, retrievePayment, fetchWebhooksBatch } from '../api.js';
import { profileEwallet } from '../profiles.js';
import { renderJSONView } from '../json-view.js';
import { setActiveTab } from '../ui.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import { classify } from '../classify.js';
import {
  getLedger, getEntry, subscribeLedger, recordPayment, recordRefund, updateRefund,
  setPaymentId, updateStatus, applyPaymentObject, walletBalances, refundedTotals,
} from '../ledger.js';
import * as customers from '../customers.js';

const $ = (s, r = document) => r.querySelector(s);

/* ── module-local navigation + form state ─────────────────── */
let view = 'list';        // 'list' | 'detail'
let detailRef = null;     // reference of the payment open in detail
let refundOpen = false;   // is the refund form expanded
let firing = false;       // a refund POST is in flight
let pendingRefundRef = null; // refund ref we're waiting to confirm
let lastHoverRef = null;  // avoids redundant GET-preview repaints on hover
let form = { amount: '', reason: '', route: null }; // route: 'customer' | 'merchant' | null
let refundWatchTimer = null;

/* Customer-on-file / MIT charge state (mirrors the refund form's pattern) */
let cofChargeRef = null;      // credential ref with the charge form open
let chargeForm = { amount: '' };
let chargeFiring = false;     // a MIT POST /v1/payments is in flight
let pendingChargeRef = null;  // payment reference we're waiting to confirm

const PHASE_LABEL = {
  created: 'Created', pending_3ds: 'Pending · 3DS', awaiting_confirmation: 'Awaiting confirmation',
  completed: 'Completed', failed: 'Failed', declined: 'Declined', error: 'Error',
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : '—'; };
const money = (n, cur) => `${fmt(n)} ${cur || ''}`.trim();
function pill(text, kind) { return `<span class="wh-pill ${kind}">${text}</span>`; }

function statusKind(status) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'failure';
  return 'pending';
}

function brandLabel(entry) {
  const s = entry.settled || {};
  const t = (s.brand || entry.brand || '').toLowerCase();
  const net = /visa/.test(t) ? 'Visa' : /master/.test(t) ? 'Mastercard' : /amex|express/.test(t) ? 'Amex' : 'Card';
  const last4 = s.last4 || entry.last4;
  return last4 ? `${net} ending ${last4}` : net;
}

/** True FX = a distinct merchant settlement leg was captured. */
function isFx(entry) {
  const s = entry.settled || {};
  return s.merchant_requested_amount != null && !!s.merchant_requested_currency;
}

/* ── Left panel: wallet anchor (both views, reactive) ─────────
   A plain ledger: the balance (one figure per currency held) and how many
   payments were captured this session. No model tag / name / settlement
   line — the tile is an anchor, not a header. */
function renderWallet() {
  const el = $('#bo-wallet');
  if (!el) return;
  const bal = walletBalances();
  const curs = Object.keys(bal);
  const count = getLedger().filter((e) => e.status === 'completed').length;

  // primary = settlement currency of the most recent completed payment
  let primaryCur = curs[0] || null;
  for (const e of getLedger().filter((x) => x.status === 'completed')) {
    const c = e.settled?.merchant_requested_currency || e.settled?.currency || e.currency;
    if (c && bal[c] != null) { primaryCur = c; break; }
  }
  const others = curs.filter((c) => c !== primaryCur);

  el.innerHTML = `
    <div class="bo-wallet-card">
      <div class="bo-wallet-ballabel">Wallet balance</div>
      <div class="bo-wallet-balmain">${primaryCur ? money(bal[primaryCur], primaryCur) : '0.00'}</div>
      ${others.map((c) => `<div class="bo-wallet-balsub">${money(bal[c], c)}</div>`).join('')}
      <div class="bo-wallet-meta">${count} payment${count === 1 ? '' : 's'} this session</div>
    </div>`;
}

/* ── Left panel: LIST of payment tiles ────────────────────── */
function eligibilityChip(entry) {
  if (entry.status !== 'completed') return pill(PHASE_LABEL[entry.phase] || entry.status, statusKind(entry.status));
  const t = refundedTotals(entry);
  if (t.count === 0 || t.refunded <= 0) return pill('COMPLETED', 'success');
  if (t.remaining <= 0) return pill('REFUNDED', 'field');
  return pill(`PARTIAL · ${fmt(t.refunded)}/${fmt(t.total)}`, 'pending');
}

function tileHTML(entry) {
  const v = VERTICALS[entry.vertical];
  const fx = isFx(entry);
  const s = entry.settled || {};
  const custAmt = s.original_amount ?? entry.amount;
  const custCur = s.currency || entry.currency;
  const clickable = entry.status === 'completed';
  const mit = entry.origin === 'backoffice';
  return `
    <div class="bo-tile ${clickable ? 'clickable' : 'inert'}" data-ref="${entry.reference}">
      <div class="bo-tile-main">
        <div class="bo-tile-ref">${esc(entry.reference)}</div>
        <div class="bo-tile-sub">${brandLabel(entry)}${fx ? ` <span class="bo-fx-badge">FX → ${s.merchant_requested_currency} · ${entry.fixed_side || 'sell'}</span>` : ''}${mit ? ` <span class="bo-mit-badge">MIT · ${entry.initiation_type || 'recurring'}</span>` : ''}${entry.aft ? ` <span class="bo-mit-badge aft">AFT</span>` : ''}</div>
      </div>
      <div class="bo-tile-amts">
        <div class="bo-tile-paid">${money(custAmt, custCur)}</div>
        ${fx ? `<div class="bo-tile-settled">→ ${money(s.merchant_requested_amount, s.merchant_requested_currency)}</div>` : ''}
      </div>
      <div class="bo-tile-status">${eligibilityChip(entry)}</div>
      ${clickable ? `<span class="bo-tile-chev">›</span>` : ''}
    </div>`;
}

function listHTML() {
  const entries = getLedger();
  return `
    <div class="bo-section-label">Payments this session</div>
    <div class="bo-tiles">${entries.map(tileHTML).join('')}</div>
    <div class="bo-list-note">Refunds are order-based — open a payment to refund it against its captured FX position.</div>`;
}

/* ── Left panel: DETAIL view of one payment ───────────────── */
function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function shortId(id) {
  if (!id) return '—';
  return id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
}

/* Refunded X / Y as a progress bar — doubles as the visual completion state
   (accent while partial, green once fully refunded). */
function eligibilityBarHTML(t) {
  const pct = t.total > 0 ? Math.min(100, Math.round((t.refunded / t.total) * 100)) : 0;
  const full = t.remaining <= 0 && t.refunded > 0;
  return `
    <div class="bo-eligible ${full ? 'full' : ''}">
      <div class="bo-eligible-top">
        <span class="bo-eligible-amt">Refunded ${fmt(t.refunded)} / ${fmt(t.total)} ${t.currency}</span>
        <span class="bo-eligible-state">${full ? 'Fully refunded' : `${fmt(t.remaining)} ${t.currency} eligible`}</span>
      </div>
      <div class="bo-eligible-track"><div class="bo-eligible-fill" style="width:${pct}%"></div></div>
    </div>`;
}

function refundHistoryHTML(entry) {
  if (!entry.refunds.length) return '';
  // newest first, so the most recent action reads at the top
  const rows = [...entry.refunds].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return `
    <div class="bo-refund-tablewrap">
      <div class="bo-refund-tablehead">Refund history</div>
      <table class="bo-refund-table">
        <thead><tr><th>Status</th><th>Amount</th><th>Reason</th><th>When</th><th>Refund ID</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${pill(r.status, statusKind(r.status))}</td>
              <td class="bo-rt-amt">${r.amount != null ? money(r.amount, r.currency) : '—'}</td>
              <td class="bo-rt-reason" title="${esc(r.reason || '')}">${r.reason ? esc(r.reason) : '—'}</td>
              <td class="bo-rt-when">${fmtWhen(r.created_at)}</td>
              <td class="bo-rt-id"><code>${shortId(r.refund_id)}</code></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function routeCardsHTML(entry) {
  const s = entry.settled || {};
  const fxr = s.fx_rate;
  const custCur = s.currency || entry.currency;
  const merchCur = s.merchant_requested_currency;
  const amt = round2(form.amount);
  // The active route's amount is in THAT route's currency. Only the active
  // card shows numeric legs (an inactive card's legs would misread the shared
  // amount as its own currency) — computed from the two legs of the refund.
  const legs = (route) => {
    if (route === 'customer') return { wallet: money(round2(amt * (fxr || 1)), merchCur), out: money(amt, custCur) };
    return { wallet: money(amt, merchCur), out: money(round2(fxr ? amt / fxr : amt), custCur) };
  };
  const card = (route, title, note) => {
    const active = form.route === route;
    const l = active ? legs(route) : null;
    return `
    <button type="button" class="bo-route ${active ? 'active' : ''}" data-route="${route}">
      <div class="bo-route-title">${title}</div>
      <div class="bo-route-note">${note}</div>
      ${l ? `<div class="bo-route-legs">
        <div class="bo-route-leg"><span>Leaves your wallet</span><b>${l.wallet}</b></div>
        <div class="bo-route-leg"><span>Goes out to customer</span><b>${l.out}</b></div>
      </div>` : ''}
    </button>`;
  };
  return `
    <div class="bo-route-anchor">You received <b>${money(s.merchant_requested_amount, merchCur)}</b> for this order · rate 1 ${custCur} = ${fmt(fxr)} ${merchCur}</div>
    <div class="bo-routes">
      ${card('customer', 'Make the customer whole', 'Refund what they paid — you may pay out more than you received.')}
      ${card('merchant', 'Refund what you received', 'Refund your settled amount — the customer may get back less than they paid.')}
    </div>`;
}

function refundFormHTML(entry) {
  const fx = isFx(entry);
  const s = entry.settled || {};
  const custCur = s.currency || entry.currency;
  const merchCur = s.merchant_requested_currency;
  const amtCur = fx ? (form.route === 'merchant' ? merchCur : custCur) : custCur;
  return `
    <div class="bo-refund-form">
      <div class="bo-refund-formhead">Issue a refund</div>
      ${fx ? routeCardsHTML(entry) : ''}
      <div class="bo-refund-field">
        <label>Amount</label>
        <div class="bo-refund-amtfield">
          <input type="text" inputmode="decimal" class="bo-refund-input bo-refund-amount" id="bo-refund-amount" value="${esc(form.amount)}" />
          <span class="bo-refund-currency">${amtCur}</span>
        </div>
      </div>
      <div class="bo-refund-field">
        <label>Reason</label>
        <input type="text" class="bo-refund-input" id="bo-refund-reason" value="${esc(form.reason)}" placeholder="e.g. Faulty merchandise" />
      </div>
      <div class="bo-refund-actions">
        <button class="bo-refund-btn cancel" id="bo-refund-cancel">Cancel</button>
        <button class="bo-refund-btn safe" id="bo-refund-fire" ${firing ? 'disabled' : ''}>${firing ? 'Processing…' : 'Process refund'}</button>
      </div>
    </div>`;
}

function detailHTML(entry) {
  const v = VERTICALS[entry.vertical];
  const fx = isFx(entry);
  const s = entry.settled || {};
  const custAmt = s.original_amount ?? entry.amount;
  const custCur = s.currency || entry.currency;
  const t = refundedTotals(entry);
  const fullyRefunded = t.remaining <= 0 && t.refunded > 0;
  const statusBadge = fullyRefunded
    ? pill('REFUNDED', 'field')
    : (t.refunded > 0 ? pill(`PARTIAL · ${fmt(t.refunded)}/${fmt(t.total)} ${t.currency}`, 'pending') : pill('COMPLETED', 'success'));

  return `
    <button class="bo-back" id="bo-back">‹ All payments</button>
    <div class="bo-detail-card">
      <div class="bo-detail-head">
        <div>
          <span class="bo-model-tag">${entry.model === 'toolkit' ? 'Toolkit' : 'Own fields'}</span>
          ${entry.origin === 'backoffice' ? `<span class="bo-model-tag mit">Back office · MIT</span>` : ''}
          <span class="bo-detail-vertical">${v?.label || entry.vertical}</span>
        </div>
        ${statusBadge}
      </div>
      <div class="bo-detail-ref">${esc(entry.reference)}</div>
      <div class="bo-detail-card2">${brandLabel(entry)}</div>

      <div class="bo-detail-rows">
        <div class="bo-detail-row"><span>Customer paid</span><b>${money(custAmt, custCur)}</b></div>
        ${fx ? `<div class="bo-detail-row"><span>Rate at capture</span><b>1 ${custCur} = ${fmt(s.fx_rate)} ${s.merchant_requested_currency}</b></div>` : ''}
        ${fx ? `<div class="bo-detail-row"><span>Merchant settled</span><b class="bo-detail-settled">${money(s.merchant_requested_amount, s.merchant_requested_currency)}</b></div>` : ''}
      </div>

      ${t.refunded > 0 ? eligibilityBarHTML(t) : ''}
      ${refundHistoryHTML(entry)}

      ${refundOpen ? refundFormHTML(entry)
        : (fullyRefunded ? '' : `<button class="co-cta bo-refund-open" id="bo-refund-open">Refund this payment</button>`)}
    </div>`;
}

/* ── Body orchestration ───────────────────────────────────── */
function renderBody() {
  const el = $('#bo-body');
  if (!el) return;
  if (view === 'detail' && detailRef) {
    const entry = getEntry(detailRef);
    if (entry) { el.innerHTML = detailHTML(entry); return; }
    view = 'list'; // entry vanished — fall back
  }
  el.innerHTML = listHTML();
}

export function render() {
  if (state.leftView !== 'backoffice') return;
  const el = $('#backoffice');
  if (!el) return;
  const entries = getLedger();
  if (!entries.length && !customers.hasCredentials()) {
    el.innerHTML = `<div class="eng-empty"><div class="ee-ico">🗂️</div><div class="ee-text">Payments made this session will show up here, live, whichever flow made them.</div></div>`;
    return;
  }
  el.innerHTML = `<div class="bo-wallet" id="bo-wallet"></div><div class="bo-cof" id="bo-cof"></div><div class="bo-body" id="bo-body"></div>`;
  renderWallet();
  renderCof();
  renderBody();
}

/* ── Left panel: Customer on file (stored credentials + MIT charges) ──
   Lists every stored credential for the active env/profile with its kind
   (merchant vault vs card_ token), scheme intent (recurrence) and NRI state.
   `recurring` credentials carry the Charge action — the subsequent leg of the
   recurring/DCA story: merchant-initiated, customer absent, no 3DS, no CVV.
   `unscheduled` credentials are charged from the client site (CIT), not here. */
function renderCof() {
  const el = $('#bo-cof');
  if (!el) return;
  if (view !== 'list' || !customers.hasCredentials()) { el.innerHTML = ''; return; }
  const cus = customers.getCustomerId();
  const creds = customers.credentials();
  el.innerHTML = `
    <div class="bo-section-label">Customer on file</div>
    <div class="bo-cof-card">
      <div class="bo-cof-head">
        <div>
          <div class="bo-cof-name">${customers.getIdentity().name}</div>
          <div class="bo-cof-id">${cus ? `<code>${cus}</code>` : 'merchant vault only — no Rapyd customer object'}</div>
        </div>
        ${cus ? `<button class="bo-cof-sync" id="bo-cof-sync" ${chargeFiring ? 'disabled' : ''}>↻ Sync from Rapyd</button>` : ''}
      </div>
      <div class="bo-cof-creds">${creds.map(credRowHTML).join('')}</div>
    </div>`;
}

function credRowHTML(c) {
  const mit = c.recurrence_type === 'recurring';
  const chargeable = mit && (c.kind === 'token' ? !!c.card_id : !!c.network_reference_id);
  const open = cofChargeRef === c.ref;
  const exp = c.expiration_month && c.expiration_year ? `${c.expiration_month}/${c.expiration_year}` : '··/··';
  const blockedHint = c.kind === 'token'
    ? 'Token not captured yet — waiting on PAYMENT_COMPLETED'
    : 'No network_reference_id captured — a vault card cannot be charged without the customer present';
  return `
    <div class="bo-cof-cred ${open ? 'open' : ''}" data-cred="${c.ref}">
      <div class="bo-cof-credrow">
        <span class="bo-cof-brand">${c.brand || 'Card'} ···${c.last4 || '····'}</span>
        <span class="bo-cof-exp">${exp}</span>
        ${pill(c.kind === 'token' ? 'card_ token' : 'merchant vault', 'field')}
        ${pill(c.recurrence_type || 'unscheduled', mit ? 'pending' : 'field')}
        ${c.aft ? pill('AFT', 'evt') : ''}
        ${c.network_reference_id ? pill('NRI ✓', 'success') : ''}
        ${mit
          ? `<button class="bo-cof-charge" data-charge="${c.ref}" ${chargeable && !chargeFiring ? '' : `disabled title="${esc(blockedHint)}"`}>Charge</button>`
          : `<span class="bo-cof-cit">reused from the client site</span>`}
      </div>
      ${open ? chargeFormHTML(c) : ''}
    </div>`;
}

/** The subscription product this credential was saved for — drives the charge
    amount/currency/descriptor. Falls back to the vertical's first subscription
    product (sync-discovered credentials carry no origin). */
function productForCred(c) {
  const v = VERTICALS[c.origin_vertical] || VERTICALS[state.vertical];
  return v.products.find((p) => p.id === c.origin_product)
    || v.products.find((p) => p.billing === 'subscription' && !!p.aft === !!c.aft)
    || v.products.find((p) => p.billing === 'subscription')
    || v.products[0];
}
const chargeDefaultAmount = (c) => (state.env === 'live' ? '0.01' : productForCred(c).amount);

function chargeFormHTML(c) {
  const p = productForCred(c);
  return `
    <div class="bo-charge-form">
      <div class="bo-refund-formhead">Scheduled charge — customer not present</div>
      <div class="bo-charge-meta">
        <span class="bo-charge-prod">${p.name}</span>
        ${pill('initiation_type: recurring', 'evt')}
        ${c.aft ? pill('AFT · is_direct_purchase', 'evt') : ''}
      </div>
      <div class="bo-charge-note">MIT — no 3DS, no CVV, no client_details; the ${c.kind === 'token' ? '<code>card_***</code> token' : 'stored <code>network_reference_id</code>'} authorises the reuse. In production this fires from your scheduler.</div>
      <div class="bo-refund-field">
        <label>Amount</label>
        <div class="bo-refund-amtfield">
          <input type="text" inputmode="decimal" class="bo-refund-input" id="bo-charge-amount" value="${esc(chargeForm.amount)}" />
          <span class="bo-refund-currency">${p.currency}</span>
        </div>
      </div>
      <div class="bo-refund-actions">
        <button class="bo-refund-btn cancel" id="bo-charge-cancel">Cancel</button>
        <button class="bo-refund-btn safe" id="bo-charge-fire" ${chargeFiring ? 'disabled' : ''}>${chargeFiring ? 'Processing…' : 'Run scheduled charge now'}</button>
      </div>
    </div>`;
}

/* MIT request body — PLAN §1.1/§1.6: initiation_type recurring, token or
   NRID credential, AFT block for DCA, and deliberately NO 3d_required /
   client_details / address (the customer is not present). */
function mitBody(c, amountInput, ref) {
  const p = productForCred(c);
  const v = VERTICALS[c.origin_vertical] || VERTICALS[state.vertical];
  const body = {
    amount: round2(amountInput),
    currency: p.currency,
    capture: true,
  };
  const wallet = profileEwallet();
  if (wallet) body.ewallet = wallet;
  if (c.kind === 'token') body.customer = customers.getCustomerId();
  body.merchant_reference_id = ref;
  body.statement_descriptor = v.descriptor;
  body.description = `${p.name} · scheduled charge`;
  body.payment_method = c.kind === 'token'
    ? c.card_id
    : { type: c.type, fields: {
        number: c.number,
        expiration_month: c.expiration_month,
        expiration_year: c.expiration_year,
        name: c.name,
        network_reference_id: c.network_reference_id, // replaces cvv — customer absent
      } };
  body.initiation_type = 'recurring';
  if (c.aft) {
    body.payment_method_options = {
      aft: true,
      is_direct_purchase: true, // each DCA cycle buys — that's the plan
      purpose_code: p.purpose_code || 'crypto_currency',
      special_condition_indicator: p.special_condition_indicator || 'cryptocurrency',
    };
  }
  return body;
}

/* ── Right panel: prepared / fired requests ───────────────── */
function paintGetRequest(entry, prepared) {
  const el = $('#panel-request');
  if (!el || state.leftView !== 'backoffice') return;
  const path = `/v1/payments/${entry.payment_id}`;
  const st = newSaltTimestamp();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill get">GET</span><span class="req-path">${path}</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${prepared ? 'back office · retrieve (prepared)' : 'back office · retrieve'}</span></div>
    <div class="jsonv"><div class="jsonv-body"><span class="jv-empty">— GET has no request body —</span></div></div>`;
  fillSignature(el, 'get', path, st, null);
}
function paintResponse(data, ok, label) {
  const el = $('#panel-response');
  if (!el || state.leftView !== 'backoffice') return;
  el.innerHTML = `
    <div class="eng-pillrow">
      <span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${ok ? 200 : 400}</span>
      <span class="wh-pill ${ok ? 'success' : 'failure'}">${label}</span>
    </div>
    ${renderJSONView(data ?? { error: 'no response body' })}`;
}
function paintRefundRequest(body) {
  const el = $('#panel-request');
  if (!el || state.leftView !== 'backoffice') return;
  const st = newSaltTimestamp();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/refunds</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${firing ? 'signed &amp; sent' : 'updates as you edit'}</span></div>
    ${renderJSONView(body)}`;
  fillSignature(el, 'post', '/v1/refunds', st, body);
}
function paintChargeRequest(body, sentNow) {
  const el = $('#panel-request');
  if (!el || state.leftView !== 'backoffice') return;
  const st = newSaltTimestamp();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/payments</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${sentNow ? 'signed &amp; sent' : 'back office · MIT charge (updates as you edit)'}</span></div>
    ${renderJSONView(body)}`;
  fillSignature(el, 'post', '/v1/payments', st, body);
}
function paintListRequest(prepared) {
  const el = $('#panel-request');
  if (!el || state.leftView !== 'backoffice') return;
  const cus = customers.getCustomerId();
  if (!cus) return;
  const path = `/v1/customers/${cus}/payment_methods?category=card`;
  const st = newSaltTimestamp();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill get">GET</span><span class="req-path">${path}</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${prepared ? 'back office · saved cards (prepared)' : 'back office · saved cards'}</span></div>
    <div class="jsonv"><div class="jsonv-body"><span class="jv-empty">— GET has no request body —</span></div></div>`;
  fillSignature(el, 'get', path, st, null);
}
function paintWebhookCard(events, label = 'back office · refund') {
  const el = $('#panel-webhooks');
  if (!el || state.leftView !== 'backoffice') return;
  el.innerHTML = `
    <div class="wh-status live"><span class="wh-status-dot"></span>Delivered<span class="wh-ref">${label}</span></div>
    ${events.map((e, i) => {
      const kind = classify(e);
      return `
        <details class="wh-card ${kind}" ${i === 0 ? 'open' : ''}>
          <summary class="wh-card-head">
            <span class="wh-chev">▸</span>
            ${pill(e.type || 'EVENT', 'evt')}
            ${e.status ? pill(`status: ${e.status}`, kind) : ''}
          </summary>
          <div class="wh-card-json">${renderJSONView(e.raw || e)}</div>
        </details>`;
    }).join('')}`;
}

/* ── Refund body assembly (route-aware) ───────────────────── */
function computeRefundLegs(entry, route, amountInput) {
  const s = entry.settled || {};
  const fxr = s.fx_rate;
  const custCur = s.currency || entry.currency;
  const merchCur = s.merchant_requested_currency;
  const amt = round2(amountInput);
  if (isFx(entry) && route === 'merchant' && merchCur && fxr) {
    return { body: { amount: amt, currency: merchCur }, customer_equiv: round2(amt / fxr),
      merchant_debit_amount: amt, merchant_debit_currency: merchCur };
  }
  if (isFx(entry) && route === 'customer' && merchCur && fxr) {
    return { body: { amount: amt, currency: custCur }, customer_equiv: amt,
      merchant_debit_amount: round2(amt * fxr), merchant_debit_currency: merchCur };
  }
  return { body: { amount: amt, currency: custCur }, customer_equiv: amt,
    merchant_debit_amount: amt, merchant_debit_currency: custCur };
}

function buildBody(entry, refundRef, legs) {
  const body = { payment: entry.payment_id, merchant_reference_id: refundRef, ...legs.body };
  if (form.reason) body.reason = form.reason; // omit rather than send an empty/undefined key
  return body;
}
function currentRefundBody(entry) {
  const legs = computeRefundLegs(entry, form.route, form.amount);
  return buildBody(entry, `${entry.reference}_refund_${entry.refunds.length + 1}`, legs);
}

/* ── Actions ──────────────────────────────────────────────── */
// Monotonic token: any newer right-panel action (another tile's GET, a refund
// fire) supersedes a still-in-flight GET, so a slow response can't clobber the
// panel after the SE has moved on.
let actionSeq = 0;

async function retrieveAndOpen(reference) {
  const entry = getEntry(reference);
  if (!entry || !entry.payment_id) return;
  const mySeq = ++actionSeq;
  view = 'detail';
  detailRef = reference;
  refundOpen = false;
  renderBody();
  paintGetRequest(entry, false);
  setActiveTab('response');
  paintResponse(null, true, 'RETRIEVING…');
  try {
    // signed by the MID that created the payment — the only one that can see it
    const { httpStatus, data } = await retrievePayment(entry.payment_id, state.env, entry.profile || state.profile);
    const okResp = httpStatus < 400 && !data?.error;
    if (okResp && data?.data) applyPaymentObject(reference, data.data); // ledger is always safe to update, even if the panel paint is superseded
    if (mySeq !== actionSeq) return; // superseded by a newer action — leave the panel alone
    paintResponse(data, okResp, okResp ? 'PAYMENT RETRIEVED' : 'ERROR');
  } catch (err) {
    if (mySeq !== actionSeq) return;
    paintResponse({ error: 'network_error', message: err.message }, false, 'ERROR');
  }
}

function openRefundForm() {
  const entry = getEntry(detailRef);
  if (!entry) return;
  const t = refundedTotals(entry);
  const fx = isFx(entry);
  form = { amount: fmt(t.remaining > 0 ? t.remaining : t.total), reason: '', route: fx ? 'customer' : null };
  refundOpen = true;
  renderBody();
  paintRefundRequest(currentRefundBody(entry));
  setActiveTab('request');
}

function selectRoute(route) {
  const entry = getEntry(detailRef);
  if (!entry) return;
  form.route = route;
  const s = entry.settled || {};
  const t = refundedTotals(entry);
  // reset the amount to the remaining slice, expressed in the chosen leg's currency
  const custRemaining = t.remaining > 0 ? t.remaining : t.total;
  form.amount = fmt(route === 'merchant' && s.fx_rate ? round2(custRemaining * s.fx_rate) : custRemaining);
  renderBody();
  paintRefundRequest(currentRefundBody(entry));
}

// Update the active route card's in/out legs in place (no re-render — the
// amount input must keep focus while the SE types).
function refreshRouteLegs() {
  const entry = getEntry(detailRef);
  if (!entry || !isFx(entry) || !form.route) return;
  const s = entry.settled || {};
  const fxr = s.fx_rate, custCur = s.currency || entry.currency, merchCur = s.merchant_requested_currency;
  const amt = round2(form.amount);
  const wallet = form.route === 'customer' ? money(round2(amt * (fxr || 1)), merchCur) : money(amt, merchCur);
  const out = form.route === 'customer' ? money(amt, custCur) : money(round2(fxr ? amt / fxr : amt), custCur);
  const bs = document.querySelectorAll('.bo-route.active .bo-route-leg b');
  if (bs[0]) bs[0].textContent = wallet;
  if (bs[1]) bs[1].textContent = out;
}

function onAmountInput(raw) {
  // digits + single decimal point (mirrors the checkout tile's filter)
  let vlr = raw.replace(/[^\d.]/g, '');
  const dot = vlr.indexOf('.');
  if (dot !== -1) vlr = vlr.slice(0, dot + 1) + vlr.slice(dot + 1).replace(/\./g, '');
  form.amount = vlr;
  const entry = getEntry(detailRef);
  if (entry) paintRefundRequest(currentRefundBody(entry)); // live body repaint, form DOM untouched
  refreshRouteLegs();
}

async function fireRefund() {
  const entry = getEntry(detailRef);
  if (!entry || firing) return;
  const legs = computeRefundLegs(entry, form.route, form.amount);
  if (!(legs.body.amount > 0)) return; // guard blank/zero
  const refundRef = `${entry.reference}_refund_${Date.now()}`;
  const body = buildBody(entry, refundRef, legs);

  ++actionSeq; // supersede any still-in-flight GET so it can't clobber this
  firing = true;
  pendingRefundRef = refundRef;
  recordRefund(entry.reference, {
    reference: refundRef, amount: legs.body.amount, currency: legs.body.currency,
    reason: form.reason, route: form.route,
    merchant_debit_amount: legs.merchant_debit_amount, merchant_debit_currency: legs.merchant_debit_currency,
    customer_equiv: legs.customer_equiv,
  });
  renderBody(); // reflect "Processing…" on the button
  paintRefundRequest(body); // freeze the signed body view (env is transport-only, added at fetch)
  setActiveTab('request');

  try {
    // refunds must be signed by the MID that took the payment
    const { httpStatus, data } = await createRefund({ ...body, env: state.env, profile: entry.profile || state.profile });
    const ok = httpStatus < 400 && !data?.error;
    paintResponse(data, ok, ok ? 'REFUND CREATED' : (data?.raw?.error_code || data?.error || 'ERROR'));
    setActiveTab('response');
    if (ok) {
      const d = data?.data;
      if (d?.id) updateRefund(entry.reference, refundRef, { refund_id: d.id, amount: d.amount ?? legs.body.amount, currency: d.currency ?? legs.body.currency });
      watchEventForRef(refundRef, 'back office · refund'); // real REFUND_COMPLETED / PAYMENT_REFUND_FAILED
    } else {
      // Rapyd rejected the refund synchronously (e.g. amount exceeds
      // refundable) — mark it failed and surface a PAYMENT_REFUND_FAILED
      // event on the webhook tab, grounded in the real API error.
      updateRefund(entry.reference, refundRef, { status: 'failed' });
      paintWebhookCard([refundFailedEvent(refundRef, body, data)]);
    }
  } catch (err) {
    // A genuine transport failure (no API response to render) — not a Rapyd
    // business error. Shown as-is; no webhook, since no refund was created.
    paintResponse({ error: 'network_error', message: err.message }, false, 'NETWORK ERROR');
    setActiveTab('response');
    updateRefund(entry.reference, refundRef, { status: 'failed' });
  } finally {
    firing = false;
    renderBody();
  }
}

/* A PAYMENT_REFUND_FAILED webhook shape, built from the synchronous Rapyd
   rejection so the webhook tab reflects the failure end-to-end. */
function refundFailedEvent(refundRef, body, data) {
  const rapyd = data?.raw || {};
  return {
    type: 'PAYMENT_REFUND_FAILED',
    status: rapyd.status || 'ERROR',
    raw: {
      type: 'PAYMENT_REFUND_FAILED',
      data: {
        merchant_reference_id: refundRef,
        payment: body.payment,
        amount: body.amount,
        currency: body.currency,
        status: 'ERROR',
        failure_code: rapyd.error_code || data?.error || 'REFUND_ERROR',
        failure_message: rapyd.message || data?.message || 'The refund could not be processed.',
      },
    },
  };
}

/* ── Back-office webhook watcher (card + confirmation beat) ──
   Shared by refunds AND MIT charges — watches one reference until its real
   event lands, paints the card, jumps to the Webhooks tab (locked UX #2). */
function stopRefundWatch() { if (refundWatchTimer) clearInterval(refundWatchTimer); refundWatchTimer = null; }
function watchEventForRef(ref, label) {
  stopRefundWatch();
  let elapsed = 0;
  const tick = async () => {
    elapsed += 3000;
    let events = [];
    try { const d = await fetchWebhooksBatch([ref]); events = d.byRef?.[ref] || []; } catch { /* transient */ }
    if (events.length) {
      paintWebhookCard(events, label);
      if (state.leftView === 'backoffice') setActiveTab('webhooks');
      stopRefundWatch();
    }
    if (elapsed > 120000) stopRefundWatch();
  };
  tick();
  refundWatchTimer = setInterval(tick, 3000);
}

/* On refund completion (surfaced by the ledger poller), close the form and
   refresh the detail from the now-updated ledger (wallet + X/Y follow). */
function maybeFinalizeRefund() {
  if (!pendingRefundRef) return;
  for (const e of getLedger()) {
    const r = e.refunds.find((x) => x.reference === pendingRefundRef);
    if (r && (r.status === 'completed' || r.status === 'failed')) {
      pendingRefundRef = null;
      refundOpen = false;
    }
  }
}

/* ── Customer-on-file actions (MIT charge + live sync) ─────── */
function openChargeForm(credRef) {
  const cred = customers.getCredential(credRef);
  if (!cred || chargeFiring) return;
  ++actionSeq; // supersede any in-flight GET
  cofChargeRef = credRef;
  chargeForm = { amount: chargeDefaultAmount(cred) };
  renderCof();
  paintChargeRequest(mitBody(cred, chargeForm.amount, '(assigned on fire)'), false);
  setActiveTab('request');
}
function closeChargeForm() {
  cofChargeRef = null;
  renderCof();
}
function onChargeAmountInput(raw) {
  // digits + single decimal point (mirrors the refund form's filter)
  let vlr = raw.replace(/[^\d.]/g, '');
  const dot = vlr.indexOf('.');
  if (dot !== -1) vlr = vlr.slice(0, dot + 1) + vlr.slice(dot + 1).replace(/\./g, '');
  chargeForm.amount = vlr;
  const cred = customers.getCredential(cofChargeRef);
  if (cred) paintChargeRequest(mitBody(cred, chargeForm.amount, '(assigned on fire)'), false); // live body, form DOM untouched
}

async function fireCharge() {
  const cred = customers.getCredential(cofChargeRef);
  if (!cred || chargeFiring) return;
  if (!(round2(chargeForm.amount) > 0)) return; // guard blank/zero
  const p = productForCred(cred);
  const ref = `pb_mit_${Date.now()}`;
  const body = mitBody(cred, chargeForm.amount, ref);

  ++actionSeq; // supersede any still-in-flight GET
  chargeFiring = true;
  pendingChargeRef = ref;
  recordPayment(ref, {
    model: cred.origin_model || 'own-fields',
    vertical: cred.origin_vertical || state.vertical,
    amount: String(body.amount), currency: body.currency,
    last4: cred.last4, brand: cred.brand,
    origin: 'backoffice', initiation_type: 'recurring', profile: state.profile,
    credential: { kind: cred.kind, label: `${cred.brand || 'Card'} ···${cred.last4 || ''}` },
    aft: cred.aft,
  });
  renderCof(); // reflect "Processing…" on the button
  paintChargeRequest(body, true); // freeze the signed body view (env/profile are transport-only)
  setActiveTab('request');

  try {
    const { httpStatus, data } = await createDirectPayment({ ...body, env: state.env, profile: state.profile });
    const ok = httpStatus < 400 && !data?.error;
    paintResponse(data, ok, ok ? 'CHARGE CREATED' : (data?.raw?.error_code || data?.error || 'ERROR'));
    setActiveTab('response');
    if (ok) {
      const d = data?.data;
      if (d?.id) setPaymentId(ref, d.id);
      updateStatus(ref, { phase: 'awaiting_confirmation' });
      watchEventForRef(ref, 'back office · scheduled charge'); // real PAYMENT_COMPLETED / PAYMENT_FAILED
    } else {
      // Rapyd rejected the charge synchronously — mark it failed and surface a
      // PAYMENT_FAILED event on the webhook tab, grounded in the real error.
      updateStatus(ref, { status: 'failed', phase: 'declined' });
      paintWebhookCard([paymentFailedEvent(ref, body, data)], 'back office · scheduled charge');
    }
  } catch (err) {
    paintResponse({ error: 'network_error', message: err.message }, false, 'NETWORK ERROR');
    setActiveTab('response');
    updateStatus(ref, { status: 'failed', phase: 'error' });
  } finally {
    chargeFiring = false;
    renderCof();
  }
}

/* A PAYMENT_FAILED webhook shape, built from the synchronous Rapyd rejection
   so the webhook tab reflects the failed MIT charge end-to-end. */
function paymentFailedEvent(ref, body, data) {
  const rapyd = data?.raw || {};
  return {
    type: 'PAYMENT_FAILED',
    status: rapyd.status || 'ERROR',
    raw: {
      type: 'PAYMENT_FAILED',
      data: {
        merchant_reference_id: ref,
        amount: body.amount,
        currency: body.currency,
        initiation_type: body.initiation_type,
        status: 'ERROR',
        failure_code: rapyd.error_code || data?.error || 'PAYMENT_ERROR',
        failure_message: rapyd.message || data?.message || 'The charge could not be processed.',
      },
    },
  };
}

/* The API-visible version of the silent token backfill — fires the real list
   GET, paints its response, and re-derives the credential rows. */
async function fireSync() {
  if (!customers.getCustomerId()) return;
  const mySeq = ++actionSeq;
  paintListRequest(false);
  setActiveTab('response');
  paintResponse(null, true, 'RETRIEVING…');
  const { httpStatus, data } = await customers.refreshTokens();
  if (mySeq !== actionSeq) return; // superseded — leave the panel alone
  const ok = httpStatus < 400 && !data?.error;
  paintResponse(data, ok, ok ? 'SAVED CARDS RETRIEVED' : 'ERROR');
}

/* On MIT-charge completion (surfaced by the ledger poller), close the form —
   the new payment tile is already in the list below. */
function maybeFinalizeCharge() {
  if (!pendingChargeRef) return;
  const e = getLedger().find((x) => x.reference === pendingChargeRef);
  if (e && (e.status === 'completed' || e.status === 'failed')) {
    pendingChargeRef = null;
    cofChargeRef = null;
  }
}

/* ── Boot ─────────────────────────────────────────────────── */
export function mount() {
  subscribeLedger(() => {
    if (state.leftView !== 'backoffice') return;
    renderWallet();
    maybeFinalizeRefund();
    maybeFinalizeCharge();
    if (!refundOpen) renderBody(); // never clobber a form the SE is mid-edit on
    if (!cofChargeRef) renderCof(); // same rule for the charge form (fireCharge repaints itself)
  });

  // Credentials changing (webhook harvest, sync backfill, profile re-key)
  // repaint the customer-on-file card — but never over an open charge form.
  customers.subscribeCustomers(() => {
    if (state.leftView !== 'backoffice') return;
    if (!cofChargeRef) renderCof();
  });

  const root = $('#backoffice');

  // hover a completed tile → prepared GET preview on the right;
  // hover the customer card → prepared saved-cards GET
  root.addEventListener('mouseover', (e) => {
    if (view !== 'list' || firing || chargeFiring) return;
    const cof = e.target.closest('.bo-cof-card');
    if (cof && !cofChargeRef && customers.getCustomerId()) {
      if (lastHoverRef === 'cof') return;
      lastHoverRef = 'cof';
      paintListRequest(true);
      setActiveTab('request');
      return;
    }
    const tile = e.target.closest('.bo-tile.clickable');
    if (!tile || tile.dataset.ref === lastHoverRef) return;
    const entry = getEntry(tile.dataset.ref);
    if (!entry?.payment_id) return;
    lastHoverRef = tile.dataset.ref;
    paintGetRequest(entry, true);
    setActiveTab('request');
  });
  root.addEventListener('mouseleave', () => { lastHoverRef = null; });

  root.addEventListener('click', (e) => {
    // navigation
    if (e.target.closest('#bo-back')) { view = 'list'; detailRef = null; refundOpen = false; lastHoverRef = null; renderBody(); renderCof(); return; }
    const tile = e.target.closest('.bo-tile.clickable');
    if (tile && view === 'list') { retrieveAndOpen(tile.dataset.ref); renderCof(); return; }

    // customer on file
    if (e.target.closest('#bo-cof-sync')) { fireSync(); return; }
    const chargeBtn = e.target.closest('.bo-cof-charge[data-charge]');
    if (chargeBtn && !chargeBtn.disabled) { openChargeForm(chargeBtn.dataset.charge); return; }
    if (e.target.closest('#bo-charge-cancel')) { closeChargeForm(); return; }
    if (e.target.closest('#bo-charge-fire')) { fireCharge(); return; }

    // refund form
    if (e.target.closest('#bo-refund-open')) { openRefundForm(); return; }
    if (e.target.closest('#bo-refund-cancel')) { refundOpen = false; renderBody(); return; }
    const routeBtn = e.target.closest('.bo-route[data-route]');
    if (routeBtn) { selectRoute(routeBtn.dataset.route); return; }
    if (e.target.closest('#bo-refund-fire')) { fireRefund(); return; }
  });

  root.addEventListener('input', (e) => {
    if (e.target.id === 'bo-refund-amount') { onAmountInput(e.target.value); return; }
    if (e.target.id === 'bo-charge-amount') { onChargeAmountInput(e.target.value); return; }
    if (e.target.id === 'bo-refund-reason') {
      form.reason = e.target.value;
      const entry = getEntry(detailRef);
      if (entry) paintRefundRequest(currentRefundBody(entry)); // live body, form DOM untouched
    }
  });
}
