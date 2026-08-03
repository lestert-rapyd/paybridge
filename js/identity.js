/* ─────────────────────────────────────────────────────────────
   Checkout identity — the first decision of the checkout, shared by
   BOTH flows. Three modes make the Rapyd customer object's position
   in the overall flow explicit:

     guest     · no cus_*** at all — the one-time payment path
     account   · a cus_*** is created at submit; the profile starts
                 with NO cards and gains them as purchases save them
     returning · reuse this session's cus_*** and its cards on file

   The customer is still created LAZILY (beat 1 of submit), so picking a
   mode never fires an API call — it records intent only.

   Session-scoped, like customers.js: "returning" means a credential
   already exists in the active `env:profile` bucket. Nothing persists
   across reloads and there is no retrieve-customer endpoint, so this is
   the only honest meaning available.
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';
import * as customers from './customers.js';
import { activeProduct } from './verticals.js';

export const IDENTITY_MODES = ['guest', 'account', 'returning'];

const isSubscription = () => activeProduct().billing === 'subscription';

/** Saved credentials reusable by the customer on this page (customer-present).
    Subscriptions bill from the back office (MIT), so they never list here. */
export function reusableCreds() {
  return activeProduct().billing === 'one_time' ? customers.credentialsFor('unscheduled') : [];
}

/** Returning needs a saved card to return TO. */
export const canReturn = () => reusableCreds().length > 0;
/** Subscribing inherently stores the card, so a subscription can't be a guest. */
export const canGuest = () => !isSubscription();

/** The EFFECTIVE mode. Guards stale selections: an env/profile switch re-keys
    the customer bucket (credentials vanish) and a product switch can outlaw
    guest — in both cases the stored choice must degrade rather than lie. */
export function identityMode() {
  const m = state.identityMode;
  if (m === 'returning' && !canReturn()) return canGuest() ? 'guest' : 'account';
  if (m === 'guest' && !canGuest()) return 'account';
  return m;
}
export function setIdentityMode(mode) {
  if (IDENTITY_MODES.includes(mode)) state.identityMode = mode;
}

/** Whether this payment attaches (or creates) a cus_***. */
export const usesCustomer = () => identityMode() !== 'guest';

/** After a payment saves a card, the natural next state is "returning" — this
    reproduces the old implicit behaviour, where the saved-card view flipped
    itself on as soon as credentials existed. */
export function promoteToReturning() {
  if (canReturn()) state.identityMode = 'returning';
}

const LABEL = {
  guest: 'Guest checkout',
  account: 'Create an account',
  returning: 'Returning customer',
};

function captionHTML() {
  switch (identityMode()) {
    case 'guest':
      return `No account — this payment carries no <code>cus_***</code>. Cards can still be vaulted by the merchant.`;
    case 'account':
      return `<code>POST /v1/customers</code> runs first, then the card saves under the new <code>cus_***</code>.`;
    default: {
      const cus = customers.getCustomerId();
      return `Reusing ${cus ? `<code>${cus}</code>` : 'the saved customer'} and its cards on file.`;
    }
  }
}

/** Repaint the chooser in place. Credentials arriving mid-session (a webhook
    harvest, a list backfill, a profile re-key) can unlock or withdraw
    "Returning" while the checkout is on screen, and the chooser lives in the
    shell — outside the surfaces those events already repaint. Safe to swap
    wholesale: the click handler is delegated on the stable #checkout root. */
export function refreshIdentityChooser() {
  const block = document.querySelector('.id-block');
  if (block) block.outerHTML = identityChooserHTML();
}

/** Customer-facing 3-way chooser. Rendered by app.js's checkout shell and by
    the toolkit's own summary aside — hence a shared template here rather than
    inside either flow. */
export function identityChooserHTML() {
  const active = identityMode();
  const btn = (mode, blockedWhy) => `
    <button type="button" data-mode="${mode}" class="${mode === active ? 'active' : ''}"${blockedWhy ? ` disabled title="${blockedWhy}"` : ''}>${LABEL[mode]}</button>`;
  return `
    <div class="id-block">
      <div class="id-label">How would you like to check out?</div>
      <div class="id-select" id="identity-select">
        ${btn('guest', canGuest() ? '' : 'A subscription stores the card — it needs an account')}
        ${btn('account', '')}
        ${btn('returning', canReturn() ? '' : 'Unlocks once an account has saved a card')}
      </div>
      <div class="id-caption">${captionHTML()}</div>
    </div>`;
}
