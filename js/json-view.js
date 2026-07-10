/* ─────────────────────────────────────────────────────────────
   Syntax-highlighted JSON renderer.
   Every primitive value gets a `.jv` span tagged with its dotted
   path (e.g. payment_method.fields.number) so the sync engine can
   highlight the node that a focused form field maps to.
   ───────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function primitive(value, path) {
  let cls = 'tok-str';
  let text;
  if (value === null)               { cls = 'tok-bool'; text = 'null'; }
  else if (typeof value === 'number')  { cls = 'tok-num'; text = String(value); }
  else if (typeof value === 'boolean') { cls = 'tok-bool'; text = String(value); }
  else                                  { text = `"${esc(value)}"`; }
  const shown = text === '""' ? '<span class="jv-empty">""</span>' : `<span class="${cls}">${text}</span>`;
  return `<span class="jv" data-path="${path}">${shown}</span>`;
}

function render(value, path, indent) {
  const pad   = '  '.repeat(indent);
  const padIn = '  '.repeat(indent + 1);

  if (value === null || typeof value !== 'object') return primitive(value, path);

  if (Array.isArray(value)) {
    if (!value.length) return '<span class="tok-punc">[]</span>';
    const items = value.map((v, i) =>
      padIn + render(v, path ? `${path}.${i}` : `${i}`, indent + 1)
    ).join('<span class="tok-punc">,</span>\n');
    return `<span class="tok-punc">[</span>\n${items}\n${pad}<span class="tok-punc">]</span>`;
  }

  const keys = Object.keys(value);
  if (!keys.length) return '<span class="tok-punc">{}</span>';
  const items = keys.map(k => {
    const childPath = path ? `${path}.${k}` : k;
    return padIn +
      `<span class="tok-key">"${esc(k)}"</span><span class="tok-punc">: </span>` +
      render(value[k], childPath, indent + 1);
  }).join('<span class="tok-punc">,</span>\n');
  return `<span class="tok-punc">{</span>\n${items}\n${pad}<span class="tok-punc">}</span>`;
}

export function renderJSON(obj) {
  return render(obj, '', 0);
}

/** Add .sync-hit to the value spans at the given paths, clear the rest. */
export function highlightPaths(container, paths = []) {
  if (!container) return;
  container.querySelectorAll('.jv.sync-hit').forEach(e => e.classList.remove('sync-hit'));
  paths.forEach(p => {
    const el = container.querySelector(`.jv[data-path="${CSS.escape(p)}"]`);
    if (el) el.classList.add('sync-hit');
  });
}
