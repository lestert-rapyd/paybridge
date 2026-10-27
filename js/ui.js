/* ─────────────────────────────────────────────────────────────
   Shared UI helpers: backend tab switching + header status pill,
   plus the ONE HTML-escaping helper every renderer imports.
   Kept separate so flow modules and the bootstrap can both use them
   without a circular import. No DOM access at module top level — the
   browser test harness imports this file directly.
   ───────────────────────────────────────────────────────────── */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for interpolation into HTML text AND quoted attribute
    values. Quotes are escaped too, so `data-x="${esc(v)}"` can't be broken
    out of — webhook payloads, customer names and Rapyd response fields all
    reach innerHTML through this. null/undefined render as ''. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

export function setActiveTab(name) {
  document.querySelectorAll('.rtab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.rpanel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === name));
}

/** kind: idle | drafting | processing | ok | action | error.
    `text` is plain text (escaped) — every caller passes a literal label. */
export function setStatus(text, kind = 'idle') {
  const el = document.getElementById('status-ind');
  if (!el) return;
  el.className = `status-ind ${esc(kind)}`;
  el.innerHTML = `<span class="si-dot"></span><span class="si-text">${esc(text)}</span>`;
}
