/* ─────────────────────────────────────────────────────────────
   Skins — WHOSE site the shopper is on. A skin is the merchant's
   identity: name, statement descriptor, the domain in the browser
   frame, and the tokens the client site paints with. It names an
   industry pack (js/packs.js) for its content; the two are composed
   in js/verticals.js.

   The skin is how the demo matches the prospect in the room, so it
   applies to the MERCHANT SITE ONLY — the browser frame in the left
   pane. The demo tool around it (header, demo-controls drawer, engine
   room, back office, dialogs) is Rapyd's and never changes face; and
   inside the frame the integration seam still holds: Rapyd surfaces
   (the toolkit iframe, the hosted page, Rapyd's 3DS challenge) render
   as Rapyd ships them, never skinned.

   Tokens are data, not CSS, so a customer skin needs no stylesheet
   edit: applySkin() writes `tokens` as custom properties onto the
   browser frame (.browser), where css/tokens.css scopes the site ramp.
   Settable: --accent (fills), --accent-ink (accent as text — must pass
   4.5:1 on white), --accent-soft, --on-accent, the site faces
   (--font-site, --font-site-display) and the site neutrals
   (--site-ink … --site-soft-2). Anything a skin omits falls back to the
   Rapyd defaults in css/tokens.css; applySkin() clears every token
   another skin set before painting this one.

   The three built-in skins are Rapyd's own demo merchants and share
   the Rapyd palette (Inter, cool greys, #7437F5) — they differ in
   identity and catalog, not in colour.
   ───────────────────────────────────────────────────────────── */

/* The Rapyd storefront look, shared by the built-in skins. Spelled out (not
   left to the tokens.css defaults) so a customer skin file has a complete,
   working example to copy and edit. */
const RAPYD_SITE = {
  '--accent': '#7437F5', '--accent-ink': '#7437F5', '--on-accent': '#ffffff', '--accent-soft': '#F6F2FF',
  '--font-site': "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  '--font-site-display': "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  '--site-ink': '#2A2A2B', '--site-text': '#454545', '--site-muted': '#727272', '--site-faint': '#A1A1A1',
  '--site-line': '#EAEBEC', '--site-field': '#CECECE', '--site-soft': '#FBFBFB', '--site-soft-2': '#F1F2F3',
};

export const SKINS = {
  // rapyd.shop — home & living, the Claude Design storefront prototype.
  ecommerce: {
    id: 'ecommerce',
    label: 'E-commerce',
    pack: 'home',
    dot: '#7437F5',
    merchant: 'rapyd.shop',
    descriptor: 'RAPYD SHOP',
    domain: 'rapyd.shop',
    tokens: { ...RAPYD_SITE },
  },

  // rapyd.coin — a crypto on-ramp (KYC at signup, AFT purchases).
  crypto: {
    id: 'crypto',
    label: 'Crypto',
    pack: 'crypto',
    dot: '#7437F5',
    merchant: 'rapyd.coin',
    descriptor: 'RAPYD COIN',
    domain: 'rapyd.coin',
    tokens: { ...RAPYD_SITE },
  },

  // rapyd.spin — gambling: deposits and a monthly add-on.
  gaming: {
    id: 'gaming',
    label: 'Gambling',
    pack: 'igaming',
    dot: '#7437F5',
    merchant: 'rapyd.spin',
    descriptor: 'RAPYD SPIN',
    domain: 'rapyd.spin',
    tokens: { ...RAPYD_SITE },
  },
};

/** The order the demo-controls drawer lists them in. */
export const SKIN_ORDER = ['ecommerce', 'crypto', 'gaming'];

/* Every token ANY skin sets — cleared before a skin paints, so switching from a
   skin that sets an optional token (a font, a neutral) to one that doesn't
   falls back to the css/tokens.css default instead of inheriting it. */
const ALL_TOKENS = [...new Set(Object.values(SKINS).flatMap((s) => Object.keys(s.tokens)))];

/* Where a skin paints: the client site's browser frame. */
const defaultRoot = () => (typeof document !== 'undefined' ? document.querySelector('.browser') : null);

/** Paint a skin onto the merchant site: its tokens as custom properties on the
    browser frame, and data-skin for any skin-scoped CSS. Unknown ids are
    ignored (the css/tokens.css defaults stay in force). */
export function applySkin(id, root = defaultRoot()) {
  const skin = SKINS[id];
  if (!skin || !root) return;
  for (const prop of ALL_TOKENS) root.style.removeProperty(prop);
  for (const [prop, value] of Object.entries(skin.tokens)) root.style.setProperty(prop, value);
  root.dataset.skin = id;
}
