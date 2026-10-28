/* ─────────────────────────────────────────────────────────────
   Left-panel post-payment screens: processing → (inline 3DS) →
   success / error. The terminal screen is driven by the real
   PAYMENT_COMPLETED / PAYMENT_FAILED webhook (see webhooks.js).

   The event's raw.data reaches innerHTML here (descriptor, last4,
   currency), so every non-constant interpolation goes through esc().
   webhooks.js only hands over TRUSTED events, but a payment object is
   still third-party data — escaping is the renderer's job regardless.
   ───────────────────────────────────────────────────────────── */

import { VERTICALS, activeProduct } from './verticals.js';
import { state, setState } from './state.js';
import { esc } from './ui.js';
import { brandLabel } from './sync.js';
import { getEntry } from './ledger.js';
import { markResultShown, landOn } from './steps.js';
import { clearCart } from './site/cart.js';
import { siteHeaderHTML } from './site/chrome.js';
import { isSignedIn } from './site/session.js';
import { seamWrapHTML, SEAM_LABELS, seamExtWrapHTML, setAddress } from './seam.js';
import { EXT3DS_ISSUER } from './ext3ds.js';

const host = () => document.getElementById('checkout');
const set3DSWidth = (on) => document.querySelector('.browser')?.classList.toggle('wide-3ds', on);
/* End screens always render in the standard narrow card — the toolkit's
   wide stage would otherwise stretch the success/error layout. */
const resetWide = () => document.querySelector('.browser')?.classList.remove('wide-tk');

/* "Visa ending 1111" / "Apple Pay" / "Google Pay ending 4242" — plain text;
   factsHTML() escapes it. The scheme comes from sync.js's one brandLabel()
   (null = unknown, so the request snapshot's network can fill in). */
const WALLETS = new Set(['Apple Pay', 'Google Pay']);
function cardLabel(pay, lp) {
  const pmd = pay.payment_method_data || {};
  const hint = `${pmd.type || ''} ${pmd.name || ''}`;
  const last4 = pmd.last4 || lp.last4;
  const ending = last4 ? ` ending ${last4}` : '';
  const network = brandLabel(hint, null) || lp.network || null;
  if (WALLETS.has(network)) return `${network}${ending}`; // a wallet names itself even without last4
  if (network && last4) return `${network}${ending}`;
  if (last4) return `Card${ending}`;
  return '—';
}

/* Standalone annotations rendered OUTSIDE the client-site window. */
function setOffstage(html) {
  const el = document.getElementById('offstage');
  if (!el) return;
  el.innerHTML = html || '';
  el.hidden = !html;
}

/* ── Customer's bank-app view (statement descriptor) ─────────
   Reads the real payment from the terminal webhook when present,
   falling back to the request snapshot (state.lastPayment). Shows
   the FX variant (charged currency big, original small) when the
   payment carries FX fields — reactive once FX is configured. */
function bankViewHTML(event) {
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  const descriptor = pay.statement_descriptor || lp.descriptor;
  if (!descriptor) return '';

  // When FX was configured, drive the figures off the checkout snapshot so the
  // statement matches exactly what the customer saw: `charged` is what hit the
  // card (main line); `base` is the merchant's price (the small original line,
  // shown only when the customer paid in a different currency, i.e. 'buy').
  const fx = lp.fx;
  let currency, amount, isFx = false, origCurrency, origAmount;
  if (fx) {
    currency = fx.charged.currency;
    amount = fmtAmount(fx.charged.amount);
    isFx = fx.charged.currency !== fx.base.currency;
    origCurrency = fx.base.currency;
    origAmount = fx.base.amount;
  } else {
    currency = pay.currency_code || lp.currency || '';
    amount = fmtAmount(pay.amount ?? lp.amount);
  }

  const main = `− ${amount} ${currency}`;
  const d = new Date();
  const when = `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  return `
    <div class="bank-view">
      <div class="bank-view-label">Customer's bank app · <code>statement_descriptor</code></div>
      <div class="bank-card">
        <div class="bank-ico">↑</div>
        <div class="bank-info">
          <div class="bank-desc">${esc(descriptor)}</div>
          <div class="bank-date">${when}</div>
        </div>
        <div class="bank-amt">
          <div class="bank-amt-main">${esc(main)}</div>
          ${isFx ? `<div class="bank-amt-fx">− ${esc(fmtAmount(origAmount))} ${esc(origCurrency)}</div>` : ''}
        </div>
      </div>
    </div>`;
}
function fmtAmount(a) {
  const n = Number(a);
  return Number.isFinite(n) ? n.toFixed(2) : (a ?? '—');
}
/* What the customer paid — the lastPayment snapshot already holds the converted
   figure (under 'buy'), so success/decline screens match the checkout total. */
function paidLabel() {
  const lp = state.lastPayment;
  if (lp && lp.amount != null) return `${fmtAmount(lp.amount)} ${lp.currency || ''}`.trim();
  const p = activeProduct();
  return `${p.amount} ${p.currency}`;
}

/** `title` / `sub` are plain text (every caller passes a literal). */
export function renderProcessing(title = 'Confirming payment…', sub = 'This only takes a moment — please don’t close this page.') {
  resetWide();
  setOffstage(null);
  host().innerHTML = `
    <div class="screen">
      <div class="screen-spinner"></div>
      <div class="screen-title">${esc(title)}</div>
      <div class="screen-sub">${esc(sub)}</div>
    </div>`;
}

const LOCK_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#5b564d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path><circle cx="12" cy="15.5" r="1.3" fill="#5b564d"></circle></svg>`;

/* The challenge URL is Rapyd's redirect_url — only http(s) may load in the
   frame: a javascript:/data: src would run in (or be framed by) this origin. */
function safeFrameUrl(url) {
  const u = String(url ?? '').trim();
  return /^https?:\/\//i.test(u) ? u : 'about:blank'; // Rapyd's redirect_url is always absolute
}

export function render3DS(url) {
  set3DSWidth(true);
  setOffstage(null);
  host().innerHTML = `
    <div class="screen-3ds">
      <div class="screen-3ds-bar">
        <span class="tds-ico">${LOCK_SVG}</span>
        <div>
          <div class="screen-3ds-title">3-D Secure verification</div>
          <div class="screen-3ds-sub">Your bank needs to confirm it’s you — follow the steps below to finish paying.</div>
        </div>
      </div>
      ${seamWrapHTML(`<iframe class="tds-frame" src="${esc(safeFrameUrl(url))}" title="3-D Secure challenge"></iframe>`, SEAM_LABELS.tds, 'seam-tds')}
    </div>`;
}

/* ── External 3DS: the merchant's own provider (SIMULATED) ──────
   A MID set up for an external 3DS provider (js/ext3ds.js) authenticates
   BEFORE any Rapyd call. This page stands in for that provider's challenge —
   an issuer page on the issuer's domain, so it is neither the merchant's skin
   nor Rapyd: fixed neutral greys and a slate accent (css .x3ds-*), its own
   grey seam marker (seamExtWrapHTML), never the Rapyd one.

   `info` = { merchant, amount, card } (plain text, escaped here). `auto` =
   null for a challenge (the shopper picks: Pass / Fail, or the simulator's
   Frictionless shortcut), or 'frictionless' / 'fail' to answer by itself
   after a beat — the SE's preset (drawer). `onChoice(choice)` gets an
   ext3ds.js EXT3DS_CHOICES value, once, and only while this page is up. */
const SHIELD_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6l7-3z"></path><path d="M9 12l2 2 4-4"></path></svg>`;
let x3dsToken = 0;
export function renderExternal3DS(info, { auto = null, onChoice } = {}) {
  set3DSWidth(true);
  resetWide();
  setOffstage(null);
  const token = ++x3dsToken;
  const issuer = EXT3DS_ISSUER;
  setAddress(issuer.host, issuer.path, false); // the issuer's domain: not the merchant's, not Rapyd's
  const facts = [['Merchant', info.merchant], ['Amount', info.amount], ['Card', info.card]]
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  const body = auto
    ? `
      <div class="x3ds-title">Checking with your bank…</div>
      <p class="x3ds-sub">${esc(issuer.name)} is confirming this purchase. This only takes a moment.</p>
      <div class="x3ds-facts">${facts}</div>
      <div class="x3ds-wait"><span class="x3ds-spin"></span>Authenticating</div>`
    : `
      <div class="x3ds-title">Verify it’s you</div>
      <p class="x3ds-sub">${esc(issuer.name)} wants to confirm this purchase. In a real challenge you’d enter a one-time code or approve it in your banking app.</p>
      <div class="x3ds-facts">${facts}</div>
      <div class="x3ds-actions">
        <button type="button" class="x3ds-btn" data-x3ds="challenge-fail">Fail</button>
        <button type="button" class="x3ds-btn primary" data-x3ds="challenge-pass">Pass</button>
      </div>
      <button type="button" class="x3ds-link" data-x3ds="frictionless">Frictionless — authenticate without a challenge</button>`;
  host().innerHTML = `
    <div class="x3ds-stage">
      ${seamExtWrapHTML(`
        <div class="x3ds" id="x3ds">
          <div class="x3ds-head">
            <span class="x3ds-shield">${SHIELD_SVG}</span>
            <div class="x3ds-brand"><b>${esc(issuer.name)}</b><span>Verified by ${esc(issuer.name)}</span></div>
            <span class="x3ds-sim">Simulator</span>
          </div>
          <div class="x3ds-body">${body}</div>
          <div class="x3ds-foot">Simulated authentication — no real bank is contacted.</div>
        </div>`)}
    </div>`;
  let done = false;
  const choose = (choice) => {
    // Once, and only while THIS page is the one on screen (a reset or a newer
    // render must not answer for it).
    if (done || token !== x3dsToken || !document.getElementById('x3ds')) return;
    done = true;
    onChoice?.(choice);
  };
  if (auto) {
    setTimeout(() => choose(auto === 'fail' ? 'frictionless-fail' : 'frictionless'), 1400);
    return;
  }
  host().querySelectorAll('[data-x3ds]').forEach((btn) =>
    btn.addEventListener('click', () => choose(btn.dataset.x3ds)));
}

/* Receipt rows. Values are set in the UI face, not mono, and are not
   click-to-copy: a receipt is something a shopper reads, and the mono +
   "Copied ✓" treatment made it read as a debug dump. The ids the SE needs —
   payment, reference, customer — are one pane to the right.
   Values are plain text (card label, amounts) and escaped here. */
function factsHTML(rows) {
  return `<div class="screen-facts rise-4">` + rows
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
    .join('') + `</div>`;
}

/* A shop's order number. Derived from the demo reference's own timestamp, so it
   is stable for the run and the SE can still tie it to the pb_* reference in
   the right pane — but it reads like something a store would print. */
function orderNumber() {
  const ref = state.reference || '';
  const digits = ref.replace(/\D/g, '');
  return digits ? `#${digits.slice(-4)}` : '#0001';
}

const CHECK_SVG = `<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>`;
const CROSS_SVG = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M7 7l10 10"></path><path d="M17 7L7 17"></path></svg>`;

function badgeHTML(kind) {
  const err = kind === 'err';
  return `
    <div class="cs-badge-wrap">
      <span class="cs-ring ${err ? 'err' : ''}"></span>
      <span class="cs-glow ${err ? 'err' : ''}"></span>
      <span class="cs-badge ${err ? 'err' : 'ok'}">${err ? CROSS_SVG : CHECK_SVG}</span>
    </div>`;
}

/* What the order was, from the ledger entry the flow recorded for this payment
   (verticals.js orderItems) — "Oak Lounge Chair × 2, Walnut Monitor Riser". */
function itemsLabel() {
  const items = getEntry(state.reference)?.items;
  if (!Array.isArray(items) || !items.length) return null;
  return items.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(', ');
}

/* The terminal screens are pages of the merchant site: its header stays on top
   (its links reset the flow — steps.js navigate), the receipt sits below. */
function sitePage(inner) {
  markResultShown();
  return `${siteHeaderHTML('checkout')}<main class="site-main site-narrow">${inner}</main>`;
}

export function renderSuccess(event = {}) {
  set3DSWidth(false);
  resetWide();
  const v = VERTICALS[state.vertical];
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  const items = itemsLabel();
  // Paid — the bag has been bought. Emptied before the header renders, so its
  // badge reads 0. (A decline leaves the bag alone: the shopper retries it.)
  clearCart();
  // Product/AFT-aware copy: the flow picks the note at pay time (e.g. the
  // crypto "wallet funded, buy later" variant when is_direct_purchase=false).
  const note = lp.note || v.successNote;
  // A receipt, not a debug dump: the rows below are what a shopper would see —
  // ids they might quote back, and the payment's own status. The stored-
  // credential mechanics (card_*** / network_reference_id / initiation_type /
  // AFT) live in the engine room, and the SE narrates them.
  // (factsHTML drops null/empty values, so absent rows simply don't render.)
  host().innerHTML = sitePage(`
    <div class="screen success">
      ${badgeHTML('ok')}
      <div class="screen-title rise-1">${successVerb(v)} confirmed</div>
      <div class="screen-sub rise-2">${esc(v.merchant)} · <strong>${esc(paidLabel())}</strong></div>
      ${note ? `<div class="screen-next rise-3">${esc(note)}</div>` : ''}
      ${factsHTML([
        ['Order', orderNumber()],
        ['Items', items],
        ['Paid', paidLabel()],
        ['Method', cardLabel(pay, lp)],
        ['Saved card', lp.credential_label],
      ])}
      <div class="screen-actions rise-5">
        ${isSignedIn() ? `<button class="cs-secondary" data-land="orders">View orders</button>` : ''}
        <button class="co-cta site-cta" data-land="shop">Continue shopping</button>
      </div>
    </div>`);
  setOffstage(bankViewHTML(event)); // bank-app view lives OUTSIDE the client window
  wireReset();
}

/* `opts.note` replaces the decline sentence — the external-3DS stop uses it
   ("We couldn't verify this payment with your bank"). Always a literal from
   the caller, never gateway text. */
export function renderError(event = {}, opts = {}) {
  set3DSWidth(false);
  resetWide();
  setOffstage(null);
  const v = VERTICALS[state.vertical];
  const pay = event.raw?.data || {};
  const lp = state.lastPayment || {};
  // One sentence, always ours. The gateway's own message (and any SDK error that
  // reached this far) is engine-room material — printing it here put strings like
  // "Failed to fetch" in front of the shopper.
  const note = opts.note || 'Your card was declined — no charge was made. Try a different card, or contact your bank if it keeps happening.';
  host().innerHTML = sitePage(`
    <div class="screen error">
      ${badgeHTML('err')}
      <div class="screen-title rise-1">Payment declined</div>
      <div class="screen-sub rise-2">${esc(v.merchant)} · <strong>${esc(paidLabel())}</strong></div>
      <div class="screen-next err rise-3">${esc(note)} Your items are still in your bag.</div>
      ${factsHTML([
        ['Order', orderNumber()],
        ['Method', cardLabel(pay, lp)],
      ])}
      <div class="screen-actions rise-5">
        <button class="cs-secondary" data-land="bag">Back to bag</button>
        <button class="co-cta site-cta" data-land="checkout">Try a different card</button>
      </div>
    </div>`);
  wireReset();
}

/* The hosted page's cancel return (cancel_checkout_url): the shopper left
   Rapyd's page and is back on the MERCHANT's site — its header, its words.
   Nothing was charged; the bag is untouched. Not an error: no badge. */
export function renderCancelled() {
  set3DSWidth(false);
  resetWide();
  setOffstage(null);
  const v = VERTICALS[state.vertical];
  host().innerHTML = sitePage(`
    <div class="screen cancelled">
      <div class="screen-title rise-1">Payment cancelled</div>
      <div class="screen-sub rise-2">${esc(v.merchant)} · <strong>${esc(paidLabel())}</strong></div>
      <div class="screen-next rise-3">You left the payment page — nothing was charged. Your items are still in your bag.</div>
      <div class="screen-actions rise-5">
        <button class="cs-secondary" data-land="bag">Back to bag</button>
        <button class="co-cta site-cta" data-land="checkout">Return to checkout</button>
      </div>
    </div>`);
  wireReset();
}

function successVerb(v) {
  return v.cta === 'Deposit' ? 'Deposit' : v.cta === 'Buy' ? 'Purchase' : 'Payment';
}

/* Both terminal screens' buttons reset the flow (fresh reference, fresh watch)
   and land on a page of the site — the shop, the orders, the bag or straight
   back into the checkout. The labels are the SHOP's words, not the demo's:
   "Run another payment" was a control the SE reads out, printed where a store
   would say "Continue shopping". */
function wireReset() {
  host().querySelectorAll('[data-land]').forEach((btn) =>
    btn.addEventListener('click', () => { landOn(btn.dataset.land); setState({}); }));
}
