/* ─────────────────────────────────────────────────────────────
   Demo request signing — faithfully mirrors Rapyd's scheme with
   DISPLAY-ONLY keys (the real signature is computed server-side
   with the real secret; these keys never touch the API):

     to_sign   = method + path + salt + timestamp
                 + access_key + secret_key + body(no whitespace)
     signature = urlsafe_base64( hex_digest( HMAC-SHA256 ) )

   Exists so the engine room shows a LIVE signature that visibly
   re-computes as the request body changes.
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';
import { activeProfile } from './profiles.js';

const HEXC = '0123456789abcdef';
function randHex(n) { let s = ''; for (let i = 0; i < n; i++) s += HEXC[Math.floor(Math.random() * 16)]; return s; }

// One display identity per env/profile, so the header visibly changes when
// the Sandbox/Live switch OR the SC1/SC2/SC3 profile flips. Sandbox shows the
// profile's REAL access key (public identifier, redacted below) — the secret
// is always a random demo value; the real signature is computed server-side.
const DEMO_LIVE_ACCESS = 'rak_' + randHex(20).toUpperCase();
const DEMO_SECRETS = {}; // identity -> random rsk_
const identity = () => (state.env === 'live' ? 'live' : `sandbox:${state.profile}`);

const accessKey = () => (state.env === 'live' ? DEMO_LIVE_ACCESS : activeProfile().access_key);
const secretKey = () => (DEMO_SECRETS[identity()] ||= 'rsk_' + randHex(40));

// "rak_A1B***X9Z" — first 3 / last 3 chars of the key body, prefix kept in full.
export function redactKey(key) {
  const m = /^([a-z]+_)(.+)$/i.exec(key);
  if (!m) return key;
  const [, prefix, body] = m;
  if (body.length <= 6) return key;
  return `${prefix}${body.slice(0, 3)}***${body.slice(-3)}`;
}

const enc = (s) => new TextEncoder().encode(s);
const keyPromises = {};
function hmacKey() {
  const id = identity();
  keyPromises[id] ||= crypto.subtle.importKey('raw', enc(secretKey()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return keyPromises[id];
}

export function newSaltTimestamp() {
  return { salt: randHex(12), timestamp: Math.floor(Date.now() / 1000).toString() };
}

export async function signDemo(method, path, salt, timestamp, body) {
  const bodyStr = body ? JSON.stringify(body) : ''; // no whitespace — as signed on the wire
  const toSign = method.toLowerCase() + path + salt + timestamp + accessKey() + secretKey() + bodyStr;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc(toSign));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(hex).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Shared header block — identical fields for every flow. */
export function headersHTML(st) {
  return `
    <p class="eng-label">Headers</p>
    <div class="req-headers">
      <span class="hk">access_key</span><span class="hv">${redactKey(accessKey())}</span>
      <span class="hk">salt</span><span class="hv">${st.salt}</span>
      <span class="hk">timestamp</span><span class="hv">${st.timestamp}</span>
      <span class="hk">signature</span><span class="hv hv-sig">calculating…</span>
      <span class="hk">Content-Type</span><span class="hv">application/json</span>
    </div>`;
}

/** Compute + patch the signature into the freshly rendered panel.
    Sequenced so rapid re-renders can't write a stale signature.

    `root` is scoped, not necessarily the whole panel: one panel can hold
    several stacked beat cards (POST /v1/customers above POST /v1/payments),
    each with its own .hv-sig — so pass the CARD element, not the panel, or
    both fills fight over the first match.

    `key` scopes the staleness counter the same way. A single global counter
    made beat 2's fill cancel beat 1's, leaving one card stuck on
    "calculating…"; each key (the path, by default) sequences independently. */
const seq = new Map();
export function fillSignature(root, method, path, st, body, key = path) {
  const mySeq = (seq.get(key) || 0) + 1;
  seq.set(key, mySeq);
  signDemo(method, path, st.salt, st.timestamp, body).then(sig => {
    if (seq.get(key) !== mySeq) return;
    const el = root.querySelector('.hv-sig');
    if (el) el.textContent = sig; // btoa keeps its own base64 padding
  });
}
