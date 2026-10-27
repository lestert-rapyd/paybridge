/* ─────────────────────────────────────────────────────────────
   The merchant site's sign-in session — the MERCHANT's login, which
   never calls Rapyd. A merchant authenticates its own shopper and then
   references the cus_*** it stored for them; the Rapyd customer object
   is not a credential store. So:

     signed in  ⇔  this env:profile bucket holds a cus_*** (customers.js)
                    and the shopper hasn't signed out of the site

   Signing out keeps the cus_*** (it still exists at Rapyd, and the
   next sign-in references it again) and checks the shopper out as a
   guest. Signing in with no cus_*** in the bucket is refused in
   shopper words — "returning" can only mean this tab's own customer
   (see js/identity.js on why nothing persists across reloads).

   The password field is decorative: there is no merchant user store
   in this demo, and nothing typed into it is read or kept.
   ───────────────────────────────────────────────────────────── */

import * as customers from '../customers.js';
import { setIdentityMode, promoteToReturning } from '../identity.js';

let signedOut = false;

export const isSignedIn = () => !!customers.getCustomerId() && !signedOut;

/** Site sign-out: the shopper continues as a guest; the cus_*** stays filed. */
export function signOut() {
  signedOut = true;
  setIdentityMode('guest');
}

/** Site sign-in against the session's customer. Returns null on success, else
    the shopper-facing reason. Email match is case-insensitive. */
export function signIn(email) {
  if (!customers.getCustomerId()) return 'We couldn’t find an account for that email. Create one below — it only takes a moment.';
  const want = String(customers.getIdentity().email || '').trim().toLowerCase();
  if (String(email || '').trim().toLowerCase() !== want) return 'That email and password don’t match our records.';
  signedOut = false;
  setIdentityMode('account');
  promoteToReturning(); // a card on file makes this a returning customer
  return null;
}

/** A customer created on the register page signs the shopper in. */
export function markSignedIn() { signedOut = false; }
