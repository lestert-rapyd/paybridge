/* ─────────────────────────────────────────────────────────────
   Line-numbered JSON viewer.
   renderJSONView(obj) → a gutter of line numbers + syntax-highlighted
   body. Every primitive value carries its dotted path (data-path) so
   the sync engine can highlight the node a focused field maps to.
   Line numbers anchor demos + troubleshooting ("see line 7").
   ───────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function valueSpan(value, path) {
  let cls = 'tok-str';
  let text;
  if (value === null)                  { cls = 'tok-bool'; text = 'null'; }
  else if (typeof value === 'number')  { cls = 'tok-num'; text = String(value); }
  else if (typeof value === 'boolean') { cls = 'tok-bool'; text = String(value); }
  else                                  { text = `"${esc(value)}"`; }
  const inner = text === '""'
    ? '<span class="jv-empty">""</span>'
    : `<span class="${cls}">${text}</span>`;
  return `<span class="jv" data-path="${path}">${inner}</span>`;
}

function build(value, path, indent, prefix, comma, lines) {
  const pad = '  '.repeat(indent);

  if (value !== null && typeof value === 'object') {
    const isArr = Array.isArray(value);
    const keys = isArr ? value.map((_, i) => i) : Object.keys(value);
    const open = isArr ? '[' : '{';
    const close = isArr ? ']' : '}';

    if (keys.length === 0) {
      lines.push(`${pad}${prefix}<span class="tok-punc">${open}${close}</span>${comma}`);
      return;
    }
    lines.push(`${pad}${prefix}<span class="tok-punc">${open}</span>`);
    keys.forEach((k, idx) => {
      const childPath = path ? `${path}.${k}` : `${k}`;
      const childPrefix = isArr
        ? ''
        : `<span class="tok-key">"${esc(k)}"</span><span class="tok-punc">: </span>`;
      const childComma = idx < keys.length - 1 ? '<span class="tok-punc">,</span>' : '';
      build(value[k], childPath, indent + 1, childPrefix, childComma, lines);
    });
    lines.push(`${pad}<span class="tok-punc">${close}</span>${comma}`);
  } else {
    lines.push(`${pad}${prefix}${valueSpan(value, path)}${comma}`);
  }
}

export function renderJSONView(obj) {
  const lines = [];
  build(obj, '', 0, '', '', lines);
  const gutter = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
  const body = lines.map(l => `<div class="jsonv-line">${l || '&nbsp;'}</div>`).join('');
  return `<div class="jsonv"><div class="jsonv-gutter">${gutter}</div><div class="jsonv-body">${body}</div></div>`;
}

/** Highlight the FULL row (line + gutter number) for the given paths —
    Claude Code style — clearing any previous hits. */
export function highlightPaths(container, paths = []) {
  if (!container) return;
  container.querySelectorAll('.sync-hit').forEach(e => e.classList.remove('sync-hit'));
  paths.forEach(p => {
    const el = container.querySelector(`.jv[data-path="${CSS.escape(p)}"]`);
    const line = el?.closest('.jsonv-line');
    if (!line) return;
    line.classList.add('sync-hit');
    const idx = [...line.parentElement.children].indexOf(line);
    line.closest('.jsonv')?.querySelector('.jsonv-gutter')?.children[idx]?.classList.add('sync-hit');
  });
}
