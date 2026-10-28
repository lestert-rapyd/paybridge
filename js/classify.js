/* ─────────────────────────────────────────────────────────────
   Shared webhook-event classification. Used by both the customer-
   facing singleton watcher (webhooks.js) and the back-office ledger
   poller (ledger.js) — extracted so the PAYMENT_COMPLETED-not-
   PAYMENT_SUCCEEDED rule, and the trust rule below, can't drift
   between the two.
   ───────────────────────────────────────────────────────────── */

export function classify(e) {
  const type = (e?.type || '').toUpperCase();
  // Best practice: only the terminal webhook confirms an outcome.
  // PAYMENT_COMPLETED / REFUND_COMPLETED (or a capture) = terminal success.
  if (/COMPLETED|CAPTURE/.test(type)) return 'success';
  // PAYMENT_FAILED / declined / expired / cancelled = terminal failure.
  if (/FAILED|DECLINED|EXPIRED|CANCEL/.test(type)) return 'failure';
  // PAYMENT_SUCCEEDED (even CLO+paid) and status ACT are intermediate — wait
  // for the terminal event; never confirm off PAYMENT_SUCCEEDED.
  return 'pending';
}

/** May this event DRIVE state (success screen, wallet credit, credential
    harvest)? /api/webhook is a public URL, so anyone can POST a
    PAYMENT_COMPLETED to it; only an event whose Rapyd signature the
    receiver verified server-side, or one we built from our own signed
    Retrieve Payment call, is trusted. Anything else is displayed but
    confirmed via Retrieve Payment before it counts. */
export function isTrusted(e) {
  return e?.verified === 'verified' || e?.source === 'retrieve';
}

/** isTrusted() narrowed to ONE payment. A signature only proves that SOME
    configured MID sent the event — and the sandbox proxy lets anyone create
    a payment carrying any merchant_reference_id, which Rapyd then signs a
    PAYMENT_COMPLETED for. So a verified webhook drives state only when
      · the environment whose key pair signed it (receiver's verified_env)
        is the payment's `env` — a sandbox event never settles a live one;
      · once the payment id is known, it is about THAT payment.
    Anything else is a claim: it earns a Retrieve Payment, never a settlement.
    A retrieve-derived event is ours (fetched by id with the payment's own
    env + MID), so it always counts. */
export function isTrustedFor(e, { env, paymentId } = {}) {
  if (e?.source === 'retrieve') return true;
  if (e?.verified !== 'verified') return false;
  if (env && e.verified_env !== env) return false;
  if (paymentId && e.payment_id !== paymentId) return false;
  return true;
}
