/* ─────────────────────────────────────────────────────────────
   Backend fetch wrappers. The backend signs each request with the
   Rapyd secret key (server-side) and proxies to the real Rapyd API.
   ───────────────────────────────────────────────────────────── */

export const BACKEND_URL = 'https://rapyd-backend.vercel.app';

/** POST /api/create-direct-payment → Rapyd POST /v1/payments (own-fields flow) */
export async function createDirectPayment(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-direct-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** POST /api/create-checkout-session → Rapyd POST /v1/checkout (toolkit flow, Phase 3) */
export async function createCheckoutSession(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** POST /api/create-refund → Rapyd POST /v1/refunds (back office) */
export async function createRefund(body) {
  const res = await fetch(`${BACKEND_URL}/api/create-refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, httpStatus: res.status, data };
}

/** GET /api/webhooks?refs=ref1,ref2,... → batched status for the back-office ledger poller */
export async function fetchWebhooksBatch(refs) {
  const qs = encodeURIComponent(refs.join(','));
  const res = await fetch(`${BACKEND_URL}/api/webhooks?refs=${qs}`);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return data || { byRef: {}, configured: false };
}
