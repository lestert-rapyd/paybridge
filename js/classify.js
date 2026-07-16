/* ─────────────────────────────────────────────────────────────
   Shared webhook-event classification. Used by both the customer-
   facing singleton watcher (webhooks.js) and the back-office ledger
   poller (ledger.js) — extracted so the PAYMENT_COMPLETED-not-
   PAYMENT_SUCCEEDED rule can't drift between the two.
   ───────────────────────────────────────────────────────────── */

export function classify(e) {
  const type = (e.type || '').toUpperCase();
  // Best practice: only the terminal webhook confirms an outcome.
  // PAYMENT_COMPLETED / REFUND_COMPLETED (or a capture) = terminal success.
  if (/COMPLETED|CAPTURE/.test(type)) return 'success';
  // PAYMENT_FAILED / declined / expired / cancelled = terminal failure.
  if (/FAILED|DECLINED|EXPIRED|CANCEL/.test(type)) return 'failure';
  // PAYMENT_SUCCEEDED (even CLO+paid) and status ACT are intermediate — wait
  // for the terminal event; never confirm off PAYMENT_SUCCEEDED.
  return 'pending';
}
