/* ─────────────────────────────────────────────────────────────
   Tiny reactive store. setState(patch) merges + notifies subscribers.
   ───────────────────────────────────────────────────────────── */

const listeners = new Set();

export const state = {
  env:      'sandbox',      // 'sandbox' | 'live'
  vertical: 'ecommerce',    // key into VERTICALS
  model:    'own-fields',   // 'own-fields' | 'toolkit'
  leftView: 'client',       // 'client' | 'backoffice' — which left-pane tab is active

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
  productOverride: null,    // { vertical, amount, currency } | null
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
