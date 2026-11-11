/* ─────────────────────────────────────────────────────────────
   Which tag config is in force.

     scoped (withConfig — the Tag Studio's own preview pane)
       ▸ draft (this tab only, the Studio's "Preview in app")
         ▸ published (the backend's cfg:tags:v1, cached in localStorage)
           ▸ the code defaults in registry.js

   The first layer present is used WHOLE (the Studio's draft is a complete
   config built on top of the published one). Inside it, a step's own slot
   (`beat.header:pay`) wins over the shared slot (`beat.header`), which wins
   over the defaults.

   This module holds the layers and nothing else; resolve.js asks it for a
   slot. The network load lives in loader.js so unit tests never fetch.
   ───────────────────────────────────────────────────────────── */

import { SLOTS, splitSlotId, STEP_RE } from './registry.js';

let published = null; // { version, updatedAt, updatedBy, note, slots }
let draft = null;     // { slots } — the Studio's unpublished edit, this tab only
let scoped = null;    // withConfig(): the Studio's preview pane, never seen by the app

const listeners = new Set();
/** Called whenever the effective config may have changed. */
export function onTagsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() {
  for (const fn of listeners) { try { fn(); } catch { /* a bad listener must not stop the rest */ } }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('paybridge:tags-changed'));
}

/** Keep only what this build understands — a config written by a newer
    Studio (or a corrupted cache) can't break rendering. */
export function sanitizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || typeof cfg.slots !== 'object' || !cfg.slots) return null;
  const slots = {};
  for (const [id, s] of Object.entries(cfg.slots)) {
    const [base, step] = splitSlotId(id);
    const def = SLOTS[base];
    if (!def || !s || typeof s !== 'object' || (step !== null && !STEP_RE.test(step))) continue;
    if (def.kind === 'rules' && Array.isArray(s.rules)) {
      slots[id] = { rules: s.rules.filter((r) => r && typeof r === 'object' && typeof r.label === 'string') };
      if (s.fallback && typeof s.fallback === 'object') slots[id].fallback = s.fallback;
    } else if (def.kind === 'dict' && s.entries && typeof s.entries === 'object') {
      const entries = {};
      for (const [k, e] of Object.entries(s.entries)) {
        if (def.entries[k] && e && typeof e === 'object' && typeof e.label === 'string') entries[k] = e;
      }
      slots[id] = { entries };
    }
  }
  return { ...cfg, version: Number(cfg.version) || 0, slots };
}

export function setPublished(cfg) { published = sanitizeConfig(cfg); changed(); }
export function getPublished() { return published; }
export function setDraft(cfg) { draft = cfg ? sanitizeConfig(cfg) : null; changed(); }
export function getDraft() { return draft; }

const active = () => scoped || draft || published;

/** A rules slot's override for `step` (its own, else the shared one), or null → defaults. */
export function overrideFor(slotId, step = null) {
  const slots = active()?.slots;
  if (!slots) return null;
  return (step && slots[`${slotId}:${step}`]) || slots[slotId] || null;
}

/** A dictionary entry's override for `step` (its own, else the shared one), or null. */
export function entryOverride(slotId, key, step = null) {
  const slots = active()?.slots;
  if (!slots) return null;
  return (step && slots[`${slotId}:${step}`]?.entries?.[key]) || slots[slotId]?.entries?.[key] || null;
}

/** Run `fn` as if `cfg` were the only override (defaults beneath it) —
    the Studio renders its preview this way without repainting the app. */
export function withConfig(cfg, fn) {
  const prev = scoped;
  scoped = sanitizeConfig(cfg) || { slots: {} };
  try { return fn(); } finally { scoped = prev; }
}
