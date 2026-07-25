/* ─────────────────────────────────────────────────────────────
   Sandbox key-profile registry — frontend mirror of
   rapyd-backend/utils/key-profiles.js. Three sandbox MIDs with
   different feature sets: which 3DS provider the MID uses, whether
   it returns network_reference_id, and which collection wallet(s)
   it owns. Only PUBLIC identifiers live here (access keys are shown
   redacted in the header display; ewallet ids appear in request
   bodies) — secrets never leave the backend.
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';

export const PROFILES = {
  SC1: {
    label: 'SC1', tds: 'rapyd', nrid: true, aft: true,
    access_key: 'rak_E78F1D29633035F97013',
    ewallets: ['ewallet_c7e9f04ce7f31a8186dd99d982d7385c'],
  },
  SC2: {
    label: 'SC2', tds: 'external', nrid: true, aft: true,
    access_key: 'rak_038389705CDD4A8145CD',
    ewallets: ['ewallet_185ca1ac03736af59f1e20fa1a9cef4f', 'ewallet_878607091fd1af99590719d2288b8868'],
  },
  SC3: {
    label: 'SC3', tds: 'rapyd', nrid: false, aft: true,
    access_key: 'rak_4395BD694CCBBEF05A9D',
    ewallets: ['ewallet_4bc668f5c18b6b8c78d0ff2652cd6810'],
  },
};

export const PROFILE_ORDER = ['SC1', 'SC2', 'SC3'];

export function activeProfile() {
  return PROFILES[state.profile] || PROFILES.SC1;
}

/** The wallet every /v1/payments body routes to. Known client-side only for
    the sandbox profiles; in live the backend injects its configured wallet
    (the displayed body simply omits it there). */
export function profileEwallet() {
  return state.env === 'sandbox' ? activeProfile().ewallets[0] : null;
}

/** Whether the active MID returns network_reference_id (SC3 does not — the
    PCI vault path degrades to CVV-only reuse there). */
export function nridAvailable() {
  return state.env !== 'sandbox' || activeProfile().nrid;
}
