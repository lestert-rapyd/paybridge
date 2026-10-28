/* ─────────────────────────────────────────────────────────────
   The merchant site's own chrome — the header every page of the
   client site keeps (wordmark, nav, account, bag), plus the small
   shared pieces the site's pages draw with (product tile, money).

   Generic across skins: the wordmark, domain and colours come from
   the active skin (js/skins.js) through VERTICALS; nothing here names
   a merchant. It is styled ONLY by tokens (css/site.css), so a skin
   restyles it without a stylesheet edit.

   Markup only — js/steps.js routes and wires every control here by
   its data-nav / id (document-delegated, like the rest of the app).
   Every catalog/API/identity value is escaped: the skin and pack are
   data an SE (or a customer skin file) supplies.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import * as customers from '../customers.js';
import { esc } from '../ui.js';
import { currencyDecimals } from '../sync.js';
import { cartCount } from './cart.js';
import { isSignedIn } from './session.js';

/* Which nav item a page lights up. */
const NAV_OF = { shop: 'shop', product: 'shop', bag: 'shop', checkout: 'shop', orders: 'orders', methods: 'methods' };

/** "rapyd.shop" → rapyd + accented ".shop"; a name without a dot is one word.
    Both halves are escaped text. */
export function wordmarkHTML(merchant) {
  const m = String(merchant || '');
  const dot = m.indexOf('.');
  if (dot <= 0) return `<span class="sh-word">${esc(m)}</span>`;
  return `<span class="sh-word">${esc(m.slice(0, dot))}<span class="sh-word-acc">${esc(m.slice(dot))}</span></span>`;
}

/** The site header. `page` is the step being drawn (state.step by default). */
export function siteHeaderHTML(page = state.step) {
  const v = VERTICALS[state.vertical];
  const active = NAV_OF[page] || null;
  const signedIn = isSignedIn();
  const n = cartCount();
  // `label` is literal markup from this function (a long and a short form) — never data.
  const nav = (key, label) =>
    `<button type="button" class="sh-nav ${active === key ? 'active' : ''}" data-nav="${key}">${label}</button>`;
  const first = customers.getIdentity().name.split(' ')[0] || 'Account';
  return `
    <header class="site-head">
      <button type="button" class="sh-brand" data-nav="shop" title="${esc(v.merchant)}">${wordmarkHTML(v.merchant)}</button>
      <nav class="sh-navs">
        ${nav('shop', 'Shop')}
        ${signedIn ? nav('orders', 'Orders') + nav('methods', '<span class="sh-lg">Payment methods</span><span class="sh-sm">Cards</span>') : ''}
      </nav>
      <div class="sh-right">
        ${signedIn
          ? `<span class="sh-user"><i class="icon-user"></i>${esc(first)}</span>
             <button type="button" class="sh-link" id="site-signout">Sign out</button>`
          : `<button type="button" class="sh-link" data-nav="account-q">Sign in</button>`}
        <button type="button" class="sh-bag" data-nav="bag" aria-label="Bag, ${n} item${n === 1 ? '' : 's'}">
          <i class="icon-bag"></i>${n ? `<span class="sh-bag-n">${n}</span>` : ''}
        </button>
      </div>
    </header>`;
}

/** A "‹ Back to …" link that navigates to `step`. */
export function backLinkHTML(step, label) {
  return `<button type="button" class="site-back" data-nav="${esc(step)}"><i class="icon-chevron_left"></i>${esc(label)}</button>`;
}

/** A product's tile: the pack's gradient + glyph when it has one, else the
    neutral hatched "product shot" placeholder. `cls` sizes it. */
export function thumbHTML(p, cls = 'co-thumb') {
  if (Array.isArray(p?.thumb) && p.thumb.length >= 2) {
    const [c1, c2] = p.thumb;
    return `<div class="${cls}" style="background:linear-gradient(135deg,${esc(c1)},${esc(c2)})">${esc(p.glyph || '◆')}</div>`;
  }
  return `<div class="${cls} ph" aria-hidden="true"></div>`;
}

/** ISO-code money ("1,449.00 GBP"), the demo's locked convention. Text. */
export function moneyText(amount, currency) {
  const n = Number(amount);
  const dp = currencyDecimals(currency);
  const money = Number.isFinite(n) ? n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : String(amount ?? '—');
  return `${money} ${currency || ''}`.trim();
}

/** A product's shelf price — "/ month" for a subscription. Text. */
export function priceText(p) {
  return `${moneyText(p.amount, p.currency)}${p.billing === 'subscription' ? ' / month' : ''}`;
}
