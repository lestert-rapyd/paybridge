/* ─────────────────────────────────────────────────────────────
   The signed-in shopper's account pages — two CUSTOMER views over
   stores the demo already keeps for the merchant:

     · Orders           ← js/ledger.js (this tab's payments, the same
                          entries the back office lists), in two groups:
                          the signed-in customer's (entries recorded under
                          their cus_***) and this tab's guest checkouts
                          (ledger.ordersFor). Read-only and local: no call.
                          Status comes from the ledger's own settlement
                          (trusted webhook / Retrieve).
     · Payment methods  ← js/customers.js stored credentials, synced ONCE
                          per page visit with the real GET /v1/customers/
                          {id}/payment_methods (customers.refreshTokens —
                          the back office's "Sync from Rapyd" call), shown
                          in the engine room like any other beat; the
                          page's "Refresh" link re-syncs on demand.

   A shopper sees their own words: a card is "Visa •••• 1111", not a
   card_*** or a storage route; an order is what they bought and whether
   it went through. The ids live one pane to the right.

   Markup + the sync beat's record; js/steps.js routes, wires and paints.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import * as customers from '../customers.js';
import { getLedger, refundedTotals, ordersFor } from '../ledger.js';
import { beatCardHTML } from '../customer-beat.js';
import { renderJSONView } from '../json-view.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import { esc } from '../ui.js';
import { siteHeaderHTML, thumbHTML, moneyText } from './chrome.js';

/* ── Orders ──────────────────────────────────────────────── */

/* The shopper's orders at THIS merchant, in this environment — the signed-in
   customer's payments (client checkouts and the back office's MIT renewals
   recorded under their cus_***) and this tab's guest checkouts, newest first. */
function myOrders() {
  return ordersFor(getLedger(), { customerId: customers.getCustomerId(), vertical: state.vertical, env: state.env });
}

/* [label, tone] — tone picks the badge colour (css/site.css .ord-badge). */
function orderStatus(e, isSub) {
  if (e.status === 'failed') return ['Declined', 'bad'];
  if (e.status !== 'completed') return ['Processing', 'info'];
  const r = refundedTotals(e);
  if (r.count && r.remaining <= 0) return ['Refunded', 'mute'];
  if (r.count) return ['Partly refunded', 'mute'];
  return [isSub ? 'Active' : 'Paid', 'ok'];
}

function orderRowHTML(e) {
  const products = VERTICALS[e.vertical]?.products || [];
  const items = Array.isArray(e.items) ? e.items : [];
  const first = products.find((p) => p.id === items[0]?.id) || null;
  const isSub = e.origin === 'backoffice' || items.some((i) => i.billing === 'subscription');
  const name = e.origin === 'backoffice'
    ? `${items[0]?.name || 'Subscription'} · monthly charge`
    : items.length > 1
      ? `${items[0].name} + ${items.length - 1} more`
      : items[0]?.name || 'Order';
  const [label, tone] = orderStatus(e, isSub);
  const when = new Date(e.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const card = e.credential?.label || (e.last4 ? `•••• ${e.last4}` : null);
  const meta = [when, moneyText(e.amount, e.currency) + (isSub ? ' / month' : ''), card].filter(Boolean).join(' · ');
  return `
    <div class="ord-row">
      ${thumbHTML(first, 'ord-thumb')}
      <div class="ord-main">
        <div class="ord-name">${esc(name)}</div>
        <div class="ord-meta">${esc(meta)}</div>
        ${items.length > 1 ? `<div class="ord-items">${esc(items.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(', '))}</div>` : ''}
      </div>
      <span class="ord-badge ${tone}">${esc(label)}</span>
    </div>`;
}

function orderGroupHTML(title, list, empty) {
  return `
    <section class="ord-group">
      <div class="ord-group-h">${esc(title)}<span class="ord-group-n">${esc(list.length)}</span></div>
      ${list.length
        ? `<div class="ord-list">${list.map(orderRowHTML).join('')}</div>`
        : `<div class="ord-empty">${esc(empty)}</div>`}
    </section>`;
}

export function ordersPageHTML() {
  const { mine, guest } = myOrders();
  const any = mine.length + guest.length;
  return `
    ${siteHeaderHTML('orders')}
    <main class="site-main site-mid">
      <div class="site-titles">
        <h1 class="site-h1">Orders</h1>
        <p class="site-sub">${any ? 'Your recent purchases' : 'Nothing here yet'}</p>
      </div>
      ${any
        ? `${orderGroupHTML('Your orders', mine, 'Nothing under your account yet.')}
           ${guest.length ? orderGroupHTML('Guest checkouts this session', guest, '') : ''}`
        : `<div class="site-empty">
             <img src="assets/no-results.svg" alt="" />
             <div>Your orders will show up here.</div>
             <button type="button" class="co-cta site-cta compact" data-nav="shop">Browse the shop</button>
           </div>`}
    </main>`;
}

/* ── Payment methods ─────────────────────────────────────── */

const MARK = { Visa: 'VISA', Mastercard: 'MC', 'American Express': 'AMEX', Amex: 'AMEX', Discover: 'DISC' };

function methodRowHTML(c) {
  const exp = c.expiration_month && c.expiration_year ? `${c.expiration_month}/${c.expiration_year}` : null;
  const forSubs = c.recurrence_type === 'recurring';
  return `
    <div class="pm-row">
      <div class="pm-mark">${esc(MARK[c.brand] || 'CARD')}</div>
      <div class="pm-main">
        <div class="pm-num">${esc(c.brand || 'Card')} •••• ${esc(c.last4 || '····')}</div>
        <div class="pm-exp">${exp ? `Expires ${esc(exp)}` : 'Expiry on file'}</div>
      </div>
      <span class="ord-badge ${forSubs ? 'info' : 'ok'}">${forSubs ? 'Subscriptions' : 'Checkout'}</span>
    </div>`;
}

export function methodsPageHTML() {
  const creds = customers.credentials();
  const syncing = sync.status === 'sending';
  return `
    ${siteHeaderHTML('methods')}
    <main class="site-main site-mid">
      <div class="site-titles">
        <h1 class="site-h1">Payment methods</h1>
        <p class="site-sub">${syncing ? 'Checking your saved cards…' : creds.length ? 'Here’s what we have on file' : 'No payment methods so far'}</p>
        <button type="button" class="site-link-btn accent pm-refresh" id="pm-refresh" ${syncing ? 'disabled' : ''}><i class="icon-refresh"></i>${syncing ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      ${creds.length
        ? `<div class="ord-list">${creds.map(methodRowHTML).join('')}</div>`
        : `<div class="site-empty">
             <img src="assets/no-results.svg" alt="" />
             <div>Save a card at checkout to pay faster next time — subscriptions save theirs automatically.</div>
           </div>`}
    </main>`;
}

/* ── The payment-methods beat (engine room) ──────────────────
   GET /v1/customers/{id}/payment_methods?category=card, fired when the shopper
   opens the page — a merchant's account page reads saved cards from its PSP.
   The record survives repaints; the steps router paints it. It fires ONCE per
   page visit (steps.js goStep, on entry — never on a repaint), and again only
   when the shopper clicks the page's Refresh link. */
let sync = { status: 'idle', key: null, cus: null, httpStatus: null, data: null, salt: null };
let syncSeq = 0;

const methodsPath = (cus) => `/v1/customers/${cus}/payment_methods?category=card`;

/** Fire the list call for the session customer. `onUpdate` repaints (the
    router's job). Never rejects — customers.refreshTokens returns failures. */
export async function fireMethodsSync(onUpdate = () => {}) {
  const cus = customers.getCustomerId();
  if (!cus) return;
  const mySeq = ++syncSeq;
  // Captured now — a profile switch mid-call can't misfile the cards.
  const key = customers.bucketKey();
  sync = { status: 'sending', key, cus, httpStatus: null, data: null, salt: newSaltTimestamp() };
  onUpdate();
  let httpStatus = 0, data = null;
  try {
    ({ httpStatus, data } = await customers.refreshTokens({ key }));
  } catch (err) {
    data = { error: 'NETWORK_ERROR', message: err?.message || 'request failed' };
  }
  if (mySeq !== syncSeq) return; // a newer entry owns the record
  sync = { ...sync, status: 'done', httpStatus, data };
  onUpdate();
}

/** The request card for the engine room, or '' when nothing has fired for the
    active bucket (a profile/env switch leaves the other MID's call behind). */
export function methodsRequestCardHTML() {
  if (sync.status === 'idle' || sync.key !== customers.bucketKey()) return '';
  const ok = sync.status === 'done' && sync.httpStatus >= 200 && sync.httpStatus < 400 && !sync.data?.error;
  return beatCardHTML({
    id: 'beat-pm-list', method: 'GET', path: methodsPath(sync.cus), // text — beatCardHTML escapes
    badge: sync.status === 'sending' ? 'sending…' : ok ? 'signed & sent' : 'failed',
    badgeKind: sync.status === 'sending' ? 'live' : ok ? 'ok' : 'err',
    inner: `
      ${headersHTML(sync.salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">a GET carries none</span></div>`,
  });
}

/** Patch the signature into the painted card (signed over the same salt). */
export function fillMethodsSignature() {
  const card = document.getElementById('beat-pm-list');
  if (card && sync.salt) fillSignature(card, 'get', methodsPath(sync.cus), sync.salt, null, 'beat-pm-list');
}

/** The response card, or '' until the call has answered. */
export function methodsResponseCardHTML() {
  if (sync.status !== 'done' || sync.key !== customers.bucketKey()) return '';
  const ok = sync.httpStatus >= 200 && sync.httpStatus < 400 && !sync.data?.error;
  const code = sync.httpStatus ? `HTTP ${esc(sync.httpStatus)}` : 'NO RESPONSE';
  return beatCardHTML({
    id: 'beat-pm-list-res', method: 'GET', path: methodsPath(sync.cus),
    badge: ok ? 'saved cards' : String(sync.data?.error || 'failed'), badgeKind: ok ? 'ok' : 'err',
    inner: `
      <div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">${code}</span></div>
      ${renderJSONView(sync.data ?? { error: 'no response body' })}`,
  });
}
