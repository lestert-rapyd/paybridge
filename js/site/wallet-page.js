/* ─────────────────────────────────────────────────────────────
   The merchant site's Wallet page — signed-in only, and only for a
   pack whose journey rules run a wallet (packs.js `wallet`). The rules
   (balance, limits, the payout body) are js/site/wallet.js; this is the
   page, its engine-room beats and the withdraw orchestration.

     Deposit / Top up  → no call HERE: the amount becomes the checkout's
                         product (wallet.js depositProduct) and the shopper
                         pays on the normal checkout — own fields, toolkit or
                         a saved card, whichever path the drawer picked. The
                         balance moves when the ledger confirms the payment.
     Withdraw          → three real calls, one beat each:
                           1 GET  /v1/payout_method_types   which card payout
                                  type the MID offers for the country+currency
                           2 GET  /v1/payout_methods/{type}/required_fields
                                  what the beneficiary/sender must carry
                           3 POST /v1/payouts                the payout itself
                         The ledger (kind 'payout') then confirms it from a
                         trusted PAYOUT_COMPLETED / PAYOUT_FAILED or a
                         Retrieve Payout, like any payment.

   Shopper copy on the left; the ids, bodies and Rapyd's answers on the
   right. js/steps.js routes, wires and paints.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, activeWallet } from '../verticals.js';
import * as customers from '../customers.js';
import { getLedger, getEntry, recordPayout, applyPayoutObject, updateStatus, eventsFor } from '../ledger.js';
import {
  createPayout, listPayoutMethodTypes, getPayoutRequiredFields, newReference, newIdempotencyKey,
} from '../api.js';
import { profileEwallet } from '../profiles.js';
import { promoteToReturning } from '../identity.js';
import { beatCardHTML } from '../customer-beat.js';
import { renderJSONView } from '../json-view.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import { setActiveTab, setStatus, esc } from '../ui.js';
import { currencyDecimals } from '../sync.js';
import { eventCardHTML } from '../webhooks.js';
import { siteHeaderHTML, moneyText } from './chrome.js';
import {
  DEPOSIT_ID, SANDBOX_PAYOUT_CARD, walletEntries, walletBalance, isDepositEntry,
  depositProblem, withdrawProblem, withdrawChips, setPendingDeposit,
  pickPayoutMethodType, fallbackPayoutMethodType, fillParties, payoutBody, requiredFieldsQuery,
} from './wallet.js';

/* ── Page state (module-local; survives repaints, not reloads) ── */
let tab = 'deposit';                       // 'deposit' | 'withdraw'
const draft = { deposit: '', withdraw: '' };
let destRef = null;                        // withdraw destination: a credential ref | 'test'
let formError = null;
/* The latest withdrawal attempt: { key, seq, amount, currency, dest, reference,
   stopped: shopper copy | null, types, fields, payout } — each beat is
   { salt, path, status: 'sending'|'done', httpStatus, data, … }. */
let wd = null;
let seq = 0;
let preparedSalt = null; // the prepared POST card's salt (signed after paint)

const isLive = () => state.env === 'live';
const cfgNow = () => activeWallet();
const ctxNow = () => ({ customerId: customers.getCustomerId(), vertical: state.vertical, env: state.env });
const balanceNow = (cfg = cfgNow()) => walletBalance(getLedger(), ctxNow(), cfg.currency);
/** Live charges and pays out 0.01 only (the backend caps it independently). */
const amountFor = (which) => (isLive() ? '0.01' : draft[which]);
const ok = (b) => b && b.status === 'done' && b.httpStatus >= 200 && b.httpStatus < 400 && !b.data?.error;
/* The backend's own refusals — Rapyd never saw these. */
const isGateError = (data) => /^(LIVE_|UNKNOWN_PROFILE$|MISSING_)/.test(String(data?.error || ''));

/** Labels the page and its buttons speak in ('Deposit' / 'Top up'). */
export function walletLabels() {
  const cfg = cfgNow();
  return cfg ? { deposit: cfg.depositLabel, withdraw: cfg.withdrawLabel } : null;
}

/* ── Withdraw destinations ────────────────────────────────────
   The shopper's saved Rapyd cards (card_*** → beneficiary.card_id), and in
   sandbox Rapyd's published payout test card. Merchant-vault cards are not
   offered: paying out to a raw PAN is the PCI path, and the test card
   already demonstrates that body shape. */
function destinations() {
  const out = customers.credentials()
    .filter((c) => c.kind === 'token' && c.card_id)
    .map((c) => ({ ref: c.ref, kind: 'token', card_id: c.card_id, brand: c.brand || 'Card', last4: c.last4 || '····' }));
  if (!isLive()) out.push({ ref: 'test', kind: 'test', brand: SANDBOX_PAYOUT_CARD.brand, last4: SANDBOX_PAYOUT_CARD.last4 });
  return out;
}
function activeDest() {
  const list = destinations();
  return list.find((d) => d.ref === destRef) || list[0] || null;
}
const destLabel = (d) => (d ? `${d.brand} •••• ${d.last4}` : '');

/* ── Markup ──────────────────────────────────────────────── */

function balanceHTML(cfg) {
  const b = balanceNow(cfg);
  const extra = [
    Number(b.incoming) > 0 ? `+ ${moneyText(b.incoming, b.currency)} confirming` : null,
    Number(b.outgoing) > 0 ? `− ${moneyText(b.outgoing, b.currency)} on its way to your card` : null,
  ].filter(Boolean).join(' · ');
  return `
    <div class="wal-balance" data-wal-region="balance">
      <div class="wal-balance-l"><i class="icon-wallet"></i>Available balance</div>
      <div class="wal-balance-v">${esc(moneyText(b.available, b.currency))}</div>
      ${extra ? `<div class="wal-balance-x">${esc(extra)}</div>` : ''}
    </div>`;
}

/* [label, tone] for a movement that isn't simply done. */
function rowState(e) {
  if (e.status === 'failed') return isDepositEntry(e) ? ['Declined', 'bad'] : ['Failed', 'bad'];
  if (e.status !== 'completed') return ['Processing', 'info'];
  if (isDepositEntry(e) && (e.refunds || []).some((r) => r.status === 'completed')) return ['Refunded', 'mute'];
  return null;
}

function activityRowHTML(e, cfg) {
  const dep = isDepositEntry(e);
  const when = new Date(e.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const card = dep ? (e.credential?.label || (e.last4 ? `•••• ${e.last4}` : null)) : e.destination?.label;
  const st = rowState(e);
  const sign = dep ? '+' : '−';
  return `
    <div class="wal-row">
      <span class="wal-ico ${dep ? 'in' : 'out'}"><i class="${dep ? 'icon-cash_in' : 'icon-cash_out'}"></i></span>
      <div class="wal-row-main">
        <div class="wal-row-name">${esc(dep ? cfg.depositLabel : 'Withdrawal')}</div>
        <div class="wal-row-meta">${esc([when, card].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="wal-row-end">
        <div class="wal-row-amt ${dep ? 'in' : ''} ${e.status === 'failed' ? 'void' : ''}">${esc(`${sign} ${moneyText(e.amount, e.currency)}`)}</div>
        ${st ? `<span class="ord-badge ${st[1]}">${esc(st[0])}</span>` : ''}
      </div>
    </div>`;
}

function activityHTML(cfg) {
  const list = walletEntries(getLedger(), ctxNow()).filter((e) => e.currency === cfg.currency);
  return `
    <section class="wal-activity" data-wal-region="activity">
      <div class="ord-group-h">Activity</div>
      ${list.length
        ? `<div class="wal-rows">${list.map((e) => activityRowHTML(e, cfg)).join('')}</div>`
        : `<div class="ord-empty">No activity yet — your ${esc(cfg.depositLabel.toLowerCase())}s and withdrawals show up here.</div>`}
    </section>`;
}

function chipsHTML(cfg) {
  const amount = amountFor(tab);
  const chips = tab === 'deposit'
    ? cfg.chips.map((c) => ({ label: String(c).replace(/\.0+$/, ''), amount: String(c) }))
    : withdrawChips(balanceNow(cfg).available, cfg.currency);
  if (isLive() || !chips.length) return `<div class="wal-chips" data-wal-region="chips"></div>`;
  return `
    <div class="wal-chips" data-wal-region="chips">
      ${chips.map((c) => `<button type="button" class="wal-chip ${Number(c.amount) === Number(amount) && amount !== '' ? 'active' : ''}" data-wal-chip="${esc(c.amount)}">${esc(c.label)}</button>`).join('')}
    </div>`;
}

function destsHTML() {
  const list = destinations();
  const cur = activeDest();
  if (!list.length) {
    return `<div class="wal-dests" data-wal-region="dests"><div class="ord-empty">Save a card at checkout to withdraw to it.</div></div>`;
  }
  return `
    <div class="wal-dests" data-wal-region="dests">
      ${list.map((d) => `
        <button type="button" class="wal-dest ${d.ref === cur?.ref ? 'active' : ''}" data-wal-dest="${esc(d.ref)}">
          <span class="wal-radio"></span>
          <span class="wal-dest-name">${esc(destLabel(d))}</span>
          <span class="wal-dest-meta">${d.kind === 'test' ? 'Sandbox test card' : 'Saved card'}</span>
        </button>`).join('')}
    </div>`;
}

function ctaHTML(cfg) {
  const amount = amountFor(tab);
  const money = amount ? ` ${moneyText(amount, cfg.currency)}` : '';
  const sending = tab === 'withdraw' && wd && wd.key === customers.bucketKey() && !wd.done;
  const label = tab === 'deposit' ? `${cfg.depositLabel}${money}` : sending ? 'Sending…' : `Withdraw${money}`;
  return `
    <div data-wal-region="cta">
      ${formError ? `<div class="acct-err" role="alert">${esc(formError)}</div>` : ''}
      <button type="button" class="co-cta site-cta" id="${tab === 'deposit' ? 'wal-deposit' : 'wal-withdraw'}" ${sending ? 'disabled' : ''}>${esc(label)}</button>
    </div>`;
}

/* The withdrawal's outcome, in the shopper's words — from the ledger entry
   (which only a trusted outcome settles), or why it never left. */
function resultHTML(cfg) {
  if (tab !== 'withdraw' || !wd || wd.key !== customers.bucketKey()) return `<div data-wal-region="result"></div>`;
  let tone = 'info', title, copy;
  if (wd.stopped) {
    tone = 'bad'; title = 'We couldn’t send your withdrawal'; copy = wd.stopped;
  } else {
    const e = wd.reference ? getEntry(wd.reference) : null;
    const what = `${moneyText(wd.amount, wd.currency)} to ${destLabel(wd.dest)}`;
    if (!e) { title = 'Sending your withdrawal…'; copy = what; }
    else if (e.status === 'completed') { tone = 'ok'; title = 'Withdrawal sent'; copy = `${what}. Most banks show it within 30 minutes.`; }
    else if (e.status === 'failed') { tone = 'bad'; title = 'We couldn’t send your withdrawal'; copy = 'Nothing left your balance. Try again, or choose another card.'; }
    else { title = 'Withdrawal on its way'; copy = `${what}. We’ll update this page as soon as your bank confirms it.`; }
  }
  return `
    <div class="wal-result ${tone}" data-wal-region="result" role="status">
      <div class="wal-result-t">${esc(title)}</div>
      <div class="wal-result-c">${esc(copy)}</div>
    </div>`;
}

export function walletPageHTML() {
  const cfg = cfgNow();
  const v = VERTICALS[state.vertical];
  if (!cfg) return `${siteHeaderHTML('wallet')}<main class="site-main site-narrow"></main>`;
  const dep = tab === 'deposit';
  return `
    ${siteHeaderHTML('wallet')}
    <main class="site-main wal">
      <div class="wal-main">
        <div class="site-titles">
          <h1 class="site-h1">Wallet</h1>
          <p class="site-sub">Your ${esc(v.merchant)} balance — ${esc(cfg.depositLabel.toLowerCase())} or withdraw it back to your card</p>
        </div>
        ${balanceHTML(cfg)}
        ${activityHTML(cfg)}
      </div>
      <aside class="wal-panel">
        <div class="wal-tabs" role="tablist">
          <button type="button" role="tab" class="${dep ? 'active' : ''}" data-wal-tab="deposit"><i class="icon-cash_in"></i>${esc(cfg.depositLabel)}</button>
          <button type="button" role="tab" class="${dep ? '' : 'active'}" data-wal-tab="withdraw"><i class="icon-cash_out"></i>Withdraw</button>
        </div>
        <label class="wal-field"><span>Amount</span>
          <div class="co-input wal-amount">
            <input id="wal-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(amountFor(tab))}" ${isLive() ? 'readonly title="Live is fixed at 0.01"' : ''} />
            <span class="wal-cur">${esc(cfg.currency)}</span>
          </div>
        </label>
        ${chipsHTML(cfg)}
        ${dep
          ? `<div class="wal-note">You’ll pay by card on the next page — a saved card works too.</div>`
          : `<div class="wal-field"><span>Withdraw to</span></div>${destsHTML()}`}
        ${ctaHTML(cfg)}
        ${resultHTML(cfg)}
        ${isLive() ? `<div class="wal-note">Live: amounts are fixed at 0.01.</div>` : ''}
      </aside>
    </main>`;
}

/** Re-render just the regions that follow the ledger / the draft — never the
    amount input, so a ledger tick can't take the caret away mid-typing. */
export function refreshWalletRegions() {
  const cfg = cfgNow();
  const root = document.querySelector('#checkout .wal');
  if (!cfg || !root) return;
  const html = {
    balance: () => balanceHTML(cfg), activity: () => activityHTML(cfg), chips: () => chipsHTML(cfg),
    dests: () => destsHTML(), cta: () => ctaHTML(cfg), result: () => resultHTML(cfg),
  };
  root.querySelectorAll('[data-wal-region]').forEach((el) => {
    const fn = html[el.dataset.walRegion];
    if (fn) el.outerHTML = fn();
  });
}

/* ── Controls (wired by steps.js) ────────────────────────── */

export function setWalletTab(t) {
  if (t !== 'deposit' && t !== 'withdraw') return;
  tab = t;
  formError = null;
}
export function setWalletAmount(raw) {
  draft[tab] = String(raw ?? '').replace(/[^\d.]/g, '');
  formError = null;
}
export function pickWalletChip(amount) { setWalletAmount(amount); }
export function pickWalletDest(ref) { destRef = ref; formError = null; }
export const walletTab = () => tab;

/** Deposit: hand the amount to the checkout. Returns true when the caller
    should go to the checkout; false with formError set otherwise. */
export function startDeposit() {
  const cfg = cfgNow();
  if (!cfg) return false;
  const amount = amountFor('deposit');
  const p = depositProblem(amount, cfg.currency);
  if (p) { formError = p.message; return false; }
  // A price-tile edit captured for an EARLIER deposit must not replace this amount.
  if (state.productOverride?.productId === DEPOSIT_ID) state.productOverride = null;
  setPendingDeposit(state.vertical, Number(amount).toFixed(currencyDecimals(cfg.currency)), cfg.currency);
  promoteToReturning(); // a card on file → the checkout opens on the saved-card chips
  formError = null;
  return true;
}

/* ── Withdraw orchestration ──────────────────────────────── */

/* Same contract as flows/shared.js sendIdempotent (one key per withdrawal; an
   unknown outcome is re-sent ONCE under the same key so Rapyd can't pay out
   twice) — kept local: shared.js pulls in the result screens. */
const UNKNOWN = new Set([0, 502, 504]);
async function sendPayout(body) {
  const idempotencyKey = newIdempotencyKey();
  let res = await createPayout(body, { idempotencyKey });
  if (UNKNOWN.has(res?.httpStatus)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await createPayout(body, { idempotencyKey });
  }
  return res;
}

const typesPath = (cfg) => `/v1/payout_method_types?category=card&beneficiary_country=${cfg.country}&payout_currency=${cfg.currency}`;
const fieldsPath = (q) => `/v1/payout_methods/${q.payout_method_type}/required_fields?sender_country=${q.sender_country}`
  + `&beneficiary_country=${q.beneficiary_country}&sender_currency=${q.sender_currency}&payout_currency=${q.payout_currency}`
  + `&sender_entity_type=${q.sender_entity_type}&beneficiary_entity_type=${q.beneficiary_entity_type}&payout_amount=${q.payout_amount}`;

/** Fire the withdrawal. `onUpdate` repaints (the router's job). Never rejects. */
export async function fireWithdraw(onUpdate = () => {}) {
  const cfg = cfgNow();
  const v = VERTICALS[state.vertical];
  if (!cfg) return;
  if (wd && wd.key === customers.bucketKey() && !wd.done) return; // one at a time
  const amount = amountFor('withdraw');
  const problem = withdrawProblem(amount, balanceNow(cfg).available, cfg.currency);
  const dest = activeDest();
  if (problem || !dest) { formError = problem?.message || 'Add a card to withdraw to.'; onUpdate(); return; }

  // Captured now — a profile/env switch mid-withdrawal can't misroute it.
  const env = state.env, profile = state.profile, key = customers.bucketKey();
  const cus = customers.getCustomerId();
  const mySeq = ++seq;
  const current = () => mySeq === seq;
  formError = null;
  const w = { key, seq: mySeq, amount, currency: cfg.currency, dest, reference: null, stopped: null, done: false,
    types: { salt: newSaltTimestamp(), path: typesPath(cfg), status: 'sending' }, fields: null, payout: null };
  wd = w;
  setStatus('Sending withdrawal…', 'processing');
  setActiveTab('request');
  onUpdate();
  const stop = (copy) => { w.stopped = copy; w.done = true; setStatus('Withdrawal not sent', 'error'); setActiveTab('response'); onUpdate(); };

  // 1 · which card payout type the MID offers here
  const r1 = await listPayoutMethodTypes({ category: 'card', beneficiaryCountry: cfg.country, payoutCurrency: cfg.currency, env, profile });
  if (!current()) return;
  Object.assign(w.types, { status: 'done', httpStatus: r1.httpStatus, data: r1.data });
  let methodType = null;
  if (ok(w.types)) {
    methodType = pickPayoutMethodType(r1.data?.data, { country: cfg.country, brand: dest.brand });
    if (!methodType) return stop('Withdrawals to cards aren’t available here right now.');
  } else if (isGateError(r1.data)) {
    return stop('Withdrawals are unavailable right now.');
  } else {
    // The list couldn't be read — fall back to the documented naming
    // pattern and let the payout itself be the judge.
    methodType = fallbackPayoutMethodType(cfg.country, dest.brand);
    w.types.fallback = methodType;
  }
  w.types.picked = methodType;

  // 2 · what the beneficiary and sender must carry
  const q = requiredFieldsQuery({ methodType, country: cfg.country, currency: cfg.currency, amount });
  w.fields = { salt: newSaltTimestamp(), path: fieldsPath(q), status: 'sending' };
  onUpdate();
  const r2 = await getPayoutRequiredFields(q, { env, profile });
  if (!current()) return;
  Object.assign(w.fields, { status: 'done', httpStatus: r2.httpStatus, data: r2.data });
  if (!ok(w.fields) && isGateError(r2.data)) return stop('Withdrawals are unavailable right now.');
  const parties = fillParties(ok(w.fields) ? r2.data?.data : null, {
    dest, identity: customers.getIdentity(), merchant: v.merchant, country: cfg.country,
  });
  w.fields.missing = [...parties.missing.beneficiary.map((f) => `beneficiary.${f}`), ...parties.missing.sender.map((f) => `sender.${f}`)];

  // 3 · the payout
  const reference = newReference('wd'); // ≤ 45 chars — Create Payout's limit
  const body = payoutBody({
    amount, currency: cfg.currency, country: cfg.country, methodType,
    beneficiary: parties.beneficiary, sender: parties.sender, reference,
    description: `Withdrawal to ${destLabel(dest)}`, descriptor: v.descriptor,
    ewallet: env === 'sandbox' ? profileEwallet() : null,
  });
  w.reference = reference;
  w.payout = { salt: newSaltTimestamp(), body, status: 'sending' };
  recordPayout(reference, {
    vertical: state.vertical, amount: Number(amount).toFixed(currencyDecimals(cfg.currency)), currency: cfg.currency, profile, env,
    customer_id: cus, method_type: methodType, destination: { kind: dest.kind, label: destLabel(dest) },
  });
  onUpdate();
  const r3 = await sendPayout({ ...body, env, profile });
  Object.assign(w.payout, { status: 'done', httpStatus: r3.httpStatus, data: r3.data });
  w.done = true;
  const payout = ok(w.payout) ? r3.data?.data : null;
  if (payout) applyPayoutObject(reference, payout, { own: true });   // our own signed answer
  else if (UNKNOWN.has(r3.httpStatus) && !isGateError(r3.data)) updateStatus(reference, { phase: 'unconfirmed' }); // may exist — the poller settles it
  else updateStatus(reference, { status: 'failed', phase: 'failed' });
  if (current()) {
    const st = getEntry(reference)?.status;
    setStatus(st === 'completed' ? 'Payout completed' : st === 'failed' ? 'Payout failed' : 'Payout created', st === 'failed' ? 'error' : st === 'completed' ? 'ok' : 'processing');
    setActiveTab('response');
    onUpdate();
  }
}

/* ── Engine room ─────────────────────────────────────────── */

const mine = () => wd && wd.key === customers.bucketKey();

/** The draft POST /v1/payouts the Withdraw button would send — what the SE
    shows before anything fires (method type + parties still to be looked up). */
function preparedBody() {
  const cfg = cfgNow();
  const v = VERTICALS[state.vertical];
  const dest = activeDest();
  const parties = fillParties(null, { dest: dest || { kind: 'test' }, identity: customers.getIdentity(), merchant: v.merchant, country: cfg.country });
  return payoutBody({
    amount: amountFor('withdraw') || '(amount)', currency: cfg.currency, country: cfg.country,
    methodType: '(from GET /v1/payout_method_types)',
    beneficiary: parties.beneficiary, sender: parties.sender,
    reference: '(assigned on withdraw)', description: `Withdrawal to ${destLabel(dest)}`, descriptor: v.descriptor,
    ewallet: state.env === 'sandbox' ? profileEwallet() : null,
  });
}

function badgeOf(b) {
  if (b.status === 'sending') return ['sending…', 'live'];
  return ok(b) ? ['signed & sent', 'ok'] : ['failed', 'err'];
}

function getCardHTML(id, n, path, b, hint) {
  const [badge, kind] = badgeOf(b);
  return beatCardHTML({
    id, n, method: 'GET', path, badge, badgeKind: kind,
    inner: `
      ${headersHTML(b.salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">a GET carries none · ${esc(hint)}</span></div>`,
  });
}

/** The Request tab on the wallet page. */
export function walletRequestCardsHTML() {
  const cfg = cfgNow();
  if (!cfg) return '';
  if (!mine()) {
    if (tab !== 'withdraw') return '';
    const st = newSaltTimestamp();
    preparedSalt = st;
    return beatCardHTML({
      id: 'beat-po-create', method: 'POST', path: '/v1/payouts', badge: 'prepared', badgeKind: '',
      inner: `
        ${headersHTML(st)}
        <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">updates as you edit · sent on Withdraw</span></div>
        ${renderJSONView(preparedBody())}`,
    });
  }
  const parts = [];
  parts.push(getCardHTML('beat-po-types', 1, wd.types.path, wd.types,
    wd.types.fallback ? `list unavailable — using ${wd.types.fallback}` : 'which card payout type'));
  if (wd.fields) {
    const missing = wd.fields.missing?.length ? ` · no demo value for ${wd.fields.missing.join(', ')}` : '';
    parts.push(getCardHTML('beat-po-fields', 2, wd.fields.path, wd.fields, `beneficiary + sender fields${missing}`));
  }
  if (wd.payout) {
    const [badge, kind] = badgeOf(wd.payout);
    parts.push(beatCardHTML({
      id: 'beat-po-create', n: 3, method: 'POST', path: '/v1/payouts', badge, badgeKind: kind,
      inner: `
        ${headersHTML(wd.payout.salt)}
        <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${wd.dest.kind === 'token' ? 'beneficiary.card_id = the saved card_***' : 'sandbox payout test card'}</span></div>
        ${renderJSONView(wd.payout.body)}`,
    }));
  }
  return parts.join('');
}
/** Sign every painted card over the salt it was drawn with. */
export function fillWalletSignatures() {
  const sign = (id, method, path, salt, body) => {
    const el = document.getElementById(id);
    if (el && salt) fillSignature(el, method, path, salt, body, id);
  };
  if (!mine()) {
    if (preparedSalt) sign('beat-po-create', 'post', '/v1/payouts', preparedSalt, preparedBody());
    return;
  }
  sign('beat-po-types', 'get', wd.types.path, wd.types.salt, null);
  if (wd.fields) sign('beat-po-fields', 'get', wd.fields.path, wd.fields.salt, null);
  if (wd.payout) sign('beat-po-create', 'post', '/v1/payouts', wd.payout.salt, wd.payout.body);
}

function responseCardHTML(id, n, method, path, b, okLabel) {
  if (b.status === 'sending') {
    return beatCardHTML({ id, n, method, path, badge: 'sending…', badgeKind: 'live',
      inner: `<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>` });
  }
  const good = ok(b);
  const code = b.httpStatus ? `HTTP ${esc(b.httpStatus)}` : 'NO RESPONSE';
  return beatCardHTML({
    id, n, method, path,
    badge: good ? okLabel : String(b.data?.raw?.error_code || b.data?.error || 'failed'), badgeKind: good ? 'ok' : 'err',
    inner: `
      <div class="eng-pillrow"><span class="wh-pill ${good ? 'success' : 'failure'}">${code}</span></div>
      ${renderJSONView(b.data ?? { error: 'no response body' })}`,
  });
}

/** The Response tab, or '' until the withdrawal's first call has answered. */
export function walletResponseCardsHTML() {
  if (!mine() || wd.types.status !== 'done') return '';
  const parts = [];
  if (wd.payout) parts.push(responseCardHTML('beat-po-create-res', 3, 'POST', '/v1/payouts', wd.payout, `payout · ${wd.payout.data?.data?.status || '…'}`));
  if (wd.fields) parts.push(responseCardHTML('beat-po-fields-res', 2, 'GET', wd.fields.path, wd.fields, 'required fields'));
  parts.push(responseCardHTML('beat-po-types-res', 1, 'GET', wd.types.path, wd.types, wd.types.picked ? `→ ${wd.types.picked}` : 'method types'));
  return parts.join('');
}

/** The Webhooks tab: the payout's events as the ledger poller reads them
    (verified ones settle it; the rest earn a Retrieve Payout), or what to
    expect. '' before a payout exists. */
export function walletWebhooksHTML() {
  if (!mine() || !wd.reference) return '';
  const events = eventsFor(wd.reference);
  const label = `<div class="wh-beat-label"><span class="wh-beat-n">3</span>Withdrawal · <code>POST /v1/payouts</code></div>`;
  if (!events.length) {
    return `${label}
      <div class="wh-expect-row"><span class="wh-expect">PAYOUT_COMPLETED</span><span class="wh-expect">PAYOUT_FAILED</span></div>
      <div class="wh-expect-note">Filed under <code>${esc(wd.reference)}</code>. Until one arrives verified, the ledger confirms the payout with <code>GET /v1/payouts/{id}</code>.</div>`;
  }
  return `${label}${events.map((e, i) => eventCardHTML(e, i === 0)).join('')}`;
}

/** The header status pill follows the payout settling (ledger notify) — once
    per change, so a quiet poll tick doesn't rewrite it. */
export function syncWalletStatus() {
  if (!mine() || !wd.reference || !wd.done) return;
  const st = getEntry(wd.reference)?.status;
  if (!st || st === wd.shownStatus) return;
  wd.shownStatus = st;
  if (st === 'completed') setStatus('Payout completed', 'ok');
  else if (st === 'failed') setStatus('Payout failed', 'error');
}

/** Forget the attempt (a flow reset / env switch) — the ledger keeps the payout. */
export function resetWalletPage() {
  seq++;
  wd = null;
  formError = null;
  tab = 'deposit';
  draft.deposit = '';
  draft.withdraw = '';
  destRef = null;
}
