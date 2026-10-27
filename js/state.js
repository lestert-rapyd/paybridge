/* ─────────────────────────────────────────────────────────────
   Tiny reactive store. setState(patch) merges + notifies subscribers.
   ───────────────────────────────────────────────────────────── */

const listeners = new Set();

export const state = {
  env:      'sandbox',      // 'sandbox' | 'live'
  vertical: 'ecommerce',    // key into VERTICALS
  model:    'own-fields',   // 'own-fields' | 'toolkit'
  leftView: 'client',       // 'client' | 'backoffice' — which left-pane tab is active

  // Sandbox key profile (SC1|SC2|SC3 — see js/profiles.js). Mutated DIRECTLY
  // (like fx below) so switching MIDs never resets an in-flight client flow;
  // app.js repaints the affected surfaces explicitly.
  profile: 'SC1',

  // Client-site product selector: { vertical, productId } | null. Mutated
  // DIRECTLY; falls back to the vertical's first product when it doesn't match
  // the active vertical (same guard pattern as productOverride).
  selectedProduct: null,

  // The shopper's bag: { vertical, lines: [{ productId, qty }] } | null — see
  // js/site/cart.js. Mutated DIRECTLY; a bag captured for another vertical reads
  // as empty (same guard pattern as productOverride). A valid bag is what
  // verticals.js activeProduct() charges.
  cart: null,

  // Which page of the merchant site is on screen — see js/steps.js. The customer
  // beat is separated in TIME, not just in space: one page per call, so the
  // engine room only ever shows the call the current page is about. Mutated
  // DIRECTLY (never a RESET_KEY): a step change must not reset the flow, and the
  // pages repaint themselves explicitly.
  // 'account-q' (sign in / register / guest) | 'account' (register) | 'shop' |
  // 'product' (detail) | 'bag' | 'checkout' | 'orders' | 'methods'
  step: 'account-q',

  // How the customer identifies at checkout: 'guest' | 'account' | 'returning'
  // (see js/identity.js). Mutated DIRECTLY — picking a mode repaints the client
  // page explicitly rather than resetting the flow. Read through
  // identity.js's identityMode(), which degrades a stale choice.
  identityMode: 'guest',

  // populated by later phases:
  reference:  null,         // merchant_reference_id of the active session
  paymentId:  null,         // payment_xxx once created
  request:    null,         // last outbound API request (for the right panel)
  response:   null,         // last API response
  webhooks:   [],           // received webhook events
  ledger:     [],           // session payment ledger (owned/mutated by ledger.js)

  // Own-fields checkout tile + FX popover — mutated directly (not via
  // setState) by app.js/own-fields.js, deliberately outside the reactive
  // pipeline so a keystroke never triggers a full flow reset. Read by
  // verticals.js's activeProduct() and own-fields.js's displayBody().
  productOverride: null,    // { vertical, productId, amount, currency } | null — amount always passes validAmount
  // True while the tile's TYPED amount fails sync.js validAmount (blank,
  // "149.999", "0"). app.js never stores such an amount — productOverride keeps
  // the last valid one, so no request body can carry it — and this flag tells
  // the flows to keep Pay disabled until the tile is fixed. Mutated directly;
  // reset whenever the checkout re-renders the tile.
  amountInvalid: false,
  // `quote` caches the latest live Rapyd fx_rates result so every customer-facing
  // surface (checkout totals, pay button, success screen, bank statement) shows
  // the SAME converted figure — see verticals.js customerCharge()/merchantReceive().
  fx: { enabled: false, requestedCurrency: null, fixedSide: 'sell', quote: null },
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state, patch);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
