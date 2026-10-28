/* ─────────────────────────────────────────────────────────────
   The shopper's bag — several lines, ONE checkout. The flows never
   read the bag directly: verticals.js pricedProduct() folds a valid
   bag into a single composite product (cartAsProduct below), so the
   amount/currency the flows send, the SE's price override, FX and the
   live 0.01 clamp all keep working through the one path they already
   use. An invalid bag composes nothing — and the bag screen refuses to
   reach the checkout until it's fixed (cartProblem).

   Two rules a real payment imposes on the bag:
     · ONE currency — a payment has one `currency`.
     · a SUBSCRIPTION checks out alone, qty 1 — its first payment stores
       the card with recurrence_type=recurring (the back office then
       bills it as MITs, one product per credential); one-off lines would
       ride an `unscheduled`-or-nothing intent the same POST can't carry.

   State lives on state.cart ({ vertical, lines: [{ productId, qty }] }),
   mutated directly like state.productOverride and guarded the same way:
   a bag captured for another vertical (skin) simply reads as empty.

   Pure apart from that one state field — no DOM, no catalog import (the
   catalog is passed in), so tests/unit.js exercises it directly.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { currencyDecimals } from '../sync.js';

export const MAX_QTY = 9;

/* ── Bag state ───────────────────────────────────────────── */

/** The raw lines for a vertical — [] when the bag belongs to another one. */
export function cartLines(verticalId = state.vertical) {
  const c = state.cart;
  return c && c.vertical === verticalId ? c.lines : [];
}

function ensureCart(verticalId) {
  if (!state.cart || state.cart.vertical !== verticalId) state.cart = { vertical: verticalId, lines: [] };
  return state.cart;
}

/** Add one of a product. A subscription line stays at qty 1 — adding it again
    is a no-op, not a second subscription. `isSubscription` is passed by the
    caller (this module never reads the catalog). */
export function addToCart(productId, { verticalId = state.vertical, isSubscription = false } = {}) {
  const cart = ensureCart(verticalId);
  const line = cart.lines.find((l) => l.productId === productId);
  if (line) {
    if (!isSubscription) line.qty = Math.min(MAX_QTY, line.qty + 1);
    return;
  }
  cart.lines.push({ productId, qty: 1 });
}

/** Set a line's quantity; 0 or less removes it. */
export function setLineQty(productId, qty, verticalId = state.vertical) {
  const cart = ensureCart(verticalId);
  const n = Math.floor(Number(qty));
  if (!Number.isFinite(n) || n <= 0) { removeLine(productId, verticalId); return; }
  const line = cart.lines.find((l) => l.productId === productId);
  if (line) line.qty = Math.min(MAX_QTY, n);
}

export function removeLine(productId, verticalId = state.vertical) {
  const cart = ensureCart(verticalId);
  cart.lines = cart.lines.filter((l) => l.productId !== productId);
}

export function clearCart(verticalId = state.vertical) {
  if (state.cart && state.cart.vertical === verticalId) state.cart = { vertical: verticalId, lines: [] };
}

/** Items in the bag (sum of quantities) — the header badge. */
export function cartCount(verticalId = state.vertical) {
  return cartLines(verticalId).reduce((n, l) => n + l.qty, 0);
}

/* ── Pure rules (catalog passed in) ──────────────────────── */

/** Lines joined to their catalog products: [{ product, qty }]. A line whose
    product left the catalog is dropped rather than charged for. */
export function resolveLines(lines, products) {
  return (lines || [])
    .map((l) => ({ product: products.find((p) => p.id === l.productId), qty: l.qty }))
    .filter((l) => l.product && l.qty > 0);
}

/* Money in minor units, so 3 × 12.99 is 38.97 and not 38.970000000000006. */
const toMinor = (amount, dp) => Math.round(Number(amount) * 10 ** dp);
const fromMinor = (minor, dp) => (minor / 10 ** dp).toFixed(dp);

/** One line's total as a currency-formatted string ("298.00"). */
export function lineTotal(product, qty) {
  const dp = currencyDecimals(product.currency);
  return fromMinor(toMinor(product.amount, dp) * qty, dp);
}

/** The bag total: { amount, currency }. amount is null for an empty bag or one
    that mixes currencies — there is no honest single figure for either. */
export function cartTotal(resolved) {
  if (!resolved.length) return { amount: null, currency: null };
  const currency = resolved[0].product.currency;
  if (resolved.some((l) => l.product.currency !== currency)) return { amount: null, currency: null };
  const dp = currencyDecimals(currency);
  const minor = resolved.reduce((sum, l) => sum + toMinor(l.product.amount, dp) * l.qty, 0);
  return { amount: fromMinor(minor, dp), currency };
}

/** Why this bag can't check out, or null. `code` is for callers/tests; the
    message is shopper copy (the SE narrates the API reason). */
export function cartProblem(resolved) {
  if (!resolved.length) return { code: 'empty', message: 'Your bag is empty.' };
  const currencies = [...new Set(resolved.map((l) => l.product.currency))];
  if (currencies.length > 1) {
    return { code: 'currency', message: `Your bag mixes currencies (${currencies.join(', ')}). Check out one currency at a time.` };
  }
  const subs = resolved.filter((l) => l.product.billing === 'subscription');
  if (subs.length && (resolved.length > 1 || subs[0].qty > 1)) {
    return {
      code: 'subscription',
      message: subs.length > 1
        ? 'Subscriptions check out on their own — one at a time.'
        : `${subs[0].product.name} is a subscription, so it checks out on its own. Remove the other items, or check them out first.`,
    };
  }
  return null;
}

/** A valid bag as ONE product, the shape every flow already reads
    (activeProduct()). Billing-nature fields (billing, interval, cta, the AFT
    indicators) come from the lines — all one-off, or a lone subscription, once
    cartProblem() is null. `id` stays the product's own id for a single qty-1
    line, so the price override, the stored credential's origin_product and the
    back office's MIT lookup behave exactly as before the bag existed; any other
    bag gets a content-derived id, so editing the bag drops a stale override.
    `lines` is the receipt/ledger snapshot. */
export function cartAsProduct(resolved) {
  const [first] = resolved;
  const single = resolved.length === 1;
  const { amount, currency } = cartTotal(resolved);
  const count = resolved.reduce((n, l) => n + l.qty, 0);
  const label = (l) => (l.qty > 1 ? `${l.product.name} × ${l.qty}` : l.product.name);
  const aft = resolved.every((l) => !!l.product.aft);
  return {
    ...first.product,
    id: single && first.qty === 1 ? first.product.id : `cart:${resolved.map((l) => `${l.product.id}*${l.qty}`).join('+')}`,
    name: single ? label(first) : `${count} items`,
    // The checkout row's sub-line: the item's own description (its quantity is
    // in the name), or what a mixed bag holds.
    desc: single ? first.product.desc : resolved.map(label).join(', '),
    amount,
    currency,
    aft,
    // A mixed basket has no single product's success copy — the pack's applies.
    successNote: single ? first.product.successNote : undefined,
    fundedNote: single ? first.product.fundedNote : undefined,
    lines: resolved.map((l) => ({
      id: l.product.id, name: l.product.name, qty: l.qty,
      amount: lineTotal(l.product, l.qty), currency: l.product.currency, billing: l.product.billing,
    })),
  };
}
