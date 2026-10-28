/* ─────────────────────────────────────────────────────────────
   Line-numbered JSON viewer.
   renderJSONView(obj) → a gutter of line numbers + syntax-highlighted
   body. Every primitive value carries its dotted path (data-path) so
   the sync engine can highlight the node a focused field maps to.
   Line numbers anchor demos + troubleshooting ("see line 7").

   Renders webhook payloads (attacker-controllable — /api/webhook is
   public), so EVERY interpolation goes through ui.js esc(): values,
   keys AND the data-path attribute built from those keys.
   ───────────────────────────────────────────────────────────── */

import { esc } from './ui.js';

function valueSpan(value, path) {
  let cls = 'tok-str';
  let text;
  if (value === null)                  { cls = 'tok-bool'; text = 'null'; }
  else if (typeof value === 'number')  { cls = 'tok-num'; text = esc(value); }
  else if (typeof value === 'boolean') { cls = 'tok-bool'; text = esc(value); }
  else                                  { text = `"${esc(String(value))}"`; } // String(): undefined still reads "undefined"
  const inner = text === '""'
    ? '<span class="jv-empty">""</span>'
    : `<span class="${cls}">${text}</span>`;
  return `<span class="jv" data-path="${esc(path)}">${inner}</span>`;
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
    Claude Code style — clearing any previous hits OF THE SAME CLASS. `cls`
    lets a second, independent highlight share the view (own-fields marks the
    external-3DS fields with 'inject-hit' while focus keeps 'sync-hit'). */
export function highlightPaths(container, paths = [], cls = 'sync-hit') {
  if (!container) return;
  container.querySelectorAll(`.${cls}`).forEach(e => e.classList.remove(cls));
  paths.forEach(p => {
    const el = container.querySelector(`.jv[data-path="${CSS.escape(p)}"]`);
    const line = el?.closest('.jsonv-line');
    if (!line) return;
    line.classList.add(cls);
    const idx = [...line.parentElement.children].indexOf(line);
    line.closest('.jsonv')?.querySelector('.jsonv-gutter')?.children[idx]?.classList.add(cls);
  });
}
