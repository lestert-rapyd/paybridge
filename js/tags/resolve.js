/* ─────────────────────────────────────────────────────────────
   resolveTag(slot, ctx) → { label, tone, hidden, ruleId }

   Pure data → text. No eval, no HTML: conditions are a small fixed set of
   ops over an allowlisted field path, templates only substitute `{field}`
   placeholders, and the returned label is plain text for the caller (or
   the helpers at the bottom) to escape.
   ───────────────────────────────────────────────────────────── */

import { SLOTS, TONES } from './registry.js';
import { overrideFor } from './store.js';
import { esc } from '../ui.js';

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const present = (v) => v !== undefined && v !== null && v !== '';

function test(cond, ctx, fields) {
  if (!cond || !fields.includes(cond.field)) return false;
  const v = get(ctx, cond.field);
  switch (cond.op) {
    case 'eq': return v === cond.value;
    case 'neq': return v !== cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(v);
    case 'exists': return cond.value === false ? !present(v) : present(v);
    case 'between': {
      const [lo, hi] = Array.isArray(cond.value) ? cond.value : [];
      return typeof v === 'number' && v >= Number(lo) && v <= Number(hi);
    }
    default: return false;
  }
}

/** `when` omitted = always; { all: [...] } / { any: [...] }. */
export function matches(when, ctx, fields) {
  if (!when) return true;
  if (Array.isArray(when.all)) return when.all.every((c) => test(c, ctx, fields));
  if (Array.isArray(when.any)) return when.any.some((c) => test(c, ctx, fields));
  return false;
}

/** Fill `{name}` from `lookup(name)` for allowlisted names; anything else
    stays literal, so a typo shows up in the preview instead of vanishing. */
export function fillTemplate(label, allowed, lookup) {
  return String(label ?? '').replace(/\{([a-z0-9_.]+)\}/gi, (whole, name) => {
    if (!allowed.includes(name)) return whole;
    const v = lookup(name);
    return present(v) ? String(v) : '';
  });
}

const toneOf = (t) => (TONES.includes(t) ? t : 'neutral');

/** The effective rule list for a rules slot (override or defaults). */
export function effectiveRules(slotId) {
  const def = SLOTS[slotId];
  const o = overrideFor(slotId);
  return { rules: o?.rules || def.rules, fallback: o?.fallback || def.fallback };
}

/** Effective entry for a dict slot key: override merged over the default. */
export function effectiveEntry(slotId, key) {
  const def = SLOTS[slotId]?.entries?.[key];
  if (!def) return null;
  const o = overrideFor(slotId)?.entries?.[key];
  return o ? { ...def, ...o, vars: def.vars } : def;
}

export function resolveTag(slotId, ctx = {}, depth = 0) {
  const def = SLOTS[slotId];
  if (!def || def.kind !== 'rules') return { label: '', tone: 'neutral', hidden: true, ruleId: null };
  const { rules, fallback } = effectiveRules(slotId);
  const hit = rules.find((r) => matches(r.when, ctx, def.fields));
  if (!hit && fallback?.slot && fallback.slot !== slotId && depth < 2) {
    return resolveTag(fallback.slot, ctx, depth + 1);
  }
  const r = hit || fallback || { label: '', tone: 'neutral' };
  return {
    label: fillTemplate(r.label, def.fields, (f) => get(ctx, f)),
    tone: toneOf(r.tone),
    hidden: !!r.hidden,
    ruleId: hit ? hit.id ?? null : 'fallback',
  };
}

/** A dictionary badge: resolveBadge('beat.header', 'request.sent'). An
    unknown key resolves hidden — callers only pass keys from registry.js. */
export function resolveBadge(slotId, key, vars = {}) {
  const e = effectiveEntry(slotId, key);
  if (!e) return { label: '', tone: 'neutral', hidden: true };
  return {
    label: fillTemplate(e.label, e.vars || [], (n) => vars[n]),
    tone: toneOf(e.tone),
    hidden: !!e.hidden,
  };
}

/* ── Contexts — how the flows' raw values map to the slot fields ── */

/** `error`: pass it only where an error body should turn the pill red. */
export const httpCtx = (status, error) => ({
  http: { status: Number(status) || 0 },
  ...(present(error) ? { error: String(error) } : {}),
});

/** A POST /v1/payments response: api.js's { httpStatus, data } pair. */
export const paymentCtx = (httpStatus, body) => {
  const d = body?.data;
  return {
    http: { status: Number(httpStatus) || 0 },
    data: d ? { status: d.status, paid: d.paid, next_action: d.next_action } : {},
    ...(present(body?.error) ? { error: String(body.error) } : {}),
  };
};

/* ── Tone → the existing CSS families ── */
const WH = { success: 'success', failure: 'failure', pending: 'pending', info: 'info', neutral: 'neutral', sim: 'sim' };
const BEAT = { success: 'ok', failure: 'err', pending: 'live', info: 'live', neutral: '', sim: 'sim' };
export const whClass = (tone) => WH[tone] ?? 'neutral';
export const beatClass = (tone) => BEAT[tone] ?? '';

/* ── Markup helpers (escape here, once) ── */

/** A .wh-pill for a resolved tag, '' when hidden. */
export const pillHTML = (t) => (t.hidden ? '' : `<span class="wh-pill ${whClass(t.tone)}">${esc(t.label)}</span>`);

/** The HTTP pill: httpPillHTML(status) or httpPillHTML(status, errorCode). */
export const httpPillHTML = (status, error) => pillHTML(resolveTag('http.status', httpCtx(status, error)));

/** beatCardHTML's { badge, badgeKind } for a beat.header key. */
export function beatBadge(key, vars) {
  const t = resolveBadge('beat.header', key, vars);
  return t.hidden ? { badge: '', badgeKind: '' } : { badge: t.label, badgeKind: beatClass(t.tone) };
}

/** The same key as a body .wh-pill (response cards echo their header badge). */
export const badgePillHTML = (key, vars) => pillHTML(resolveBadge('beat.header', key, vars));
