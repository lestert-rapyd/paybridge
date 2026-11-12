/* ─────────────────────────────────────────────────────────────
   Tag Studio — the admin-only editor for the engine-room tags.

   Organised the way the demo runs: pick a JOURNEY (Own Card Fields, Add a
   card, Withdraw…) and its cards are listed in the order the engine room
   shows them — each call's request card, then its response card, with every
   state its header badge goes through (in flight → sent → failed …). Every
   card's tags are its OWN (slot `beat.header:<step>`, `payment.result:<step>`
   …); a card nobody touched follows the shared defaults, and any edit can be
   pushed to every card with "apply to all". The preview on the right renders
   the whole journey, in order, for a scenario (success, 3DS, failure…).

   Entry: the #admin hash, or "Admin · Tag Studio" at the foot of the demo
   drawer. Both ask for the admin token (PAYBRIDGE_ADMIN_TOKEN on the backend —
   NOT the live token), checked with GET /api/config?op=whoami; only then does
   the header button appear. Hiding is cosmetic: the backend refuses writes.

   The working config (S.cfg) is a sparse override set on top of the code
   defaults. The preview renders through store.withConfig — the app only
   changes on "Preview in app" (this tab) or Publish (everyone: staging AND
   production share the one published config).
   ───────────────────────────────────────────────────────────── */

import {
  SLOTS, TONES, OPS, OP_LABELS, TONE_LABELS, FIELD_TYPES, SAMPLE_VARS,
  CALLS, JOURNEYS, SCENARIOS, STEPS, journeysOf, splitSlotId,
} from '../tags/registry.js';
import { getPublished, getDraft, withConfig } from '../tags/store.js';
import {
  resolveTag, httpCtx, paymentCtx, pillHTML, httpPillHTML, badgePillHTML, resolveBeatBadge, beatClass,
} from '../tags/resolve.js';
import { cachePublished, setPreviewDraft } from '../tags/loader.js';
import { beatCardHTML } from '../customer-beat.js';
import { esc } from '../ui.js';
import { callSpec, journeyMarkdown } from '../engine/spec.js';
import {
  getAdminToken, setAdminToken, adminWhoami, fetchTagConfig, publishTagConfig, fetchTagHistory, rollbackTagConfig,
} from '../api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const canon = (v) => JSON.stringify(v ?? null, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().filter((x) => val[x] !== undefined && !(x === 'hidden' && val[x] === false)).map((x) => [x, val[x]]))
  : val));
const NAME_KEY = 'pb_admin_name';
const adminName = () => { try { return sessionStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const setAdminName = (n) => { try { sessionStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } };
const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };
const BH = 'beat.header';
const look = (e) => ({ label: e.label, tone: e.tone, ...(e.hidden ? { hidden: true } : {}) });
const sideName = (step) => (STEPS[step]?.side === 'req' ? 'request card' : CALLS[STEPS[step]?.call]?.res?.single ? 'card' : 'response card');

/* ── Working config ──────────────────────────────────────── */

const S = {
  root: null, open: false, unlocked: false,
  published: null,  // the version the draft was opened from
  cfg: { slots: {} }, // sparse overrides being edited
  nav: 'j:ocf',     // 'j:<journey>' | 's:<base slot>'
  scenario: 'success',
  openRules: null,  // the step-rules editor expanded inline (slot id)
  preview: false, modal: null, history: null, conflict: null, msg: null, busy: false,
};
const slots = () => S.cfg.slots;

/** Shared (no step) effective entry: the shared override, else the default. */
const sharedEntry = (cfgSlots, key) => cfgSlots[BH]?.entries?.[key] || look(SLOTS[BH].entries[key]);
/** Shared effective rules for a base slot. */
const sharedRules = (cfgSlots, base) => {
  const o = cfgSlots[base];
  const d = SLOTS[base];
  return o ? { rules: o.rules, fallback: o.fallback || d.fallback } : { rules: d.rules, fallback: d.fallback };
};

/** Drop overrides that change nothing — what gets published and diffed. */
function compact(src) {
  const out = {};
  for (const [id, s] of Object.entries(src || {})) {
    const [base, step] = splitSlotId(id);
    const def = SLOTS[base];
    if (!def) continue;
    if (def.kind === 'dict') {
      const entries = {};
      for (const [k, e] of Object.entries(s.entries || {})) {
        if (!def.entries[k]) continue;
        const parent = step ? sharedEntry(src, k) : look(def.entries[k]);
        if (canon(look(e)) !== canon(parent)) entries[k] = look(e);
      }
      if (Object.keys(entries).length) out[id] = { entries };
    } else {
      const parent = step ? sharedRules(src, base) : { rules: def.rules, fallback: def.fallback };
      const mine = { rules: s.rules, fallback: s.fallback || def.fallback };
      if (canon(mine) !== canon(parent)) out[id] = clone(mine);
    }
  }
  return out;
}
const draftCfg = () => ({ slots: compact(slots()) });
const pubSlots = () => compact(S.published?.slots || {});
const isDirty = () => canon(compact(slots())) !== canon(pubSlots());

/* Dictionary entries at a step. */
function entryAt(key, step) {
  const own = slots()[`${BH}:${step}`]?.entries?.[key];
  if (own) return { e: own, source: 'card' };
  const shared = slots()[BH]?.entries?.[key];
  if (shared) return { e: shared, source: 'shared' };
  return { e: look(SLOTS[BH].entries[key]), source: 'default' };
}
function setEntry(step, key, e) {
  const id = step ? `${BH}:${step}` : BH;
  (slots()[id] ||= { entries: {} }).entries[key] = look(e);
}
function clearEntry(step, key) {
  const id = `${BH}:${step}`;
  const s = slots()[id];
  if (!s) return;
  delete s.entries[key];
  if (!Object.keys(s.entries).length) delete slots()[id];
}
function stepIdsWith(base, key = null) {
  return Object.keys(slots()).filter((id) => id.startsWith(`${base}:`) && (!key || slots()[id].entries?.[key])).map((id) => splitSlotId(id)[1]);
}
function applyEntryEverywhere(key, e) {
  setEntry(null, key, e);
  for (const step of stepIdsWith(BH, key)) clearEntry(step, key);
}

/* Rules at a step. `sid` = 'payment.result' (shared) or 'payment.result:pay-res'. */
function rulesOf(sid) {
  if (slots()[sid]) return slots()[sid];
  const [base, step] = splitSlotId(sid);
  return clone(step ? sharedRules(slots(), base) : sharedRules({}, base));
}
function ensureRules(sid) {
  if (!slots()[sid]) slots()[sid] = rulesOf(sid);
  return slots()[sid];
}

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

/** Slot ids a journey's cards own. */
const journeySteps = (j) => j.calls.flatMap((c) => ['req', 'res'].filter((s) => CALLS[c][s]).map((s) => CALLS[c][s].step));
function journeyMarks(j) {
  const steps = new Set(journeySteps(j));
  const mine = compact(slots());
  const pub = pubSlots();
  const ids = new Set([...Object.keys(mine), ...Object.keys(pub)].filter((id) => steps.has(splitSlotId(id)[1])));
  const changed = [...ids].some((id) => canon(mine[id]) !== canon(pub[id]));
  const custom = Object.keys(mine).some((id) => steps.has(splitSlotId(id)[1]));
  return changed ? '<span class="ts-dot draft" title="Changed in this draft"></span>' : custom ? '<span class="ts-dot custom" title="Has its own tags"></span>' : '';
}

function navHTML() {
  const groups = {};
  for (const j of JOURNEYS) (groups[j.group] ||= []).push(j);
  const jhtml = Object.entries(groups).map(([g, js]) => `
    <div class="ts-group">${esc(g)}</div>
    ${js.map((j) => `<button type="button" class="ts-slot${S.nav === `j:${j.id}` ? ' on' : ''}" data-act="nav" data-nav="j:${esc(j.id)}">
      <span>${esc(j.title)}</span>${journeyMarks(j)}</button>`).join('')}`).join('');
  const shared = [['beat.header', 'Header badges'], ['payment.result', 'Payment result rules'], ['http.status', 'HTTP status rules']];
  return `${jhtml}
    <div class="ts-group">Shared defaults</div>
    <p class="ts-navnote">What every card shows unless it has its own.</p>
    ${shared.map(([id, t]) => {
      const changed = canon(compact(slots())[id]) !== canon(pubSlots()[id]);
      return `<button type="button" class="ts-slot${S.nav === `s:${id}` ? ' on' : ''}" data-act="nav" data-nav="s:${id}"><span>${t}</span>${changed ? '<span class="ts-dot draft"></span>' : ''}</button>`;
    }).join('')}`;
}

/* ── Journey editor ──────────────────────────────────────── */

const methodPill = (c) => `<span class="method-pill ${c.sim ? 'sim' : esc(c.method.toLowerCase())}">${esc(c.method)}</span>`;
const varsFor = (key) => Object.fromEntries((SLOTS[BH].entries[key]?.vars || []).map((n) => [n, SAMPLE_VARS[n] ?? n]));
const headerChip = (key, step) => withConfig(draftCfg(), () => {
  const b = resolveBeatBadge(key, varsFor(key), step);
  return b.badge ? `<span class="beat-state ${esc(b.badgeKind)}">${esc(b.badge)}</span>` : '<span class="ts-hiddenmark">hidden</span>';
});

function srcCell(key, step, source) {
  if (source === 'card') {
    const others = stepIdsWith(BH, key).length - 1;
    return `<span class="ts-src-chip own" title="Only this card">this card</span>
      <button type="button" class="ts-mini" data-act="reset-entry" title="Go back to the shared default">↺ shared</button>
      <button type="button" class="ts-mini" data-act="apply-all" title="Make this the shared default and clear other cards’ own versions">apply to all${others > 0 ? ` (+${others} custom)` : ''}</button>`;
  }
  return `<span class="ts-src-chip" title="${source === 'shared' ? 'The shared default (edited)' : 'The code default'}">${source === 'shared' ? 'shared' : 'default'}</span>`;
}

function stateRowHTML(st, step) {
  const { e, source } = entryAt(st.key, step);
  return `<tr data-k="${esc(st.key)}" class="${source === 'card' ? 'own' : ''}">
    <td class="ts-when">${esc(st.when)}<div class="ts-note"><code>${esc(st.key)}</code></div></td>
    <td><input class="ts-in label" data-f="label" maxlength="40" value="${esc(e.label)}" aria-label="Label" /></td>
    <td><select class="ts-in" data-f="tone" aria-label="Tone">${TONES.map((t) => `<option value="${t}" ${t === e.tone ? 'selected' : ''}>${esc(TONE_LABELS[t])}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-f="hidden" ${e.hidden ? 'checked' : ''} aria-label="Hide this badge" title="Hide this badge" /></td>
    <td class="ts-dark ts-rowprev">${headerChip(st.key, step)}</td>
    <td class="ts-src">${srcCell(st.key, step, source)}</td>
  </tr>`;
}

function sampleChips(base, step) {
  const samples = SLOTS[base].samples.slice(0, 4);
  return withConfig(draftCfg(), () => `<div class="ts-samplechips">${samples.map((x) => {
    const t = resolveTag(base, base === 'http.status' ? httpCtx(x.ctx.http.status, x.ctx.error) : x.ctx, step);
    return `<span class="ts-sc"><span class="ts-sc-l">${esc(x.label)}</span>${t.hidden ? '<span class="ts-hiddenmark">hidden</span>' : pillHTML(t)}</span>`;
  }).join('')}</div>`);
}

function rulesRefHTML(base, step, label) {
  const sid = `${base}:${step}`;
  const own = !!slots()[sid];
  const openNow = own && S.openRules === sid;
  return `<div class="ts-rulesref${own ? ' own' : ''}" data-base="${esc(base)}">
    <div class="ts-rulesref-head">
      <b>${esc(label)}</b>
      <span class="ts-src-chip${own ? ' own' : ''}">${own ? 'this card’s own rules' : `shared ${esc(SLOTS[base].title)} rules`}</span>
      <span class="ts-tools">${own
        ? `<button type="button" class="ts-mini" data-act="rules-toggle">${openNow ? 'Hide rules' : 'Edit rules'}</button>
           <button type="button" class="ts-mini" data-act="rules-shared">↺ shared</button>
           <button type="button" class="ts-mini" data-act="rules-all">apply to all</button>`
        : '<button type="button" class="ts-mini" data-act="rules-customise">Customise for this card</button>'}</span>
    </div>
    <div class="ts-dark ts-samplewrap">${sampleChips(base, step)}</div>
    ${openNow ? `<div class="ts-rules-inline">${rulesEditorHTML(sid)}</div>` : ''}
  </div>`;
}

function sideHTML(side, label) {
  const step = side.step;
  return `<div class="ts-side" data-step="${esc(step)}" id="ts-step-${esc(step)}">
    <div class="ts-side-label">${esc(label)}</div>
    ${side.states.length ? `<table class="ts-states"><thead><tr><th>When</th><th>Header badge</th><th>Tone</th><th>Hide</th><th>Shows</th><th></th></tr></thead><tbody>${side.states.map((st) => stateRowHTML(st, step)).join('')}</tbody></table>` : ''}
    ${side.rules ? rulesRefHTML(side.rules, step, 'Result pill + header badge') : ''}
    ${side.http ? rulesRefHTML('http.status', step, 'HTTP pill') : ''}
  </div>`;
}

function journeyHTML(j) {
  return `
    <div class="ts-ed-head"><h2>${esc(j.title)}</h2>
      <p>The cards in the order the engine room shows them. Edits apply to that card only; untouched cards follow the shared defaults.</p>
      <p>Each call also lists its <b>Sequence</b> expectations — response criteria, the webhooks it fires, and the async step after it. <button type="button" class="ts-mini" data-act="copy-seq" data-j="${esc(j.id)}">Copy as proposal</button></p></div>
    <ol class="ts-timeline">${j.calls.map((id, i) => {
      const c = CALLS[id];
      const also = journeysOf(id).filter((x) => x.id !== j.id);
      return `<li class="ts-call">
        <div class="ts-call-head"><span class="ts-n">${i + 1}</span>${methodPill(c)}<code class="ts-path">${esc(c.path)}</code></div>
        <div class="ts-call-title">${esc(c.title)}${also.length ? `<span class="ts-also">same card in ${also.map((x) => esc(x.title)).join(', ')}</span>` : ''}</div>
        ${c.req ? sideHTML(c.req, 'Request card') : ''}
        ${c.res ? sideHTML(c.res, c.res.single ? 'Card' : 'Response card') : ''}
        ${seqSpecHTML(id)}
      </li>`;
    }).join('')}</ol>`;
}

/* The engine room's Sequence expectations for one call — read-only here
   (they live in tags/registry.js EXPECT / ASYNC); "Copy as proposal" hands
   the journey's whole spec over as Markdown to mark up. */
function seqSpecHTML(call) {
  const spec = callSpec(call);
  if (!spec.length) return '';
  const list = (xs) => (xs.length ? `<ul>${xs.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : '<span class="ts-note">none</span>');
  return `<div class="ts-side ts-seq"><div class="ts-side-label">Sequence · what this call should produce <span class="ts-note">read-only</span></div>
    ${spec.map((v) => `${v.label ? `<div class="ts-seq-variant">${esc(v.label)}</div>` : ''}
      <table class="ts-seq-table"><thead><tr><th>Outcome</th><th>Response criteria</th><th>Sync webhooks</th><th>Then, async</th></tr></thead><tbody>
      ${v.scenarios.map((s) => `<tr><td>${esc(s.title)}</td><td>${list(s.criteria)}</td><td>${list(s.sync)}</td>
        <td>${s.async ? `<b>${esc(s.async.title)}</b><div class="ts-note">${esc(s.async.trigger)}</div>${list(s.async.sync)}` : '<span class="ts-note">—</span>'}</td></tr>`).join('')}
      </tbody></table>`).join('')}
  </div>`;
}

/* ── Rules editor (shared slot or one card's) ────────────── */

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
  if (c.op === 'in') return `<input class="ts-in" data-f="value" value="${esc((Array.isArray(v) ? v : []).join(', '))}" placeholder="CLO, ACT" title="Comma-separated" />`;
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

function lookHTML(r, name, fields) {
  return `<div class="ts-look">
    <label class="ts-field"><span>Label</span><input class="ts-in label" data-f="label" maxlength="40" value="${esc(r.label)}" /></label>
    <div class="ts-chips"><span>Insert</span>${fields.map((f) => `<button type="button" class="ts-chip" data-act="insert" data-ph="${esc(f)}">{${esc(f)}}</button>`).join('')}</div>
    ${toneRadios(name, r.tone)}
    <label class="ts-check"><input type="checkbox" data-f="hidden" ${r.hidden ? 'checked' : ''} /> Hide this tag</label>
  </div>`;
}

function rulesEditorHTML(sid) {
  const [base] = splitSlotId(sid);
  const def = SLOTS[base];
  const s = rulesOf(sid);
  const tag = sid.replace(/[^a-z0-9]/gi, '_');
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
      ${lookHTML(r, `tone-${tag}-${i}`, def.fields)}
    </li>`;
  }).join('');
  const fb = s.fallback || {};
  const others = Object.keys(SLOTS).filter((x) => x !== base && SLOTS[x].kind === 'rules');
  return `<div class="ts-rules-ed" data-sid="${esc(sid)}">
    <p class="ts-hint">Rules run top to bottom; the first match wins.</p>
    <ol class="ts-rules">${rules}</ol>
    <button type="button" class="ts-btn" data-act="add-rule">+ Add rule</button>
    <div class="ts-rule ts-fallback" data-r="fb">
      <div class="ts-rule-head"><span class="ts-n">⋯</span><span>Otherwise</span>
        <select class="ts-in" data-f="fb-mode">
          <option value="custom" ${fb.slot ? '' : 'selected'}>show this label</option>
          ${others.map((x) => `<option value="${esc(x)}" ${fb.slot === x ? 'selected' : ''}>use the ${esc(SLOTS[x].title)} tag</option>`).join('')}
        </select></div>
      ${fb.slot ? '' : lookHTML({ label: fb.label || '', tone: fb.tone || 'neutral', hidden: fb.hidden }, `tone-${tag}-fb`, def.fields)}
    </div>
  </div>`;
}

/* ── Shared-defaults editors ─────────────────────────────── */

function sharedRulesHTML(base) {
  const def = SLOTS[base];
  const own = stepIdsWith(base);
  return `
    <div class="ts-ed-head"><h2>${esc(def.title)} · shared rules</h2><p>${esc(def.help)}</p>
      <p class="ts-hint">Every card follows these unless it has its own${own.length ? ` — ${own.length} card${own.length === 1 ? '' : 's'} do: ${own.map((s) => `<code>${esc(s)}</code>`).join(' ')}` : ''}.</p></div>
    ${rulesEditorHTML(base)}
    <button type="button" class="ts-link danger" data-act="reset-shared-rules">↺ Reset the shared ${esc(def.title)} rules to the code defaults</button>`;
}

function sharedDictHTML() {
  const def = SLOTS[BH];
  const rows = Object.keys(def.entries).map((k) => {
    const d = def.entries[k];
    const e = sharedEntry(slots(), k);
    const changed = canon(e) !== canon(look(d));
    const n = stepIdsWith(BH, k).length;
    return `<tr data-k="${esc(k)}" class="${changed ? 'changed' : ''}">
      <td><code>${esc(k)}</code>${d.note ? `<div class="ts-note">${esc(d.note)}</div>` : ''}${d.vars?.length ? `<div class="ts-note">vars: ${d.vars.map((v) => `{${esc(v)}}`).join(' ')}</div>` : ''}</td>
      <td><input class="ts-in label" data-f="label" maxlength="40" value="${esc(e.label)}" /></td>
      <td><select class="ts-in" data-f="tone">${TONES.map((t) => `<option value="${t}" ${t === e.tone ? 'selected' : ''}>${esc(TONE_LABELS[t])}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-f="hidden" aria-label="Hide" ${e.hidden ? 'checked' : ''} /></td>
      <td class="ts-dark ts-rowprev">${headerChip(k, null)}</td>
      <td class="ts-note">${n ? `${n} card${n === 1 ? '' : 's'} override` : ''}${changed ? ` <button type="button" class="ts-icon" data-act="reset-shared-entry" title="Back to “${esc(d.label)}”">↺</button>` : ''}</td>
    </tr>`;
  }).join('');
  return `
    <div class="ts-ed-head"><h2>Header badges · shared defaults</h2>
      <p>The badge every card shows for each state, unless the card has its own (set in its journey).</p></div>
    <table class="ts-dict" data-shared><thead><tr><th>Key</th><th>Label</th><th>Tone</th><th>Hide</th><th>Shows</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ── Preview ─────────────────────────────────────────────── */

const SCEN_CTX = {
  success: { http: { status: 200 }, data: { status: 'CLO', paid: true } },
  action: { http: { status: 200 }, data: { status: 'ACT', paid: false, next_action: '3d_verification' } },
  failure: { http: { status: 400 }, data: {}, error: 'ERROR_PROCESSING_CARD' },
};
const pick = (states, sc) => states.find((s) => s.scenarios.includes(sc)) || null;

function previewCard(c, side, n, sc) {
  const step = side.step;
  const id = `beat-${step}`;
  const isRes = STEPS[step].side === 'res';
  const base = { id, n: String(n), method: c.method, path: c.path, sim: !!c.sim };
  if (!isRes) {
    const st = pick(side.states, sc);
    return beatCardHTML({ ...base, ...(st ? { badgeKey: st.key, badgeVars: varsFor(st.key) } : {}), inner: '' });
  }
  if (sc === 'prepared' && !side.single) return '';
  if (sc === 'sending' && !side.single) {
    const st = pick(side.states, 'sending');
    return beatCardHTML({ ...base, ...(st ? { badgeKey: st.key } : {}), inner: '<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>' });
  }
  const scen = sc === 'prepared' || sc === 'sending' ? 'success' : sc;
  const ctx = SCEN_CTX[scen];
  if (side.rules) {
    const t = resolveTag(side.rules, paymentCtx(ctx.http.status, { data: ctx.data, ...(ctx.error ? { error: ctx.error } : {}) }), step);
    return beatCardHTML({ ...base, badge: t.hidden ? '' : t.label, badgeKind: beatClass(t.tone),
      inner: `<div class="eng-pillrow">${httpPillHTML(ctx.http.status, null, step)}${pillHTML(t)}</div>` });
  }
  const st = pick(side.states, scen);
  const fail = scen === 'failure';
  return beatCardHTML({ ...base, ...(st ? { badgeKey: st.key, badgeVars: varsFor(st.key) } : {}),
    inner: `<div class="eng-pillrow">${httpPillHTML(fail ? 400 : 200, fail ? ctx.error : null, step)}${!side.single && st ? badgePillHTML(st.key, varsFor(st.key), step) : ''}</div>` });
}

function journeyScenarios(j) {
  const set = new Set();
  for (const id of j.calls) for (const side of ['req', 'res']) {
    const sd = CALLS[id][side];
    if (!sd) continue;
    sd.states.forEach((s) => s.scenarios.forEach((x) => set.add(x)));
    if (sd.rules) ['success', 'action', 'failure'].forEach((x) => set.add(x));
  }
  return Object.keys(SCENARIOS).filter((x) => set.has(x));
}

function journeyPreviewHTML(j) {
  const scens = journeyScenarios(j);
  if (!scens.includes(S.scenario)) S.scenario = scens.includes('success') ? 'success' : scens[0];
  const cards = withConfig(draftCfg(), () => j.calls.map((id, i) => {
    const c = CALLS[id];
    return ['req', 'res'].filter((s) => c[s]).map((s) => `<div class="ts-pv" data-act="goto" data-step="${esc(c[s].step)}">${previewCard(c, c[s], i + 1, S.scenario)}</div>`).join('');
  }).join(''));
  return `
    <div class="ts-prev-head">Preview · <span>${esc(j.title)}</span></div>
    <div class="ts-scen">${scens.map((x) => `<button type="button" class="ts-chip${x === S.scenario ? ' on' : ''}" data-act="scenario" data-sc="${x}">${esc(SCENARIOS[x])}</button>`).join('')}</div>
    <div class="ts-prev-stack">${cards}</div>
    <p class="ts-prev-foot">Request cards, then responses, in engine-room order. Click a card to jump to its tags.</p>`;
}

function sharedRulesPreviewHTML(base) {
  const def = SLOTS[base];
  const draft = draftCfg();
  const pub = { slots: pubSlots() };
  const tagOf = (cfg, ctx) => withConfig(cfg, () => resolveTag(base, base === 'http.status' ? httpCtx(ctx.http.status, ctx.error) : ctx));
  const show = (t) => (t.hidden ? '<span class="ts-hiddenmark">hidden</span>' : pillHTML(t));
  const rows = def.samples.map((x) => {
    const d = tagOf(draft, x.ctx); const p = tagOf(pub, x.ctx);
    return `<tr><td>${esc(x.label)}</td><td>${show(p)}</td><td>${show(d)}${canon(d) !== canon(p) ? ' <span class="ts-chg">changed</span>' : ''}</td>
      <td class="ts-hit">${esc(d.ruleId === 'fallback' ? 'otherwise' : `rule ${d.ruleId ?? '—'}`)}</td></tr>`;
  }).join('');
  return `<div class="ts-prev-head">Preview · <span>shared ${esc(def.title)} rules</span></div>
    <table class="ts-grid"><thead><tr><th>Sample</th><th>Published</th><th>Draft</th><th>Hit</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="ts-prev-foot">Cards with their own rules aren’t affected.</p>`;
}

function sharedDictPreviewHTML() {
  const cards = withConfig(draftCfg(), () => Object.keys(SLOTS[BH].entries).map((k) => beatCardHTML({
    id: `ts-shared-${k}`, method: k.startsWith('sim.') ? 'AUTH' : 'POST', sim: k.startsWith('sim.'), path: k, badgeKey: k, badgeVars: varsFor(k), inner: '',
  })).join(''));
  return `<div class="ts-prev-head">Preview · <span>shared header badges</span></div><div class="ts-prev-stack">${cards}</div>`;
}

const navJourney = () => (S.nav.startsWith('j:') ? JOURNEYS.find((j) => j.id === S.nav.slice(2)) : null);
function editorHTML() {
  const j = navJourney();
  if (j) return journeyHTML(j);
  const base = S.nav.slice(2);
  return base === BH ? sharedDictHTML() : sharedRulesHTML(base);
}
function previewHTML() {
  const j = navJourney();
  if (j) return journeyPreviewHTML(j);
  const base = S.nav.slice(2);
  return base === BH ? sharedDictPreviewHTML() : sharedRulesPreviewHTML(base);
}

/* ── Modals ──────────────────────────────────────────────── */

function slotLabel(id) {
  const [base, step] = splitSlotId(id);
  if (!step) return `Shared ${SLOTS[base].kind === 'dict' ? 'header badges' : `${SLOTS[base].title} rules`}`;
  const call = CALLS[STEPS[step]?.call];
  const js = call ? journeysOf(STEPS[step].call).map((j) => j.title).join(' / ') : '';
  return `${call ? esc(call.title) : esc(step)} · ${sideName(step)}${js ? ` <span class="ts-note">(${esc(js)})</span>` : ''}`;
}
function changesList() {
  const mine = compact(slots());
  const pub = pubSlots();
  const ids = [...new Set([...Object.keys(mine), ...Object.keys(pub)])].filter((id) => canon(mine[id]) !== canon(pub[id]));
  return ids.map((id) => {
    const [base] = splitSlotId(id);
    let what;
    if (!mine[id]) what = 'back to the default';
    else if (SLOTS[base].kind === 'rules') what = `${base === 'http.status' ? 'HTTP' : 'result'} rules changed`;
    else what = Object.entries(mine[id].entries).filter(([k, e]) => canon(e) !== canon(pub[id]?.entries?.[k])).map(([k, e]) => `<code>${esc(k)}</code> → “${esc(e.label)}”${e.hidden ? ' (hidden)' : ''}`).join(', ') || 'entries reset';
    return `<li><b>${slotLabel(id)}</b> — ${what}</li>`;
  }).join('');
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
  const top = $('.ts-editor', S.root)?.scrollTop || 0;
  S.root.innerHTML = `
    ${headerHTML()}
    <div class="ts-body">
      <nav class="ts-slots" aria-label="Journeys">${navHTML()}</nav>
      <section class="ts-editor">${editorHTML()}</section>
      <aside class="ts-preview">${previewHTML()}</aside>
    </div>
    ${S.modal ? `<div class="ts-modal-back">${modalHTML()}</div>` : ''}`;
  const ed = $('.ts-editor', S.root);
  if (ed) ed.scrollTop = top;
  openPreviewCards();
  if (S.modal === 'publish') $('#ts-note', S.root)?.focus();
}
function openPreviewCards() { S.root.querySelectorAll('.ts-preview details').forEach((d) => { d.open = !!d.querySelector('.beat-body *'); }); }

/** After a keystroke: repaint everything EXCEPT the editor's inputs (keeps focus/caret). */
function renderLight(row) {
  const head = $('.ts-head', S.root);
  if (head) {
    const tmp = document.createElement('div');
    tmp.innerHTML = headerHTML();
    $('.ts-msg', S.root)?.remove();
    head.replaceWith(...tmp.childNodes);
  }
  const nav = $('.ts-slots', S.root); if (nav) nav.innerHTML = navHTML();
  const pv = $('.ts-preview', S.root); if (pv) pv.innerHTML = previewHTML();
  openPreviewCards();
  // the touched row's preview chip + source cell; rule editors' sample chips
  if (row) {
    const step = row.closest('[data-step]')?.dataset.step || null;
    const k = row.dataset.k;
    const prev = $('.ts-rowprev', row); if (prev) prev.innerHTML = headerChip(k, step);
    if (step) {
      const src = entryAt(k, step);
      row.classList.toggle('own', src.source === 'card');
      const cell = $('.ts-src', row); if (cell) cell.innerHTML = srcCell(k, step, src.source);
    }
  }
  S.root.querySelectorAll('.ts-rulesref').forEach((ref) => {
    const step = ref.closest('[data-step]')?.dataset.step;
    const wrap = $('.ts-samplewrap', ref);
    if (wrap && step) wrap.innerHTML = sampleChips(ref.dataset.base, step);
  });
  syncPreviewInApp();
}
function syncPreviewInApp() { if (S.preview) setPreviewDraft(draftCfg()); }

/* ── Editing ─────────────────────────────────────────────── */

const ruleAt = (el) => {
  const ed = el.closest('[data-sid]');
  const li = el.closest('[data-r]');
  if (!ed || !li) return null;
  const s = ensureRules(ed.dataset.sid);
  if (li.dataset.r === 'fb') return { sid: ed.dataset.sid, s, rule: s.fallback || (s.fallback = { label: '', tone: 'neutral' }) };
  return { sid: ed.dataset.sid, s, i: Number(li.dataset.r), rule: s.rules[Number(li.dataset.r)] };
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
const editedLook = (e, f, el) => {
  const n = look(e);
  if (f === 'label') n.label = el.value;
  if (f === 'tone') n.tone = el.value;
  if (f === 'hidden') { if (el.checked) n.hidden = true; else delete n.hidden; }
  return n;
};

function onInput(e) {
  const el = e.target;
  const f = el.dataset?.f;
  if (!f) return;
  // A card's header-badge state row (journey view)
  const row = el.closest('tr[data-k]');
  if (row && !el.closest('[data-sid]')) {
    const k = row.dataset.k;
    if (el.closest('[data-shared]')) {
      setEntry(null, k, editedLook(sharedEntry(slots(), k), f, el));
      row.classList.toggle('changed', canon(sharedEntry(slots(), k)) !== canon(look(SLOTS[BH].entries[k])));
    } else {
      const step = el.closest('[data-step]').dataset.step;
      setEntry(step, k, editedLook(entryAt(k, step).e, f, el));
    }
    renderLight(row);
    return;
  }
  // A rules editor (shared or one card's)
  const at = ruleAt(el);
  if (!at) return;
  const { rule, s } = at;
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
  } else if (f === 'mode') rule.when = { [el.value]: condsOf(rule) || [] };
  else if (f === 'label') rule.label = el.value;
  else if (f === 'tone') rule.tone = el.value;
  else if (f === 'hidden') { if (el.checked) rule.hidden = true; else delete rule.hidden; }
  else if (f === 'fb-mode') {
    s.fallback = el.value === 'custom' ? { label: 'HTTP {http.status}', tone: 'neutral' } : { slot: el.value };
    structural = true;
  }
  if (structural) { render(); syncPreviewInApp(); } else renderLight();
}

function gotoStep(step) {
  const target = $(`#ts-step-${CSS.escape(step)}`, S.root);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1000);
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !S.root.contains(btn)) return;
  const act = btn.dataset.act;
  if (act === 'preview') return; // the checkbox's change event handles it
  const stepEl = btn.closest('[data-step]');
  const step = stepEl?.dataset.step;
  const k = btn.closest('tr[data-k]')?.dataset.k;
  const ref = btn.closest('.ts-rulesref');
  switch (act) {
    case 'close': return closeStudio();
    case 'nav': S.nav = btn.dataset.nav; S.openRules = null; $('.ts-editor', S.root) && ($('.ts-editor', S.root).scrollTop = 0); return render();
    case 'scenario': S.scenario = btn.dataset.sc; return renderLight();
    case 'goto': e.preventDefault(); return gotoStep(btn.dataset.step);
    case 'copy-seq': {
      const j = JOURNEYS.find((x) => x.id === btn.dataset.j);
      if (!j) return;
      const md = journeyMarkdown(j);
      try { await navigator.clipboard.writeText(md); S.msg = { kind: 'info', text: `${j.title}: the expected sequence is on your clipboard as Markdown — mark it up and hand it back.` }; }
      catch { S.msg = { kind: 'error', text: 'Couldn’t reach the clipboard — the spec is in the browser console instead.' }; console.info(md); }
      return render();
    }
    // a card's own badge
    case 'reset-entry': clearEntry(step, k); break;
    case 'apply-all': applyEntryEverywhere(k, entryAt(k, step).e); S.msg = { kind: 'info', text: `“${entryAt(k, step).e.label}” is now the shared ${k} badge for every card.` }; break;
    case 'reset-shared-entry': { const s = slots()[BH]; if (s) { delete s.entries[k]; if (!Object.keys(s.entries).length) delete slots()[BH]; } break; }
    // a card's own rules
    case 'rules-customise': { const sid = `${ref.dataset.base}:${step}`; ensureRules(sid); S.openRules = sid; break; }
    case 'rules-toggle': { const sid = `${ref.dataset.base}:${step}`; S.openRules = S.openRules === sid ? null : sid; break; }
    case 'rules-shared': delete slots()[`${ref.dataset.base}:${step}`]; S.openRules = null; break;
    case 'rules-all': {
      const base = ref.dataset.base;
      slots()[base] = clone(slots()[`${base}:${step}`]);
      for (const s of stepIdsWith(base)) delete slots()[`${base}:${s}`];
      S.openRules = null;
      S.msg = { kind: 'info', text: `These ${SLOTS[base].title} rules are now the shared rules for every card.` };
      break;
    }
    case 'reset-shared-rules': delete slots()[S.nav.slice(2)]; break;
    // rule editing
    case 'add-rule': case 'del-rule': case 'up': case 'down': case 'add-cond': case 'del-cond': {
      const sid = btn.closest('[data-sid]').dataset.sid;
      const s = ensureRules(sid);
      const base = splitSlotId(sid)[0];
      const fields = SLOTS[base].fields;
      if (act === 'add-rule') s.rules.push({ id: newRuleId(s.rules), when: { all: [defaultCond(fields[0])] }, label: 'NEW TAG', tone: 'neutral' });
      else {
        const { i, rule } = ruleAt(btn);
        if (act === 'del-rule') s.rules.splice(i, 1);
        if (act === 'up' || act === 'down') { const j = act === 'up' ? i - 1 : i + 1; if (j >= 0 && j < s.rules.length) [s.rules[i], s.rules[j]] = [s.rules[j], s.rules[i]]; }
        if (act === 'add-cond') { const list = condsOf(rule); if (list) list.push(defaultCond(fields[0])); else rule.when = { all: [defaultCond(fields[0])] }; }
        if (act === 'del-cond') { const list = condsOf(rule); list.splice(Number(btn.closest('[data-c]').dataset.c), 1); if (!list.length) delete rule.when; }
      }
      break;
    }
    case 'insert': {
      const lk = btn.closest('.ts-look');
      const input = $('input[data-f="label"]', lk);
      const ph = `{${btn.dataset.ph}}`;
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + ph + input.value.slice(input.selectionEnd ?? at);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return;
    }
    // shell
    case 'discard': S.cfg = { slots: clone(S.published?.slots || {}) }; S.msg = null; break;
    case 'publish': S.modal = 'publish'; break;
    case 'modal-close': S.modal = null; break;
    case 'publish-confirm': return doPublish();
    case 'history': S.modal = 'history'; S.history = null; render(); return loadHistory();
    case 'rollback': return doRollback(Number(btn.dataset.version));
    case 'conflict-load': await refreshPublished(); S.cfg = { slots: clone(S.published?.slots || {}) }; S.modal = null; S.msg = { kind: 'ok', text: `Loaded v${S.published?.version || 0}.` }; break;
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
  const r = await publishTagConfig({ baseVersion: S.published?.version || 0, slots: compact(slots()), updatedBy: adminName(), note });
  S.busy = false;
  if (r.ok) {
    S.published = r.data;
    cachePublished(r.data);
    S.cfg = { slots: clone(r.data.slots || {}) };
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
    S.published = r.data; cachePublished(r.data); S.cfg = { slots: clone(r.data.slots || {}) };
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
  S.cfg = { slots: clone(getDraft()?.slots || S.published?.slots || {}) };
  S.preview = !!getDraft();
  S.open = true; S.modal = null; S.msg = null;
  S.root.hidden = false;
  document.body.classList.add('ts-open');
  render();
  // Re-base an untouched draft on the freshest published version.
  const untouched = canon(compact(slots())) === canon(pubSlots());
  await refreshPublished();
  if (untouched) S.cfg = { slots: clone(S.published?.slots || {}) };
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
