/* ─────────────────────────────────────────────────────────────
   The integration seam — where the merchant's site ends and Rapyd
   begins, per integration path. The ONE source of truth for it: the
   drawer's Integration path section (app.js) and the engine room's
   seam strip both render from SEAM_PATHS, and the flows label their
   Rapyd surfaces with SEAM_LABELS.

   Paths (seamPathKey):
     own-fields · Own Card Fields — the whole page is the merchant's;
                  Rapyd only appears if its 3DS challenge does
     embedded   · Checkout Toolkit, full toolkit — merchant page around
                  Rapyd's iframe
     wallets    · Checkout Toolkit, wallet buttons only — same seam,
                  the iframe shows just the wallet buttons
     hosted     · Hosted checkout page — merchant page up to a full
                  redirect to Rapyd's page, then the merchant's
                  complete / cancel page

   Apple Pay / Google Pay add a "Wallets" line per path (WALLET_SEAMS):
   Checkout (real) keeps them inside Rapyd's surfaces; the simulated
   direct variants put the merchant's own buttons + Apple's / Google's
   sheet on the merchant's page (js/direct-wallet.js).

   PCI wording, checked against:
     · docs.rapyd.net/en/create-checkout-page.html — the hosted page
       "can be used by all clients without the need for PCI certification"
     · docs.rapyd.net/en/checkout-toolkit-integration.html — the toolkit
       is "a checkout solution without the PCI-DSS compliance worry"
       (an iframe, #rapyd-checkout-frame)
     · PCI SSC SAQ A (v4.0.1, r1) + FAQ 1588 — SAQ A covers fully
       outsourced card-not-present handling (iframe or redirect); an
       EMBEDDED form adds the "page not susceptible to script attacks"
       criterion, a redirect doesn't. Card data on the merchant's own
       systems takes it out of SAQ A — SAQ D for the direct API.
   The SAQ is the acquirer's call, so the copy says "typically".

   Visual markers: a Rapyd surface inside the browser frame is wrapped by
   seamWrapHTML() — a dashed Rapyd-purple outline + "Rapyd" tag drawn
   AROUND it (css/main.css .seam-rapyd), never inside it: Rapyd's iframe,
   3DS page and hosted page are never restyled. The merchant's parts carry
   no label. The drawer's "Show seam" switch (default on) hides every
   marker for a clean customer-facing view.

   Pure data + helpers, plus three small DOM writers that only run when
   called (no DOM work at import time — tests/unit.js imports this).
   ───────────────────────────────────────────────────────────── */

import { esc } from './ui.js';

/** Per path: who owns which surface, and what that means for PCI.
    `summary` is the drawer's one-liner; form / pci / redirect are the
    SE-facing explainer lines (drawer + engine room). Text only — callers escape. */
export const SEAM_PATHS = {
  'own-fields': {
    label: 'Own Card Fields',
    tag: 'SAQ D',
    summary: 'The whole checkout is the merchant’s — it collects the card and calls POST /v1/payments itself.',
    form: 'The merchant hosts the card form; the PAN crosses its servers to Rapyd’s API.',
    pci: 'PCI scope: full — typically SAQ D (Rapyd requires PCI-DSS certification for direct card payments).',
    redirect: 'No redirect — Rapyd appears only if 3DS returns a redirect_url (its challenge page).',
    merchant: ['Checkout page', 'Card fields', 'Pay button', 'Complete / decline page'],
    rapyd: ['3DS challenge (redirect_url), when one is required'],
  },
  embedded: {
    label: 'Checkout Toolkit',
    tag: 'SAQ A',
    summary: 'The merchant’s page surrounds Rapyd’s toolkit iframe — the card never touches the merchant.',
    form: 'Rapyd hosts the card form in an iframe on the merchant’s page (POST /v1/checkout first).',
    pci: 'PCI scope: reduced — typically SAQ A, plus the SAQ A check that the page isn’t open to script attacks.',
    redirect: 'No page redirect — the address stays the merchant’s; 3DS runs in the iframe (or a popup).',
    merchant: ['Checkout page', 'Order summary', 'Custom pay button (optional)', 'Complete / decline page'],
    rapyd: ['Toolkit iframe (card form, saved cards)', '3DS challenge'],
  },
  wallets: {
    label: 'Checkout Toolkit · wallet buttons',
    tag: 'SAQ A',
    summary: 'The merchant’s page surrounds Rapyd’s iframe, which shows only the Apple Pay / Google Pay buttons.',
    form: 'Rapyd hosts the wallet buttons in its iframe; no card form at all on the merchant’s page.',
    pci: 'PCI scope: reduced — typically SAQ A, as for the full toolkit.',
    redirect: 'No page redirect — the wallet sheet opens over the merchant’s page.',
    merchant: ['Checkout page', 'Order summary', 'Complete / decline page'],
    rapyd: ['Toolkit iframe (wallet buttons)'],
  },
  hosted: {
    label: 'Hosted checkout page',
    tag: 'SAQ A',
    summary: 'The merchant’s site up to a full redirect to Rapyd’s hosted page, then back to the merchant’s own return page.',
    form: 'Rapyd hosts the whole payment page on its own domain (POST /v1/checkout → redirect_url).',
    pci: 'PCI scope: minimal — typically SAQ A; a redirect doesn’t carry the embedded-form script check.',
    redirect: 'Two redirects: merchant → Rapyd (redirect_url), then Rapyd → complete_ / cancel_checkout_url.',
    merchant: ['Shop, bag and checkout', 'Complete page', 'Cancel page'],
    rapyd: ['Hosted checkout page (its own domain)'],
  },
};

/** The tag on each Rapyd surface in the frame. Text only. */
export const SEAM_LABELS = {
  toolkit: 'Rapyd · Checkout Toolkit iframe',
  wallets: 'Rapyd · wallet buttons iframe',
  tds: 'Rapyd · 3-D Secure (redirect_url)',
  hosted: 'Rapyd · hosted checkout page',
};

/* ── External 3DS on the seam ────────────────────────────────
   On a MID set up for an external 3DS provider (profiles.js tds:'external')
   the merchant's own provider is a THIRD party in the frame: neither the
   merchant's skin nor Rapyd. Its simulated challenge page gets its own,
   neutral marker (.seam-ext — grey, not Rapyd purple), shown with the
   others under "Show seam". See js/ext3ds.js. */
export const EXT_TDS_LABEL = 'Merchant’s 3DS provider (simulated)';

/** The seam's 3DS line for a path, given the MID's 3DS provider; null when
    there's nothing to add (Rapyd's own 3DS is already the redirect line).
    Text only — callers escape. */
export function seamTdsLine(key, tdsProvider) {
  if (tdsProvider !== 'external') return null;
  if (key === 'own-fields' || !SEAM_PATHS[key]) {
    return 'External 3DS: the merchant’s own 3DS provider authenticates first; its results go in payment_method_options and Rapyd runs no 3DS of its own. A failed check never reaches Rapyd.';
  }
  return 'External 3DS doesn’t apply here — Rapyd hosts the card form, so the merchant has no card to authenticate; Rapyd runs 3DS itself.';
}

/** Wrap the external 3DS provider's page in its own marker. Same contract as
    seamWrapHTML: `inner` is trusted markup, the label is escaped. */
export function seamExtWrapHTML(inner, label = EXT_TDS_LABEL) {
  return `<div class="seam-ext" data-seam="${esc(label)}">${inner}</div>`;
}

/* ── Apple Pay / Google Pay on the seam ──────────────────────
   The wallet integration (js/direct-wallet.js) moves the seam for wallet
   payments only. Checkout (real): the wallet buttons are Rapyd's — inside
   its toolkit iframe or hosted page. Direct (simulated): the buttons are
   the merchant's own, the payment sheet is Apple's / Google's (a third
   party in the frame — the grey .seam-ext marker, like the external 3DS
   provider), and the merchant calls POST /v1/payments itself. Encrypted:
   Rapyd decrypts server-side, no card data at the merchant. Decrypted: the
   merchant holds the wallet's keys and the DPAN — PCI. Text only. */
export const WALLET_SEAMS = {
  checkout: {
    label: 'Checkout (real)',
    line: 'Apple Pay / Google Pay sit inside Rapyd’s toolkit iframe or hosted page — Rapyd runs the sheet, validation and decryption.',
    ownFields: 'Apple Pay / Google Pay come with Rapyd’s toolkit or hosted page — this page has no wallet buttons of its own.',
  },
  encrypted: {
    label: 'Direct — encrypted (simulated)',
    line: 'The merchant’s own button opens Apple’s / Google’s sheet on the merchant’s page; the merchant forwards the encrypted token and Rapyd decrypts it server-side — no card data at the merchant.',
  },
  decrypted: {
    label: 'Direct — decrypted (simulated)',
    line: 'The merchant’s own button and Apple’s / Google’s sheet; the merchant holds the wallet’s decryption keys and sends Rapyd the DPAN + cryptogram — card data on its servers, PCI scope (Own Card Fields only).',
  },
};
/** The seam's wallet line for a path, given the effective wallet integration. */
export function seamWalletLine(key, wallet) {
  const w = WALLET_SEAMS[wallet];
  if (!w) return null;
  return key === 'own-fields' && w.ownFields ? w.ownFields : w.line;
}
/** The tag on the simulated wallet sheet in the frame (grey marker). */
export const walletSheetLabel = (walletLabel) => `${walletLabel} sheet (simulated)`;

const TOOLKIT_KEYS = new Set(['embedded', 'wallets', 'hosted']);
/** state.model + the toolkit's integration mode → a SEAM_PATHS key. */
export function seamPathKey(model, toolkitMode) {
  if (model !== 'toolkit') return 'own-fields';
  return TOOLKIT_KEYS.has(toolkitMode) ? toolkitMode : 'embedded';
}
export const seamPath = (model, toolkitMode) => SEAM_PATHS[seamPathKey(model, toolkitMode)];

/* ── Address bar ─────────────────────────────────────────────
   The fake browser's address bar follows the journey: the merchant's domain
   (+ the page) on the site, Rapyd's hosted-checkout domain while the hosted
   page is up, the merchant's return page afterwards. */

/** Rapyd's hosted page, per environment, when a redirect_url can't be read.
    Sandbox is the host in the docs' examples (create-checkout-page:
    https://sandboxcheckout.rapyd.net/?token=checkout_…); live mirrors the
    toolkit's sandbox/live naming and is only a fallback — the real address
    always comes from the session's own redirect_url. */
export const HOSTED_DOMAIN = { sandbox: 'sandboxcheckout.rapyd.net', live: 'checkout.rapyd.net' };

export const isRapydHost = (host) => /^([a-z0-9-]+\.)*rapyd\.net$/i.test(String(host || ''));

/** { host, path } for the hosted page, from the session's redirect_url. Only an
    https Rapyd host is shown as-is; anything else falls back to the env's
    domain (the address bar must never print a non-Rapyd host as Rapyd's). */
export function hostedAddress(redirectUrl, env = 'sandbox') {
  try {
    const u = new URL(String(redirectUrl || ''));
    if (u.protocol === 'https:' && isRapydHost(u.hostname)) {
      return { host: u.host, path: `${u.pathname === '/' ? '/' : u.pathname}${u.search}` };
    }
  } catch { /* not a URL — fall back */ }
  return { host: HOSTED_DOMAIN[env === 'live' ? 'live' : 'sandbox'], path: '/' };
}

/* A plausible path per site page (display only — the site is one SPA). */
const PAGE_PATHS = {
  'account-q': '/signin', account: '/register', shop: '/', product: '/product', bag: '/bag',
  checkout: '/checkout', orders: '/account/orders', methods: '/account/payment-methods', wallet: '/account/wallet',
  complete: '/checkout/complete', cancel: '/checkout/cancel',
};
export const pagePath = (page) => PAGE_PATHS[page] ?? '/';

/** Write the address bar. `rapyd` marks it as Rapyd's domain (the seam tag on
    the bar shows only while "Show seam" is on). Text only — textContent. */
export function setAddress(host, path = '/', rapyd = false) {
  const el = typeof document !== 'undefined' && document.getElementById('client-domain');
  if (!el) return;
  el.textContent = `${host}${path === '/' ? '' : path}`;
  el.closest('.urlbar')?.classList.toggle('is-rapyd', !!rapyd);
}

/* ── Show seam (SE switch) ───────────────────────────────── */
let seamOn = true;
export const isSeamOn = () => seamOn;
/** Toggle every seam marker. CSS-only (`.browser.seam-on`), so it applies to
    surfaces already on screen — an in-flight iframe is never re-rendered. */
export function setSeamOn(on) {
  seamOn = !!on;
  applySeam();
}
export function applySeam() {
  if (typeof document === 'undefined') return;
  document.querySelector('.browser')?.classList.toggle('seam-on', seamOn);
}

/** Wrap a Rapyd surface's markup in the seam marker. `inner` is trusted markup
    from the caller; the label is escaped. The wrapper adds an outline and a tag
    around the surface — nothing reaches inside it. */
export function seamWrapHTML(inner, label, extraClass = '') {
  return `<div class="seam-rapyd${extraClass ? ` ${esc(extraClass)}` : ''}" data-seam="${esc(label)}">${inner}</div>`;
}

/** The SE-facing explainer for a path — drawer and engine room share it.
    `tds` is the MID's 3DS provider ('rapyd' | 'external' | null in live);
    `wallet` the effective wallet integration (direct-wallet.js) or null. */
export function seamLinesHTML(key, { tds = null, wallet = null } = {}) {
  const p = SEAM_PATHS[key] || SEAM_PATHS['own-fields'];
  const tdsLine = seamTdsLine(key, tds);
  const walletLine = seamWalletLine(key, wallet);
  const direct = wallet === 'encrypted' || wallet === 'decrypted';
  return `
    <ul class="seam-lines">
      <li><b>Card form</b><span>${esc(p.form)}</span></li>
      <li><b>PCI</b><span>${esc(p.pci)}</span></li>
      <li><b>Redirects</b><span>${esc(p.redirect)}</span></li>
      ${tdsLine ? `<li><b>3DS</b><span>${esc(tdsLine)}</span></li>` : ''}
      ${walletLine ? `<li><b>Wallets</b><span>${esc(walletLine)}</span></li>` : ''}
    </ul>
    <div class="seam-owners">
      <div><span class="seam-who merchant">Merchant</span>${esc(p.merchant.join(' · '))}${direct ? esc(` · Apple Pay / Google Pay buttons${wallet === 'decrypted' ? ' · token decryption (PCI)' : ''}`) : ''}</div>
      ${direct ? `<div><span class="seam-who third">Apple / Google</span>${esc('Payment sheet · merchant validation · the token')}</div>` : ''}
      <div><span class="seam-who rapyd">Rapyd</span>${esc(p.rapyd.join(' · '))}${wallet === 'encrypted' ? esc(' · token decryption') : ''}</div>
    </div>`;
}

/** The engine room's collapsible seam strip (above the request tabs' panels). */
export function seamStripHTML(key, open = false, opts = {}) {
  const p = SEAM_PATHS[key] || SEAM_PATHS['own-fields'];
  return `
    <details class="seam-strip"${open ? ' open' : ''}>
      <summary><span class="seam-strip-k">Integration seam</span><span class="seam-strip-v">${esc(p.label)}</span><span class="seam-strip-tag">${esc(p.tag)}</span></summary>
      ${seamLinesHTML(key, opts)}
    </details>`;
}
