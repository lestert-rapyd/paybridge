/* ─────────────────────────────────────────────────────────────
   Which tag config is in force.

     draft (this tab only, the Tag Studio's "Preview in app")
       ▸ published (the backend's cfg:tags:v1, cached in localStorage)
         ▸ the code defaults in registry.js

   This module holds the two override layers and nothing else; resolve.js
   asks it for a slot. The network load lives with the Studio's loader so
   unit tests (and any page without a backend) never fetch.
   ───────────────────────────────────────────────────────────── */

import { SLOTS } from './registry.js';

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
    const def = SLOTS[id];
    if (!def || !s || typeof s !== 'object') continue;
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

/** The override for one slot, or null → the defaults. Draft wins whole-slot. */
export function overrideFor(slotId) {
  if (scoped) return scoped.slots?.[slotId] || null;
  return draft?.slots?.[slotId] || published?.slots?.[slotId] || null;
}

/** Run `fn` as if `cfg` were the only override (defaults beneath it) —
    the Studio renders its preview this way without repainting the app. */
export function withConfig(cfg, fn) {
  const prev = scoped;
  scoped = sanitizeConfig(cfg) || { slots: {} };
  try { return fn(); } finally { scoped = prev; }
}
