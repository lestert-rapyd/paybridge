/* ─────────────────────────────────────────────────────────────
   Checkout identity — the first decision of the checkout, shared by
   BOTH flows. Three modes make the Rapyd customer object's position
   in the overall flow explicit:

     guest     · no cus_*** at all — the one-time payment path
     account   · a cus_*** is created at submit; the profile starts
                 with NO cards and gains them as purchases save them
     returning · reuse this session's cus_*** and its cards on file

   The chooser itself (FRAME 1) offers only the first two — answering it never
   fires a call, it records intent. `returning` is reached by fact, not by
   choice: once a card is on file, promoteToReturning() sets it and frame 1
   shows the signed-in view instead of asking again.

   Creation stays LAZY as a fallback (beat 1 of submit) for an SE who skips the
   account frame entirely.

   Session-scoped, like customers.js: "returning" means a credential
   already exists in the active `env:profile` bucket. Nothing persists
   across reloads and there is no retrieve-customer endpoint, so this is
   the only honest meaning available.
   ───────────────────────────────────────────────────────────── */

import { state } from './state.js';
import * as customers from './customers.js';
import { activeProduct } from './verticals.js';
import { nridAvailable, activeProfile } from './profiles.js';

export const IDENTITY_MODES = ['guest', 'account', 'returning'];

const isSubscription = () => activeProduct().billing === 'subscription';

/** Saved credentials reusable by the customer on this page (customer-present).
    Subscriptions bill from the back office (MIT), so they never list here. */
export function reusableCreds() {
  return activeProduct().billing === 'one_time' ? customers.credentialsFor('unscheduled') : [];
}

/** Returning needs a saved card to return TO. */
export const canReturn = () => reusableCreds().length > 0;

/** A subscription must store the card — but NOT necessarily under a Rapyd
    customer. A PCI merchant doesn't need our customer object at all: it vaults
    the PAN itself and bills later on the card's `network_reference_id`, which is
    the `vault` route in own-fields' storageAvailability(). The toolkit never sees
    the PAN, so there the hosted page's save-card option IS the `customer` field
    on the checkout session — no account, no subscription. */
export const canGuestSubscribe = () => state.model === 'own-fields' && nridAvailable();
/** Why a guest subscription is unavailable right now — the frame states it
    rather than greying the option out. */
export function guestSubscribeBlocker() {
  if (canGuestSubscribe()) return '';
  return state.model === 'toolkit'
    ? `The toolkit's iframe collects the card, so the merchant never holds a PAN to vault — the saved card has to live under a <code>cus_***</code>.`
    : `${activeProfile().label} returns no <code>network_reference_id</code>, so there's no card to bill later without an account. Create one, or switch to <b>SC2</b>/<b>SC3</b>.`;
}
export const canGuest = () => !isSubscription() || canGuestSubscribe();

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
/** The RAW answer, before identityMode()'s degradation. The product frame needs
    this: picking a subscription is exactly what makes canGuest() false, so the
    degraded read would already say 'account' and the frame would silently
    convert the SE's guest into an account instead of explaining why it can't
    stay one. */
export const chosenGuest = () => state.identityMode === 'guest';

/** Whether this payment attaches (or creates) a cus_***. */
export const usesCustomer = () => identityMode() !== 'guest';

/** After a payment saves a card, the natural next state is "returning" — this
    reproduces the old implicit behaviour, where the saved-card view flipped
    itself on as soon as credentials existed. */
export function promoteToReturning() {
  if (canReturn()) state.identityMode = 'returning';
}

/** Repaint the question in place. Credentials arriving mid-session (a webhook
    harvest, a list backfill, a profile re-key) change what this frame should
    say while it's on screen. Safe to swap wholesale: the click handler is
    delegated on the stable #checkout root (see js/steps.js). */
export function refreshIdentityChooser() {
  const block = document.querySelector('.id-block');
  if (block) block.outerHTML = identityChooserHTML();
}

/** FRAME 1 — the first question of the checkout, and the only one that decides
    whether a call happens at all. Two answers, in route-card grammar (design
    system §04.4b): each carries a money consequence the SE narrates, so the
    consequence is on the card. `data-answer` is read by js/steps.js.

    `answered` matters: state.identityMode starts at 'guest', so without it the
    guest card would render selected under a question nobody has answered yet. */
export function identityChooserHTML(answered = false) {
  const active = answered ? identityMode() : null;
  const card = (answer, title, note, on) => `
    <button type="button" class="bo-route ${on ? 'active' : ''}" data-answer="${answer}">
      <div class="bo-route-title">${title}</div>
      <div class="bo-route-note">${note}</div>
    </button>`;
  return `
    <div class="id-block">
      <div class="id-label">Would you like an account?</div>
      <div class="bo-routes">
        ${card('account', 'Create an account',
          `<code>POST /v1/customers</code> runs first — then the card saves under the new <code>cus_***</code>, and later charges can reference it.`,
          !!active && active !== 'guest')}
        ${card('guest', 'Continue as guest',
          `No <code>cus_***</code> on this payment. A PCI merchant can still vault the card itself and bill it later on its <code>network_reference_id</code>.`,
          active === 'guest')}
      </div>
    </div>`;
}
