/* ─────────────────────────────────────────────────────────────
   Vertical definitions.
   Brand stays "PayBridge" — client-side merchants are PayBridge
   sub-brands. Only context, product framing, colours and copy change.
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
    product: {
      thumb: ['#5600ef', '#a855f7'],
      name: 'Oak Lounge Chair',
      desc: 'Walnut finish · Qty 1',
      amount: '149.00',
      currency: 'GBP',
      symbol: '£',
      country: 'GB',
      delivery: 'Free',
    },
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
    product: {
      thumb: ['#00b36b', '#00ff89'],
      name: 'Bitcoin',
      desc: 'You receive ≈ 0.00075 BTC',
      amount: '50.00',
      currency: 'USD',
      symbol: '$',
      country: 'US',
      delivery: null,
    },
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
    product: {
      thumb: ['#c4005f', '#ff007a'],
      name: 'Account Deposit',
      desc: 'Funds available instantly',
      amount: '50.00',
      currency: 'EUR',
      symbol: '€',
      country: 'MT',
      delivery: null,
    },
  },
};

export const VERTICAL_ORDER = ['ecommerce', 'crypto', 'gaming'];

/* The active vertical's product for the current environment.
   An SE-edited amount/currency (own-fields' price tile) overrides the
   vertical's default when it was captured for this same vertical — it's
   never explicitly cleared, this guard is what makes it fall away cleanly
   when the vertical changes. Live still charges a real card — every price
   collapses to one penny regardless of any edited amount. */
export function activeProduct(verticalId = state.vertical) {
  let p = VERTICALS[verticalId].product;
  const override = state.productOverride;
  if (override && override.vertical === verticalId) {
    p = { ...p, amount: override.amount, currency: override.currency };
  }
  return state.env === 'live' ? { ...p, amount: '0.01' } : p;
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
