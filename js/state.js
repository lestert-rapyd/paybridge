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
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state, patch);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
