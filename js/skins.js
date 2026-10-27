/* ─────────────────────────────────────────────────────────────
   Skins — WHOSE site the shopper is on. A skin is the merchant's
   identity: name, statement descriptor, the domain in the browser
   frame, and the colour tokens the client surface paints with. It
   names a default industry pack (js/packs.js) for its content; the
   two are composed in js/verticals.js.

   The skin is how the demo matches the prospect in the room, so it
   applies up to the integration seam ONLY. Rapyd surfaces — the
   toolkit iframe, the hosted page, Rapyd's 3DS challenge — are never
   skinned: they render as Rapyd ships them, inside the skinned page.

   Colours are data, not CSS, so a customer skin needs no stylesheet
   edit: applySkin() writes `tokens` onto :root as custom properties.
   Accent must pass 4.5:1 on white for text use, or use accent-soft
   fills with accent text. The engine room tint follows the accent
   (hue from the accent, value near-black) — layout and the ramps in
   css/tokens.css never fork per skin.
   ───────────────────────────────────────────────────────────── */

export const SKINS = {
  ecommerce: {
    id: 'ecommerce',
    label: 'Retail',
    pack: 'retail',
    dot: '#5600ef',
    merchant: 'PayBridge Shop',
    descriptor: 'PayBridge - Shop',
    domain: 'shop.paybridge.com',
    tokens: {
      '--accent': '#5600ef', '--accent-2': '#a855f7', '--on-accent': '#ffffff', '--accent-soft': '#efe8ff',
      '--eng-bg': '#0f0a17', '--eng-surface': '#170f22', '--eng-surface-2': '#1c1230',
      '--eng-line': '#2a1c3b', '--eng-text': '#f6ecff', '--eng-muted': '#9a86b0', '--eng-faint': '#6b5b80',
    },
  },

  // Crypto — neon green
  crypto: {
    id: 'crypto',
    label: 'Crypto',
    pack: 'crypto',
    dot: '#00ff89',
    merchant: 'PayBridge Coin',
    descriptor: 'PayBridge - Coin',
    domain: 'coin.paybridge.io',
    tokens: {
      '--accent': '#00e07a', '--accent-2': '#00ff89', '--on-accent': '#00140a', '--accent-soft': '#daffed',
      '--eng-bg': '#0a0e0c', '--eng-surface': '#121814', '--eng-surface-2': '#16201b',
      '--eng-line': '#1d2823', '--eng-text': '#eafff4', '--eng-muted': '#6f8a7e', '--eng-faint': '#4a5f55',
    },
  },

  // iGaming — magenta
  gaming: {
    id: 'gaming',
    label: 'iGaming',
    pack: 'igaming',
    dot: '#ff007a',
    merchant: 'PayBridge Play',
    descriptor: 'PayBridge - Play',
    domain: 'play.paybridge.bet',
    tokens: {
      '--accent': '#ff007a', '--accent-2': '#ff5ca8', '--on-accent': '#ffffff', '--accent-soft': '#ffe1ee',
      '--eng-bg': '#120410', '--eng-surface': '#1c0a17', '--eng-surface-2': '#250d1e',
      '--eng-line': '#3a1329', '--eng-text': '#ffeaf4', '--eng-muted': '#b07d97', '--eng-faint': '#7a5266',
    },
  },
};

/** Paint a skin onto the document: its colour tokens as :root custom
    properties, and data-skin for any skin-scoped CSS. Unknown ids are
    ignored (the css/tokens.css :root defaults stay in force). */
export function applySkin(id, root = typeof document !== 'undefined' ? document.documentElement : null) {
  const skin = SKINS[id];
  if (!skin || !root) return;
  for (const [prop, value] of Object.entries(skin.tokens)) root.style.setProperty(prop, value);
  root.dataset.skin = id;
}
