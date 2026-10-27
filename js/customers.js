/* ─────────────────────────────────────────────────────────────
   Session customer + stored-credential store — the card-on-file /
   recurring flows' source of truth, mirroring ledger.js's patterns
   (module store + subscribe/notify, session-scoped, in-memory).

   Buckets are keyed by `${env}:${profile}` — a cus_/card_ minted
   under one sandbox MID does not exist under another.

   Remembered customers: a SANDBOX bucket's customer survives a reload —
   the cus_***, the shopper's name/email and the TOKEN credentials'
   metadata (card_***, brand, last4, expiry, network_reference_id,
   intent) are written to localStorage, one entry per bucket. Never a
   card number or CVV: merchant-vault credentials hold the PAN, so they
   stay memory-only and are not remembered at all. Live buckets are never
   written. Storage failures (private mode, quota, blocked) are swallowed
   — the demo then simply forgets on reload, as it always did. A
   restored bucket is flagged so app.js re-syncs its cards with the list
   call the first time it's used (needsResync / markResynced).

   Two credential kinds (single-intent each — a card authorised
   `unscheduled` is never charged `recurring`, and vice versa):
     · 'vault'  — PCI merchant stores the PAN itself; NO Rapyd object.
                  Reuse via cvv re-entry or network_reference_id.
     · 'token'  — Rapyd card_*** under the session cus_***.
   Both card_*** and network_reference_id are harvested from the
   PAYMENT_COMPLETED webhook (never PAYMENT_SUCCEEDED); the INITIAL
   network_reference_id wins forever (setNetworkReferenceId enforces).

   Async writers (the webhook harvest, the list backfill, the customer
   beat's POST) capture bucketKey() when their request STARTS and pass it
   back as { key } — the SE may switch sandbox profile while a 3DS
   challenge is open, and the cus_/card_ must land under the MID that
   minted it, not whichever one is selected when the response arrives.
   ───────────────────────────────────────────────────────────── */

import { listCustomerPaymentMethods } from './api.js';
import { brandLabel } from './sync.js';
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

const DEFAULT_IDENTITY = JSON.parse(JSON.stringify(IDENTITY));

/** Back to the demo's own dummy shopper — after the SE forgets a customer
    whose name/email the site had taken on (sign-in with a customer ID). */
export function resetIdentity() {
  Object.assign(IDENTITY, JSON.parse(JSON.stringify(DEFAULT_IDENTITY)));
  notify();
}

const key = () => `${state.env}:${state.profile}`;

/** The current bucket's key, `${env}:${profile}` — capture it before an
    async call and hand it back to a mutator as { key }. */
export function bucketKey() { return key(); }

// Mutators take an optional trailing { key }; anything else (including an
// Event, should one be wired straight to a listener) means "current bucket".
// A KeyboardEvent's .key is a string too — hence the ':' shape check.
const keyFrom = (opts) => (typeof opts?.key === 'string' && opts.key.includes(':') ? opts.key : key());

function bucket(k = key()) {
  if (!buckets.has(k)) buckets.set(k, { customer_id: null, credentials: [] });
  return buckets.get(k);
}

// A throwing subscriber must not abort the mutation's caller (refreshTokens
// in particular is fired without a catch) or starve the other subscribers.
function notify() {
  persist();
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('customers listener failed:', err); }
  }
}

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
export function setCustomerId(id, opts) {
  if (!id) return;
  const k = keyFrom(opts);
  forgotten.delete(k);
  const b = bucket(k);
  b.customer_id = id;
  b.identity = { name: IDENTITY.name, email: IDENTITY.email }; // who it was created for
  notify();
}

/** Adopt an EXISTING customer (sign-in with a customer ID): file `id` in the
    bucket, dropping the previous customer's cards when it's a different
    customer (they belong to someone else), and take the shopper's name/email
    from the retrieved customer object when it carries them. */
export function adoptCustomer(id, { name, email } = {}, opts) {
  if (!id) return;
  const k = keyFrom(opts);
  forgotten.delete(k);
  const b = bucket(k);
  if (b.customer_id !== id) b.credentials = [];
  b.customer_id = id;
  if (typeof name === 'string' && name.trim()) setIdentityQuiet('name', name.trim());
  if (typeof email === 'string' && email.trim()) setIdentityQuiet('email', email.trim());
  b.identity = { name: IDENTITY.name, email: IDENTITY.email };
  notify();
}
function setIdentityQuiet(path, value) {
  if (path === 'name') { IDENTITY.name = value; IDENTITY.address.name = twoWordName(value); }
  else IDENTITY[path] = value;
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
export function addVaultCredential(c, opts) {
  const ref = `cred_${++credSeq}`;
  bucket(keyFrom(opts)).credentials.push({ ref, kind: 'vault', network_reference_id: null, aft: false, ...c, created_at: Date.now() });
  notify();
  return ref;
}

/** Rapyd token credential — deduped by card_id; later sightings only fill
    fields we don't have yet (e.g. expiry arriving via the list endpoint). */
export function upsertTokenCredential(c, opts) {
  const b = bucket(keyFrom(opts));
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
export function setNetworkReferenceId(ref, nri, opts) {
  const cred = bucket(keyFrom(opts)).credentials.find((c) => c.ref === ref);
  if (!cred || !nri || cred.network_reference_id) return;
  cred.network_reference_id = String(nri);
  notify();
}

/** Demo-side forget — the sandbox cus_*** keeps existing on Rapyd's side
    (worth narrating); the demo simply stops referencing it. */
export function forgetCustomer(opts) {
  const k = keyFrom(opts);
  buckets.delete(k);
  forgotten.add(k);
  resync.delete(k);
  notify(); // persist() drops the remembered entry with the bucket
}

/* ── Remembered customers (localStorage, sandbox only) ─────── */
const STORE_KEY = 'rapyd-demo:customers:v1';

/** Only sandbox buckets are ever remembered — a live cus_*** is real data. */
export const persistable = (k) => typeof k === 'string' && k.startsWith('sandbox:');

/* The token-credential fields that may be written. An allowlist, not a
   denylist: whatever a credential grows later stays memory-only until it's
   deliberately added here. No number, no cvv, no name-on-card. */
const SAFE_CRED_FIELDS = [
  'card_id', 'type', 'brand', 'last4', 'expiration_month', 'expiration_year',
  'network_reference_id', 'recurrence_type', 'aft',
  'origin_vertical', 'origin_model', 'origin_product', 'created_at',
];

/** A bucket as a storable plain object, or null when there's nothing to
    remember. Pure — exported for tests/unit.js. Vault credentials are dropped
    whole (their reuse needs the PAN, which never leaves memory). */
export function serializeBucket(b, identity = b?.identity || IDENTITY) {
  if (!b?.customer_id) return null;
  const credentials = (b.credentials || [])
    .filter((c) => c && c.kind === 'token' && typeof c.card_id === 'string')
    .map((c) => Object.fromEntries(SAFE_CRED_FIELDS.filter((f) => c[f] != null).map((f) => [f, c[f]])));
  return {
    customer_id: String(b.customer_id),
    identity: { name: String(identity?.name || ''), email: String(identity?.email || '') },
    credentials,
  };
}

/** The inverse, validating as it goes — storage is user-editable, so nothing
    is trusted: a malformed entry restores as null, a malformed card is
    skipped, unknown fields are ignored. Pure — exported for tests. */
export function restoreBucket(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const id = saved.customer_id;
  if (typeof id !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(id)) return null;
  const credentials = (Array.isArray(saved.credentials) ? saved.credentials : [])
    .filter((c) => c && typeof c.card_id === 'string' && /^card_[A-Za-z0-9]+$/.test(c.card_id))
    .map((c) => ({
      ...Object.fromEntries(SAFE_CRED_FIELDS.filter((f) => c[f] != null).map((f) => [f, c[f]])),
      kind: 'token',
      recurrence_type: c.recurrence_type === 'recurring' ? 'recurring' : 'unscheduled',
      aft: !!c.aft,
    }));
  const name = typeof saved.identity?.name === 'string' ? saved.identity.name : '';
  const email = typeof saved.identity?.email === 'string' ? saved.identity.email : '';
  return { customer_id: id, credentials, identity: { name, email } };
}

/* localStorage, guarded: any access can throw (blocked storage, private mode). */
let storage = (() => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
})();
/** Swap the storage backend (tests pass an in-memory stand-in; null disables). */
export function setCustomerStorage(s) { storage = s || null; }

function readStore() {
  try {
    const raw = storage?.getItem(STORE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

/* Write every remembered bucket. Called from notify(), so the store follows
   each mutation. Restored-but-untouched entries for buckets this tab never
   loaded are left alone; live keys are never written. */
function persist() {
  if (!storage) return;
  try {
    const out = {};
    const prev = readStore();
    for (const [k, v] of Object.entries(prev)) if (persistable(k) && !buckets.has(k) && !forgotten.has(k)) out[k] = v;
    for (const [k, b] of buckets) {
      if (!persistable(k)) continue;
      const ser = serializeBucket(b);
      if (ser) out[k] = ser;
    }
    if (Object.keys(out).length) storage.setItem(STORE_KEY, JSON.stringify(out));
    else storage.removeItem(STORE_KEY);
  } catch { /* quota / blocked — remembered state is a convenience */ }
}

/* Buckets restored from storage that haven't been re-synced with Rapyd yet. */
const resync = new Set();
/* Buckets forgotten this session — a stale stored copy must not come back. */
const forgotten = new Set();

/** Load remembered sandbox buckets. Runs once at import; the identity follows
    the bucket that's active at load (the shopper the SE left signed in). */
export function restoreRemembered() {
  const saved = readStore();
  for (const [k, v] of Object.entries(saved)) {
    if (!persistable(k) || buckets.has(k)) continue;
    const r = restoreBucket(v);
    if (!r) continue;
    buckets.set(k, {
      customer_id: r.customer_id,
      credentials: r.credentials.map((c) => ({ ref: `cred_${++credSeq}`, network_reference_id: null, ...c })),
      identity: r.identity,
    });
    resync.add(k);
  }
  useBucketIdentity();
}

/** Make the demo identity the active bucket's customer's — called at load and
    after an env/profile switch, so the site greets whoever that MID's
    customer is. A bucket without a customer leaves the identity alone (the
    account form may be mid-edit). */
export function useBucketIdentity() {
  const b = buckets.get(key());
  if (!b?.customer_id || !b.identity) return;
  if (b.identity.name) setIdentityQuiet('name', b.identity.name);
  if (b.identity.email) setIdentityQuiet('email', b.identity.email);
}

/** Whether the ACTIVE bucket came from storage and still needs its cards
    re-read from Rapyd (they may have been deleted, or new ones added). */
export function needsResync() { return resync.has(key()); }
export function markResynced(opts) { resync.delete(keyFrom(opts)); }
/** Whether the active bucket's customer is remembered across reloads. */
export function isRemembered() { return persistable(key()) && !!bucket().customer_id && !!storage; }


/* ── live sync (GET /v1/customers/{id}/payment_methods) ──────
   Silent backfill after a save completes, and the back office's
   "Sync from Rapyd" action (which also paints the raw response).
   Returns the api.js wrapper result so callers can render it, and
   NEVER rejects — callers fire it without awaiting (or await it without a
   try), so a failure must come back as a value, not an unhandled rejection.
   `{ key }` targets a captured bucket (see the header). */
export async function refreshTokens(opts) {
  const k = keyFrom(opts);
  const b = bucket(k); // captured — a later env/profile switch can't misroute the merge
  if (!b.customer_id) return { ok: false, httpStatus: 0, data: null };
  // Sign with the bucket's own MID — the only one that can see its cus_***.
  const sep = k.indexOf(':');
  const env = k.slice(0, sep), profile = k.slice(sep + 1);
  let resp;
  try {
    resp = await listCustomerPaymentMethods(b.customer_id, { env, profile });
  } catch (err) {
    return { ok: false, httpStatus: 0, data: { error: 'NETWORK_ERROR', message: err?.message || 'request failed' } };
  }
  const cards = resp?.data?.data;
  if (resp?.ok && Array.isArray(cards)) {
    for (const d of cards) {
      if (!d?.id || !/^card_/.test(d.id)) continue;
      const existing = b.credentials.find((x) => x.kind === 'token' && x.card_id === d.id);
      if (existing) {
        if (existing.last4 == null && d.last4) existing.last4 = d.last4;
        if (existing.expiration_month == null && d.expiration_month) existing.expiration_month = d.expiration_month;
        if (existing.expiration_year == null && d.expiration_year) existing.expiration_year = d.expiration_year;
        if (!existing.type && d.type) { existing.type = d.type; existing.brand = existing.brand || brandLabel(d.type); }
        if (!existing.network_reference_id && d.network_reference_id) existing.network_reference_id = String(d.network_reference_id);
      } else {
        // Discovered outside this session — intent unknown; Rapyd's default
        // recurrence is unscheduled, so list it as customer-present reuse.
        b.credentials.push({
          ref: `cred_${++credSeq}`, kind: 'token', card_id: d.id,
          type: d.type || null, brand: brandLabel(d.type), last4: d.last4 || null,
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

restoreRemembered();
