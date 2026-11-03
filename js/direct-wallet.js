/* ─────────────────────────────────────────────────────────────
   Direct Apple Pay / Google Pay — MOCK wallet token, REAL sandbox call.
   The merchant puts the wallet's own button on its own checkout, takes
   the token the wallet sheet returns and calls POST /v1/payments itself.
   Two variants:

     encrypted · the merchant forwards the wallet's ENCRYPTED token,
                 unchanged; Rapyd decrypts it server-side. No card data
                 on the merchant's systems.
     decrypted · the merchant decrypts the token itself (it holds the
                 wallet's decryption keys) and sends the DPAN +
                 cryptogram (+ ECI). The card is then on the merchant's
                 servers — PCI scope.

   Both are demoed for PCI-DSS merchants only (user decision 2026-11-03):
   the merchant's own wallet buttons appear on the Own Card Fields path
   and nowhere else.

   The CHECKOUT variants — Apple Pay / Google Pay inside Rapyd's toolkit
   iframe ("Wallet buttons") or hosted page — are real and untouched
   (flows/toolkit.js); in the drawer, "Off" = no merchant buttons.

   What's mock and what's real: there is no Apple / Google session — the
   sheet is drawn by the page and the token it "returns" is built here,
   every opaque value an obviously dummy one carrying a SIMULATED marker.
   That token then goes to Rapyd for real: the Rapyd SANDBOX accepts mock
   wallet payloads and creates a genuine payment (checked 2026-11-03 on
   all five shapes — each answered CLO, paid; the sandbox charges its own
   test card, not the 4111 in the mock). So the payment, its webhook and
   its ledger entry are real; only the wallet side is pretend. Sandbox
   only — a mock token has no place beside live money (and the backend
   refuses a decrypted PAN in live: utils/live-guards.js hasRawCard).

   Rapyd field names — exactly as documented, checked against:
     · docs.rapyd.net/en/creating-a-payment-with-apple-pay--encrypted-.html
       payment_method { type: "by_visa_card", digital_wallet { type:
       "apple_pay", details { token { paymentData { data, signature,
       header { publicKeyHash, ephemeralPublicKey, transactionId },
       version: "EC_v1" }, paymentMethod { displayName, network, type },
       transactionIdentifier } } } } — "token.paymentData to
       payment_method.digital_wallet.details.token" (also creating-an-apple-
       pay-payment-on-a-customized-checkout-page.html); metadata {
       digital_wallet: "apple_pay" } and capture: true as in the sample
     · docs.rapyd.net/en/creating-a-payment-with-apple-pay--decrypted-.html
       details { decrypted_data { applicationPrimaryAccountNumber,
       applicationExpirationDate (YYMMDD), currencyCode (ISO 4217 numeric),
       transactionAmount, deviceManufacturerIdentifier, paymentDataType:
       "3DSecure", paymentData { onlinePaymentCryptogram, eciIndicator: "7" } },
       brand_data { displayName, network, type } } — "copy token.paymentData
       to decrypted_data and token.paymentMethod to brand_data"
     · docs.rapyd.net/en/creating-a-payment-with-google-pay---encrypted-.html
       details { token { apiVersionMinor, apiVersion, paymentMethodData {
       description, type: "CARD", info { cardNetwork, cardDetails,
       assuranceDetails }, tokenizationData { type: "PAYMENT_GATEWAY", token
       } } }, type: "CARD" } — tokenizationData.token is the JSON STRING
       Google returns, "without any changes" (both doc samples). "CARD" sits
       both in `details` (the encrypted page) and in paymentMethodData
       (Google's own shape, recurring-digital-wallet-payments.html)
     · docs.rapyd.net/en/creating-a-payment-with-google-pay---decrypted-.html
       (expirationYear / expirationMonth are NUMBERS in its samples)
       details { decrypted_data { gatewayMerchantId, messageExpiration,
       messageId, paymentMethod: "CARD", paymentMethodDetails { pan,
       expirationMonth, expirationYear, authMethod: "CRYPTOGRAM_3DS" |
       "PAN_ONLY", cryptogram, eciIndicator } }, brand_data { cardDetails,
       cardNetwork } } — gatewayMerchantId is the merchant's Rapyd ACCESS
       KEY: the browser never holds it, so this sends a placeholder and the
       backend writes the key in before signing (create-direct-payment.js
       withGatewayMerchantId). PAN_ONLY carries no cryptogram / ECI; Rapyd
       may answer it ACT + next_action 3d_verification (Rapyd's 3DS) — the
       sandbox answered CLO
     · docs.rapyd.net/en/creating-a-google-pay--payment-on-a-customized-
       checkout-page.html — tokenizationSpecification PAYMENT_GATEWAY,
       gateway "Rapyd", gatewayMerchantId = the merchant's Rapyd access
       key; allowedAuthMethods PAN_ONLY, CRYPTOGRAM_3DS
     · docs.rapyd.net/en/retrieve-apple-pay-session.html — POST
       /v1/digital_wallets/session/apple_pay { display_name,
       initiative_context } returns the Apple Pay session (merchant
       validation through Rapyd)
   3DS — no "6DS": the wallet already did SCA (Face ID / Touch ID, or the
   cryptogram), so every body says payment_method_options.3d_required:
   false — EXCEPT Google Pay PAN_ONLY, a card on file with no cryptogram,
   which asks for Rapyd's 3DS (true) and comes back ACT + redirect_url
   (sandbox, SC1–SC3: checked 2026-11-03).

   payment_method.type is the CARD's method type (the docs' samples use
   gb_/sg_ visa and mastercard types — there is no *_apple_pay type); this demo sends
   gb_visa_card like every other card body here (sync.js detectBrand).
   The docs say nothing about PCI for the decrypted variant — "decrypted
   = PCI scope" is the card-data rule (the DPAN is a card number), not a
   Rapyd quote. Neither Rapyd's encrypted pages nor its overview say how
   the payment processing certificate is set up for Rapyd to decrypt —
   the Apple box says "set up with Rapyd", not more.

   Pure data + builders (tests/unit.js imports this) — no DOM, no network;
   the call itself is flows/direct-wallet.js.
   ───────────────────────────────────────────────────────────── */

/** The drawer's choices (Integration path → Wallet integration). Text only. */
export const WALLET_INTEGRATIONS = [
  ['checkout', 'Off'],
  ['encrypted', 'Direct — encrypted (mock token)'],
  ['decrypted', 'Direct — decrypted (mock token)'],
];
let integration = 'checkout';
export const walletIntegration = () => integration;
export function setWalletIntegration(v) {
  if (WALLET_INTEGRATIONS.some(([k]) => k === v)) integration = v;
}

/** Google Pay's decrypted authMethod (drawer: shown under a decrypted pick).
    CRYPTOGRAM_3DS — a tokenised card with a cryptogram + ECI; PAN_ONLY — a
    card on file in the Google account, no cryptogram. */
export const GOOGLE_AUTH_METHODS = ['CRYPTOGRAM_3DS', 'PAN_ONLY'];
let googleAuth = 'CRYPTOGRAM_3DS';
export const googleAuthMethod = () => googleAuth;
export function setGoogleAuthMethod(v) {
  if (GOOGLE_AUTH_METHODS.includes(v)) googleAuth = v;
}

/** Whether a variant can run on this path. Text only — callers escape.
    Both direct variants are Own Card Fields (PCI) only, and sandbox-only —
    a mock token has no place beside live money. */
export function walletAvailability(variant, { model, env } = {}) {
  if (variant === 'checkout') return { ok: true, reason: '' };
  if (!WALLET_INTEGRATIONS.some(([k]) => k === variant)) return { ok: false, reason: 'Unknown wallet integration.' };
  if (env === 'live') return { ok: false, reason: 'Mock wallet tokens — sandbox only.' };
  if (model !== 'own-fields') {
    return { ok: false, reason: 'Own Card Fields only — direct Apple Pay / Google Pay is demoed for PCI-DSS merchants.' };
  }
  return { ok: true, reason: '' };
}
/** The variant that actually runs: the SE's pick, or Off when the pick
    doesn't apply to this path. */
export function effectiveWalletIntegration(ctx, pick = integration) {
  return walletAvailability(pick, ctx).ok ? pick : 'checkout';
}
export const isDirect = (variant) => variant === 'encrypted' || variant === 'decrypted';

/* ── The wallets ─────────────────────────────────────────── */
export const WALLETS = {
  apple: { id: 'apple', label: 'Apple Pay', type: 'apple_pay', party: 'Apple' },
  google: { id: 'google', label: 'Google Pay', type: 'google_pay', party: 'Google' },
};
export const WALLET_ORDER = ['apple', 'google'];

/* ── Obviously-fake values ───────────────────────────────────
   Every opaque value decodes to (or reads as) SIMULATED. The card is the
   well-known 4111 test number. */
export const SIM_MARK = 'SIMULATED';
const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : s);
const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
export const SIM_DPAN = '4111111111111111';
export const SIM_LAST4 = SIM_DPAN.slice(-4);
/* 20 bytes, like a real cryptogram — decodes to "SIMULATED-CRYPTOGRAM". */
export const SIM_CRYPTOGRAM = b64('SIMULATED-CRYPTOGRAM');
export const SIM_EXPIRY = { month: 12, year: 2029 };
/* Google decrypted: what the page sends for gatewayMerchantId — the backend
   replaces it with the merchant's Rapyd access key before signing. */
export const GATEWAY_ID_PLACEHOLDER = 'RAPYD_ACCESS_KEY';
const SIM_TXN = hex('SIMULATED-APPLE-PAY-TXN').toUpperCase();

/** Rapyd's card method type for the wallet's card (see the header). */
export const DIRECT_METHOD_TYPE = 'gb_visa_card';

/* ISO 4217 numeric codes for the currencies this demo charges in (Apple's
   decrypted currencyCode is numeric). Unknown → null, shown as such. */
const ISO_NUMERIC = { USD: '840', EUR: '978', GBP: '826', SGD: '702', ISK: '352' };
export const currencyNumeric = (c) => ISO_NUMERIC[String(c || '').toUpperCase()] || null;

/* Minor units without float drift: "149.99" → 14999 (decimals from the caller). */
export function minorUnits(amount, decimals = 2) {
  const [i, f = ''] = String(amount ?? '0').split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return Number(`${i || '0'}${frac}`) || 0;
}

/** What the wallet sheet hands back to the page (encrypted, as the merchant
    receives it). Apple: the PKPaymentToken; Google: PaymentData's
    paymentMethodData plus the API version. */
export function encryptedToken(wallet) {
  if (wallet === 'apple') {
    return {
      paymentData: {
        data: b64('SIMULATED-APPLE-PAY-ENCRYPTED-PAYMENT-DATA-NOT-A-REAL-TOKEN'),
        signature: b64('SIMULATED-PKCS7-SIGNATURE'),
        header: {
          publicKeyHash: b64('SIMULATED-PUBLIC-KEY-HASH'),
          ephemeralPublicKey: b64('SIMULATED-EPHEMERAL-PUBLIC-KEY'),
          transactionId: hex('SIMULATED-TXN'),
        },
        version: 'EC_v1',
      },
      paymentMethod: { displayName: `Visa ${SIM_LAST4}`, network: 'Visa', type: 'credit' },
      transactionIdentifier: SIM_TXN,
    };
  }
  if (wallet === 'google') {
    // Google's ECv2 envelope — a JSON STRING, forwarded unchanged.
    const inner = {
      signature: b64('SIMULATED-ECDSA-SIGNATURE'),
      intermediateSigningKey: {
        signedKey: JSON.stringify({ keyValue: b64('SIMULATED-INTERMEDIATE-KEY'), keyExpiration: '0' }),
        signatures: [b64('SIMULATED-KEY-SIGNATURE')],
      },
      protocolVersion: 'ECv2',
      signedMessage: JSON.stringify({ encryptedMessage: b64('SIMULATED-GOOGLE-PAY-ENCRYPTED-MESSAGE'), ephemeralPublicKey: b64('SIMULATED-EPHEMERAL-KEY'), tag: b64('SIMULATED-TAG') }),
    };
    return {
      apiVersionMinor: 0,
      apiVersion: 2,
      paymentMethodData: {
        description: `VISA ****${SIM_LAST4}`,
        type: 'CARD',
        info: { cardNetwork: 'VISA', cardDetails: SIM_LAST4, assuranceDetails: { accountVerified: true, cardHolderAuthenticated: false } },
        tokenizationData: { type: 'PAYMENT_GATEWAY', token: JSON.stringify(inner) },
      },
    };
  }
  throw new Error(`Unknown wallet: ${wallet}`);
}

/** What the MERCHANT gets after decrypting the token with its own keys —
    already in Rapyd's decrypted_data / brand_data shape. `now` (ms) only
    feeds Google's messageExpiration; `authMethod` is Google's (see above). */
export function decryptedDetails(wallet, { amount, currency, decimals = 2, now = Date.now(), authMethod = 'CRYPTOGRAM_3DS' } = {}) {
  if (wallet === 'apple') {
    const yy = String(SIM_EXPIRY.year).slice(-2);
    return {
      decrypted_data: {
        applicationPrimaryAccountNumber: SIM_DPAN,
        applicationExpirationDate: `${yy}${String(SIM_EXPIRY.month).padStart(2, '0')}31`, // YYMMDD
        currencyCode: currencyNumeric(currency),
        transactionAmount: minorUnits(amount, decimals),
        deviceManufacturerIdentifier: 'SIMULATED-DEVICE',
        paymentDataType: '3DSecure',
        paymentData: { onlinePaymentCryptogram: SIM_CRYPTOGRAM, eciIndicator: '7' },
      },
      brand_data: { displayName: `Visa ${SIM_LAST4}`, network: 'Visa', type: 'credit' },
    };
  }
  if (wallet === 'google') {
    const pan = authMethod === 'PAN_ONLY';
    return {
      decrypted_data: {
        gatewayMerchantId: GATEWAY_ID_PLACEHOLDER,
        messageExpiration: String(now + 7 * 24 * 3600 * 1000),
        messageId: 'SIMULATED-MESSAGE-ID-0001',
        paymentMethod: 'CARD',
        paymentMethodDetails: {
          pan: SIM_DPAN,
          expirationMonth: SIM_EXPIRY.month,
          expirationYear: SIM_EXPIRY.year,
          authMethod: pan ? 'PAN_ONLY' : 'CRYPTOGRAM_3DS',
          ...(pan ? {} : { cryptogram: SIM_CRYPTOGRAM, eciIndicator: '07' }),
        },
      },
      brand_data: { cardDetails: SIM_LAST4, cardNetwork: 'VISA' },
    };
  }
  throw new Error(`Unknown wallet: ${wallet}`);
}

/** The digital_wallet.details block per variant. */
export function walletDetails(wallet, variant, opts = {}) {
  if (variant === 'encrypted') {
    const details = { token: encryptedToken(wallet) };
    if (wallet === 'google') details.type = 'CARD'; // where Rapyd's sample puts it
    return details;
  }
  if (variant === 'decrypted') return decryptedDetails(wallet, opts);
  throw new Error(`Not a direct wallet variant: ${variant}`);
}

/** The POST /v1/payments body (mock token inside). Throws when the variant
    isn't allowed on this path — a decrypted body is never built off the PCI
    path, nor in live. `amount` / `currency` are Rapyd's (the price); `charge`
    is what the sheet showed the shopper (differs under FX) and feeds the
    wallet's own data. `ewallet` / `descriptor` as on every other payment. */
export function directPaymentBody({ wallet, variant, model, env = 'sandbox', amount, currency, charge = null, decimals = 2, description, reference, descriptor, ewallet, authMethod, now } = {}) {
  if (!WALLETS[wallet]) throw new Error(`Unknown wallet: ${wallet}`);
  if (!isDirect(variant)) throw new Error(`Not a direct wallet variant: ${variant}`);
  const avail = walletAvailability(variant, { model, env });
  if (!avail.ok) throw new Error(`${WALLETS[wallet].label} ${variant} refused: ${avail.reason}`);
  const type = WALLETS[wallet].type;
  const body = {
    amount: Number(amount),
    currency,
    capture: true,
    merchant_reference_id: reference || `${SIM_MARK}-ref`,
    metadata: { digital_wallet: type }, // as in Rapyd's samples
    payment_method: {
      type: DIRECT_METHOD_TYPE,
      digital_wallet: {
        type,
        details: walletDetails(wallet, variant, { amount: charge?.amount ?? amount, currency: charge?.currency ?? currency, decimals, now, authMethod }),
      },
    },
  };
  // Rapyd's 3DS only where the wallet did no SCA of its own (see the header).
  body.payment_method_options = { '3d_required': needsRapyd3DS(wallet, variant, authMethod) };
  if (ewallet) body.ewallet = ewallet;
  if (descriptor) body.statement_descriptor = descriptor;
  if (description) body.description = description;
  return body;
}

/** Google Pay PAN_ONLY (decrypted) is the one wallet payment with no SCA of
    its own — Rapyd's 3DS steps in. Everything else carries the wallet's. */
export function needsRapyd3DS(wallet, variant, authMethod) {
  return wallet === 'google' && variant === 'decrypted' && authMethod === 'PAN_ONLY';
}

/** Body paths the wallet's own data sits at — highlighted in the request view. */
export function walletDataPaths(wallet, variant) {
  const base = 'payment_method.digital_wallet.details';
  if (variant === 'encrypted') return wallet === 'google' ? [`${base}.token`, `${base}.type`] : [`${base}.token`];
  return [`${base}.decrypted_data`, `${base}.brand_data`];
}

/** Every primitive leaf of `obj` under one of `prefixes`, as json-view's
    dotted data-paths (it highlights leaves only). */
export function leafPathsUnder(obj, prefixes) {
  const out = [];
  const walk = (v, path) => {
    if (v && typeof v === 'object') {
      for (const [k, c] of Object.entries(v)) walk(c, path ? `${path}.${k}` : k);
    } else if (prefixes.some((p) => path === p || path.startsWith(`${p}.`))) out.push(path);
  };
  walk(obj, '');
  return out;
}

/* ── The sequence, per wallet × variant ──────────────────────
   Steps outside Rapyd (`party` apple / google / merchant) are ONE line + a
   link to the wallet's own docs — Rapyd doesn't author Apple's or Google's
   guidance. The single `rapyd` step is the real (sandbox) POST /v1/payments
   the engine room details in full. `pci` marks the merchant handling card data.
   Text only — callers escape. */
const DOCS = {
  appleSetup: 'https://developer.apple.com/help/account/capabilities/configure-apple-pay-on-the-web/',
  appleSession: 'https://developer.apple.com/documentation/apple_pay_on_the_web/apple_pay_js_api/requesting_an_apple_pay_payment_session',
  appleAuthorized: 'https://developer.apple.com/documentation/apple_pay_on_the_web/applepaysession/1778020-onpaymentauthorized',
  appleToken: 'https://developer.apple.com/documentation/passkit/payment-token-format-reference',
  googleSetup: 'https://developers.google.com/pay/api/web/guides/setup',
  googleTokenization: 'https://developers.google.com/pay/api/web/reference/request-objects',
  googleClient: 'https://developers.google.com/pay/api/web/reference/client',
  googleCrypto: 'https://developers.google.com/pay/api/web/guides/resources/payment-data-cryptography',
};
export const WALLET_DOCS = DOCS;

export function walletSteps(wallet, variant) {
  const enc = variant === 'encrypted';
  if (wallet === 'apple') {
    return [
      { party: 'apple', title: 'Merchant ID + certificates',
        line: enc
          ? 'Apple merchant ID, domain verification and a merchant identity certificate; the payment processing certificate is set up with Rapyd, so Rapyd can decrypt.'
          : 'Apple merchant ID, domain verification and a merchant identity certificate; the merchant creates its OWN payment processing certificate and keeps the private key.',
        link: { href: DOCS.appleSetup, label: 'Apple: configure Apple Pay on the web' } },
      { party: 'apple', title: 'Merchant validation',
        line: 'When the sheet opens, the merchant’s server requests an Apple Pay session with its merchant identity certificate.',
        link: { href: DOCS.appleSession, label: 'Apple: requesting a payment session' },
        rapydNote: 'Rapyd can return that session instead: POST /v1/digital_wallets/session/apple_pay (not shown).' },
      { party: 'apple', title: 'Sheet returns the token', sheet: true,
        line: 'The shopper approves with Face ID / Touch ID; onpaymentauthorized hands the page an encrypted payment token.',
        link: { href: DOCS.appleAuthorized, label: 'Apple: onpaymentauthorized' } },
      enc
        ? { party: 'merchant', title: 'Forward the token',
            line: 'The page posts the whole token, unchanged, to the merchant’s server — it can’t read it.' }
        : { party: 'merchant', title: 'Decrypt the token', pci: true,
            line: 'The merchant’s server decrypts paymentData with its payment processing private key → DPAN, expiry, cryptogram, ECI.',
            link: { href: DOCS.appleToken, label: 'Apple: payment token format' } },
      { party: 'rapyd', title: 'POST /v1/payments' },
    ];
  }
  return [
    { party: 'google', title: 'Merchant ID + tokenization',
      line: enc
        ? 'Google merchant ID; tokenizationSpecification PAYMENT_GATEWAY with gateway "Rapyd" and gatewayMerchantId = the merchant’s Rapyd ID (per Rapyd’s docs).'
        : 'Google merchant ID; DIRECT tokenization with the merchant’s own public key (Google requires a PCI attestation for it).',
      link: { href: enc ? DOCS.googleTokenization : DOCS.googleSetup, label: enc ? 'Google: tokenization specification' : 'Google: setup' } },
    { party: 'google', title: 'Sheet returns the token', sheet: true,
      line: enc
        ? 'loadPaymentData() returns PaymentData whose token is encrypted for Rapyd.'
        : 'loadPaymentData() returns PaymentData whose token is encrypted for the merchant.',
      link: { href: DOCS.googleClient, label: 'Google: PaymentsClient' } },
    enc
      ? { party: 'merchant', title: 'Forward the token',
          line: 'The page posts the token object, unchanged, to the merchant’s server — it can’t read it.' }
      : { party: 'merchant', title: 'Decrypt the token', pci: true,
          line: 'The merchant’s server verifies and decrypts the ECv2 token with its private key → PAN/DPAN, expiry, cryptogram, ECI.',
          link: { href: DOCS.googleCrypto, label: 'Google: payment data cryptography' } },
    { party: 'rapyd', title: 'POST /v1/payments' },
  ];
}
