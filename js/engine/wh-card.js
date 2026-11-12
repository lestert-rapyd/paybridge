/* ─────────────────────────────────────────────────────────────
   One webhook event card (pill row + line-numbered JSON) — shared by the
   engine room's sequence view and the back office.
   ───────────────────────────────────────────────────────────── */

import { renderJSONView } from '../json-view.js';
import { classify, isTrusted } from '../classify.js';
import { esc } from '../ui.js';

/* ── Markup ──────────────────────────────────────────────────
   Everything below lands in innerHTML and webhook bodies are attacker-
   controllable, so every interpolated value goes through esc(). */
function pill(text, cls = '') { return `<span class="wh-pill ${esc(cls)}">${esc(text)}</span>`; }

// One pill per field Rapyd actually sends, rather than one combined string —
// easier to scan, and each field only appears when the event carries it.
function fieldPills(e) {
  const d = e.raw?.data || {};
  const ar = d.authentication_result || {};
  return [
    ['status', e.status ?? d.status, classify(e)],
    ['paid', d.paid ?? e.paid, null],
    ['next_action', d.next_action, null],
    ['eci', ar.eci, null],
    ['result', ar.result, null],
  ]
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v, kind]) => pill(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`, kind || 'field'))
    .join('');
}

function verifyChip(e) {
  if (e.source === 'retrieve') return `<span class="wh-verify ok">✓ confirmed via Retrieve Payment</span>`;
  // Which env's MID signed it — a sandbox signature never settles a live payment.
  if (e.verified === 'verified') return `<span class="wh-verify ok">✓ signature verified${e.verified_env ? ` · ${esc(e.verified_env)}` : ''}</span>`;
  if (e.verified === 'unverified' || e.verified === 'skipped') {
    const why = e.verified === 'skipped' ? 'No Rapyd signature headers' : 'Rapyd signature did not match';
    return `<span class="wh-verify warn" title="${esc(why)} — shown, but confirmed via Retrieve Payment before it counts">unverified — not trusted</span>`;
  }
  return `<span class="wh-verify">received</span>`; // built locally (e.g. back office's synchronous refund failure)
}

/** One webhook event card — shared by both sections here and by the back
    office's webhook tab, so the markup (and its escaping) lives once. */
export function eventCardHTML(e, open) {
  const kind = classify(e);
  const untrusted = kind !== 'pending' && !isTrusted(e) && e.verified !== undefined;
  return `
    <details class="wh-card ${kind}${untrusted ? ' untrusted' : ''}" ${open ? 'open' : ''}>
      <summary class="wh-card-head">
        <span class="wh-chev">▸</span>
        ${pill(e.type || 'EVENT', 'evt')}
        ${fieldPills(e)}
        ${verifyChip(e)}
      </summary>
      <div class="wh-card-json">${renderJSONView(e.raw || e)}</div>
    </details>`;
}

