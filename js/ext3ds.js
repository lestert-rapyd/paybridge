/* ─────────────────────────────────────────────────────────────
   External 3DS — SIMULATED. Some MIDs (profiles.js tds:'external', SC2)
   are set up for a merchant that runs its OWN 3DS provider: the merchant
   authenticates the shopper first, and only if that passes does it call
   Rapyd, passing the authentication results in payment_method_options.
   A failed authentication never reaches Rapyd at all.

   Nothing here talks to a real 3DS server. The provider's challenge is a
   neutral "issuer" page in the frame (screens.js renderExternal3DS) and its
   results are obviously dummy values; the POST /v1/payments that follows a
   pass is real.

   Only the Own Card Fields path can do this — the merchant must hold the
   card to authenticate it. On the toolkit / hosted page Rapyd hosts the card
   form, so Rapyd runs 3DS (seam.js seamTdsLine says so).

   Rapyd field names, checked against:
     · docs.rapyd.net/en/creating-a-card-payment-with-3ds-authentication---external-3ds.html
       — payment_method_options { 3d_version, cavv, eci, ds_trans_id }
       (example: "2.2.0", "BwABBYcyOCdlg0QChDI4EHUURgE", "05",
       "1b20b229-…"); cavv = the CAVV, 20 bytes Base64-encoded; eci from
       the 3DS Server; ds_trans_id required for Mastercard 2.0; NO
       3d_required in the request; "not currently available for hosted
       pages"; the feature is enabled per account by Rapyd Client Support
     · docs.rapyd.net/en/creating-a-card-payment-with-an-external-3ds-provider.html
       — same fields (3d_version 1.0.2 / 2.1.0 / 2.2.0; eci 01 02 05 06 07 08)
   xid (3DS 1.0's transaction id) is not among Rapyd's documented fields, so
   it isn't sent. The provider-side names below (transStatus,
   authenticationValue, dsTransID, messageVersion) are EMV 3DS's.

   Pure data + helpers (tests/unit.js imports this) — no DOM, no network.
   ───────────────────────────────────────────────────────────── */

import { PROFILES } from './profiles.js';

/** The SE's default outcome (drawer → Account → 3-D Secure provider), so the
    run can be preset before the room. Text labels only — callers escape. */
export const EXT3DS_OUTCOMES = [
  ['challenge', 'Challenge'],
  ['frictionless', 'Frictionless'],
  ['fail', 'Fail'],
];
let preset = 'challenge';
export const ext3dsPreset = () => preset;
export function setExt3dsPreset(v) {
  if (EXT3DS_OUTCOMES.some(([k]) => k === v)) preset = v;
}

/** Whether the merchant's own 3DS runs: a sandbox MID configured for an
    external provider, on the PCI path. Live has no profiles — and Own Card
    Fields are off in live anyway. */
export function usesExternal3DS({ env, profile, model }) {
  return env === 'sandbox' && model === 'own-fields' && PROFILES[profile]?.tds === 'external';
}

/* Obviously-dummy authentication values. The CAVV is a real 20-byte Base64
   value, as Rapyd's field expects — it decodes to "SIMULATED-CAVV-00000". */
export const DUMMY_CAVV = 'U0lNVUxBVEVELUNBVlYtMDAwMDA=';
export const DUMMY_DS_TRANS_ID = '00000000-5141-4000-8000-000000000001';
export const DUMMY_SERVER_TRANS_ID = '00000000-5141-4000-8000-000000000002';
export const EXT3DS_VERSION = '2.2.0';

/* How each outcome comes about:
     challenge-pass  · the shopper completed the issuer's challenge
     challenge-fail  · …and failed it
     frictionless    · the issuer authenticated without a challenge
     frictionless-fail · the issuer refused without a challenge (the SE's "Fail" preset) */
export const EXT3DS_CHOICES = ['challenge-pass', 'challenge-fail', 'frictionless', 'frictionless-fail'];

/** The provider's authentication result (EMV 3DS names), simulated. ECI per
    scheme: Visa / Amex / others 05 (authenticated) / 07, Mastercard 02 / 00. */
export function simulateExternal3DS(choice, brand = '') {
  const c = EXT3DS_CHOICES.includes(choice) ? choice : 'challenge-fail'; // unknown → never a pass
  const passed = c === 'challenge-pass' || c === 'frictionless';
  const mc = /master/i.test(String(brand));
  const r = {
    simulated: true,
    outcome: c,
    challenged: c.startsWith('challenge'),
    messageVersion: EXT3DS_VERSION,
    transStatus: passed ? 'Y' : 'N',
    eci: passed ? (mc ? '02' : '05') : (mc ? '00' : '07'),
    threeDSServerTransID: DUMMY_SERVER_TRANS_ID,
    dsTransID: DUMMY_DS_TRANS_ID,
  };
  if (passed) r.authenticationValue = DUMMY_CAVV;
  else r.transStatusReason = '01'; // EMV: card authentication failed
  return r;
}

/** The payment_method_options block for Rapyd, from a PASSED result; null
    otherwise. Rapyd's 3DS is not requested alongside it (no 3d_required). */
export function externalTdsOptions(result) {
  if (!result || result.transStatus !== 'Y' || !result.authenticationValue) return null;
  return {
    '3d_version': result.messageVersion,
    cavv: result.authenticationValue,
    eci: result.eci,
    ds_trans_id: result.dsTransID,
  };
}

/** The merchant's decision after its own 3DS: call Rapyd only on a pass. */
export function ext3dsDecision(result) {
  const options = externalTdsOptions(result);
  return { callRapyd: !!options, payment_method_options: options };
}

/** Before authentication: what the body WILL carry, as placeholders. */
export const EXT3DS_PLACEHOLDER = {
  '3d_version': '(from the 3DS provider)',
  cavv: '(from the 3DS provider)',
  eci: '(from the 3DS provider)',
  ds_trans_id: '(from the 3DS provider)',
};
/** Body paths the injected fields sit at — highlighted in the request view. */
export const EXT3DS_PMO_PATHS = Object.keys(EXT3DS_PLACEHOLDER).map((k) => `payment_method_options.${k}`);

/** Rapyd field ← provider field, for the engine room's mapping line. */
export const EXT3DS_FIELD_MAP = [
  ['3d_version', 'messageVersion'],
  ['cavv', 'authenticationValue'],
  ['eci', 'eci'],
  ['ds_trans_id', 'dsTransID'],
];

/** What the merchant sends its 3DS server (an AReq, summarised). Masked PAN
    only — the engine room never needs the full number for this card. */
export function authRequestSummary({ last4, brand, amount, currency, merchant }) {
  return {
    messageType: 'AReq',
    messageVersion: EXT3DS_VERSION,
    deviceChannel: '02', // browser
    acctNumber: `•••• •••• •••• ${last4 || '••••'}`,
    cardNetwork: brand || 'Card',
    purchaseAmount: amount,
    purchaseCurrency: currency,
    merchantName: merchant,
  };
}

/** The simulated issuer for the challenge page — deliberately generic, never
    a real bank, the merchant or Rapyd. */
export const EXT3DS_ISSUER = { name: 'Example Bank', host: 'acs.example-bank.test', path: '/3ds/challenge' };
