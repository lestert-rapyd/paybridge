/* ─────────────────────────────────────────────────────────────
   Boot-time load of the published tag config.

     1. the localStorage copy, synchronously — the first paint already uses
        the last config this browser saw;
     2. GET /api/config?op=tags (2.5 s timeout) — replaces it and refreshes
        the cache; version 0 = nothing published → code defaults;
     3. the Studio's "Preview in app" draft (sessionStorage, this tab only).

   Every failure leaves whatever was already in force; a payment never waits
   on any of this.
   ───────────────────────────────────────────────────────────── */

import { setPublished, setDraft, getPublished } from './store.js';
import { fetchTagConfig } from '../api.js';

const CACHE_KEY = 'rapyd-demo:tags:v1';
const DRAFT_KEY = 'rapyd-demo:tags-draft:v1';

const read = (store, key) => {
  try { const s = store.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
};
const write = (store, key, v) => {
  try { if (v) store.setItem(key, JSON.stringify(v)); else store.removeItem(key); } catch { /* storage unavailable */ }
};

/** Remember a just-published config (the Studio calls this after a publish). */
export function cachePublished(cfg) {
  write(localStorage, CACHE_KEY, cfg && cfg.version > 0 ? cfg : null);
  setPublished(cfg && cfg.version > 0 ? cfg : null);
}

/** The Studio's preview-in-app draft — persisted per tab so a reload keeps it. */
export function setPreviewDraft(cfg) {
  write(sessionStorage, DRAFT_KEY, cfg);
  setDraft(cfg);
}
export const hasPreviewDraft = () => !!read(sessionStorage, DRAFT_KEY);

/** Fire-and-forget at boot. Resolves to the published config (or null). */
export async function loadTags() {
  const cached = read(localStorage, CACHE_KEY);
  if (cached) setPublished(cached);
  const draft = read(sessionStorage, DRAFT_KEY);
  if (draft) setDraft(draft);
  const r = await fetchTagConfig();
  if (!r.ok || !r.data || typeof r.data !== 'object') return getPublished();
  if (r.data.configured === false) return getPublished(); // no KV on that backend — keep the cache
  const fresh = r.data;
  if (cached && fresh.version === cached.version && fresh.updatedAt === cached.updatedAt) return getPublished();
  cachePublished(fresh);
  return getPublished();
}
