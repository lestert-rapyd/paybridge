/* ─────────────────────────────────────────────────────────────
   The sequence expectations (tags/registry.js EXPECT / ASYNC), written out
   for people: the Tag Studio's read-only Sequence block and its "Copy as
   proposal" Markdown. Pure — no DOM.
   ───────────────────────────────────────────────────────────── */

import { CALLS, EXPECT, ASYNC, SCENARIOS } from '../tags/registry.js';

const OP_TEXT = { eq: 'is', neq: 'is not', in: 'is one of', exists: 'is present' };
const SCN_ORDER = ['success', 'action', 'failure'];

const val = (v) => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)).join(' | ') : JSON.stringify(v));
export const criterionText = (c) => `${c.path} ${OP_TEXT[c.op] || c.op}${c.op === 'exists' ? '' : ` ${val(c.value)}`}`;
export const slotText = (s) => {
  const types = (s.anyOf || [s.type]).join(' | ');
  const links = Object.entries(s.links || {}).map(([p, k]) => `${p} = ${k}`).join(', ');
  return `${types}${links ? ` (linked by ${links})` : ''}${s.confirm ? ' [to confirm]' : ''}`;
};

/** [{ label, scenarios: [{ id, title, criteria: [text], sync: [text], async: { id, title, trigger, sync: [text] } | null }] }] */
export function callSpec(call) {
  return (EXPECT[call] || []).map((v) => ({
    label: v.label || (v.path ? `Path contains ${v.path}` : ''),
    scenarios: SCN_ORDER.filter((s) => v[s]).map((s) => {
      const x = v[s];
      const a = x.async && ASYNC[x.async];
      return {
        id: s, title: `${SCENARIOS[s] || s}${x.confirm ? ' (to confirm)' : ''}`,
        criteria: (x.criteria || []).map(criterionText),
        sync: (x.sync || []).map(slotText),
        async: a ? { id: x.async, title: a.title, trigger: a.trigger, sync: a.sync.map(slotText) } : null,
      };
    }),
  }));
}

/** A journey's expectations as Markdown — what "Copy as proposal" puts on
    the clipboard, for the user to mark up and hand back. */
export function journeyMarkdown(j) {
  const out = [`## ${j.title} — expected sequence`, ''];
  j.calls.forEach((id, i) => {
    const c = CALLS[id];
    out.push(`### ${i + 1}. ${c.title} — \`${c.method} ${c.path}\``);
    const spec = callSpec(id);
    if (!spec.length) { out.push('- No expectations yet (its webhooks, if any, land under “Other events”).', ''); return; }
    for (const v of spec) {
      if (v.label) out.push(`**${v.label}**`);
      for (const s of v.scenarios) {
        out.push(`- ${s.title}`);
        out.push(`  - Response: ${s.criteria.length ? s.criteria.join('; ') : '—'}`);
        out.push(`  - Sync webhooks: ${s.sync.length ? s.sync.join('; ') : 'none'}`);
        if (s.async) out.push(`  - Async · ${s.async.title} (${s.async.trigger}): ${s.async.sync.join('; ')}`);
      }
    }
    out.push('');
  });
  return out.join('\n');
}
