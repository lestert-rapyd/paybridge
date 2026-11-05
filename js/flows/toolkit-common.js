/* ─────────────────────────────────────────────────────────────
   What the two toolkit surfaces share — the checkout toolkit
   (flows/toolkit.js) and the card-token toolkit / hosted tokenisation
   page (site/add-card.js):

     · the Console tab's event log — one stream, so the SE sees every
       toolkit lifecycle event and API beat in the order they happened;
     · returnUrl() — where a Rapyd hosted page sends the shopper back to.

   Kept apart from toolkit.js so the add-card page can use them without
   importing the checkout flow (which imports the steps router, which
   imports the add-card page).
   ───────────────────────────────────────────────────────────── */

import { esc } from '../ui.js';

/* ── Console tab ─────────────────────────────────────────── */
let events = [];
let lastHeartbeat = null;

const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour12: false });
function logLineHTML(e) {
  return `
    <div class="cl-line">
      <span class="cl-time">${fmtTime(e.at)}</span>
      <span class="cl-tag cl-${esc(e.tag)}">${esc(e.tag)}</span>
      <span class="cl-msg${e.kind ? ` cl-${esc(e.kind)}` : ''}">${esc(e.name)}${e.detail ? ` <span class="cl-detail">${esc(e.detail)}</span>` : ''}</span>
    </div>`;
}

export function renderConsole() {
  const el = document.getElementById('panel-console');
  if (!el) return;
  if (!events.length && !lastHeartbeat) {
    el.innerHTML = `<div class="eng-empty"><div class="ee-ico">▸</div><div class="ee-text">Toolkit lifecycle events stream here once the toolkit renders.</div></div>`;
    return;
  }
  const lines = events.map(logLineHTML).join('');
  const heartbeat = lastHeartbeat ? logLineHTML({ name: 'heartbeat', tag: 'poll', at: lastHeartbeat }) : '';
  el.innerHTML = `<div class="tk-console">${lines}${heartbeat}<span class="cl-cursor">▏</span></div>`;
}

/** Append a line: `tag` tk (toolkit) / api / poll / app; `kind` ok / err / action. */
export function logConsole(name, detail = '', tag = 'tk', kind = '') {
  events.push({ name, detail, tag, kind, at: new Date() });
  renderConsole();
}
/** The webhook watcher's poll tick (one line, kept current). */
export function consoleHeartbeat() { lastHeartbeat = new Date(); renderConsole(); }
/** A new launch starts a fresh log. */
export function clearConsole() { events = []; lastHeartbeat = null; }

/* ── The toolkit mode (drawer → Integration path → Toolkit mode) ──
   flows/toolkit.js owns the setting — the drawer AND the checkout's own
   config panel change it — and registers a reader here, so the add-card
   page always sees the live value (hosted page → full redirect, else the
   card-token toolkit) without importing the checkout flow. */
let readMode = () => 'embedded';
export const sharedToolkitMode = () => readMode();
export function setToolkitModeSource(fn) { if (typeof fn === 'function') readMode = fn; }

/* ── Return URLs ─────────────────────────────────────────────
   Where a hosted page sends the customer afterwards. This site ships its
   own complete/ and cancel/ pages; Rapyd requires https, so:
     1. served over https → this deployment's own pages;
     2. else (http://localhost, file://) → the https deployment named in
        <meta name="paybridge-public-url" content="https://…/"> (index.html);
     3. else the legacy fixed URL, only so the call still validates — NOTE
        rapydtoolkit.com currently 404s (Vercel DEPLOYMENT_NOT_FOUND); set the
        meta tag to fix local runs. */
const LEGACY_RETURN_ORIGIN = 'https://rapydtoolkit.com/';
function publicUrl() {
  try {
    const v = document.querySelector('meta[name="paybridge-public-url"]')?.getAttribute('content')?.trim();
    if (v && new URL(v).protocol === 'https:') return v.endsWith('/') ? v : `${v}/`;
  } catch { /* malformed — ignore */ }
  return null;
}
/** `query` (e.g. 'for=card') is appended so the return page can say what finished. */
export function returnUrl(page, query = '') {
  const q = query ? `?${query}` : '';
  try {
    if (typeof location !== 'undefined' && location.protocol === 'https:') return new URL(`${page}/${q}`, location.href).href;
    const pub = publicUrl();
    if (pub) return new URL(`${page}/${q}`, pub).href;
  } catch { /* fall through */ }
  return `${LEGACY_RETURN_ORIGIN}${page}${q}`;
}
