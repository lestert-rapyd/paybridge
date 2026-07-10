/* ─────────────────────────────────────────────────────────────
   Shared UI helpers: backend tab switching + header status pill.
   Kept separate so flow modules and the bootstrap can both use them
   without a circular import.
   ───────────────────────────────────────────────────────────── */

export function setActiveTab(name) {
  document.querySelectorAll('.rtab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.rpanel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === name));
}

/** kind: idle | drafting | processing | ok | action | error */
export function setStatus(text, kind = 'idle') {
  const el = document.getElementById('status-ind');
  if (!el) return;
  el.className = `status-ind ${kind}`;
  el.innerHTML = `<span class="si-dot"></span><span class="si-text">${text}</span>`;
}
