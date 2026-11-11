/* ─────────────────────────────────────────────────────────────
   Tag Studio — the admin-only editor for the engine-room pills.

   Entry: the #admin hash, or the "Admin" link at the foot of the demo
   drawer. Both ask for the admin token (PAYBRIDGE_ADMIN_TOKEN on the
   backend — NOT the live token) and check it with GET /api/config?op=whoami;
   only then does a "Tag Studio" button appear in the header for this tab.
   Hiding is cosmetic: the backend refuses every write without the token.

   The editor works on a DRAFT of every slot (registry.js defaults with the
   published overrides on top). The preview renders the real card markup
   through store.withConfig(draft) — the app itself only changes when the
   admin ticks "Preview in app" (this tab) or publishes (everyone: staging
   AND production share the one published config).
   ───────────────────────────────────────────────────────────── */

import { SLOTS, SLOT_ORDER, TONES, OPS, OP_LABELS, TONE_LABELS, FIELD_TYPES, SAMPLE_VARS } from '../tags/registry.js';
import { getPublished, getDraft, withConfig } from '../tags/store.js';
import { resolveTag, resolveBadge, httpCtx, pillHTML, beatBadge } from '../tags/resolve.js';
import { cachePublished, setPreviewDraft } from '../tags/loader.js';
import { paymentResponseCardHTML } from '../flows/shared.js';
import { beatCardHTML } from '../customer-beat.js';
import { esc } from '../ui.js';
import {
  getAdminToken, setAdminToken, adminWhoami, fetchTagConfig, publishTagConfig, fetchTagHistory, rollbackTagConfig,
} from '../api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const canon = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().filter((x) => val[x] !== undefined && !(x === 'hidden' && val[x] === false)).map((x) => [x, val[x]]))
  : val));
const NAME_KEY = 'pb_admin_name';
const adminName = () => { try { return sessionStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const setAdminName = (n) => { try { sessionStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } };
const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };

/* ── Draft model ─────────────────────────────────────────── */

const look = (e) => ({ label: e.label, tone: e.tone, ...(e.hidden ? { hidden: true } : {}) });

function defaultSlot(id) {
  const d = SLOTS[id];
  if (d.kind === 'rules') return { rules: clone(d.rules), fallback: clone(d.fallback) };
  return { entries: Object.fromEntries(Object.entries(d.entries).map(([k, e]) => [k, look(e)])) };
}

/** Every slot in full (defaults + `cfg`'s overrides) — what the editor edits. */
function fullSlots(cfg) {
  const out = {};
  for (const id of SLOT_ORDER) {
    const d = SLOTS[id];
    const o = cfg?.slots?.[id];
    const base = defaultSlot(id);
    if (o && d.kind === 'rules') out[id] = { rules: clone(o.rules), fallback: clone(o.fallback || d.fallback) };
    else if (o) {
      for (const [k, e] of Object.entries(o.entries || {})) if (base.entries[k]) base.entries[k] = look(e);
      out[id] = base;
    } else out[id] = base;
  }
  return out;
}

/** Only what differs from the code defaults — what gets published. */
function compact(slots) {
  const out = {};
  for (const id of SLOT_ORDER) {
    const def = defaultSlot(id);
    const s = slots[id];
    if (SLOTS[id].kind === 'rules') {
      if (canon(s) !== canon(def)) out[id] = { rules: s.rules, ...(canon(s.fallback) !== canon(def.fallback) ? { fallback: s.fallback } : { fallback: def.fallback }) };
    } else {
      const entries = {};
      for (const [k, e] of Object.entries(s.entries)) if (canon(e) !== canon(def.entries[k])) entries[k] = e;
      if (Object.keys(entries).length) out[id] = { entries };
    }
  }
  return out;
}

const S = {
  root: null,
  open: false,
  unlocked: false,
  published: null,  // the version the draft was opened from
  slots: null,      // the draft (full)
  slot: 'payment.result',
  sample: null,
  preview: false,   // "Preview in app"
  modal: null,      // 'publish' | 'history' | 'conflict' | null
  history: null,
  conflict: null,
  msg: null,        // { kind, text }
  busy: false,
};

const publishedFull = () => fullSlots(S.published);
const isDirty = () => canon(compact(S.slots)) !== canon(compact(publishedFull()));
const slotDiffers = (id, a, b) => canon(a[id]) !== canon(b[id]);
const draftCfg = () => ({ slots: compact(S.slots) });

/* ── Shell ───────────────────────────────────────────────── */

function headerHTML() {
  const p = S.published;
  const ver = p?.version ? `v${p.version} · published ${esc(when(p.updatedAt))}${p.updatedBy ? ` by ${esc(p.updatedBy)}` : ''}` : 'Nothing published · code defaults';
  const dirty = isDirty();
  return `
    <div class="ts-head">
      <div class="ts-title"><i class="icon-label" aria-hidden="true"></i>Tag Studio</div>
      <span class="ts-ver">${ver}</span>
      ${dirty ? '<span class="ts-dirty">Unpublished changes</span>' : ''}
      <span class="ts-scope" title="One published set — the Redis key both environments read">Publishing applies to staging <b>and</b> production</span>
      <div class="ts-head-actions">
        <label class="ts-toggle" title="Show this draft in the engine room — this tab only">
          <input type="checkbox" data-act="preview" ${S.preview ? 'checked' : ''} /> Preview in app
        </label>
        <button type="button" class="ts-btn" data-act="history">History</button>
        <button type="button" class="ts-btn" data-act="discard" ${dirty ? '' : 'disabled'}>Discard</button>
        <button type="button" class="ts-btn primary" data-act="publish" ${dirty && !S.busy ? '' : 'disabled'}>Publish…</button>
        <button type="button" class="ts-x" data-act="close" aria-label="Close Tag Studio"><i class="icon-close_2" aria-hidden="true"></i></button>
      </div>
    </div>
    ${S.msg ? `<div class="ts-msg ${esc(S.msg.kind)}" role="status">${esc(S.msg.text)}</div>` : ''}`;
}

function slotsHTML() {
  const pub = publishedFull();
  const def = fullSlots(null);
  const groups = {};
  for (const id of SLOT_ORDER) (groups[SLOTS[id].group] ||= []).push(id);
  return Object.entries(groups).map(([g, ids]) => `
    <div class="ts-group">${esc(g)}</div>
    ${ids.map((id) => {
      const changed = slotDiffers(id, S.slots, pub);
      const custom = slotDiffers(id, S.slots, def);
      return `<button type="button" class="ts-slot${id === S.slot ? ' on' : ''}" data-act="slot" data-slot="${esc(id)}">
        <span>${esc(SLOTS[id].title)}</span>
        ${changed ? '<span class="ts-dot draft" title="Changed in this draft"></span>' : custom ? '<span class="ts-dot custom" title="Differs from the code defaults"></span>' : ''}
      </button>`;
    }).join('')}`).join('');
}

/* ── Rules editor ────────────────────────────────────────── */

function toneRadios(name, tone) {
  return `<div class="ts-tones" role="radiogroup">${TONES.map((t) => `
    <label class="ts-tone"><input type="radio" name="${esc(name)}" data-f="tone" value="${t}" ${t === tone ? 'checked' : ''} />
      <span class="ts-swatch"><span class="wh-pill ${t}">${esc(TONE_LABELS[t])}</span></span></label>`).join('')}</div>`;
}

function valueHTML(c) {
  const type = FIELD_TYPES[c.field] || 'string';
  const v = c.value;
  if (c.op === 'exists') {
    return `<select data-f="value" class="ts-in"><option value="true" ${v !== false ? 'selected' : ''}>yes</option><option value="false" ${v === false ? 'selected' : ''}>no (absent)</option></select>`;
  }
  if (c.op === 'between') {
    const [a, b] = Array.isArray(v) ? v : ['', ''];
    return `<input class="ts-in num" type="number" data-f="v0" value="${esc(a)}" /> <span class="ts-and">and</span> <input class="ts-in num" type="number" data-f="v1" value="${esc(b)}" />`;
  }
  if (c.op === 'in') {
    return `<input class="ts-in" data-f="value" value="${esc((Array.isArray(v) ? v : []).join(', '))}" placeholder="CLO, ACT" title="Comma-separated" />`;
  }
  if (type === 'boolean') {
    return `<select data-f="value" class="ts-in"><option value="true" ${v === true ? 'selected' : ''}>true</option><option value="false" ${v === false ? 'selected' : ''}>false</option></select>`;
  }
  return `<input class="ts-in${type === 'number' ? ' num' : ''}" ${type === 'number' ? 'type="number"' : ''} data-f="value" value="${esc(v ?? '')}" />`;
}

function condHTML(c, j, fields) {
  return `<div class="ts-cond" data-c="${j}">
    <select class="ts-in" data-f="field">${fields.map((f) => `<option value="${esc(f)}" ${f === c.field ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
    <select class="ts-in" data-f="op">${OPS.map((o) => `<option value="${o}" ${o === c.op ? 'selected' : ''}>${esc(OP_LABELS[o])}</option>`).join('')}</select>
    ${valueHTML(c)}
    <button type="button" class="ts-icon" data-act="del-cond" aria-label="Remove condition">✕</button>
  </div>`;
}

function lookHTML(r, i, fields) {
  return `<div class="ts-look">
    <label class="ts-field"><span>Label</span><input class="ts-in label" data-f="label" maxlength="40" value="${esc(r.label)}" /></label>
    <div class="ts-chips"><span>Insert</span>${fields.map((f) => `<button type="button" class="ts-chip" data-act="insert" data-ph="${esc(f)}">{${esc(f)}}</button>`).join('')}</div>
    ${toneRadios(`tone-${i}`, r.tone)}
    <label class="ts-check"><input type="checkbox" data-f="hidden" ${r.hidden ? 'checked' : ''} /> Hide this tag</label>
  </div>`;
}

function rulesEditorHTML(id) {
  const def = SLOTS[id];
  const s = S.slots[id];
  const rules = s.rules.map((r, i) => {
    const mode = r.when?.any ? 'any' : 'all';
    const conds = r.when?.[mode] || [];
    return `<li class="ts-rule" data-r="${i}">
      <div class="ts-rule-head">
        <span class="ts-n">${i + 1}</span>
        ${conds.length ? `<span>When</span><select class="ts-in" data-f="mode"><option value="all" ${mode === 'all' ? 'selected' : ''}>all</option><option value="any" ${mode === 'any' ? 'selected' : ''}>any</option></select><span>of these match</span>` : '<span>Always</span>'}
        <span class="ts-rule-id">${esc(r.id)}</span>
        <span class="ts-tools">
          <button type="button" class="ts-icon" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="ts-icon" data-act="down" ${i === s.rules.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button type="button" class="ts-icon" data-act="del-rule" aria-label="Delete rule">✕</button>
        </span>
      </div>
      <div class="ts-conds">${conds.map((c, j) => condHTML(c, j, def.fields)).join('')}
        <button type="button" class="ts-link" data-act="add-cond">+ condition</button></div>
      ${lookHTML(r, i, def.fields)}
    </li>`;
  }).join('');
  const fb = s.fallback || {};
  const otherRules = SLOT_ORDER.filter((x) => x !== id && SLOTS[x].kind === 'rules');
  const fbHTML = `<div class="ts-rule ts-fallback" data-r="fb">
    <div class="ts-rule-head"><span class="ts-n">⋯</span><span>Otherwise</span>
      <select class="ts-in" data-f="fb-mode">
        <option value="custom" ${fb.slot ? '' : 'selected'}>show this label</option>
        ${otherRules.map((x) => `<option value="${esc(x)}" ${fb.slot === x ? 'selected' : ''}>use the ${esc(SLOTS[x].title)} tag</option>`).join('')}
      </select></div>
    ${fb.slot ? '' : lookHTML({ label: fb.label || '', tone: fb.tone || 'neutral', hidden: fb.hidden }, 'fb', def.fields)}
  </div>`;
  return `
    <div class="ts-ed-head"><h2>${esc(def.title)}</h2><p>${esc(def.help)}</p><p class="ts-hint">Rules run top to bottom; the first match wins.</p></div>
    <ol class="ts-rules">${rules}</ol>
    <button type="button" class="ts-btn" data-act="add-rule">+ Add rule</button>
    ${fbHTML}
    <button type="button" class="ts-link danger" data-act="reset-slot">↺ Reset “${esc(def.title)}” to the code defaults</button>`;
}

/* ── Dictionary editor ───────────────────────────────────── */

function dictRowPreview(id, key) {
  const def = SLOTS[id].entries[key];
  const vars = Object.fromEntries((def.vars || []).map((n) => [n, SAMPLE_VARS[n] ?? n]));
  const t = withConfig(draftCfg(), () => resolveBadge(id, key, vars));
  return t.hidden ? '<span class="ts-hiddenmark">hidden</span>' : pillHTML(t);
}

function dictEditorHTML(id) {
  const def = SLOTS[id];
  const dflt = defaultSlot(id).entries;
  const rows = Object.entries(S.slots[id].entries).map(([k, e]) => {
    const d = def.entries[k];
    const changed = canon(e) !== canon(dflt[k]);
    return `<tr data-k="${esc(k)}" class="${changed ? 'changed' : ''}">
      <td><code>${esc(k)}</code>${d.note ? `<div class="ts-note">${esc(d.note)}</div>` : ''}${d.vars?.length ? `<div class="ts-note">vars: ${d.vars.map((v) => `{${esc(v)}}`).join(' ')}</div>` : ''}</td>
      <td><input class="ts-in label" data-f="label" maxlength="40" value="${esc(e.label)}" /></td>
      <td><select class="ts-in" data-f="tone">${TONES.map((t) => `<option value="${t}" ${t === e.tone ? 'selected' : ''}>${esc(TONE_LABELS[t])}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-f="hidden" aria-label="Hide" ${e.hidden ? 'checked' : ''} /></td>
      <td class="ts-dark ts-rowprev">${dictRowPreview(id, k)}</td>
      <td>${changed ? `<button type="button" class="ts-icon" data-act="reset-entry" title="Back to “${esc(dflt[k].label)}”">↺</button>` : ''}</td>
    </tr>`;
  }).join('');
  return `
    <div class="ts-ed-head"><h2>${esc(def.title)}</h2><p>${esc(def.help)}</p></div>
    <table class="ts-dict"><thead><tr><th>Key</th><th>Label</th><th>Tone</th><th>Hide</th><th>Preview</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <button type="button" class="ts-link danger" data-act="reset-slot">↺ Reset every badge to the code defaults</button>`;
}

/* ── Preview ─────────────────────────────────────────────── */

const sampleBody = (ctx) => (ctx.data || ctx.error ? { ...(ctx.data ? { data: ctx.data } : {}), ...(ctx.error ? { error: ctx.error } : {}) } : null);

function rulesPreviewHTML(id) {
  const def = SLOTS[id];
  const samples = def.samples;
  const cur = samples.find((x) => x.id === S.sample) || samples[0];
  const draft = draftCfg();
  const pub = { slots: S.published?.slots || {} };
  const tagOf = (cfg, ctx) => withConfig(cfg, () => resolveTag(id, id === 'http.status' ? httpCtx(ctx.http.status, ctx.error) : ctx));
  const card = withConfig(draft, () => (id === 'payment.result'
    ? paymentResponseCardHTML({ id: 'ts-prev-card', n: '5', httpStatus: cur.ctx.http.status, data: sampleBody(cur.ctx) })
    : beatCardHTML({ id: 'ts-prev-card', method: 'GET', path: '/v1/payments/{id}', ...beatBadge('request.sent'),
      inner: `<div class="eng-pillrow">${pillHTML(resolveTag(id, httpCtx(cur.ctx.http.status, cur.ctx.error)))}</div>` })));
  const grid = samples.map((x) => {
    const d = tagOf(draft, x.ctx);
    const p = tagOf(pub, x.ctx);
    const show = (t) => (t.hidden ? '<span class="ts-hiddenmark">hidden</span>' : pillHTML(t));
    return `<tr class="${x.id === cur.id ? 'on' : ''}" data-act="sample" data-sample="${esc(x.id)}">
      <td>${esc(x.label)}</td><td>${show(p)}</td><td>${show(d)}${canon(d) !== canon(p) ? ' <span class="ts-chg">changed</span>' : ''}</td>
      <td class="ts-hit">${esc(d.ruleId === 'fallback' ? 'otherwise' : `rule ${d.ruleId ?? '—'}`)}</td></tr>`;
  }).join('');
  return `
    <div class="ts-prev-head">Preview · <span>${esc(cur.label)}</span></div>
    <div class="ts-prev-card">${card}</div>
    <table class="ts-grid"><thead><tr><th>Sample</th><th>Published</th><th>Draft</th><th>Hit</th></tr></thead><tbody>${grid}</tbody></table>
    <p class="ts-prev-foot">Click a sample to preview its card.</p>`;
}

function dictPreviewHTML(id) {
  const draft = draftCfg();
  const cards = Object.keys(SLOTS[id].entries).map((k) => {
    const d = SLOTS[id].entries[k];
    const vars = Object.fromEntries((d.vars || []).map((n) => [n, SAMPLE_VARS[n] ?? n]));
    return withConfig(draft, () => beatCardHTML({ id: `ts-prev-${k}`, method: k.startsWith('sim.') ? 'AUTH' : 'POST', sim: k.startsWith('sim.'), path: k, ...beatBadge(k, vars), inner: '' }));
  }).join('');
  return `<div class="ts-prev-head">Preview · every header badge</div><div class="ts-prev-stack">${cards}</div>`;
}

/* ── Modals ──────────────────────────────────────────────── */

function changesList() {
  const pub = publishedFull();
  const out = [];
  for (const id of SLOT_ORDER) {
    if (!slotDiffers(id, S.slots, pub)) continue;
    if (SLOTS[id].kind === 'rules') out.push(`<li><b>${esc(SLOTS[id].title)}</b> — rules changed (${S.slots[id].rules.length} rule${S.slots[id].rules.length === 1 ? '' : 's'})</li>`);
    else {
      const keys = Object.keys(S.slots[id].entries).filter((k) => canon(S.slots[id].entries[k]) !== canon(pub[id].entries[k]));
      out.push(`<li><b>${esc(SLOTS[id].title)}</b> — ${keys.map((k) => `<code>${esc(k)}</code> → “${esc(S.slots[id].entries[k].label)}”`).join(', ')}</li>`);
    }
  }
  return out.join('');
}

function modalHTML() {
  if (S.modal === 'publish') {
    return `<div class="ts-modal" role="dialog" aria-modal="true" aria-label="Publish tags">
      <h3>Publish v${(S.published?.version || 0) + 1}</h3>
      <div class="pb-notice warn"><b>Everyone sees this immediately.</b> Staging and production read the same published tags.</div>
      <ul class="ts-changes">${changesList()}</ul>
      <label class="ts-field"><span>Note (optional)</span><input class="ts-in" id="ts-note" maxlength="200" placeholder="e.g. Rename PAID · CLO for the Acme demo" /></label>
      <div class="ts-modal-actions"><button type="button" class="ts-btn" data-act="modal-close">Cancel</button>
        <button type="button" class="ts-btn primary" data-act="publish-confirm" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Publishing…' : 'Publish'}</button></div>
    </div>`;
  }
  if (S.modal === 'conflict') {
    const c = S.conflict || {};
    return `<div class="ts-modal" role="dialog" aria-modal="true" aria-label="Publish conflict">
      <h3>Someone published first</h3>
      <p>v${esc(c.version)} was published${c.updatedBy ? ` by ${esc(c.updatedBy)}` : ''}${c.updatedAt ? ` on ${esc(when(c.updatedAt))}` : ''} after you opened v${esc(S.published?.version || 0)}. Your edits are still here.</p>
      <div class="ts-modal-actions">
        <button type="button" class="ts-btn" data-act="conflict-load">Discard mine, load v${esc(c.version)}</button>
        <button type="button" class="ts-btn primary" data-act="conflict-rebase">Keep mine on top of v${esc(c.version)}</button></div>
    </div>`;
  }
  if (S.modal === 'history') {
    const h = S.history;
    const rows = !h ? '<li class="ts-note">Loading…</li>' : h.error ? `<li class="ts-note">${esc(h.error)}</li>`
      : [h.current, ...h.history].filter((x) => x && x.version).map((x, i) => `<li>
        <div><b>v${esc(x.version)}</b> · ${esc(when(x.updatedAt))}${x.updatedBy ? ` · ${esc(x.updatedBy)}` : ''}${x.note ? `<div class="ts-note">${esc(x.note)}</div>` : ''}</div>
        ${i === 0 ? '<span class="ts-cur">current</span>' : `<button type="button" class="ts-btn" data-act="rollback" data-version="${esc(x.version)}" ${S.busy ? 'disabled' : ''}>Roll back to this</button>`}
      </li>`).join('') || '<li class="ts-note">Nothing published yet.</li>';
    return `<div class="ts-modal wide" role="dialog" aria-modal="true" aria-label="Publish history">
      <h3>History</h3><ul class="ts-history">${rows}</ul>
      <div class="ts-modal-actions"><button type="button" class="ts-btn" data-act="modal-close">Close</button></div>
    </div>`;
  }
  return '';
}

/* ── Render ──────────────────────────────────────────────── */

function render() {
  if (!S.root || !S.open) return;
  const ed = $('.ts-editor', S.root);
  const top = ed?.scrollTop || 0;
  S.root.innerHTML = `
    ${headerHTML()}
    <div class="ts-body">
      <nav class="ts-slots" aria-label="Tag slots">${slotsHTML()}</nav>
      <section class="ts-editor">${SLOTS[S.slot].kind === 'rules' ? rulesEditorHTML(S.slot) : dictEditorHTML(S.slot)}</section>
      <aside class="ts-preview">${renderPreviewHTML()}</aside>
    </div>
    ${S.modal ? `<div class="ts-modal-back">${modalHTML()}</div>` : ''}`;
  const ned = $('.ts-editor', S.root);
  if (ned) ned.scrollTop = top;
  openPreviewCards();
  if (S.modal === 'publish') $('#ts-note', S.root)?.focus();
}
const renderPreviewHTML = () => (SLOTS[S.slot].kind === 'rules' ? rulesPreviewHTML(S.slot) : dictPreviewHTML(S.slot));
function openPreviewCards() { S.root.querySelectorAll('.ts-prev-card details').forEach((d) => { d.open = true; }); }

/** After a keystroke: repaint everything EXCEPT the editor (keeps focus/caret). */
function renderLight() {
  const head = $('.ts-head', S.root);
  if (head) {
    const tmp = document.createElement('div');
    tmp.innerHTML = headerHTML();
    const oldMsg = $('.ts-msg', S.root);
    if (oldMsg) oldMsg.remove();
    head.replaceWith(...tmp.childNodes);
  }
  const nav = $('.ts-slots', S.root); if (nav) nav.innerHTML = slotsHTML();
  const pv = $('.ts-preview', S.root); if (pv) pv.innerHTML = renderPreviewHTML();
  openPreviewCards();
  S.root.querySelectorAll('.ts-dict tr[data-k]').forEach((tr) => {
    const cell = $('.ts-rowprev', tr);
    if (cell) cell.innerHTML = dictRowPreview(S.slot, tr.dataset.k);
  });
  syncPreviewInApp();
}

function syncPreviewInApp() {
  if (S.preview) setPreviewDraft(draftCfg());
}

/* ── Editing ─────────────────────────────────────────────── */

const ruleAt = (el) => {
  const li = el.closest('[data-r]');
  if (!li) return null;
  const s = S.slots[S.slot];
  if (li.dataset.r === 'fb') return { fb: true, rule: s.fallback || (s.fallback = { label: '', tone: 'neutral' }) };
  return { i: Number(li.dataset.r), rule: s.rules[Number(li.dataset.r)] };
};
const condsOf = (r) => (r.when ? r.when.all || r.when.any : null);
function coerce(field, raw) {
  const t = FIELD_TYPES[field] || 'string';
  if (t === 'number') return raw === '' ? 0 : Number(raw);
  if (t === 'boolean') return raw === 'true';
  return raw;
}
const newRuleId = (rules) => { let n = rules.length + 1; while (rules.some((r) => r.id === `rule-${n}`)) n++; return `rule-${n}`; };
function defaultCond(field, op = 'eq') {
  const t = FIELD_TYPES[field];
  const value = op === 'exists' ? undefined : op === 'between' ? [200, 399] : op === 'in' ? [] : t === 'number' ? 200 : t === 'boolean' ? true : '';
  return { field, op, ...(value !== undefined ? { value } : {}) };
}

function onInput(e) {
  const el = e.target;
  const f = el.dataset?.f;
  if (!f) return;
  if (SLOTS[S.slot].kind === 'dict') {
    const tr = el.closest('tr[data-k]');
    const entry = S.slots[S.slot].entries[tr.dataset.k];
    if (f === 'label') entry.label = el.value;
    if (f === 'tone') entry.tone = el.value;
    if (f === 'hidden') { if (el.checked) entry.hidden = true; else delete entry.hidden; }
    tr.classList.toggle('changed', canon(entry) !== canon(defaultSlot(S.slot).entries[tr.dataset.k]));
    renderLight();
    return;
  }
  const at = ruleAt(el);
  if (!at) return;
  const { rule } = at;
  const condEl = el.closest('[data-c]');
  let structural = false;
  if (condEl) {
    const c = condsOf(rule)[Number(condEl.dataset.c)];
    const reset = (nc) => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, nc); structural = true; };
    if (f === 'field') reset(defaultCond(el.value, c.op));
    else if (f === 'op') reset(defaultCond(c.field, el.value));
    else if (f === 'value') {
      if (c.op === 'exists') c.value = el.value === 'true';
      else if (c.op === 'in') c.value = el.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => coerce(c.field, x));
      else c.value = coerce(c.field, el.value);
    } else if (f === 'v0' || f === 'v1') {
      const pair = Array.isArray(c.value) ? c.value : [0, 0];
      pair[f === 'v0' ? 0 : 1] = Number(el.value || 0);
      c.value = pair;
    }
  } else if (f === 'mode') {
    const list = condsOf(rule) || [];
    rule.when = { [el.value]: list };
  } else if (f === 'label') rule.label = el.value;
  else if (f === 'tone') rule.tone = el.value;
  else if (f === 'hidden') { if (el.checked) rule.hidden = true; else delete rule.hidden; }
  else if (f === 'fb-mode') {
    const s = S.slots[S.slot];
    s.fallback = el.value === 'custom' ? { label: 'HTTP {http.status}', tone: 'neutral' } : { slot: el.value };
    structural = true;
  }
  if (structural) { render(); syncPreviewInApp(); } else renderLight();
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !S.root.contains(btn)) return;
  const act = btn.dataset.act;
  if (act === 'preview') return; // the checkbox's change event handles it
  const s = S.slots?.[S.slot];
  switch (act) {
    case 'close': return closeStudio();
    case 'slot': S.slot = btn.dataset.slot; S.sample = null; return render();
    case 'sample': S.sample = btn.dataset.sample; return renderLight();
    case 'add-rule': s.rules.push({ id: newRuleId(s.rules), when: { all: [defaultCond(SLOTS[S.slot].fields[0])] }, label: 'NEW TAG', tone: 'neutral' }); break;
    case 'del-rule': { const { i } = ruleAt(btn); s.rules.splice(i, 1); break; }
    case 'up': case 'down': {
      const { i } = ruleAt(btn); const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= s.rules.length) return;
      [s.rules[i], s.rules[j]] = [s.rules[j], s.rules[i]]; break;
    }
    case 'add-cond': {
      const { rule } = ruleAt(btn);
      const list = condsOf(rule);
      if (list) list.push(defaultCond(SLOTS[S.slot].fields[0])); else rule.when = { all: [defaultCond(SLOTS[S.slot].fields[0])] };
      break;
    }
    case 'del-cond': {
      const { rule } = ruleAt(btn); const list = condsOf(rule);
      list.splice(Number(btn.closest('[data-c]').dataset.c), 1);
      if (!list.length) delete rule.when;
      break;
    }
    case 'insert': {
      const look = btn.closest('.ts-look');
      const input = $('input[data-f="label"]', look);
      const ph = `{${btn.dataset.ph}}`;
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + ph + input.value.slice(input.selectionEnd ?? at);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return;
    }
    case 'reset-slot': S.slots[S.slot] = defaultSlot(S.slot); break;
    case 'reset-entry': { const k = btn.closest('tr[data-k]').dataset.k; s.entries[k] = defaultSlot(S.slot).entries[k]; break; }
    case 'discard': S.slots = publishedFull(); S.msg = null; break;
    case 'publish': S.modal = 'publish'; break;
    case 'modal-close': S.modal = null; break;
    case 'publish-confirm': return doPublish();
    case 'history': S.modal = 'history'; S.history = null; render(); return loadHistory();
    case 'rollback': return doRollback(Number(btn.dataset.version));
    case 'conflict-load': await refreshPublished(); S.slots = publishedFull(); S.modal = null; S.msg = { kind: 'ok', text: `Loaded v${S.published?.version || 0}.` }; break;
    case 'conflict-rebase': await refreshPublished(); S.modal = 'publish'; break;
    default: return;
  }
  render();
  syncPreviewInApp();
}

function onChange(e) {
  if (e.target.dataset?.act !== 'preview') return;
  S.preview = e.target.checked;
  setPreviewDraft(S.preview ? draftCfg() : null);
  S.msg = S.preview ? { kind: 'info', text: 'The engine room in this tab now shows your draft. Nobody else sees it until you publish.' } : null;
  renderLight();
}

/* ── Backend actions ─────────────────────────────────────── */

async function refreshPublished() {
  const r = await fetchTagConfig();
  if (r.ok && r.data && r.data.configured !== false) {
    S.published = r.data.version ? r.data : null;
    cachePublished(r.data);
  }
  return r;
}

async function doPublish() {
  if (S.busy) return;
  const note = $('#ts-note', S.root)?.value || '';
  S.busy = true; render();
  const r = await publishTagConfig({ baseVersion: S.published?.version || 0, slots: compact(S.slots), updatedBy: adminName(), note });
  S.busy = false;
  if (r.ok) {
    S.published = r.data;
    cachePublished(r.data);
    if (S.preview) { S.preview = false; setPreviewDraft(null); }
    S.modal = null;
    S.msg = { kind: 'ok', text: `Published v${r.data.version}. Every viewer picks it up on their next load.` };
  } else if (r.httpStatus === 409 && r.data?.error === 'VERSION_CONFLICT') {
    S.conflict = r.data.current; S.modal = 'conflict';
  } else {
    S.modal = null;
    S.msg = { kind: 'error', text: `${r.data?.error || `HTTP ${r.httpStatus}`}: ${r.data?.message || 'publish failed'}` };
  }
  render();
}

async function loadHistory() {
  const r = await fetchTagHistory();
  S.history = r.ok ? r.data : { error: r.data?.message || `HTTP ${r.httpStatus}` };
  if (S.modal === 'history') render();
}

async function doRollback(version) {
  S.busy = true; render();
  const r = await rollbackTagConfig({ version, baseVersion: S.published?.version || 0, updatedBy: adminName() });
  S.busy = false;
  if (r.ok) {
    S.published = r.data; cachePublished(r.data); S.slots = publishedFull();
    S.modal = null; S.msg = { kind: 'ok', text: `Rolled back: v${version} is live again as v${r.data.version}.` };
  } else if (r.httpStatus === 409 && r.data?.error === 'VERSION_CONFLICT') {
    await refreshPublished(); S.history = null; loadHistory();
    S.msg = { kind: 'error', text: 'Someone published meanwhile — the history is refreshed; try again.' };
  } else {
    S.msg = { kind: 'error', text: `${r.data?.error || `HTTP ${r.httpStatus}`}: ${r.data?.message || 'rollback failed'}` };
    S.modal = null;
  }
  render();
}

/* ── Open / close ────────────────────────────────────────── */

export async function openStudio() {
  if (!S.unlocked) return openUnlock();
  if (!S.root) {
    S.root = document.createElement('div');
    S.root.className = 'ts-overlay';
    S.root.setAttribute('role', 'dialog');
    S.root.setAttribute('aria-label', 'Tag Studio');
    S.root.addEventListener('input', onInput);
    // Selects, checkboxes and radios all fire `input` too; `change` is only
    // the Preview-in-app toggle (which edits nothing).
    S.root.addEventListener('change', onChange);
    S.root.addEventListener('click', onClick);
    document.body.appendChild(S.root);
  }
  S.published = getPublished();
  S.slots = getDraft() ? fullSlots(getDraft()) : publishedFull();
  S.preview = !!getDraft();
  S.open = true; S.modal = null; S.msg = null;
  S.root.hidden = false;
  document.body.classList.add('ts-open');
  render();
  // The freshest published version — the draft is re-based on it if untouched.
  const before = canon(compact(S.slots));
  const wasPub = canon(compact(publishedFull()));
  await refreshPublished();
  if (before === wasPub) S.slots = publishedFull();
  render();
}

function closeStudio() {
  if (!S.root) return;
  if (isDirty() && !S.preview && !window.confirm('Close the Tag Studio? Your unpublished changes will be lost.')) return;
  S.open = false;
  S.root.hidden = true;
  $('#ts-open')?.classList.toggle('previewing', S.preview);
  document.body.classList.remove('ts-open');
  if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
}

/* ── Unlock ──────────────────────────────────────────────── */

let unlockEl = null;
function openUnlock() {
  if (!unlockEl) {
    unlockEl = document.createElement('div');
    unlockEl.className = 'live-dialog-backdrop';
    unlockEl.innerHTML = `
      <form class="live-dialog" role="dialog" aria-modal="true" aria-labelledby="ts-unlock-title" autocomplete="off" novalidate>
        <div class="live-dialog-head"><span id="ts-unlock-title">Admin · Tag Studio</span>
          <button type="button" class="dc-x" data-x aria-label="Cancel"><i class="icon-close_2" aria-hidden="true"></i></button></div>
        <ul class="live-dialog-rules">
          <li>Edits the tags on the engine-room cards for everyone, on staging and production.</li>
          <li>Uses the admin token — not the live token. It is kept for this tab only.</li>
        </ul>
        <label class="live-dialog-label" for="ts-admin-token">Admin token</label>
        <input type="password" class="live-dialog-input" id="ts-admin-token" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <label class="live-dialog-label" for="ts-admin-name">Your name <span class="ts-note">(shown in the publish history)</span></label>
        <input class="live-dialog-input" id="ts-admin-name" maxlength="40" autocomplete="off" />
        <div class="live-dialog-err" role="alert" hidden></div>
        <div class="live-dialog-actions">
          <button type="button" class="live-dialog-btn" data-x>Cancel</button>
          <button type="submit" class="live-dialog-btn primary">Unlock</button>
        </div>
      </form>`;
    document.body.appendChild(unlockEl);
    const close = () => { unlockEl.hidden = true; $('#ts-admin-token').value = ''; };
    unlockEl.addEventListener('click', (e) => { if (e.target.closest('[data-x]') || e.target === unlockEl) close(); });
    unlockEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    $('form', unlockEl).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.live-dialog-err', unlockEl);
      const token = $('#ts-admin-token').value.trim();
      const name = $('#ts-admin-name').value.trim();
      const show = (m) => { err.textContent = m; err.hidden = !m; };
      if (!/^[\x21-\x7e]{16,512}$/.test(token)) return show('That doesn’t look like an admin token (16+ characters, no spaces).');
      setAdminToken(token);
      show('');
      const r = await adminWhoami();
      if (r.httpStatus === 204) {
        setAdminName(name);
        close();
        setUnlocked(true);
        openStudio();
      } else {
        setAdminToken(null);
        show(r.httpStatus === 0 ? 'Couldn’t reach the backend.'
          : r.data?.error === 'ADMIN_DISABLED' ? 'Admin is disabled on this backend (no PAYBRIDGE_ADMIN_TOKEN).'
            : 'That token was not accepted.');
      }
    });
  }
  $('#ts-admin-name').value = adminName();
  $('.live-dialog-err', unlockEl).hidden = true;
  unlockEl.hidden = false;
  $('#ts-admin-token').focus();
}

function setUnlocked(on) {
  S.unlocked = on;
  const btn = $('#ts-open');
  if (btn) btn.hidden = !on;
}

/** Wire the entry points. Called once from app.js. */
export function mountTagStudio() {
  const bar = $('.topbar');
  if (bar && !$('#ts-open')) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'ts-open'; b.className = 'ts-open'; b.hidden = true;
    b.innerHTML = '<i class="icon-label" aria-hidden="true"></i>Tag Studio';
    b.addEventListener('click', openStudio);
    bar.insertBefore(b, $('#drawer-btn'));
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-open-tag-studio]')) openStudio(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.open && !(unlockEl && !unlockEl.hidden)) {
      e.stopPropagation();
      if (S.modal) { S.modal = null; render(); } else closeStudio();
    }
  }, true);
  window.addEventListener('paybridge:admin-auth-failed', () => {
    setUnlocked(false);
    if (S.open) { S.msg = { kind: 'error', text: 'The admin token was rejected — unlock again to publish.' }; render(); }
  });
  const fromHash = () => { if (location.hash === '#admin') openStudio(); };
  window.addEventListener('hashchange', fromHash);
  // A token from earlier in this tab: confirm it quietly, then show the button.
  if (getAdminToken()) {
    adminWhoami().then((r) => { setUnlocked(r.httpStatus === 204); fromHash(); });
  } else fromHash();
}
