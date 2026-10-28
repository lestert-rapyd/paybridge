/* ─────────────────────────────────────────────────────────────
   "Sign in with a customer ID" — the SE's way back to a customer
   that already exists at Rapyd (one made in an earlier session, on
   another machine, or in the Rapyd dashboard).

   The sign-in page takes a cus_***; this fires the real
   GET /v1/customers/{id} (api.js retrieveCustomer) under the active
   env + MID and shows it in the engine room like any other beat. On
   success the customer becomes the session customer for that bucket
   (customers.adoptCustomer — its name/email greet the shopper) and its
   saved cards load through the list call (site/account.js
   fireMethodsSync). On failure the page says so in shopper words and
   the Response tab carries Rapyd's real error.

   Markup-free apart from the two engine-room cards; js/steps.js owns
   the sign-in page and wires the button.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import * as customers from '../customers.js';
import { retrieveCustomer } from '../api.js';
import { beatCardHTML } from '../customer-beat.js';
import { renderJSONView } from '../json-view.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import { setActiveTab, setStatus, esc } from '../ui.js';

/** A Rapyd customer id, as typed. Checked before any call goes out. */
export const CUS_ID = /^cus_[A-Za-z0-9]{6,64}$/;

let rec = { status: 'idle', key: null, cus: null, httpStatus: null, data: null, salt: null };
let seq = 0;

const path = (cus) => `/v1/customers/${cus}`;

/** The lookup's state for the sign-in page: 'idle' | 'sending' | 'done'. */
export const lookupStatus = () => (rec.key === customers.bucketKey() ? rec.status : 'idle');

/** Look `id` up and, when Rapyd knows it, adopt it. Resolves to null on
    success or the shopper-facing reason it didn't work. Never rejects.
    `onUpdate` repaints (the router's job). */
export async function signInWithCustomerId(raw, onUpdate = () => {}) {
  const id = String(raw || '').trim();
  if (!CUS_ID.test(id)) return 'That doesn’t look like a customer ID — it starts with cus_.';
  const mySeq = ++seq;
  // Captured at send time: the customer must land under the MID that found it.
  const key = customers.bucketKey();
  const env = state.env, profile = state.profile;
  rec = { status: 'sending', key, cus: id, httpStatus: null, data: null, salt: newSaltTimestamp() };
  setStatus('Retrieving customer…', 'processing');
  setActiveTab('request');
  onUpdate();

  let httpStatus = 0, data = null;
  try {
    ({ httpStatus, data } = await retrieveCustomer(id, env, profile));
  } catch (err) {
    data = { error: 'NETWORK_ERROR', message: err?.message || 'request failed' };
  }
  if (mySeq !== seq) return null; // superseded by a newer attempt
  rec = { ...rec, status: 'done', httpStatus, data };
  const cus = data?.data;
  const ok = httpStatus >= 200 && httpStatus < 400 && !data?.error && cus?.id === id;
  setStatus(ok ? 'Customer retrieved' : 'Error', ok ? 'ok' : 'error');
  setActiveTab('response');
  if (!ok) { onUpdate(); return 'We couldn’t find that customer. Check the ID and try again.'; }
  customers.adoptCustomer(id, { name: cus.name, email: cus.email }, { key });
  onUpdate();
  return null;
}

/** The request card, or '' when no lookup ran for the active bucket. */
export function lookupRequestCardHTML() {
  if (rec.status === 'idle' || rec.key !== customers.bucketKey()) return '';
  const ok = rec.status === 'done' && rec.httpStatus >= 200 && rec.httpStatus < 400 && !rec.data?.error;
  return beatCardHTML({
    id: 'beat-cus-lookup', method: 'GET', path: path(rec.cus), // text — beatCardHTML escapes
    badge: rec.status === 'sending' ? 'sending…' : ok ? 'signed & sent' : 'failed',
    badgeKind: rec.status === 'sending' ? 'live' : ok ? 'ok' : 'err',
    inner: `
      ${headersHTML(rec.salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">a GET carries none · sign in with a customer ID</span></div>`,
  });
}

/** Sign the painted card (same salt it was drawn with). */
export function fillLookupSignature() {
  const card = document.getElementById('beat-cus-lookup');
  if (card && rec.salt) fillSignature(card, 'get', path(rec.cus), rec.salt, null, 'beat-cus-lookup');
}

/** The response card, or '' until the lookup has answered. */
export function lookupResponseCardHTML() {
  if (rec.key !== customers.bucketKey()) return '';
  if (rec.status === 'sending') {
    return beatCardHTML({
      id: 'beat-cus-lookup-res', method: 'GET', path: path(rec.cus), badge: 'sending…', badgeKind: 'live',
      inner: `<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>`,
    });
  }
  if (rec.status !== 'done') return '';
  const ok = rec.httpStatus >= 200 && rec.httpStatus < 400 && !rec.data?.error;
  const code = rec.httpStatus ? `HTTP ${esc(rec.httpStatus)}` : 'NO RESPONSE';
  return beatCardHTML({
    id: 'beat-cus-lookup-res', method: 'GET', path: path(rec.cus),
    badge: ok ? 'customer' : String(rec.data?.error || 'failed'), badgeKind: ok ? 'ok' : 'err',
    inner: `
      <div class="eng-pillrow"><span class="wh-pill ${ok ? 'success' : 'failure'}">${code}</span></div>
      ${renderJSONView(rec.data ?? { error: 'no response body' })}`,
  });
}
