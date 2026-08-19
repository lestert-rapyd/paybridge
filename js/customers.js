/* ─────────────────────────────────────────────────────────────
   Session customer + stored-credential store — the card-on-file /
   recurring flows' source of truth, mirroring ledger.js's patterns
   (module store + subscribe/notify, session-scoped, in-memory).

   Buckets are keyed by `${env}:${profile}` — a cus_/card_ minted
   under one sandbox MID does not exist under another.

   Two credential kinds (single-intent each — a card authorised
   `unscheduled` is never charged `recurring`, and vice versa):
     · 'vault'  — PCI merchant stores the PAN itself; NO Rapyd object.
                  Reuse via cvv re-entry or network_reference_id.
     · 'token'  — Rapyd card_*** under the session cus_***.
   Both card_*** and network_reference_id are harvested from the
   PAYMENT_COMPLETED webhook (never PAYMENT_SUCCEEDED); the INITIAL
   network_reference_id wins forever (setNetworkReferenceId enforces).
   ───────────────────────────────────────────────────────────── */

import { listCustomerPaymentMethods } from './api.js';
import { state } from './state.js';

const buckets = new Map(); // `${env}:${profile}` -> { customer_id, credentials }
const listeners = new Set();
let credSeq = 0;

/* One demo identity, ALWAYS enriched (KYC-grade) so the same cus_*** is
   AFT-ready without a second customer — see PLAN §1.5. Dummy values; name and
   email are editable from the account step until the cus_*** exists (there is
   no update-customer call, so after that they're frozen). */
const IDENTITY = {
  name: 'Jordan Taylor',
  email: 'jordan.taylor@example.com',
  date_of_birth: '09/12/1990',   // DD/MM/YYYY
  birth_country: 'GB',           // ISO 3166-1 alpha-2
  nationality: 'GB',
  occupation: 'Software Engineer',
  address: { name: 'Jordan Taylor', line_1: '10 Downing Street', city: 'London', country: 'GB', zip: 'SW1A 2AA', state: '' },
};

const key = () => `${state.env}:${state.profile}`;
function bucket() {
  if (!buckets.has(key())) buckets.set(key(), { customer_id: null, credentials: [] });
  return buckets.get(key());
}
function notify() { for (const fn of listeners) fn(); }

export function subscribeCustomers(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── identity / customer object ──────────────────────────── */
export function getIdentity() { return IDENTITY; }

/** Edit the demo identity from the account form. Every field of the customer
    body is writable now that the form presents them all in body order — the
    account frame is the one place the customer object is authored, so a field
    the SE can see should be a field the SE can change. Notifies so the
    card-name inheritance and the back office follow. */
export function setIdentity({ name, email }) {
  if (typeof name === 'string') setIdentityField('name', name);
  if (typeof email === 'string') setIdentityField('email', email);
}

/** Writable paths, mirroring enrichedCustomerBody()'s own shape. `address.*`
    writes into the single address the body carries as addresses[0]. */
const WRITABLE = new Set([
  'name', 'email', 'date_of_birth', 'birth_country', 'nationality', 'occupation',
  'address.line_1', 'address.city', 'address.country', 'address.zip',
]);

export function setIdentityField(path, value) {
  if (!WRITABLE.has(path) || typeof value !== 'string') return;
  if (path === 'name') {
    IDENTITY.name = value;
    IDENTITY.address.name = twoWordName(value); // the address name must not drift
  } else if (path.startsWith('address.')) {
    IDENTITY.address[path.slice('address.'.length)] = value;
  } else {
    IDENTITY[path] = value;
  }
  notify();
}

/** Read one back, for the form's value attributes. */
export function getIdentityField(path) {
  return path.startsWith('address.') ? IDENTITY.address[path.slice('address.'.length)] : IDENTITY[path];
}

/** AFT rule: the customer name must be at least two words — a single-word
    name is repeated ("Cher" → "Cher Cher"). */
export function twoWordName(n) {
  const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return `${IDENTITY.name}`;
  return parts.length >= 2 ? parts.join(' ') : `${parts[0]} ${parts[0]}`;
}

/** The dummy billing address sent as the payment-level `address` (3DS
    optimisation on customer-present calls). */
export function demoAddress() {
  return { ...IDENTITY.address };
}

/** POST /v1/customers body — always the enriched shape (PLAN §1.5). */
export function enrichedCustomerBody() {
  return {
    name: twoWordName(IDENTITY.name),
    email: IDENTITY.email,
    date_of_birth: IDENTITY.date_of_birth,
    birth_country: IDENTITY.birth_country,
    nationality: IDENTITY.nationality,
    occupation: IDENTITY.occupation,
    addresses: [{ ...IDENTITY.address }],
  };
}

export function getCustomerId() { return bucket().customer_id; }
export function setCustomerId(id) {
  if (!id) return;
  bucket().customer_id = id;
  notify();
}

/* ── credentials ─────────────────────────────────────────── */
export function credentials() { return [...bucket().credentials]; }
export function credentialsFor(recurrenceType) {
  return bucket().credentials.filter((c) => c.recurrence_type === recurrenceType);
}
export function hasCredentials() { return bucket().credentials.length > 0; }
export function getCredential(ref) { return bucket().credentials.find((c) => c.ref === ref) || null; }

/** PCI vault credential — merchant-stored PAN, no Rapyd object.
    c: { type, number, expiration_month, expiration_year, name, brand, last4,
         recurrence_type, aft, origin_vertical, origin_model, origin_product } */
export function addVaultCredential(c) {
  const ref = `cred_${++credSeq}`;
  bucket().credentials.push({ ref, kind: 'vault', network_reference_id: null, aft: false, ...c, created_at: Date.now() });
  notify();
  return ref;
}

/** Rapyd token credential — deduped by card_id; later sightings only fill
    fields we don't have yet (e.g. expiry arriving via the list endpoint). */
export function upsertTokenCredential(c) {
  const b = bucket();
  const existing = c.card_id && b.credentials.find((x) => x.kind === 'token' && x.card_id === c.card_id);
  if (existing) {
    for (const [k, v] of Object.entries(c)) {
      if (v != null && (existing[k] == null || existing[k] === '')) existing[k] = v;
    }
    notify();
    return existing.ref;
  }
  const ref = `cred_${++credSeq}`;
  b.credentials.push({ ref, kind: 'token', network_reference_id: null, aft: false, ...c, created_at: Date.now() });
  notify();
  return ref;
}

/** FIRST non-null network_reference_id wins, forever — later payments return
    different NRIDs which must never overwrite the initial one (PLAN §1.4). */
export function setNetworkReferenceId(ref, nri) {
  const cred = bucket().credentials.find((c) => c.ref === ref);
  if (!cred || !nri || cred.network_reference_id) return;
  cred.network_reference_id = String(nri);
  notify();
}

/** Demo-side forget — the sandbox cus_*** keeps existing on Rapyd's side
    (worth narrating); the demo simply stops referencing it. */
export function forgetCustomer() {
  buckets.delete(key());
  notify();
}

/* ── live sync (GET /v1/customers/{id}/payment_methods) ──────
   Silent backfill after a save completes, and the back office's
   "Sync from Rapyd" action (which also paints the raw response).
   Returns the api.js wrapper result so callers can render it. */
const brandOf = (type) =>
  /visa/i.test(type || '') ? 'Visa' : /master/i.test(type || '') ? 'Mastercard' : /amex|express/i.test(type || '') ? 'Amex' : 'Card';

export async function refreshTokens() {
  const b = bucket(); // captured — a later env/profile switch can't misroute the merge
  if (!b.customer_id) return { ok: false, httpStatus: 0, data: null };
  const resp = await listCustomerPaymentMethods(b.customer_id, { env: state.env, profile: state.profile });
  const cards = resp?.data?.data;
  if (resp.ok && Array.isArray(cards)) {
    for (const d of cards) {
      if (!d?.id || !/^card_/.test(d.id)) continue;
      const existing = b.credentials.find((x) => x.kind === 'token' && x.card_id === d.id);
      if (existing) {
        if (existing.last4 == null && d.last4) existing.last4 = d.last4;
        if (existing.expiration_month == null && d.expiration_month) existing.expiration_month = d.expiration_month;
        if (existing.expiration_year == null && d.expiration_year) existing.expiration_year = d.expiration_year;
        if (!existing.type && d.type) { existing.type = d.type; existing.brand = existing.brand || brandOf(d.type); }
        if (!existing.network_reference_id && d.network_reference_id) existing.network_reference_id = String(d.network_reference_id);
      } else {
        // Discovered outside this session — intent unknown; Rapyd's default
        // recurrence is unscheduled, so list it as customer-present reuse.
        b.credentials.push({
          ref: `cred_${++credSeq}`, kind: 'token', card_id: d.id,
          type: d.type || null, brand: brandOf(d.type), last4: d.last4 || null,
          expiration_month: d.expiration_month || null, expiration_year: d.expiration_year || null,
          network_reference_id: d.network_reference_id ? String(d.network_reference_id) : null,
          recurrence_type: 'unscheduled', aft: false,
          origin_vertical: null, origin_model: null, origin_product: null,
          created_at: Date.now(),
        });
      }
    }
    notify();
  }
  return resp;
}
