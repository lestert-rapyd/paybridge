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

const HEXC = '0123456789abcdef';
function randHex(n) { let s = ''; for (let i = 0; i < n; i++) s += HEXC[Math.floor(Math.random() * 16)]; return s; }

export const DEMO_ACCESS_KEY = 'rak_' + randHex(20).toUpperCase();
const DEMO_SECRET = 'rsk_' + randHex(40);

const enc = (s) => new TextEncoder().encode(s);
let keyPromise = null;
function hmacKey() {
  keyPromise ||= crypto.subtle.importKey('raw', enc(DEMO_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return keyPromise;
}

export function newSaltTimestamp() {
  return { salt: randHex(12), timestamp: Math.floor(Date.now() / 1000).toString() };
}

export async function signDemo(method, path, salt, timestamp, body) {
  const bodyStr = body ? JSON.stringify(body) : ''; // no whitespace — as signed on the wire
  const toSign = method.toLowerCase() + path + salt + timestamp + DEMO_ACCESS_KEY + DEMO_SECRET + bodyStr;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc(toSign));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(hex).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Shared header block — identical fields for every flow. */
export function headersHTML(st) {
  return `
    <p class="eng-label">Headers</p>
    <div class="req-headers">
      <span class="hk">access_key</span><span class="hv">${DEMO_ACCESS_KEY}</span>
      <span class="hk">salt</span><span class="hv">${st.salt}</span>
      <span class="hk">timestamp</span><span class="hv">${st.timestamp}</span>
      <span class="hk">signature</span><span class="hv hv-sig">calculating…</span>
      <span class="hk">Content-Type</span><span class="hv">application/json</span>
    </div>`;
}

/** Compute + patch the signature into the freshly rendered panel.
    Sequenced so rapid re-renders can't write a stale signature. */
let seq = 0;
export function fillSignature(panel, method, path, st, body) {
  const mySeq = ++seq;
  signDemo(method, path, st.salt, st.timestamp, body).then(sig => {
    if (mySeq !== seq) return;
    const el = panel.querySelector('.hv-sig');
    if (el) el.textContent = sig; // btoa keeps its own base64 padding
  });
}
