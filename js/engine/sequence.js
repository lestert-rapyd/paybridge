/* ─────────────────────────────────────────────────────────────
   Engine room · the Sequence view.

   One expandable card per EVENT (a Rapyd call, a simulated step, or an
   async step that follows one), each broken into its backend parts:

     Headers → API request → API response (+ criteria) → Webhooks (sync)

   followed by the async events (the webhooks a later shopper/Rapyd step
   produces) and, last, "Other events": webhooks about this run that no
   expectation claimed.

   The flows' contract is unchanged: they still build one beat card per call
   side (customer-beat.js beatCardHTML — `beat-<step>` for the request,
   `beat-<step>-res` for the response) and hand the panel's markup over with
   setPanel('request' | 'response', html). This module parses those cards,
   groups the two sides of a call into one event (registry STEPS), moves the
   signed headers into their own layer, and paints the whole sequence. The
   event keeps the request card's id, so the flows' own signature fills
   ($('#beat-pay') …) and JSON highlights keep finding their nodes.

   What a call is EXPECTED to produce — response criteria, sync and async
   webhooks — is data in tags/registry.js (EXPECT / ASYNC), the same file
   the Tag Studio reads. Values are read back out of the rendered JSON
   (every value carries its data-path), so no flow has to pass its response
   twice.

   Webhooks arrive through ingestWebhooks() from every poller (webhooks.js,
   add-card, wallet, back office) and are attributed by attribute() — pure,
   unit-tested — to the first expected slot whose type matches and whose
   linked ids agree.

   Two sources: the client site's and the back office's. The panel shows
   whichever the left tab is on; the other keeps its markup for when the SE
   switches back.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { esc } from '../ui.js';
import { CALLS, STEPS, ASYNC, WEBHOOK_NOTES, expectFor } from '../tags/registry.js';
import { eventCardHTML } from './wh-card.js';

const SKEW_MS = 30000; // server vs browser clock

/* ── Pure helpers (exported for the unit tests) ───────────── */

/** `a.b.0.c` over an object. */
export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const present = (v) => v !== undefined && v !== null && v !== '';

/** One criterion over a value lookup: { pass: true | false | null (no data) }. */
export function checkCriterion(c, lookup) {
  const v = lookup(c.path);
  switch (c.op) {
    case 'exists': return present(v);
    case 'eq': return v === undefined ? false : v === c.value;
    case 'neq': return v !== c.value;
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
    default: return false;
  }
}

/** Which scenario a response is: 'failure' | 'action' | 'success'. */
export function scenarioOf(lookup, httpStatus = null) {
  const st = lookup('status.status');
  if (present(lookup('error')) || st === 'ERROR' || (httpStatus != null && (httpStatus === 0 || httpStatus >= 400))) return 'failure';
  if (lookup('data.status') === 'ACT' || lookup('data.next_action') === '3d_verification') return 'action';
  return 'success';
}

const ID_KINDS = [['payment_', 'payment'], ['cus_', 'customer'], ['card_', 'card'], ['payout_', 'payout'], ['checkout_', 'checkout'], ['hp_', 'hosted']];
/** The ids a call's JSON names: { payment, customer, card, payout, checkout, hosted, ref }.
    Only shallow paths count (data.id, data.customer_token, customer …) —
    deep ones (payment_method_data.id …) describe something else. */
export function idsFrom(entries) {
  const ids = {};
  for (const [path, v] of entries) {
    if (typeof v !== 'string' || !v) continue;
    const depth = path.split('.').length;
    if (/(^|\.)merchant_reference_id$/.test(path) && depth <= 2) { ids.ref ??= v; continue; }
    if (depth > 2) continue;
    if (!/(^|\.)(id|customer|customer_token|payment_method|payment|payout|checkout)$/.test(path)) continue;
    const hit = ID_KINDS.find(([p]) => v.startsWith(p));
    if (hit) ids[hit[1]] ??= v;
  }
  return ids;
}

const keyOf = (w) => w.event_id || `${w.type}|${w.received_at}`;
const typeMatches = (slot, w) => (slot.anyOf ? slot.anyOf.includes(w.type) : slot.type === w.type);

/** Every link whose id is known AND whose path the webhook carries must agree,
    and at least one must be comparable. */
export function linksMatch(links = {}, w, ids) {
  let compared = 0;
  for (const [path, kind] of Object.entries(links)) {
    const want = ids[kind];
    const got = getPath(w.raw, path);
    if (!present(want) || !present(got)) continue;
    if (want !== got) return false;
    compared++;
  }
  return compared > 0;
}

/** Ids a claimed webhook reveals (a payment's card, a card's payment). */
function learn(ids, w) {
  const d = w.raw?.data || {};
  const put = (kind, v) => { if (typeof v === 'string' && v && !ids[kind]) ids[kind] = v; };
  for (const v of [d.id, d.payment_method, d.customer_token, d.customer]) {
    const hit = typeof v === 'string' && ID_KINDS.find(([p]) => v.startsWith(p));
    if (hit) put(hit[1], v);
  }
}

const RELATE_PATHS = ['data.id', 'data.customer_token', 'data.customer', 'data.payment_method', 'data.merchant_reference_id', 'data.payment', 'data.original_payment'];
function relates(w, known) {
  if (known.has(w.merchant_reference_id) || known.has(w.payment_id)) return true;
  return RELATE_PATHS.some((p) => known.has(getPath(w.raw, p)));
}

/** Attribute webhooks to expected slots.
    groups: [{ id, ids, since, slots: [{ type | anyOf, links }] }] in display
    order — an async group shares its call's `ids` object, so what one
    claimed webhook reveals (a card id) is visible to the next pass.
    Returns { claimed: Map(`${groupId}#${i}` → webhook), other: [webhooks] }. */
export function attribute(groups, webhooks, skew = SKEW_MS) {
  const sorted = [...webhooks].sort((a, b) => (a.received_at || 0) - (b.received_at || 0));
  const claimed = new Map();
  const used = new Set();
  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    for (const g of groups) {
      if (!g.since) continue; // nothing sent yet — nothing can be its webhook
      g.slots.forEach((slot, i) => {
        const sk = `${g.id}#${i}`;
        if (claimed.has(sk)) return;
        const w = sorted.find((x) => !used.has(keyOf(x)) && typeMatches(slot, x)
          && (x.received_at || 0) >= g.since - skew && linksMatch(slot.links, x, g.ids));
        if (!w) return;
        claimed.set(sk, w);
        used.add(keyOf(w));
        learn(g.ids, w);
        progress = true;
      });
    }
    if (!progress) break;
  }
  const sinces = groups.map((g) => g.since).filter(Boolean);
  const from = sinces.length ? Math.min(...sinces) - skew : null;
  const known = new Set(groups.flatMap((g) => Object.values(g.ids)).filter(present));
  const other = from == null ? [] : sorted.filter((w) => !used.has(keyOf(w)) && (w.received_at || 0) >= from && relates(w, known));
  return { claimed, other };
}

/* ── State ─────────────────────────────────────────────────── */
const sides = { client: { request: '', response: '', webhooks: '' }, backoffice: { request: '', response: '', webhooks: '' } };
const activeSource = () => (state.leftView === 'backoffice' ? 'backoffice' : 'client');
const store = new Map();       // webhook key → event
const watches = new Map();     // watch key → { live, text, id, configured, note, fallback }
const firstSeen = new Map();   // `${call}|${response id}` → ms (a response's arrival)
const openState = new Map();   // event / part id → bool
const whOpen = new Set();      // webhook keys the SE expanded
let model = null;              // last painted { events, groups }

const $panel = () => document.getElementById('panel-sequence');

/** Hand a side of the panel over. `side`: 'request' | 'response' | 'webhooks'
    (the last only for loose back-office markup). Paints synchronously — the
    flows sign and highlight the nodes right after. */
export function setPanel(side, html, { source = 'client' } = {}) {
  sides[source][side] = html || '';
  if (source === activeSource()) paint();
}
/** Forget a source's markup (a flow reset). */
export function clearPanels(source = 'client', which = ['request', 'response', 'webhooks']) {
  for (const s of which) sides[source][s] = '';
  if (source === activeSource()) paint();
}

/** Every poller pushes what it read; duplicates are ignored. */
export function ingestWebhooks(list) {
  let changed = false;
  for (const w of list || []) {
    if (!w || !w.type) continue;
    const k = keyOf(w);
    const had = store.get(k);
    if (!had || had.verified !== w.verified) { store.set(k, w); changed = true; }
  }
  if (store.size > 400) [...store.keys()].slice(0, store.size - 400).forEach((k) => store.delete(k));
  if (changed) paintWebhooks();
}
/** One status line per watch (null removes it). */
export function setWatch(key, info) {
  const before = JSON.stringify(watches.get(key) || null);
  if (info) watches.set(key, info); else watches.delete(key);
  if (JSON.stringify(info || null) !== before) paintWebhooks();
}
/** Fold or unfold an event (customer-beat folds its card once it's done). */
export function setEventOpen(id, open) { openState.set(id, !!open); }

/** Repaint from what's held (a left-tab switch, published tags). */
export function repaintSequence() { paint(); }

/* ── Parsing the flows' beat cards ────────────────────────── */
function parseSide(html, sideName) {
  const out = { pre: [], cards: [] };
  if (!html) return out;
  const t = document.createElement('template');
  t.innerHTML = html;
  let last = null;
  for (const node of [...t.content.childNodes]) {
    if (node.nodeType === 3 && !node.textContent.trim()) continue;
    if (node.nodeType === 8) continue;
    if (node.nodeType === 1 && node.matches('details.beat-card')) {
      last = cardOf(node);
      out.cards.push(last);
    } else if (node.nodeType === 1 && node.matches('.eng-empty')) {
      continue;
    } else if (last) last.extra.push(node);
    else out.pre.push(node);
  }
  // Loose markup (the back office): one anonymous call, its head read off
  // the .req-headline it carries.
  if (!out.cards.length && out.pre.some((n) => n.nodeType === 1 || n.textContent.trim())) {
    const wrap = document.createElement('div');
    out.pre.forEach((n) => wrap.appendChild(n));
    const headline = wrap.querySelector('.req-headline');
    const card = {
      id: `seq-loose-${sideName}`, step: 'loose', looseSide: sideName, n: null, sim: false, badge: '',
      method: headline?.querySelector('.method-pill')?.textContent || '',
      path: headline?.querySelector('.req-path')?.innerHTML || '',
      body: [], extra: [],
    };
    headline?.remove();
    card.body = [...wrap.childNodes];
    out.pre = [];
    out.cards.push(card);
  }
  return out;
}

function cardOf(el) {
  const head = el.querySelector(':scope > summary');
  const body = el.querySelector(':scope > .beat-body');
  return {
    id: el.id,
    step: String(el.id || '').replace(/^beat-/, ''),
    n: head?.querySelector('.beat-n')?.textContent || null,
    method: head?.querySelector('.method-pill')?.textContent || '',
    path: head?.querySelector('.req-path')?.innerHTML || '',
    badge: head?.querySelector('.beat-state')?.outerHTML || '',
    sim: el.classList.contains('sim'),
    body: body ? [...body.childNodes] : [],
    extra: [],
  };
}

/** step → { call, side } — registry STEPS, else the `-res` suffix. */
function sideOf(step) {
  const s = STEPS[step];
  if (s) return { call: s.call, side: s.side };
  if (step === 'loose') return { call: 'loose', side: null };
  return step.endsWith('-res') ? { call: step.slice(0, -4), side: 'res' } : { call: step, side: 'req' };
}

/** The JSON a part rendered, as path → value (from the viewer's data-path). */
function valuesIn(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const list = n.matches?.('[data-path]') ? [n, ...n.querySelectorAll('[data-path]')] : n.querySelectorAll('[data-path]');
    for (const el of list) {
      if (map.has(el.dataset.path)) continue;
      const tok = el.firstElementChild;
      const text = el.textContent;
      let v = text;
      if (tok?.classList.contains('jv-empty')) v = '';
      else if (tok?.classList.contains('tok-bool')) v = text === 'true' ? true : text === 'false' ? false : null;
      else if (tok?.classList.contains('tok-num')) v = Number(text);
      else if (text.startsWith('"') && text.endsWith('"')) v = text.slice(1, -1);
      map.set(el.dataset.path, v);
    }
  }
  return map;
}
const lookupIn = (map) => (path) => {
  if (map.has(path)) return map.get(path);
  for (const k of map.keys()) if (k.startsWith(`${path}.`)) return {}; // an object/array that has children
  return undefined;
};

const LOOSE_CALLS = ['cus-lookup', 'pm-list', 'pay'];
/* Back-office calls with no journey card of their own. */
const LOOSE_TITLES = [
  ['GET', /^\/v1\/payments\/[^/]+$/, 'Retrieve the payment'],
  ['POST', /^\/v1\/refunds$/, 'Refund the payment'],
  ['GET', /^\/v1\/payouts\/[^/]+$/, 'Retrieve the payout'],
];
const looseTitle = (method, path) => LOOSE_TITLES.find(([m, re]) => m === String(method).trim().toUpperCase() && re.test(String(path).split('?')[0]))?.[2] || 'Back office call';

/** The registry call a method + concrete path is ('GET /v1/customers/cus_1' → cus-lookup). */
function callFor(method, path) {
  const m = String(method || '').trim().toUpperCase();
  const p = String(path || '').split('?')[0];
  // Only calls whose title reads right outside their journey (GET
  // /v1/payments/{id} is add-card's "Confirm the card was saved").
  const hit = Object.entries(CALLS).filter(([id]) => LOOSE_CALLS.includes(id)).find(([, c]) => c.method === m
    && new RegExp(`^${c.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}|\{[^}]+\}/g, '[^/]+')}$`).test(p));
  return hit ? hit[0] : null;
}

/* ── Model ─────────────────────────────────────────────────── */
function buildModel() {
  const src = sides[activeSource()];
  const req = parseSide(src.request, 'request');
  const res = parseSide(src.response, 'response');
  const byCall = new Map();
  const order = [];
  const ev = (call) => {
    if (!byCall.has(call)) { byCall.set(call, { call, req: null, res: null }); order.push(call); }
    return byCall.get(call);
  };
  for (const c of [...req.cards, ...res.cards]) {
    const { call, side } = sideOf(c.step);
    const e = ev(call);
    // A single-card call (the FX quote) is its response; a sim step is its request.
    const isRes = side === 'res' || c.looseSide === 'response' || (CALLS[call]?.res?.single && !CALLS[call]?.req);
    if (isRes) e.res = e.res || c; else if (!e.req) e.req = c;
  }
  const events = [];
  const groups = [];
  order.forEach((call) => {
    const e = byCall.get(call);
    const reqVals = e.req ? valuesIn(e.req.body) : new Map();
    const resVals = e.res && !e.req?.sim ? valuesIn(e.res.body) : new Map();
    const look = lookupIn(resVals);
    const hasResponse = resVals.size > 0;
    const path = (e.req || e.res).path.replace(/&amp;/g, '&');
    // Loose markup (the back office) names no step — match its method + path
    // against the registry so it gets the call's title and expectations.
    const known = call === 'loose' ? callFor((e.req || e.res).method, path) : call;
    const variant = expectFor(known, path);
    const scenario = hasResponse ? scenarioOf(look) : null;
    const exp = variant && scenario ? variant[scenario] || null : null;
    const ids = { ...idsFrom(reqVals), ...idsFrom(resVals) };
    if (call === 'cus' && hasResponse && look('data.id')) ids.customer = look('data.id');
    let since = null;
    if (hasResponse) {
      const fk = `${call}|${look('data.id') || path}`;
      if (!firstSeen.has(fk)) firstSeen.set(fk, Date.now());
      since = firstSeen.get(fk);
    }
    const event = {
      id: e.req?.id || `seq-${call}`, call, known, req: e.req, res: e.res, path, variant, scenario, exp, ids, since,
      criteria: (exp?.criteria || []).map((c) => ({ ...c, pass: checkCriterion(c, look), actual: look(c.path) })),
      sim: !!(e.req?.sim || e.res?.sim),
    };
    events.push(event);
    if (!event.sim) groups.push({ id: event.id, ids, since, slots: exp?.sync || [] });
    if (exp?.async && ASYNC[exp.async]) {
      const a = ASYNC[exp.async];
      const aev = { id: `seq-async-${event.id}`, asyncOf: event, def: a, key: exp.async };
      events.push(aev);
      groups.push({ id: aev.id, ids, since, slots: a.sync });
    }
  });
  return { pre: [...req.pre, ...res.pre], events, groups, loose: src.webhooks };
}

/* ── Markup ────────────────────────────────────────────────── */
const isOpen = (id, dflt = true) => (openState.has(id) ? openState.get(id) : dflt);
const shortId = (id) => (id && id.length > 22 ? `${id.slice(0, 18)}…` : id || '');
const fmt = (v) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

function chip(text, tone) { return `<span class="seq-chip ${tone}">${esc(text)}</span>`; }

function checkRow(path, shown, tone, hint = '') {
  return `<div class="seq-check ${tone}"><span class="seq-dot"></span><code>${esc(path)}</code><span class="seq-arrow">→</span><code class="seq-val">${esc(shortId(shown))}</code>${hint ? `<span class="seq-hint">${esc(hint)}</span>` : ''}</div>`;
}

function criteriaHTML(event) {
  if (!event.criteria.length) return '';
  return `<div class="seq-checks seq-criteria">${event.criteria.map((c) => {
    const tone = c.pass ? 'ok' : 'bad';
    const want = c.op === 'exists' ? 'present' : c.op === 'in' ? c.value.join(' | ') : fmt(c.value);
    return checkRow(c.path, c.pass ? fmt(c.actual) : c.actual === undefined ? 'missing' : fmt(c.actual), tone, c.pass ? '' : `expected ${want}`);
  }).join('')}</div>`;
}

function slotHTML(groupId, slot, i, claimed, ids) {
  const w = claimed.get(`${groupId}#${i}`);
  const types = slot.anyOf || [slot.type];
  const type = w?.type || types.join(' | ');
  const links = Object.entries(slot.links || {}).map(([path, kind]) => {
    if (w) {
      const got = getPath(w.raw, path);
      if (!present(got)) return checkRow(path, 'not in this event', 'mute');
      return checkRow(path, got, present(ids[kind]) && ids[kind] !== got ? 'bad' : 'ok');
    }
    return checkRow(path, present(ids[kind]) ? ids[kind] : `${kind} id`, 'wait');
  }).join('');
  const note = WEBHOOK_NOTES[w?.type || types[0]];
  const k = w ? keyOf(w) : '';
  return `
    <div class="seq-slot ${w ? 'got' : 'wait'}">
      <div class="seq-slot-head"><span class="seq-dot"></span><span class="seq-type">${esc(type)}</span>${w ? (w.event_id ? `<code class="seq-whid">${esc(shortId(w.event_id))}</code>` : '') : '<span class="seq-pending">Pending webhook…</span>'}${slot.confirm ? '<span class="seq-confirm" title="Not yet seen end to end — propose a change in the Tag Studio’s Sequence view">to confirm</span>' : ''}</div>
      ${links ? `<div class="seq-checks">${links}</div>` : ''}
      ${note ? `<div class="seq-note">${esc(note)}</div>` : ''}
      ${w ? `<div class="seq-wh" data-wh="${esc(k)}">${eventCardHTML(w, whOpen.has(k))}</div>` : ''}
    </div>`;
}

function watchHTML() {
  if (!watches.size) return '';
  return [...watches.values()].map((w) => `
    <div class="wh-status ${w.live ? 'live' : ''}"><span class="wh-status-dot"></span>${esc(w.text)}<span class="wh-ref">${esc(w.id || '')}</span></div>
    ${w.configured === false ? '<div class="wh-note">Webhook receiver not configured — add Vercel KV + register <code>/api/webhook</code>.</div>' : ''}
    ${w.note ? `<div class="wh-note">${esc(w.note)}</div>` : ''}
    ${w.fallback ? `<div class="wh-fallback"><span class="wh-fallback-tag">POLL FALLBACK</span>Retrieve Payment → <code>status: ${esc(w.fallback.status)}</code> <code>paid: ${esc(w.fallback.paid)}</code><div class="wh-fallback-note">Pull-based — verified webhooks remain the canonical signal.</div></div>` : ''}`).join('');
}

/** The webhooks part of a call or an async event (also repainted alone). */
function webhooksInner(ev, att) {
  const groupId = ev.id;
  if (ev.asyncOf) {
    const slots = ev.def.sync;
    return slots.map((s, i) => slotHTML(groupId, s, i, att.claimed, ev.asyncOf.ids)).join('');
  }
  const slots = ev.exp?.sync || [];
  if (!ev.scenario) {
    // Not answered yet — say what each outcome would fire.
    const v = ev.variant || {};
    const lines = ['success', 'action', 'failure'].filter((s) => v[s]).map((s) => {
      const types = (v[s].sync || []).map((x) => (x.anyOf || [x.type]).join(' | '));
      const asyncTitle = v[s].async && ASYNC[v[s].async] ? ` · then async: ${ASYNC[v[s].async].title.toLowerCase()}` : '';
      return `<div class="seq-expect-line"><span class="seq-scn">${esc(SCN[s])}</span>${types.length ? types.map((t) => `<span class="wh-expect">${esc(t)}</span>`).join('') : '<span class="seq-hint">no webhook</span>'}${esc(asyncTitle)}</div>`;
    });
    return lines.length ? `<div class="seq-expect">${lines.join('')}</div><div class="seq-hint">Expected once Rapyd answers.</div>` : '';
  }
  if (!slots.length) return `<div class="seq-hint">This call fires no webhook of its own${ev.exp?.async ? ' — see the async event below' : ''}.</div>`;
  return slots.map((s, i) => slotHTML(groupId, s, i, att.claimed, ev.ids)).join('');
}
const SCN = { success: 'Success', action: '3DS / redirect', failure: 'Failure' };

function countSlots(ev, att) {
  const slots = ev.asyncOf ? ev.def.sync : ev.exp?.sync || [];
  const got = slots.filter((_, i) => att.claimed.has(`${ev.id}#${i}`)).length;
  return { got, total: slots.length };
}

function chipsHTML(ev, att) {
  const out = [];
  if (!ev.asyncOf && ev.criteria?.length) {
    const ok = ev.criteria.filter((c) => c.pass).length;
    out.push(chip(`${ok}/${ev.criteria.length} criteria`, ok === ev.criteria.length ? 'ok' : 'bad'));
  }
  const { got, total } = countSlots(ev, att);
  if (total && (ev.scenario || ev.asyncOf)) out.push(chip(`${ev.asyncOf ? 'Async' : 'Webhooks'} ${got}/${total}`, got === total ? 'ok' : 'wait'));
  return out.join('');
}

function partHTML(evId, part, label, inner, { open = true, id = '', hint = '' } = {}) {
  const pid = `${evId}:${part}`;
  return `
    <details class="seq-part seq-part-${part}" data-part="${part}" data-pid="${esc(pid)}"${id ? ` id="${esc(id)}"` : ''} ${isOpen(pid, open) ? 'open' : ''}>
      <summary class="seq-part-head"><span class="seq-chev">▸</span><span class="seq-part-label">${esc(label)}</span>${hint}</summary>
      <div class="seq-part-body">${inner}</div>
    </details>`;
}

function eventShellHTML(ev, n, att) {
  const isLast = ev === model.events[model.events.length - 1];
  if (ev.asyncOf) {
    return `
      <details class="seq-event async" id="${esc(ev.id)}" data-ev="${esc(ev.id)}" ${isOpen(ev.id, true) ? 'open' : ''}>
        <summary class="seq-head">
          <span class="seq-chev">▸</span><span class="seq-n">${n}</span>
          <span class="seq-title">${esc(ev.def.title)}<span class="seq-kind async">Async</span></span>
          <span class="seq-chips" data-chips="${esc(ev.id)}">${chipsHTML(ev, att)}</span>
          <span class="seq-sub">${esc(ev.def.trigger)}</span>
        </summary>
        <div class="seq-body"><div class="seq-whlist" data-whfor="${esc(ev.id)}">${webhooksInner(ev, att)}</div></div>
      </details>`;
  }
  const c = ev.req || ev.res;
  const title = CALLS[ev.known]?.title || (ev.call === 'loose' ? looseTitle(c.method, ev.path) : '');
  const methodCls = ev.sim ? 'sim' : esc(String(c.method).toLowerCase());
  return `
    <details class="seq-event${ev.sim ? ' sim' : ''}" id="${esc(ev.id)}" data-ev="${esc(ev.id)}" ${isOpen(ev.id, isLast || model.events.length <= 2) ? 'open' : ''}>
      <summary class="seq-head">
        <span class="seq-chev">▸</span><span class="seq-n">${n}</span>
        <span class="seq-title">${esc(title.replace(/\s*\(.*\)$/, '') || ev.path)}${ev.sim ? '<span class="seq-kind sim">Simulated</span>' : ''}</span>
        <span class="seq-chips" data-chips="${esc(ev.id)}">${chipsHTML(ev, att)}</span>
        <span class="seq-sub"><span class="method-pill ${methodCls}">${esc(String(c.method).toUpperCase())}</span><span class="req-path">${c.path}</span>${(ev.res || ev.req).badge}</span>
      </summary>
      <div class="seq-body" data-body="${esc(ev.id)}"></div>
    </details>`;
}

/* Build an event's body with DOM nodes (the flows' parsed card content). */
function fillEventBody(host, ev, att) {
  if (ev.asyncOf || !host) return;
  const cols = document.createElement('div');
  cols.className = 'seq-cols';
  const main = document.createElement('div');
  main.className = 'seq-col';
  const side = document.createElement('div');
  side.className = 'seq-col seq-col-wh';
  cols.append(main, side);

  const addPart = (col, part, label, nodes, opts = {}) => {
    const t = document.createElement('template');
    t.innerHTML = partHTML(ev.id, part, label, '', opts).trim();
    const el = t.content.firstElementChild;
    const body = el.querySelector('.seq-part-body');
    if (opts.before) body.insertAdjacentHTML('beforeend', opts.before);
    nodes.forEach((x) => body.appendChild(x));
    col.appendChild(el);
    return el;
  };

  if (ev.req) {
    const nodes = [...ev.req.body, ...ev.req.extra];
    const holder = document.createElement('div');
    nodes.forEach((x) => holder.appendChild(x));
    const headers = holder.querySelector('.req-headers');
    if (headers && !ev.sim) {
      // headersHTML's own "Headers" label goes too — the part is labelled.
      const label = headers.previousElementSibling;
      if (label?.matches('p.eng-label') && /^headers$/i.test(label.textContent.trim())) label.remove();
      headers.remove();
      addPart(main, 'headers', 'Headers', [headers], { open: false, hint: '<span class="seq-hint">signed by the backend</span>' });
    }
    // Once Rapyd answered, the request folds by default — the response and its
    // webhooks lead; the SE can still open it (the choice then sticks).
    addPart(main, 'request', ev.sim ? 'Simulated exchange' : 'API request', [...holder.childNodes], { open: ev.sim || !ev.scenario });
  }
  if (ev.res && ev.res !== ev.req) {
    addPart(main, 'response', 'API response', [...ev.res.body, ...ev.res.extra], {
      id: ev.res.id && ev.res.id !== ev.id ? ev.res.id : '',
    });
    const body = main.querySelector('.seq-part-response .seq-part-body');
    const crit = criteriaHTML(ev);
    if (crit && body) {
      const pills = body.querySelector(':scope > .eng-pillrow');
      if (pills) pills.insertAdjacentHTML('afterend', crit); else body.insertAdjacentHTML('afterbegin', crit);
    }
  }
  if (!ev.sim && (ev.variant || (ev.call === 'loose' && model.loose))) {
    const inner = ev.variant ? webhooksInner(ev, att) : '';
    const el = addPart(side, 'webhooks', 'Webhooks', [], {});
    el.querySelector('.seq-part-body').innerHTML = `<div class="seq-whlist" data-whfor="${esc(ev.id)}">${inner}</div>`;
    if (ev.call === 'loose' && model.loose) el.querySelector('.seq-whlist').insertAdjacentHTML('beforeend', model.loose);
  }
  if (!side.children.length) cols.classList.add('single');
  host.appendChild(cols);
}

function otherHTML(att) {
  if (!att.other.length) return '';
  return `
    <details class="seq-event other" id="seq-other" ${isOpen('seq-other', true) ? 'open' : ''}>
      <summary class="seq-head"><span class="seq-chev">▸</span><span class="seq-title">Other events</span><span class="seq-chips">${chip(String(att.other.length), 'mute')}</span><span class="seq-sub">About this run, but no expectation claimed them — candidates to propose.</span></summary>
      <div class="seq-body">${att.other.map((w) => {
        const k = keyOf(w);
        return `<div class="seq-slot got"><div class="seq-slot-head"><span class="seq-dot"></span><span class="seq-type">${esc(w.type)}</span>${w.event_id ? `<code class="seq-whid">${esc(shortId(w.event_id))}</code>` : ''}</div>${WEBHOOK_NOTES[w.type] ? `<div class="seq-note">${esc(WEBHOOK_NOTES[w.type])}</div>` : ''}<div class="seq-wh" data-wh="${esc(k)}">${eventCardHTML(w, whOpen.has(k))}</div></div>`;
      }).join('')}</div>
    </details>`;
}

const EMPTY = `<div class="eng-empty"><div class="ee-ico">◇</div><div class="ee-text">Each call appears here as one event — its headers, the request, Rapyd’s response and the webhooks it fires.</div></div>`;

function attributeNow() {
  return attribute(model.groups, [...store.values()]);
}

function paint() {
  const el = $panel();
  if (!el) return;
  model = buildModel();
  if (!model.events.length && !model.pre.length) {
    el.innerHTML = `<div class="seq-watch" data-watch>${watchHTML()}</div>${EMPTY}`;
    return;
  }
  const att = attributeNow();
  let n = 0;
  el.innerHTML = `
    <div class="seq-watch" data-watch>${watchHTML()}</div>
    <div class="seq-pre"></div>
    ${model.events.map((ev) => eventShellHTML(ev, ++n, att)).join('')}
    <div data-other>${otherHTML(att)}</div>`;
  const pre = el.querySelector('.seq-pre');
  model.pre.forEach((x) => pre.appendChild(x));
  if (!model.pre.length) pre.remove();
  for (const ev of model.events) fillEventBody(el.querySelector(`[data-body="${CSS.escape(ev.id)}"]`), ev, att);
}

/** Webhooks / watch status only — the parsed request and response stay as
    they are (a JSON highlight, an open sub-card, the SE's scroll). */
function paintWebhooks() {
  const el = $panel();
  if (!el || !model) { paint(); return; }
  const att = attributeNow();
  const watch = el.querySelector('[data-watch]');
  if (watch) watch.innerHTML = watchHTML();
  for (const ev of model.events) {
    const list = el.querySelector(`[data-whfor="${CSS.escape(ev.id)}"]`);
    if (list && !(ev.call === 'loose' && !ev.variant)) list.innerHTML = webhooksInner(ev, att);
    const chips = el.querySelector(`[data-chips="${CSS.escape(ev.id)}"]`);
    if (chips) chips.innerHTML = chipsHTML(ev, att);
  }
  const other = el.querySelector('[data-other]');
  if (other) other.innerHTML = otherHTML(att);
}

/* ── Interaction ───────────────────────────────────────────── */
/* <details> state is owned here (repaints rebuild them). */
document.addEventListener('click', (e) => {
  const head = e.target.closest('#panel-sequence .seq-head, #panel-sequence .seq-part-head');
  if (head) {
    e.preventDefault();
    const d = head.parentElement;
    const id = d.dataset.pid || d.id;
    const next = !d.open;
    openState.set(id, next);
    d.open = next;
    return;
  }
  const wh = e.target.closest('#panel-sequence .seq-wh > .wh-card > summary');
  if (wh) {
    const k = wh.closest('.seq-wh').dataset.wh;
    const card = wh.parentElement;
    // The native toggle runs after this handler — record its next state.
    if (card.open) whOpen.delete(k); else whOpen.add(k);
  }
});

/** Bring a part into view: 'request' | 'response' | 'webhooks' — on the
    newest event that has it. Replaces the old tab switches. */
export function reveal(part) {
  requestAnimationFrame(() => {
    const el = $panel();
    if (!el || !model) return;
    const has = (ev) => (part === 'request' ? ev.req : part === 'response' ? ev.res && ev.res !== ev.req : !ev.sim && (ev.variant || ev.asyncOf));
    const target = [...model.events].reverse().find(has);
    if (!target) return;
    const evEl = el.querySelector(`[data-ev="${CSS.escape(target.id)}"]`);
    if (!evEl) return;
    openState.set(target.id, true);
    evEl.open = true;
    const p = evEl.querySelector(`.seq-part[data-part="${part}"]`);
    if (p) { openState.set(p.dataset.pid, true); p.open = true; }
    (p || evEl).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}
window.addEventListener('paybridge:reveal', (e) => reveal(e.detail));
