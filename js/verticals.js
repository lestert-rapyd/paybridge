/* ─────────────────────────────────────────────────────────────
   Verticals — the composed view the flows read: a skin (whose site,
   js/skins.js) laid over an industry pack (what it sells, js/packs.js).
   The built-in skins are Rapyd's own demo merchants (rapyd.shop,
   rapyd.coin, rapyd.spin); a customer skin swaps the identity without
   touching the pack.

   VERTICALS[id] keeps the shape every caller already reads — label,
   dot, merchant, descriptor, domain from the skin; headline, cta,
   successNote, kycAtSignup, products from the pack — keyed by skin id
   (state.vertical holds the active skin id). See packs.js for how a
   product's billing nature drives the stored-credential intent.
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';
import { SKINS, SKIN_ORDER } from './skins.js';
import { PACKS } from './packs.js';
import { cartLines, resolveLines, cartProblem, cartAsProduct } from './site/cart.js';
import { walletConfig, pendingDeposit, depositProduct } from './site/wallet.js';

const compose = (skin) => {
  const pack = PACKS[skin.pack];
  return {
    ...pack,
    id: skin.id,
    pack: pack.id,
    label: skin.label,
    dot: skin.dot,
    merchant: skin.merchant,
    descriptor: skin.descriptor,
    domain: skin.domain,
  };
};

export const VERTICALS = Object.fromEntries(Object.values(SKINS).map((s) => [s.id, compose(s)]));

export const VERTICAL_ORDER = SKIN_ORDER;

/* The active vertical's product for the current environment — what the flows
   charge. A valid BAG (js/site/cart.js) wins: its lines fold into one composite
   product whose amount is the bag total, so every flow, the price tile, FX and
   the live clamp below keep reading this one path. With no (valid) bag,
   state.selectedProduct picks from the vertical's catalog (falling back to
   the first product — the classic one-time default — when unset or pointing
   at another vertical). An SE-edited amount/currency (the price tile) then
   overrides that product's numbers when it was captured for this same
   vertical+product — never explicitly cleared, the guard makes it fall away
   cleanly on any vertical/product change. Live still charges a real card —
   every price collapses to one penny regardless of any edited amount. That
   clamp is a UX nicety only: the backend enforces its own LIVE_MAX_AMOUNT
   cap, because anything client-side can be edited away. */
export function activeProduct(verticalId = state.vertical) {
  const p = pricedProduct(verticalId);
  return state.env === 'live' ? { ...p, amount: '0.01' } : p;
}

/** The selected product with the SE's price override applied, BEFORE the live
    penny clamp — what the tile reverts to when a typed amount is invalid, so a
    live-mode edit can't bake '0.01' into the sandbox override. */
export function pricedProduct(verticalId = state.vertical) {
  const v = VERTICALS[verticalId];
  const sel = state.selectedProduct;
  // A wallet deposit in progress (js/site/wallet.js) is what this checkout is
  // for — it wins over the bag, which stays untouched for later.
  let p = depositFor(verticalId)
    || cartProduct(verticalId)
    || (sel && sel.vertical === verticalId && v.products.find((x) => x.id === sel.productId))
    || v.products[0];
  const override = state.productOverride;
  if (override && override.vertical === verticalId && override.productId === p.id) {
    p = { ...p, amount: override.amount, currency: override.currency };
  }
  return p;
}

/** The pending wallet deposit as a product, or null (no deposit, or the pack
    runs no wallet). */
export function depositFor(verticalId = state.vertical) {
  const d = pendingDeposit(verticalId);
  const cfg = d && walletConfig(VERTICALS[verticalId]?.pack);
  return cfg ? depositProduct(cfg, d) : null;
}

/** The active skin's wallet rule (js/site/wallet.js walletConfig), or null. */
export function activeWallet(verticalId = state.vertical) {
  return walletConfig(VERTICALS[verticalId]?.pack);
}

/** The bag's lines joined to this vertical's catalog: [{ product, qty }]. */
export function bagLines(verticalId = state.vertical) {
  return resolveLines(cartLines(verticalId), VERTICALS[verticalId].products);
}

/** The bag as one product, or null when it's empty or can't check out
    (cart.js cartProblem — mixed currencies, a subscription not on its own). */
export function cartProduct(verticalId = state.vertical) {
  const lines = bagLines(verticalId);
  return lines.length && !cartProblem(lines) ? cartAsProduct(lines) : null;
}

/** What a payment bought, for the ledger and the shopper's Orders page:
    the bag's lines, or the single product as one line. Text only. */
export function orderItems(p = activeProduct()) {
  return p.lines || [{ id: p.id, name: p.name, qty: 1, amount: p.amount, currency: p.currency, billing: p.billing }];
}

/** The pay-button verb for the active product ("Pay" / "Subscribe" / "Start DCA"…). */
export function productCta(verticalId = state.vertical) {
  return activeProduct(verticalId).cta || VERTICALS[verticalId].cta;
}

/* ── The fx_rates beat ───────────────────────────────────────
   GET /v1/fx_rates fires from app.js's quote fetcher (debounced, on every FX
   edit and price keystroke) and used to have NO engine-room surface at all —
   its entire UI was the FX controls' preview, which is backwards. The
   exchange is recorded here beside the rest of the FX logic; each flow renders
   it as a card with its own beatCardHTML, exactly like the calls it makes
   itself. Data lives here, presentation stays in the flows — no import cycle. */
let fxBeat = null;
export function setFxBeat(beat) { fxBeat = beat; }
export function getFxBeat() { return fxBeat; }
/** The path as it went on the wire, for the card's headline. */
export function fxBeatPath() {
  if (!fxBeat) return '/v1/fx_rates';
  const p = fxBeat.params;
  const side = p.fixedSide === 'buy' ? `buy_amount=${p.amount}` : `sell_amount=${p.amount}`;
  return `/v1/fx_rates?action_type=payment&buy_currency=${p.buyCurrency}&sell_currency=${p.sellCurrency}&${side}`;
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
