/* ─────────────────────────────────────────────────────────────
   The shop side of the merchant site: the catalog (one-off vs
   subscription tabs), a product page, and the bag. Content comes from
   the active industry pack (js/packs.js) through VERTICALS; looks come
   only from skin tokens (css/site.css).

   Nothing on these pages calls Rapyd — browsing and filling a bag is the
   merchant's own business. The first call is the checkout's, and what it
   charges is the bag folded into one product (verticals.js
   activeProduct() ← js/site/cart.js). The bag is where the payment's
   constraints surface, in shopper words: one currency, a subscription on
   its own, and a guest subscription needing somewhere to store the card.

   Markup + page-local view state only; js/steps.js routes and wires.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS, bagLines } from '../verticals.js';
import { chosenGuest, canGuestSubscribe } from '../identity.js';
import { esc } from '../ui.js';
import { cartProblem, cartTotal, lineTotal, MAX_QTY } from './cart.js';
import { siteHeaderHTML, backLinkHTML, thumbHTML, moneyText, priceText } from './chrome.js';

/* Page-local view state — which tab of the shop, which product is open.
   Plain module state: neither is part of the payment. */
let shopTab = 'one_time';           // 'one_time' | 'subscription'
let viewing = null;                 // product id on the product page

export function setShopTab(tab) { if (tab === 'one_time' || tab === 'subscription') shopTab = tab; }
export function viewProduct(id) { viewing = id; }
export const viewedProduct = () => {
  const products = VERTICALS[state.vertical].products;
  return products.find((p) => p.id === viewing) || products[0];
};

const products = () => VERTICALS[state.vertical].products;

/* ── Shop ────────────────────────────────────────────────── */
function shopCardHTML(p) {
  return `
    <button type="button" class="shop-card" data-product="${esc(p.id)}">
      <div class="shop-shot">
        ${thumbHTML(p, 'shop-thumb')}
        ${p.billing === 'subscription' ? `<span class="shop-badge"><i class="icon-loop"></i>Monthly</span>` : ''}
      </div>
      <div class="shop-name">${esc(p.name)}</div>
      <div class="shop-cat">${esc(p.cat || p.pill || '')}</div>
      <div class="shop-price">${esc(priceText(p))}</div>
    </button>`;
}

export function shopPageHTML() {
  const one = products().filter((p) => p.billing === 'one_time');
  const sub = products().filter((p) => p.billing === 'subscription');
  // A pack with only one kind shows no tabs at all.
  const tab = !sub.length ? 'one_time' : !one.length ? 'subscription' : shopTab;
  const list = tab === 'subscription' ? sub : one;
  const tabBtn = (key, label, icon) =>
    `<button type="button" class="shop-tab ${tab === key ? 'active' : ''}" data-shop-tab="${key}">${label}${icon}</button>`;
  return `
    ${siteHeaderHTML('shop')}
    <main class="site-main">
      <div class="site-titlebar">
        <h1 class="site-h1">Shop</h1>
        ${one.length && sub.length ? `
          <div class="shop-tabs">
            ${tabBtn('one_time', 'Products', '')}
            ${tabBtn('subscription', 'Subscriptions', ' <i class="icon-loop"></i>')}
          </div>` : ''}
      </div>
      <div class="shop-grid">${list.map(shopCardHTML).join('')}</div>
    </main>`;
}

/* ── Product page ────────────────────────────────────────── */
export function productPageHTML() {
  const p = viewedProduct();
  const sub = p.billing === 'subscription';
  const specs = Array.isArray(p.specs) ? p.specs : [];
  return `
    ${siteHeaderHTML('product')}
    <main class="site-main">
      ${backLinkHTML('shop', 'Back to shop')}
      <div class="pdp">
        <div class="pdp-shot">${thumbHTML(p, 'pdp-thumb')}</div>
        <div class="pdp-info">
          <div class="pdp-cat">${esc(p.cat || p.pill || '')}</div>
          <h1 class="site-h1 pdp-name">${esc(p.name)}</h1>
          <div class="pdp-price">${esc(priceText(p))}</div>
          ${sub ? `
            <div class="site-note"><i class="icon-loop"></i><span>Billed automatically every month to your saved card — cancel any time.</span></div>` : ''}
          <button type="button" class="co-cta site-cta" id="site-add" data-product="${esc(p.id)}">
            <i class="icon-bag"></i>${esc(sub ? (p.cta || 'Subscribe') : 'Add to bag')}
          </button>
          <div class="pdp-copy">
            ${p.tagline ? `<div class="pdp-tagline">${esc(p.tagline)}</div>` : ''}
            <p>${esc(p.about || p.desc)}</p>
          </div>
          ${specs.length ? `
            <div class="pdp-specs">
              ${specs.map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(val)}</b></div>`).join('')}
            </div>` : ''}
        </div>
      </div>
    </main>`;
}

/* ── Bag ─────────────────────────────────────────────────── */

/** Why the bag can't go to checkout right now, or null: the bag's own rules
    (cart.js) first, then the identity rule a guest subscription hits. The
    latter keeps the old product frame's blocker — the shopper's need, stated
    as such; WHY it can't stay a guest checkout is the SE's line. */
export function bagBlocker() {
  const lines = bagLines();
  const problem = cartProblem(lines);
  if (problem) return problem.code === 'empty' ? { code: 'empty', message: '' } : problem;
  const sub = lines.find((l) => l.product.billing === 'subscription');
  if (sub && chosenGuest() && !canGuestSubscribe()) {
    return { code: 'account', message: `${sub.product.name} needs an account, so we can charge your card each renewal.` };
  }
  return null;
}

function bagLineHTML({ product: p, qty }) {
  const sub = p.billing === 'subscription';
  return `
    <div class="bag-line">
      ${thumbHTML(p, 'bag-thumb')}
      <div class="bag-main">
        <div class="bag-top">
          <div>
            <div class="bag-name">${esc(p.name)}</div>
            <div class="bag-desc">${esc([p.cat, p.desc].filter(Boolean).join(' · '))}</div>
            ${sub ? `<span class="shop-badge inline"><i class="icon-loop"></i>Recurring monthly</span>` : ''}
          </div>
          <div class="bag-amt">${esc(moneyText(lineTotal(p, qty), p.currency))}${sub ? '<span class="per-mo">/mo</span>' : ''}</div>
        </div>
        <div class="bag-ctl">
          ${sub
            ? `<span class="bag-qty-fixed">Qty 1</span>`
            : `<div class="bag-qty">
                 <button type="button" data-qty="${esc(p.id)}" data-delta="-1" aria-label="One fewer">−</button>
                 <span>${esc(qty)}</span>
                 <button type="button" data-qty="${esc(p.id)}" data-delta="1" aria-label="One more" ${qty >= MAX_QTY ? 'disabled' : ''}>+</button>
               </div>`}
          <button type="button" class="site-link-btn" data-remove="${esc(p.id)}"><i class="icon-trash"></i>Remove</button>
        </div>
      </div>
    </div>`;
}

export function bagPageHTML() {
  const lines = bagLines();
  const head = `
    ${siteHeaderHTML('bag')}
    <main class="site-main">
      <div class="site-titles">
        <h1 class="site-h1">Got everything?</h1>
        <p class="site-sub">Your bag</p>
      </div>`;
  if (!lines.length) {
    return `${head}
      <div class="site-empty">
        <img src="assets/no-results.svg" alt="" />
        <div>Your bag is empty</div>
        <button type="button" class="co-cta site-cta compact" data-nav="shop">Browse the shop</button>
      </div>
    </main>`;
  }
  const block = bagBlocker();
  const total = cartTotal(lines);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  // "/mo" only when the whole bag bills monthly — a mixed bag is blocked anyway.
  const sub = lines.every((l) => l.product.billing === 'subscription');
  const delivery = lines[0].product.delivery;
  return `${head}
      <div class="bag">
        <div class="bag-lines">${lines.map(bagLineHTML).join('')}</div>
        <aside class="bag-sum">
          <div class="bag-sum-h">Summary</div>
          <div class="co-line"><span>${esc(count)} item${count === 1 ? '' : 's'}</span><span>${total.amount ? esc(moneyText(total.amount, total.currency)) : '—'}</span></div>
          <div class="co-line"><span>${delivery ? 'Delivery' : 'Fees'}</span><span class="free">${esc(delivery || 'Free')}</span></div>
          <div class="co-line total"><span>Total</span><span class="co-total-amt">${total.amount ? esc(moneyText(total.amount, total.currency)) : '—'}${sub ? ' <span class="per-mo">/mo</span>' : ''}</span></div>
          ${block && block.message ? `
            <div class="site-alert" role="note">
              <span>${esc(block.message)}</span>
              ${block.code === 'account' ? `<button type="button" class="site-link-btn accent" id="step-makeaccount">Create an account</button>` : ''}
            </div>` : ''}
          <button type="button" class="co-cta site-cta" id="site-checkout" ${block ? 'disabled' : ''}>Checkout</button>
          <button type="button" class="cs-secondary" data-nav="shop">Continue shopping</button>
        </aside>
      </div>
    </main>`;
}
