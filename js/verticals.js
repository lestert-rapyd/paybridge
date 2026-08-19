/* ─────────────────────────────────────────────────────────────
   Vertical definitions.
   Brand stays "PayBridge" — client-side merchants are PayBridge
   sub-brands. Only context, product framing, colours and copy change.

   Each vertical carries a small PRODUCT CATALOG: one-time products
   and subscription products. The product's billing nature — not a
   mechanical back-office switch — is what drives the stored-credential
   intent (`recurrence_type`): one-time + save → unscheduled (card-on-
   file, customer-present reuse); subscription → recurring (MIT charges
   run from the back office). Crypto products additionally carry the
   AFT indicators (aft / purpose_code / special_condition_indicator).
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';

export const VERTICALS = {
  ecommerce: {
    id: 'ecommerce',
    label: 'Retail',
    dot: '#5600ef',
    merchant: 'PayBridge Shop',
    descriptor: 'PayBridge - Shop',
    domain: 'shop.paybridge.com',
    headline: 'Secure checkout',
    cta: 'Pay',
    successNote: 'Order confirmed — we’re packing it now. Dispatch and tracking details will land in your inbox shortly.',
    products: [
      {
        id: 'chair', pill: 'Lounge Chair', billing: 'one_time', glyph: '🪑',
        thumb: ['#5600ef', '#a855f7'],
        name: 'Oak Lounge Chair',
        desc: 'Walnut finish · Qty 1',
        amount: '149.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: 'Free',
        successNote: 'Order confirmed — we’re packing it now. Dispatch and tracking details will land in your inbox shortly.',
      },
      {
        id: 'coffee-sub', pill: 'Coffee Club', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '☕',
        thumb: ['#7a3f12', '#c9803a'],
        name: 'Coffee Bean Club',
        desc: '250g single origin · monthly',
        amount: '18.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: 'Free',
        successNote: 'Subscription active — your first bag ships today. Future bags bill to this card automatically each month.',
      },
    ],
  },

  crypto: {
    id: 'crypto',
    label: 'Crypto',
    dot: '#00ff89',
    merchant: 'PayBridge Coin',
    descriptor: 'PayBridge - Coin',
    domain: 'coin.paybridge.io',
    headline: 'Buy crypto instantly',
    cta: 'Buy',
    successNote: 'Top-up confirmed — ≈ 0.00075 BTC is on its way to your wallet address. Network confirmations usually take a few minutes.',
    products: [
      {
        id: 'btc', pill: 'Buy BTC', billing: 'one_time', glyph: '₿',
        aft: true, purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency',
        thumb: ['#00b36b', '#00ff89'],
        name: 'Bitcoin',
        desc: 'You receive ≈ 0.00075 BTC',
        amount: '50.00', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'Purchase confirmed — ≈ 0.00075 BTC is on its way to your wallet address. Network confirmations usually take a few minutes.',
        // is_direct_purchase: false → the AFT funds the fiat balance instead
        fundedNote: 'Funds added — your fiat balance is topped up and held. Buy BTC whenever you’re ready, at your price.',
      },
      {
        id: 'dca', pill: 'DCA Plan', billing: 'subscription', interval: 'monthly', cta: 'Start DCA', glyph: '🔁',
        aft: true, purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency',
        thumb: ['#0e7490', '#22d3ee'],
        name: 'Bitcoin DCA Plan',
        desc: 'Auto-buy BTC · monthly',
        amount: '25.00', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'DCA plan active — your first buy just executed. Future buys run automatically every month, no action needed.',
      },
      {
        id: 'coinplus', pill: 'Coin+', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '⭐',
        thumb: ['#4338ca', '#818cf8'],
        name: 'Coin+ Platform Fee',
        desc: 'Pro trading tier · monthly',
        amount: '9.99', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'Coin+ active — pro features unlocked. Your card bills automatically each month.',
      },
    ],
  },

  gaming: {
    id: 'gaming',
    label: 'iGaming',
    dot: '#ff007a',
    merchant: 'PayBridge Play',
    descriptor: 'PayBridge - Play',
    domain: 'play.paybridge.bet',
    headline: 'Add funds to your wallet',
    cta: 'Deposit',
    successNote: 'Funds added — your new balance is available to play right away. Withdrawals return to this card.',
    products: [
      {
        id: 'spins', pill: '50 Spins', billing: 'one_time', cta: 'Buy', glyph: '🎲',
        thumb: ['#c4005f', '#ff007a'],
        name: '50 Spins Pack',
        desc: 'Credited instantly',
        amount: '50.00', currency: 'EUR', symbol: '€', country: 'MT',
        delivery: null,
        successNote: 'Spins credited — good luck! Winnings withdraw back to this card.',
      },
      {
        id: 'adfree', pill: 'Ad-free', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '✨',
        thumb: ['#7f1d1d', '#ef4444'],
        name: 'Ad-free Play',
        desc: 'No interruptions · monthly',
        amount: '12.00', currency: 'EUR', symbol: '€', country: 'MT',
        delivery: null,
        successNote: 'Ad-free active — enjoy uninterrupted play. Bills to this card automatically each month.',
      },
    ],
  },
};

export const VERTICAL_ORDER = ['ecommerce', 'crypto', 'gaming'];

/* The active vertical's SELECTED product for the current environment.
   state.selectedProduct picks from the vertical's catalog (falling back to
   the first product — the classic one-time default — when unset or pointing
   at another vertical). An SE-edited amount/currency (the price tile) then
   overrides that product's numbers when it was captured for this same
   vertical+product — never explicitly cleared, the guard makes it fall away
   cleanly on any vertical/product change. Live still charges a real card —
   every price collapses to one penny regardless of any edited amount. */
export function activeProduct(verticalId = state.vertical) {
  const v = VERTICALS[verticalId];
  const sel = state.selectedProduct;
  let p = (sel && sel.vertical === verticalId && v.products.find((x) => x.id === sel.productId)) || v.products[0];
  const override = state.productOverride;
  if (override && override.vertical === verticalId && override.productId === p.id) {
    p = { ...p, amount: override.amount, currency: override.currency };
  }
  return state.env === 'live' ? { ...p, amount: '0.01' } : p;
}

/** The pay-button verb for the active product ("Pay" / "Subscribe" / "Start DCA"…). */
export function productCta(verticalId = state.vertical) {
  return activeProduct(verticalId).cta || VERTICALS[verticalId].cta;
}

/** Customer-facing product chooser — the product FRAME (see js/steps.js), two
    columns grouped by billing nature. Route-card grammar (`.bo-route`, design
    system §04.4b): each option has a money consequence the SE has to narrate —
    a subscription authorises later MITs, a one-time purchase doesn't — so the
    consequence is stated on the card rather than left implicit. */
export function productColumnsHTML(verticalId = state.vertical) {
  const v = VERTICALS[verticalId];
  // Only a product the SE actually PICKED reads as selected. activeProduct()
  // falls back to the catalog's first entry, which would show an answer under a
  // question nobody has answered yet.
  const sel = state.selectedProduct;
  const chosen = sel && sel.vertical === verticalId ? sel.productId : null;
  const col = (label, note, products) => `
    <div class="prod-col">
      <div class="prod-col-head">${label}<span>${note}</span></div>
      ${products.length ? products.map((p) => `
        <button type="button" class="bo-route ${p.id === chosen ? 'active' : ''}" data-product="${p.id}">
          <div class="bo-route-title">${p.name}${p.billing === 'subscription' ? ' <span class="ps-mo">/mo</span>' : ''}</div>
          <div class="bo-route-note">${p.desc}</div>
          <div class="bo-route-legs">
            <div class="bo-route-leg"><span>Price</span><span><b>${p.amount} ${p.currency}</b></span></div>
          </div>
        </button>`).join('')
        : `<div class="prod-col-none">Nothing ${label.toLowerCase()} in this store.</div>`}
    </div>`;
  const of = (billing) => v.products.filter((p) => p.billing === billing);
  return `
    <div class="prod-cols">
      ${col('One-time', 'pay once', of('one_time'))}
      ${col('Subscription', 'bills again later', of('subscription'))}
    </div>`;
}

/* ── FX-aware customer/merchant amounts ──────────────────────
   The tile's amount/currency is ALWAYS the base (Rapyd `currency`/`amount`);
   requested_currency is the other side. Rapyd's buy side = merchant funds,
   sell side = customer funds. A live fx_rates quote (cached on state.fx.quote,
   keyed by fxQuoteKey) turns that base into what the customer actually pays and
   what the merchant actually receives, so every surface shows one figure.
   `approx` = this side floats with the rate; `pending` = quote not in yet. */
export function fxQuoteKey(verticalId = state.vertical) {
  const p = activeProduct(verticalId);
  return `${state.fx.fixedSide}|${p.currency}|${state.fx.requestedCurrency}|${p.amount}|${state.env}`;
}
function freshQuote(verticalId) {
  const q = state.fx.quote;
  return q && !q.error && q.key === fxQuoteKey(verticalId) ? q : null;
}
export function customerCharge(verticalId = state.vertical) {
  const p = activeProduct(verticalId);
  if (!state.fx.enabled || !state.fx.requestedCurrency) return { amount: p.amount, currency: p.currency, approx: false, pending: false };
  const q = freshQuote(verticalId);
  if (q) return { amount: q.sellAmount, currency: q.sellCurrency, approx: state.fx.fixedSide === 'buy', pending: false };
  // 'sell' fixes the customer's charge at the base, so it's known without a quote.
  if (state.fx.fixedSide === 'sell') return { amount: p.amount, currency: p.currency, approx: false, pending: false };
  return { amount: null, currency: state.fx.requestedCurrency, approx: true, pending: true };
}
export function merchantReceive(verticalId = state.vertical) {
  const p = activeProduct(verticalId);
  if (!state.fx.enabled || !state.fx.requestedCurrency) return { amount: p.amount, currency: p.currency, approx: false, pending: false };
  const q = freshQuote(verticalId);
  if (q) return { amount: q.buyAmount, currency: q.buyCurrency, approx: state.fx.fixedSide === 'sell', pending: false };
  // 'buy' fixes the merchant's payout at the base.
  if (state.fx.fixedSide === 'buy') return { amount: p.amount, currency: p.currency, approx: false, pending: false };
  return { amount: null, currency: state.fx.requestedCurrency, approx: true, pending: true };
}
/* Snapshot of the FX legs for state.lastPayment, so the success screen and the
   bank-statement mockup show exactly what the checkout showed. null when FX is
   off. `charged` = what the customer paid (statement main); `base` = the
   merchant's price/what they receive (the small "original" line). */
export function fxSnapshot(verticalId = state.vertical) {
  if (!state.fx.enabled || !state.fx.requestedCurrency) return null;
  const p = activeProduct(verticalId);
  const charge = customerCharge(verticalId);
  const receive = merchantReceive(verticalId);
  return {
    charged: { amount: charge.amount ?? p.amount, currency: charge.currency },
    receive: { amount: receive.amount ?? p.amount, currency: receive.currency },
    base: { amount: p.amount, currency: p.currency },
  };
}
/* ISO-code money string (no symbols — locked demo convention). Varying side is
   prefixed "≈"; a not-yet-fetched amount shows an ellipsis. */
export function chargeText(c) {
  if (c.pending || c.amount == null) return `${c.currency} …`;
  const n = Number(c.amount);
  const money = Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : c.amount;
  return `${c.approx ? '≈ ' : ''}${money} ${c.currency}`;
}
