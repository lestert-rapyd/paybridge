/* ─────────────────────────────────────────────────────────────
   Frontend unit tests — dependency-free, browser-only, NO network.
   tests/index.html loads this as a module (behind a fetch/XHR tripwire)
   and it paints PASS/FAIL per test, then publishes
     window.__TEST_RESULTS__ = { passed, failed, failures: [{ name, error }] }
     document.title          = 'PASS n' | 'FAIL n'
   for a headless runner to read. Run it with
     python3 -m http.server   (from the paybridge repo root)
     → http://localhost:8000/tests/
   Covers the pure helpers the audit fixes hang off: ui.esc, json-view's
   escaping, classify/isTrusted, the sync.js amount + brand rules, the
   api.js reference/idempotency generators and ledger.refundedTotals —
   plus the merchant site's bag (site/cart.js) and how its total reaches
   the flows (verticals.js activeProduct), the remembered-customer
   persistence (customers.js — never a PAN/CVV, never live), the Orders
   page's grouping (ledger.ordersFor) and the Wallet (site/wallet.js — the
   balance arithmetic, the withdraw limits, the deposit product and the
   Create Payout body builder).
   ───────────────────────────────────────────────────────────── */

import { esc } from '../js/ui.js';
import { brandLabel, currencyDecimals, validAmount, detectBrand } from '../js/sync.js';
import { classify, isTrusted, isTrustedFor } from '../js/classify.js';
import { renderJSONView, highlightPaths } from '../js/json-view.js';
import { refundedTotals, settlementOf, ordersFor } from '../js/ledger.js';
// api.js has no top-level I/O (BACKEND_URL only reads a <meta>); only the
// two pure generators are exercised — nothing here calls request().
import { newReference, newIdempotencyKey, pickBackend } from '../js/api.js';
// The bag rules (pure, catalog passed in) and the one path the flows read it
// through — verticals.js activeProduct(). Neither touches the DOM or network.
import {
  cartLines, addToCart, setLineQty, removeLine, clearCart, cartCount,
  resolveLines, lineTotal, cartTotal, cartProblem, cartAsProduct, MAX_QTY, billingPeriod,
} from '../js/site/cart.js';
import { VERTICALS, VERTICAL_ORDER, activeProduct, pricedProduct, orderItems } from '../js/verticals.js';
import { state } from '../js/state.js';
// The customer store: its serialize/restore pair is pure; the live store is
// pointed at an in-memory stand-in below, so no test writes real localStorage.
import * as customers from '../js/customers.js';
import { SKINS, SKIN_ORDER } from '../js/skins.js';
import { PACKS } from '../js/packs.js';
// The integration seam: pure data + address helpers (DOM writers untouched).
import {
  SEAM_PATHS, SEAM_LABELS, seamPathKey, hostedAddress, isRapydHost, pagePath, HOSTED_DOMAIN,
  seamWrapHTML, seamStripHTML, seamTdsLine, seamLinesHTML, seamExtWrapHTML, EXT_TDS_LABEL,
} from '../js/seam.js';
// External 3DS (simulated): the pure decision + payment_method_options builder.
import {
  usesExternal3DS, simulateExternal3DS, externalTdsOptions, ext3dsDecision, EXT3DS_CHOICES,
  EXT3DS_PMO_PATHS, EXT3DS_PLACEHOLDER, DUMMY_CAVV, ext3dsPreset, setExt3dsPreset, authRequestSummary,
} from '../js/ext3ds.js';
// Direct Apple Pay / Google Pay (mock token, real sandbox call): the pure
// payload builders and the path rules (js/direct-wallet.js — no DOM, no network).
import {
  WALLET_INTEGRATIONS, walletIntegration, setWalletIntegration, walletAvailability, effectiveWalletIntegration,
  encryptedToken, decryptedDetails, directPaymentBody, walletSteps, walletDataPaths,
  currencyNumeric, minorUnits, leafPathsUnder, SIM_MARK, SIM_CRYPTOGRAM, DIRECT_METHOD_TYPE,
  GOOGLE_AUTH_METHODS, googleAuthMethod, setGoogleAuthMethod, GATEWAY_ID_PLACEHOLDER, needsRapyd3DS,
} from '../js/direct-wallet.js';
import { WALLET_SEAMS, seamWalletLine } from '../js/seam.js';
// AFT block shared by every customer-present path (js/flows/shared.js).
import { aftOptions } from '../js/flows/shared.js';
// Add a card (site/add-card.js): the route picker and the three request bodies.
import { addCardMethod, htpBody, zeroAuthBody, externalAddBody, cardToolkitConfig, stitchEvents, expectedAddCardEvents, ADD_CARD_EVENTS } from '../js/site/add-card.js';
import { sharedToolkitMode } from '../js/flows/toolkit-common.js';
import { toolkitMode, setToolkitMode } from '../js/flows/toolkit.js';

// The Wallet's rules — pure (balance, limits, payout body); nothing here
// records into the ledger (its poller would fetch).
import {
  DEPOSIT_ID, SANDBOX_PAYOUT_CARD, walletConfig, depositProduct, setPendingDeposit, clearPendingDeposit,
  walletEntries, walletBalance, depositProblem, withdrawProblem, withdrawChips, pickPayoutMethodType,
  fallbackPayoutMethodType, fillParties, payoutBody, requiredFieldsQuery, payoutOutcome, isDepositEntry,
  eligibilityBody, payoutRoute, ELIGIBILITY_TRANSACTION_TYPE,
} from '../js/site/wallet.js';

// Tag registry (js/tags/) — the Tag Studio's data model and resolver.
import { resolveTag, resolveBadge, httpCtx, paymentCtx, resolveBeatBadge, pillHTML, beatClass, whClass, httpPillHTML } from '../js/tags/resolve.js';
import { SLOTS as TAG_SLOTS, CALLS, JOURNEYS, STEPS } from '../js/tags/registry.js';
import { beatCardHTML } from '../js/customer-beat.js';
import { setPublished, setDraft, sanitizeConfig, withConfig } from '../js/tags/store.js';
import { paymentBadge, httpLabel, paymentResponseCardHTML } from '../js/flows/shared.js';

/* ── Tiny harness ── */
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ? `${label}: ` : ''}expected ${e}, got ${a}`);
}
function ok(cond, label) {
  if (!cond) throw new Error(label);
}

/* ── ui.js ── */
test('esc: escapes & < > " \' (each one)', () => {
  eq(esc('&'), '&amp;');
  eq(esc('<'), '&lt;');
  eq(esc('>'), '&gt;');
  eq(esc('"'), '&quot;');
  eq(esc("'"), '&#39;');
  eq(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  eq(esc('&amp;'), '&amp;amp;', 'already-escaped text is escaped again, not trusted');
});
test('esc: null/undefined → "", other primitives stringified', () => {
  eq(esc(null), '');
  eq(esc(undefined), '');
  eq(esc(0), '0');
  eq(esc(false), 'false');
  eq(esc('plain text'), 'plain text');
});

/* ── json-view.js ──
   Webhook payloads are attacker-controlled (/api/webhook is public), so keys,
   values AND the data-path built from keys must all come out inert. */
const EVIL = {
  '<img src=x onerror=alert(1)>': '<img src=x onerror=alert(2)>',
  '" onmouseover="alert(3)': "' onmouseover='alert(4)",
  nested: {
    '</span><script>alert(5)</script>': ['<svg onload=alert(6)>', 1, true, null, ''],
  },
  '&lt;': '&amp;',
};
const ALLOWED_TAGS = new Set(['DIV', 'SPAN', 'DETAILS', 'SUMMARY']);
const ALLOWED_ATTRS = new Set(['class', 'data-path']);
const parseView = (html) => new DOMParser().parseFromString(html, 'text/html');

test('renderJSONView: raw output has no live markup from malicious keys/values', () => {
  const html = renderJSONView(EVIL);
  for (const bad of ['<img', '<script', '<svg', '</span><script', '" onmouseover', "' onmouseover"]) {
    ok(!html.toLowerCase().includes(bad), `output contains unescaped ${JSON.stringify(bad)}`);
  }
});
test('renderJSONView: parsed DOM is only div/span (+details/summary), no on* attributes', () => {
  const doc = parseView(renderJSONView(EVIL));
  const els = [...doc.body.querySelectorAll('*')];
  ok(els.length > 0, 'nothing rendered');
  for (const el of els) {
    ok(ALLOWED_TAGS.has(el.tagName), `unexpected <${el.tagName.toLowerCase()}> element`);
    for (const { name } of el.attributes) {
      ok(!/^on/i.test(name), `event-handler attribute ${name} on <${el.tagName.toLowerCase()}>`);
      ok(ALLOWED_ATTRS.has(name), `unexpected attribute ${name} on <${el.tagName.toLowerCase()}>`);
    }
  }
});
test('renderJSONView: malicious keys/values round-trip as TEXT', () => {
  const text = parseView(renderJSONView(EVIL)).body.textContent;
  for (const s of ['"<img src=x onerror=alert(1)>"', '"<img src=x onerror=alert(2)>"',
    '"" onmouseover="alert(3)"', `"' onmouseover='alert(4)"`,
    '"</span><script>alert(5)</script>"', '"<svg onload=alert(6)>"', '"&lt;"', '"&amp;"']) {
    ok(text.includes(s), `text content is missing ${s}`);
  }
});
test('renderJSONView: data-path survives quote-bearing keys intact', () => {
  const doc = parseView(renderJSONView(EVIL));
  const paths = [...doc.querySelectorAll('.jv')].map((el) => el.getAttribute('data-path'));
  for (const p of ['<img src=x onerror=alert(1)>', '" onmouseover="alert(3)',
    'nested.</span><script>alert(5)</script>.0', 'nested.</span><script>alert(5)</script>.4', '&lt;']) {
    ok(paths.includes(p), `no .jv node with data-path ${JSON.stringify(p)} (got ${JSON.stringify(paths)})`);
  }
});
test('renderJSONView + highlightPaths: a quote-bearing path still highlights its row', () => {
  // An inert document: if escaping ever regresses, an <img onerror> here can't
  // fire (a detached div in THIS document would still load images).
  const host = document.implementation.createHTMLDocument('').createElement('div');
  host.innerHTML = renderJSONView(EVIL);
  highlightPaths(host, ['" onmouseover="alert(3)']);
  const lines = host.querySelectorAll('.jsonv-line.sync-hit');
  const nums = host.querySelectorAll('.jsonv-gutter .sync-hit');
  eq(lines.length, 1, 'highlighted lines');
  eq(nums.length, 1, 'highlighted gutter numbers');
  ok(lines[0].textContent.includes('onmouseover="alert(3)'), 'highlighted the wrong line');
});
test('renderJSONView: primitives, empty containers, line numbers', () => {
  const doc = parseView(renderJSONView({ a: 1, b: [], c: {}, d: false, e: null, f: '' }));
  const lines = doc.querySelectorAll('.jsonv-line');
  eq(lines.length, 8, 'line count');
  eq(doc.querySelectorAll('.jsonv-gutter > span').length, 8, 'gutter count');
  eq(doc.querySelector('.jv[data-path="a"] .tok-num')?.textContent, '1');
  eq(doc.querySelector('.jv[data-path="e"] .tok-bool')?.textContent, 'null');
  eq(doc.querySelector('.jv[data-path="f"] .jv-empty')?.textContent, '""');
});

/* ── classify.js ── */
test('classify: truth table', () => {
  const table = [
    ['PAYMENT_COMPLETED', 'success'],
    ['REFUND_COMPLETED', 'success'],
    ['PAYMENT_CAPTURED', 'success'],
    ['payment_completed', 'success'],     // case-insensitive
    ['PAYMENT_SUCCEEDED', 'pending'],     // intermediate — never confirms
    ['PAYMENT_CREATED', 'pending'],
    ['PAYMENT_FAILED', 'failure'],
    ['PAYMENT_DECLINED', 'failure'],
    ['PAYMENT_EXPIRED', 'failure'],
    ['PAYMENT_CANCELED', 'failure'],
    ['REFUND_FAILED', 'failure'],
    ['', 'pending'],
  ];
  for (const [type, want] of table) eq(classify({ type }), want, type || '(empty)');
  eq(classify({}), 'pending', 'no type');
  eq(classify(null), 'pending', 'null');
  eq(classify(undefined), 'pending', 'undefined');
});

const verified = (extra = {}) => ({ type: 'PAYMENT_COMPLETED', verified: 'verified', verified_env: 'sandbox', payment_id: 'payment_1', ...extra });
test('isTrusted: truth table (verified signature or our own retrieve only)', () => {
  const table = [
    [verified(), true],
    [{ verified: 'verified' }, true],
    [{ source: 'retrieve' }, true],
    [{ verified: 'unverified' }, false],
    [{ verified: 'skipped' }, false],
    [{ verified: true }, false],          // must be the exact string
    [{ verified: 'VERIFIED' }, false],
    [{ source: 'webhook' }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ];
  table.forEach(([e, want], i) => eq(isTrusted(e), want, `row ${i} ${JSON.stringify(e)}`));
});
test('isTrustedFor: env and payment id must match', () => {
  const ctx = { env: 'sandbox', paymentId: 'payment_1' };
  eq(isTrustedFor(verified(), ctx), true);
  eq(isTrustedFor(verified({ payment_id: 'payment_attacker' }), ctx), false, 'other payment');
  eq(isTrustedFor(verified({ verified_env: 'live' }), ctx), false, 'other env');
  eq(isTrustedFor(verified({ verified_env: undefined }), ctx), false, 'receiver without verified_env');
  eq(isTrustedFor(verified(), { env: 'live', paymentId: 'payment_1' }), false, 'sandbox-signed in a live watch');
  eq(isTrustedFor(verified(), { env: 'sandbox' }), true, 'id unknown yet');
  eq(isTrustedFor({ verified: 'unverified', payment_id: 'payment_1' }, ctx), false);
  eq(isTrustedFor({ source: 'retrieve', payment_id: 'payment_other' }, ctx), true, 'retrieve is ours');
  eq(isTrustedFor(undefined, ctx), false);
});

/* ── sync.js: amounts ── */
test('validAmount: USD', () => {
  eq(validAmount(149, 'USD'), true, '149');
  eq(validAmount('149', 'USD'), true, "'149'");
  eq(validAmount('149.00', 'USD'), true, "'149.00'");
  eq(validAmount('149.99', 'USD'), true, "'149.99'");
  eq(validAmount(0.07, 'USD'), true, '0.07 (float noise)');
  eq(validAmount(' 149 ', 'USD'), true, 'surrounding whitespace');
  eq(validAmount('149.999', 'USD'), false, "'149.999'");
  eq(validAmount(149.999, 'USD'), false, '149.999');
  eq(validAmount('', 'USD'), false, "''");
  eq(validAmount(0, 'USD'), false, '0');
  eq(validAmount('0', 'USD'), false, "'0'");
  eq(validAmount(-1, 'USD'), false, '-1');
  eq(validAmount('-1', 'USD'), false, "'-1'");
  eq(validAmount('1e3', 'USD'), false, "'1e3'");
  eq(validAmount('0x10', 'USD'), false, "'0x10'");
  eq(validAmount(NaN, 'USD'), false, 'NaN');
  eq(validAmount(Infinity, 'USD'), false, 'Infinity');
  eq(validAmount(null, 'USD'), false, 'null');
  eq(validAmount(undefined, 'USD'), false, 'undefined');
});
test('validAmount: zero- and three-decimal currencies', () => {
  eq(validAmount(100, 'JPY'), true, 'JPY 100');
  eq(validAmount('100', 'JPY'), true, "JPY '100'");
  eq(validAmount(100.5, 'JPY'), false, 'JPY 100.5');
  eq(validAmount('100.5', 'JPY'), false, "JPY '100.5'");
  eq(validAmount('1.005', 'KWD'), true, 'KWD 1.005');
  eq(validAmount('1.0005', 'KWD'), false, 'KWD 1.0005');
});
test('currencyDecimals follows ISO 4217 minor units', () => {
  eq(currencyDecimals('USD'), 2);
  eq(currencyDecimals('EUR'), 2);
  eq(currencyDecimals('JPY'), 0);
  eq(currencyDecimals('jpy'), 0, 'lowercase');
  eq(currencyDecimals('KRW'), 0);
  eq(currencyDecimals('IDR'), 2);
  eq(currencyDecimals('KWD'), 3);
  eq(currencyDecimals('BHD'), 3);
  eq(currencyDecimals('CLF'), 4);
  eq(currencyDecimals(undefined), 2, 'undefined');
  eq(currencyDecimals(''), 2, 'empty');
  eq(currencyDecimals('XYZ'), 2, 'unknown');
});

/* ── sync.js: brands ── */
test('brandLabel: PANs / IIN prefixes', () => {
  eq(brandLabel('4111111111111111'), 'Visa');
  eq(brandLabel('4111 1111 1111 1111'), 'Visa');
  eq(brandLabel('5555555555554444'), 'Mastercard');
  eq(brandLabel('5555-4444'), 'Mastercard');
  eq(brandLabel('2221000000000009'), 'Mastercard', '2-series');
  eq(brandLabel('378282246310005'), 'Amex');
  eq(brandLabel('3782'), 'Amex', 'IIN prefix');
  eq(brandLabel('6011111111111117'), 'Discover');
  eq(brandLabel('9999'), 'Card', 'unknown PAN');
});
test('brandLabel: Rapyd types, brand strings, unknown + fallback', () => {
  eq(brandLabel('us_visa_card'), 'Visa');
  eq(brandLabel('gb_mastercard_card'), 'Mastercard');
  eq(brandLabel('us_american_express_card'), 'Amex');
  eq(brandLabel('VISA'), 'Visa');
  eq(brandLabel('MASTERCARD'), 'Mastercard');
  eq(brandLabel('us_apple_pay_visa_card'), 'Apple Pay', 'wallet hint wins');
  eq(brandLabel('xx_mystery_card'), 'Card', 'unknown type');
  eq(brandLabel('xx_mystery_card', null), null, 'unknown with null fallback');
  eq(brandLabel('xx_mystery_card', 'Unknown'), 'Unknown');
  eq(brandLabel(''), 'Card');
  eq(brandLabel(null), 'Card');
  eq(brandLabel(undefined, null), null);
});
test('detectBrand maps a PAN to a Rapyd type', () => {
  eq(detectBrand('4111'), { brand: 'VISA', type: 'gb_visa_card' });
  eq(detectBrand('5555'), { brand: 'MASTERCARD', type: 'gb_mastercard_card' });
  eq(detectBrand(''), { brand: '', type: 'gb_visa_card' });
});

/* ── api.js (pure generators only) ── */
test('newReference: prefix, ms timestamp, 64 random bits; unique; fits the refund suffix', () => {
  const a = newReference('pb_ecommerce_tk');
  const b = newReference('pb_ecommerce_tk');
  ok(/^pb_ecommerce_tk_\d{13}_[0-9a-f]{16}$/.test(a), `bad shape: ${a}`);
  ok(a !== b, 'two references collided');
  ok(`${a}_refund_${Date.now()}`.length <= 128, 'refund ref exceeds the backend 128-char cap');
});
test('newIdempotencyKey matches the backend pattern; unique', () => {
  const k = newIdempotencyKey();
  ok(/^[A-Za-z0-9_.:-]{8,100}$/.test(k), `bad key: ${k}`);
  ok(k !== newIdempotencyKey(), 'two keys collided');
});

/* ── ledger.js: refundedTotals ──
   Entries are built in the exact shape recordPayment()/recordRefund() store,
   with `settled` produced by the real settlementOf() from a Rapyd payment
   object — so a shape change in ledger.js breaks these tests, not just prod. */
const payment = ({ amount = 100, currency = 'USD', server, refunds = [] } = {}) => ({
  reference: 'pb_test_ref', kind: 'payment', model: 'own-fields', vertical: 'ecommerce',
  payment_id: 'payment_1', amount, currency, last4: '1111', brand: 'gb_visa_card',
  requested_currency: null, fixed_side: null, origin: 'client', initiation_type: 'customer_present',
  credential: null, aft: false, profile: 'SC1', env: 'sandbox', status: 'completed', phase: 'completed',
  // server === undefined → no GET yet (settled stays null, as after recordPayment)
  settled: server === undefined ? null
    : settlementOf({ id: 'payment_1', amount, original_amount: amount, currency_code: currency, refunded_amount: server }),
  refunds,
  created_at: Date.now(),
});
const refund = (amount, status = 'completed', extra = {}) => ({
  reference: `pb_test_ref_refund_${Math.random()}`, refund_id: null, amount, currency: 'USD',
  customer_equiv: amount, merchant_debit_amount: amount, merchant_debit_currency: 'USD',
  route: null, reason: '', status, created_at: Date.now(), ...extra,
});

test('refundedTotals: server stale → local completed sum wins', () => {
  const t = refundedTotals(payment({ server: 0, refunds: [refund(30)] }));
  eq(t, { refunded: 30, total: 100, currency: 'USD', remaining: 70, count: 1 });
});
test('refundedTotals: server ahead → server refunded_amount wins', () => {
  const t = refundedTotals(payment({ server: 50, refunds: [refund(30)] }));
  eq(t.refunded, 50);
  eq(t.remaining, 50);
  eq(t.count, 1, 'count is LOCAL completed refunds');
});
test('refundedTotals: pending / failed refunds are excluded', () => {
  const t = refundedTotals(payment({ server: 30, refunds: [refund(30), refund(20, 'pending'), refund(25, 'failed')] }));
  eq(t.refunded, 30);
  eq(t.remaining, 70);
  eq(t.count, 1);
});
test('refundedTotals: no GET yet (settled null) falls back to entry amount/currency', () => {
  const t = refundedTotals(payment({ amount: '100', refunds: [refund(40)] }));
  eq(t, { refunded: 40, total: 100, currency: 'USD', remaining: 60, count: 1 });
});
test('refundedTotals: FX refund counts customer_equiv, not the body amount', () => {
  const fx = refund(10, 'completed', { currency: 'EUR', customer_equiv: 11, route: 'merchant' });
  eq(refundedTotals(payment({ server: 0, refunds: [fx] })).refunded, 11);
});
test('refundedTotals: rounding and clamp (thirds sum to zero; over-refund never negative)', () => {
  eq(refundedTotals(payment({ server: 0, refunds: [refund(33.33), refund(33.33), refund(33.34)] })).remaining, 0);
  eq(refundedTotals(payment({ server: 120, refunds: [] })).remaining, 0);
});

/* ── Must stay last: the tripwire in index.html saw nothing ── */
/* ── site/cart.js — the bag ──
   The bag total is what the flows charge (via activeProduct), so the money
   maths, the single-currency rule and subscription isolation are pinned here. */
const P = {
  chair: { id: 'chair', name: 'Chair', billing: 'one_time', amount: '149.00', currency: 'GBP' },
  riser: { id: 'riser', name: 'Riser', billing: 'one_time', amount: '119.00', currency: 'GBP' },
  spray: { id: 'spray', name: 'Spray', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', amount: '12.99', currency: 'GBP' },
  oil:   { id: 'oil', name: 'Oil', billing: 'subscription', amount: '3.99', currency: 'GBP' },
  usd:   { id: 'usd', name: 'Mug', billing: 'one_time', amount: '10.00', currency: 'USD' },
  yen:   { id: 'yen', name: 'Tea', billing: 'one_time', amount: '500', currency: 'JPY' },
  btc:   { id: 'btc', name: 'Bitcoin', billing: 'one_time', amount: '50.00', currency: 'USD', aft: true, purpose_code: 'crypto_currency' },
};
const CAT = Object.values(P);
const L = (...pairs) => resolveLines(pairs.map(([productId, qty]) => ({ productId, qty })), CAT);

/* Run `fn` with state fields swapped in, restoring them after (the tests share
   the app's one state object). */
function withState(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = state[k];
  Object.assign(state, patch);
  try { fn(); } finally { Object.assign(state, saved); }
}

test('cart: total is summed in minor units (no float drift)', () => {
  eq(cartTotal(L(['spray', 3])), { amount: '38.97', currency: 'GBP' });
  eq(cartTotal(L(['chair', 2], ['riser', 1])), { amount: '417.00', currency: 'GBP' });
  eq(lineTotal(P.spray, 3), '38.97');
  eq(lineTotal(P.yen, 3), '1500', 'zero-decimal currency keeps no decimals');
  eq(cartTotal([]), { amount: null, currency: null });
});

test('cart: one currency per bag', () => {
  eq(cartTotal(L(['chair', 1], ['usd', 1])), { amount: null, currency: null }, 'no honest single total');
  eq(cartProblem(L(['chair', 1], ['usd', 1]))?.code, 'currency');
  eq(cartProblem(L(['chair', 1], ['riser', 3])), null, 'same-currency one-offs are fine');
});

test('cart: a subscription checks out alone, qty 1', () => {
  eq(cartProblem([])?.code, 'empty');
  eq(cartProblem(L(['spray', 1])), null, 'a lone subscription is fine');
  eq(cartProblem(L(['spray', 1], ['chair', 1]))?.code, 'subscription', 'mixed with a one-off');
  eq(cartProblem(L(['spray', 1], ['oil', 1]))?.code, 'subscription', 'two subscriptions');
  eq(cartProblem(L(['spray', 2]))?.code, 'subscription', 'qty > 1');
  ok(/on its own/.test(cartProblem(L(['spray', 1], ['chair', 1])).message), 'shopper copy names the rule');
});

test('cart: composite product — id, amount, billing, lines', () => {
  const one = cartAsProduct(L(['spray', 1]));
  eq(one.id, 'spray', 'single qty-1 line keeps the product id (override / origin_product / MIT lookup)');
  eq([one.amount, one.currency, one.billing, one.cta], ['12.99', 'GBP', 'subscription', 'Subscribe']);
  const multi = cartAsProduct(L(['chair', 2], ['riser', 1]));
  eq(multi.id, 'cart:chair*2+riser*1');
  eq([multi.amount, multi.name, multi.billing], ['417.00', '3 items', 'one_time']);
  eq(multi.lines.map((l) => [l.id, l.qty, l.amount]), [['chair', 2, '298.00'], ['riser', 1, '119.00']]);
  eq(cartAsProduct(L(['chair', 2])).name, 'Chair × 2');
  ok(cartAsProduct(L(['btc', 2])).aft === true, 'an all-AFT bag stays AFT');
  ok(cartAsProduct(L(['btc', 1], ['usd', 1])).aft === false, 'a mixed bag never claims AFT');
});

test('cart: add / qty / remove / vertical guard', () => {
  withState({ cart: null, vertical: 'ecommerce' }, () => {
    addToCart('oak'); addToCart('oak');
    addToCart('spray', { isSubscription: true }); addToCart('spray', { isSubscription: true });
    eq(cartLines(), [{ productId: 'oak', qty: 2 }, { productId: 'spray', qty: 1 }], 'a subscription never doubles');
    eq(cartCount(), 3);
    setLineQty('oak', 99);
    eq(cartLines()[0].qty, MAX_QTY, 'clamped');
    setLineQty('oak', 0);
    eq(cartLines().map((l) => l.productId), ['spray'], 'qty 0 removes');
    removeLine('spray');
    eq(cartLines(), []);
    addToCart('oak');
    eq(cartLines('crypto'), [], 'a bag captured for another vertical reads as empty');
    clearCart();
    eq(cartCount(), 0);
  });
});

test('activeProduct: a valid bag is what the flows charge', () => {
  const base = { cart: null, vertical: 'ecommerce', env: 'sandbox', productOverride: null, selectedProduct: null };
  withState({ ...base, cart: { vertical: 'ecommerce', lines: [{ productId: 'oak', qty: 2 }, { productId: 'riser', qty: 1 }] } }, () => {
    const p = activeProduct();
    eq([p.amount, p.currency, p.billing], ['417.00', 'GBP', 'one_time']);
    eq(orderItems(p).map((i) => i.id), ['oak', 'riser'], 'ledger items = the bag lines');
    // Live clamps the bag total like any price; the override path is untouched.
    withState({ env: 'live' }, () => eq(activeProduct().amount, '0.01'));
    eq(pricedProduct().amount, '417.00', 'pre-clamp price stays the bag total');
    // The SE's price override binds to THIS bag's id …
    withState({ productOverride: { vertical: 'ecommerce', productId: p.id, amount: '400.00', currency: 'GBP' } }, () => {
      eq(activeProduct().amount, '400.00');
      // … and falls away once the bag changes.
      withState({ cart: { vertical: 'ecommerce', lines: [{ productId: 'oak', qty: 1 }] } }, () => eq(activeProduct().amount, '149.00'));
    });
  });
});

test('activeProduct: an invalid or empty bag charges nothing from it', () => {
  const first = VERTICALS.ecommerce.products[0];
  withState({ cart: { vertical: 'ecommerce', lines: [{ productId: 'oak', qty: 1 }, { productId: 'spray', qty: 1 }] }, vertical: 'ecommerce', env: 'sandbox', productOverride: null, selectedProduct: null }, () => {
    eq(activeProduct().id, first.id, 'mixed sub + one-off composes nothing (the bag blocks checkout)');
  });
  withState({ cart: null, vertical: 'ecommerce', env: 'sandbox', productOverride: null, selectedProduct: { vertical: 'ecommerce', productId: 'incense' } }, () => {
    eq(activeProduct().id, 'incense', 'no bag → the selected product, as before');
  });
});

/* ── skins — the five built-in Rapyd merchants ── */
test('skins: exactly the five Rapyd merchants, ids stable, drawer order', () => {
  const ids = ['ecommerce', 'crypto', 'gaming', 'forex', 'content'];
  eq(Object.keys(SKINS), ids);
  eq(SKIN_ORDER, ids);
  eq(VERTICAL_ORDER, ids);
  eq(ids.map((id) => [VERTICALS[id].merchant, VERTICALS[id].domain, VERTICALS[id].descriptor, VERTICALS[id].pack]), [
    ['rapyd.shop', 'rapyd.shop', 'RAPYD SHOP', 'home'],
    ['rapyd.coin', 'rapyd.coin', 'RAPYD COIN', 'crypto'],
    ['rapyd.spin', 'rapyd.spin', 'RAPYD SPIN', 'igaming'],
    ['rapyd.fx', 'rapyd.fx', 'RAPYD FX', 'forex'],
    ['rapyd.stream', 'rapyd.stream', 'RAPYD STREAM', 'content'],
  ]);
  eq(VERTICALS.gaming.label, 'Gambling');
  eq([VERTICALS.forex.label, VERTICALS.content.label], ['Forex trading', 'Digital content']);
  for (const id of ids) {
    eq(VERTICALS[id].id, id, `${id}: composed under its skin id`);
    ok(PACKS[SKINS[id].pack], `${id}: its pack exists`);
    ok(VERTICALS[id].descriptor.length <= 22, `${id}: statement descriptor stays short`);
    // The built-ins share the Rapyd look — they differ in identity, not colour.
    eq(SKINS[id].tokens, SKINS.ecommerce.tokens, `${id}: Rapyd palette`);
  }
});

test('packs: catalog invariants hold for every pack', () => {
  for (const [key, pack] of Object.entries(PACKS)) {
    eq(pack.id, key, `${key}: id matches its key`);
    ok(pack.products.length > 0, `${key}: has products`);
    const ids = pack.products.map((p) => p.id);
    eq(new Set(ids).size, ids.length, `${key}: unique product ids`);
    ok(!ids.includes(DEPOSIT_ID), `${key}: no product shadows the wallet deposit id`);
    for (const p of pack.products) {
      ok(validAmount(p.amount, p.currency), `${key}/${p.id}: ${p.amount} ${p.currency} is a valid amount`);
      ok(['one_time', 'subscription'].includes(p.billing), `${key}/${p.id}: billing`);
      if (p.billing === 'subscription') ok(['monthly', 'annual'].includes(p.interval), `${key}/${p.id}: subscription has an interval`);
      else ok(!p.interval, `${key}/${p.id}: a one-off has no interval`);
      if (p.aft) ok(typeof p.purpose_code === 'string' && p.purpose_code, `${key}/${p.id}: AFT names a purpose_code`);
    }
    // One currency per pack — a bag can't mix them (cart.js cartProblem).
    eq(new Set(pack.products.map((p) => p.currency)).size, 1, `${key}: one catalog currency`);
    if (pack.wallet) {
      eq(pack.wallet.currency, pack.products[0].currency, `${key}: wallet holds the catalog currency`);
      for (const c of pack.wallet.chips) ok(validAmount(c, pack.wallet.currency), `${key}: chip ${c}`);
    }
  }
});

test('packs: forex runs KYC + an AFT wallet; content is digital, no wallet', () => {
  const fx = PACKS.forex, ct = PACKS.content;
  eq([fx.kycAtSignup, ct.kycAtSignup], [true, false]);
  const w = walletConfig('forex');
  eq([w.currency, w.country, w.depositLabel, w.withdrawLabel], ['GBP', 'GB', 'Deposit', 'Withdraw']);
  // docs.rapyd.net/en/creating-an-aft-payment.html — the only AFT field set
  // the guide documents; no special_condition_indicator is invented for forex.
  eq(w.aft, { purpose_code: 'high_risk_securities' });
  const dep = depositProduct(w, { amount: '100.00' });
  eq([dep.aft, dep.purpose_code, dep.is_direct_purchase, dep.currency], [true, 'high_risk_securities', false, 'GBP']);
  ok(fx.products.some((p) => p.billing === 'one_time') && fx.products.some((p) => p.billing === 'subscription'), 'forex: a one-off + subscriptions');
  eq(walletConfig('content'), null, 'content runs no wallet');
  ok(ct.products.every((p) => p.delivery === null && !p.aft), 'content: nothing ships, no AFT');
  eq(ct.products.filter((p) => p.billing === 'subscription').map((p) => p.interval), ['monthly', 'annual']);
  ok(ct.products.filter((p) => p.billing === 'one_time').length >= 2, 'content: rent / buy one-offs');
  // A different currency from the other packs, and one the FX list offers.
  eq([fx.products[0].currency, ct.products[0].currency], ['GBP', 'SGD']);
});

test('billingPeriod: monthly by default, annual reads per year; one-offs none', () => {
  eq(billingPeriod({ billing: 'one_time' }), null);
  eq(billingPeriod(null), null);
  eq([billingPeriod({ billing: 'subscription' }).short, billingPeriod({ billing: 'subscription', interval: 'monthly' }).noun], ['mo', 'month']);
  const yr = billingPeriod({ billing: 'subscription', interval: 'annual' });
  eq([yr.short, yr.noun, yr.badge, yr.adj], ['yr', 'year', 'Annual', 'annual']);
  // The interval reaches the ledger's order line, so the Orders page can say "/ year".
  const annual = PACKS.content.products.find((p) => p.interval === 'annual');
  eq(orderItems(annual)[0].interval, 'annual');
  eq(cartAsProduct([{ product: annual, qty: 1 }]).lines[0].interval, 'annual');
  ok(!('interval' in orderItems(PACKS.home.products[0])[0]), 'a one-off line carries no interval');
});

/* ── customers.js — remembered customers ──
   A returning-customer demo survives a reload, but the store must never hold
   a card number or CVV, and never a live customer. */
function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => m.get('rapyd-demo:customers:v1') || '',
  };
}
const PAN = '4111111111111111';

test('customers: serializeBucket keeps token metadata only — no PAN, no CVV, no vault card', () => {
  const ser = customers.serializeBucket({
    customer_id: 'cus_abc123',
    credentials: [
      { ref: 'cred_1', kind: 'vault', number: PAN, cvv: '123', last4: '1111', recurrence_type: 'unscheduled' },
      { ref: 'cred_2', kind: 'token', card_id: 'card_tok1', number: PAN, cvv: '123', name: 'Jordan Taylor', brand: 'Visa', last4: '1111',
        expiration_month: '12', expiration_year: '29', network_reference_id: 'nrid9', recurrence_type: 'recurring', aft: true },
    ],
  }, { name: 'Jordan Taylor', email: 'j@example.com' });
  eq(ser.customer_id, 'cus_abc123');
  eq(ser.identity, { name: 'Jordan Taylor', email: 'j@example.com' });
  eq(ser.credentials.length, 1, 'the vault credential is not remembered at all');
  const json = JSON.stringify(ser);
  ok(!json.includes(PAN), 'no card number');
  ok(!/cvv/i.test(json), 'no CVV field');
  ok(!json.includes('"ref"') && !json.includes('"name":"Jordan Taylor"}'), 'no local ref / name-on-card');
  eq([ser.credentials[0].card_id, ser.credentials[0].last4, ser.credentials[0].network_reference_id, ser.credentials[0].recurrence_type],
    ['card_tok1', '1111', 'nrid9', 'recurring']);
  eq(customers.serializeBucket({ customer_id: null, credentials: [] }), null, 'nothing to remember without a customer');
});

test('customers: restoreBucket validates what storage hands back', () => {
  eq(customers.restoreBucket(null), null);
  eq(customers.restoreBucket({ customer_id: 'not-a-cus' }), null, 'bad customer id');
  eq(customers.restoreBucket({ customer_id: 'cus_<script>' }), null, 'markup in the id');
  const r = customers.restoreBucket({
    customer_id: 'cus_ok1',
    identity: { name: 'Sam Lee', email: 's@example.com' },
    credentials: [
      { card_id: 'card_good', last4: '4242', number: PAN, cvv: '999', recurrence_type: 'bogus' },
      { card_id: 'nope', last4: '0000' },
      'junk',
    ],
  });
  eq(r.customer_id, 'cus_ok1');
  eq(r.identity, { name: 'Sam Lee', email: 's@example.com' });
  eq(r.credentials.length, 1, 'only well-formed card_*** survive');
  ok(!JSON.stringify(r).includes(PAN) && !/cvv/i.test(JSON.stringify(r)), 'a PAN planted in storage is dropped on the way in');
  eq([r.credentials[0].kind, r.credentials[0].recurrence_type, r.credentials[0].aft], ['token', 'unscheduled', false]);
});

test('customers: sandbox buckets persist (no PAN/CVV); live is never written', () => {
  const store = memStorage();
  customers.setCustomerStorage(null); // clear the buckets under test without writing anywhere
  customers.forgetCustomer({ key: 'sandbox:SC2' });
  customers.forgetCustomer({ key: 'live:SC2' });
  customers.setCustomerStorage(store);
  try {
    withState({ env: 'sandbox', profile: 'SC2' }, () => {
      customers.setCustomerId('cus_persist1');
      customers.addVaultCredential({ type: 'visa', number: PAN, cvv: '123', expiration_month: '12', expiration_year: '29', last4: '1111', recurrence_type: 'unscheduled' });
      customers.upsertTokenCredential({ card_id: 'card_persist1', number: PAN, last4: '1111', brand: 'Visa', recurrence_type: 'unscheduled' });
      ok(customers.isRemembered(), 'a sandbox customer is remembered');
    });
    const saved = JSON.parse(store.dump());
    ok(Object.keys(saved).every((k) => k.startsWith('sandbox:')), 'only sandbox keys');
    eq(saved['sandbox:SC2'].customer_id, 'cus_persist1');
    eq(saved['sandbox:SC2'].credentials.map((c) => c.card_id), ['card_persist1']);
    ok(!store.dump().includes(PAN) && !/cvv/i.test(store.dump()), 'storage never sees a PAN or CVV');

    withState({ env: 'live', profile: 'SC2' }, () => {
      customers.setCustomerId('cus_live1');
      ok(!customers.isRemembered(), 'a live customer is not remembered');
    });
    ok(!store.dump().includes('live:') && !store.dump().includes('cus_live1'), 'live never reaches storage');

    // Forgetting drops the remembered entry with the bucket.
    customers.forgetCustomer({ key: 'sandbox:SC2' });
    customers.forgetCustomer({ key: 'live:SC2' });
    ok(!store.dump().includes('cus_persist1'), 'forget removes it from storage');
  } finally {
    customers.setCustomerStorage(null);
    customers.forgetCustomer({ key: 'sandbox:SC2' });
    customers.forgetCustomer({ key: 'live:SC2' });
    customers.setCustomerStorage(null);
  }
});

test('customers: restoreRemembered brings a sandbox customer back (and flags a re-sync), never a live one', () => {
  const store = memStorage({
    'rapyd-demo:customers:v1': JSON.stringify({
      'sandbox:SC3': { customer_id: 'cus_back1', identity: { name: 'Alex Kim', email: 'a@example.com' },
        credentials: [{ card_id: 'card_back1', last4: '4242', brand: 'Visa', recurrence_type: 'unscheduled' }] },
      'live:SC3': { customer_id: 'cus_planted', credentials: [] },
    }),
  });
  // Start from an empty SC3 bucket (nothing written anywhere while clearing it).
  customers.setCustomerStorage(null);
  customers.forgetCustomer({ key: 'sandbox:SC3' });
  customers.setCustomerStorage(store);
  const savedIdentity = { ...customers.getIdentity() };
  try {
    withState({ env: 'sandbox', profile: 'SC3' }, () => {
      customers.restoreRemembered();
      eq(customers.getCustomerId(), 'cus_back1');
      eq(customers.credentials().map((c) => [c.kind, c.card_id, c.last4]), [['token', 'card_back1', '4242']]);
      eq(customers.getIdentity().name, 'Alex Kim', 'the shopper is greeted by name');
      ok(customers.needsResync(), 'cards are re-read from Rapyd on first use');
      customers.markResynced();
      ok(!customers.needsResync());
    });
    withState({ env: 'live', profile: 'SC3' }, () => eq(customers.getCustomerId(), null, 'a live entry in storage is ignored'));
  } finally {
    customers.setCustomerStorage(null);
    customers.forgetCustomer({ key: 'sandbox:SC3' });
    customers.setIdentity({ name: savedIdentity.name, email: savedIdentity.email });
  }
});

/* ── ledger.ordersFor — the Orders page's two groups ── */
test('ordersFor: signed-in customer\'s orders vs this tab\'s guest checkouts', () => {
  const E = (ref, customer_id, extra = {}) => ({ reference: ref, kind: 'payment', vertical: 'ecommerce', env: 'sandbox', customer_id, created_at: Number(ref.slice(1)), ...extra });
  const list = [
    E('p1', 'cus_me'), E('p2', null), E('p3', 'cus_other'), E('p4', 'cus_me'),
    E('p5', null, { vertical: 'crypto' }), E('p6', 'cus_me', { env: 'live' }), { reference: 'r1', kind: 'refund', vertical: 'ecommerce', env: 'sandbox' },
  ];
  const g = ordersFor(list, { customerId: 'cus_me', vertical: 'ecommerce', env: 'sandbox' });
  eq(g.mine.map((e) => e.reference), ['p4', 'p1'], 'mine: this customer, this merchant + env, newest first');
  eq(g.guest.map((e) => e.reference), ['p2'], 'guest: no customer at all');
  const anon = ordersFor(list, { customerId: null, vertical: 'ecommerce', env: 'sandbox' });
  eq(anon.mine, [], 'no signed-in customer → nothing is "yours"');
  eq(anon.guest.map((e) => e.reference), ['p2']);
});

/* ── seam — where the merchant ends and Rapyd begins ── */
test('seam: every path names its card form, PCI scope, redirects and both sides', () => {
  eq(Object.keys(SEAM_PATHS), ['own-fields', 'embedded', 'wallets', 'hosted']);
  for (const [key, p] of Object.entries(SEAM_PATHS)) {
    for (const f of ['label', 'tag', 'summary', 'form', 'pci', 'redirect']) ok(typeof p[f] === 'string' && p[f].length > 0, `${key}.${f}`);
    ok(Array.isArray(p.merchant) && p.merchant.length > 0, `${key}.merchant`);
    ok(Array.isArray(p.rapyd) && p.rapyd.length > 0, `${key}.rapyd`);
  }
  eq(SEAM_PATHS['own-fields'].tag, 'SAQ D');
  eq(['embedded', 'wallets', 'hosted'].map((k) => SEAM_PATHS[k].tag), ['SAQ A', 'SAQ A', 'SAQ A']);
});

test('seam: model + toolkit mode → path key', () => {
  eq(seamPathKey('own-fields', 'hosted'), 'own-fields'); // the mode only matters on the toolkit
  eq(seamPathKey('toolkit', 'embedded'), 'embedded');
  eq(seamPathKey('toolkit', 'wallets'), 'wallets');
  eq(seamPathKey('toolkit', 'hosted'), 'hosted');
  eq(seamPathKey('toolkit', 'nonsense'), 'embedded');
});

test('seam: hosted address comes from the redirect_url, Rapyd hosts only', () => {
  eq(hostedAddress('https://sandboxcheckout.rapyd.net/?token=checkout_abc', 'sandbox'),
    { host: 'sandboxcheckout.rapyd.net', path: '/?token=checkout_abc' });
  eq(hostedAddress('https://checkout.rapyd.net/?token=checkout_live', 'sandbox').host, 'checkout.rapyd.net'); // the URL wins over env
  // never print a non-Rapyd host as Rapyd's — fall back to the env's domain
  eq(hostedAddress('https://rapyd.net.evil.example/?token=x', 'sandbox'), { host: HOSTED_DOMAIN.sandbox, path: '/' });
  eq(hostedAddress('http://sandboxcheckout.rapyd.net/?token=x', 'sandbox').path, '/');
  eq(hostedAddress('javascript:alert(1)', 'live'), { host: HOSTED_DOMAIN.live, path: '/' });
  eq(hostedAddress(null), { host: HOSTED_DOMAIN.sandbox, path: '/' });
  ok(isRapydHost('sandboxcheckouttoolkit.rapyd.net'), 'toolkit host');
  ok(!isRapydHost('rapyd.net.evil.example') && !isRapydHost('evilrapyd.net') && !isRapydHost(''), 'look-alikes');
});

test('seam: page paths and escaped markers', () => {
  eq([pagePath('shop'), pagePath('checkout'), pagePath('complete'), pagePath('cancel'), pagePath('??')],
    ['/', '/checkout', '/checkout/complete', '/checkout/cancel', '/']);
  const w = seamWrapHTML('<i></i>', '"><img src=x onerror=1>');
  ok(!w.includes('<img'), 'label escaped');
  ok(w.includes('<i></i>'), 'inner kept');
  ok(SEAM_LABELS.hosted.startsWith('Rapyd'), 'labels name Rapyd');
  ok(seamStripHTML('hosted').includes('SAQ A') && seamStripHTML('bogus').includes('SAQ D'), 'strip falls back to own-fields');
});

/* ── external 3DS — merchant's own provider, simulated ── */
test('ext3ds: only a sandbox external-3DS MID on Own Card Fields', () => {
  ok(usesExternal3DS({ env: 'sandbox', profile: 'SC2', model: 'own-fields' }), 'SC2 own fields');
  ok(!usesExternal3DS({ env: 'sandbox', profile: 'SC2', model: 'toolkit' }), 'toolkit: Rapyd hosts the card form');
  ok(!usesExternal3DS({ env: 'sandbox', profile: 'SC1', model: 'own-fields' }), 'SC1 runs Rapyd 3DS');
  ok(!usesExternal3DS({ env: 'live', profile: 'SC2', model: 'own-fields' }), 'never in live');
  ok(!usesExternal3DS({ env: 'sandbox', profile: 'nope', model: 'own-fields' }), 'unknown profile');
});

test('ext3ds: a pass builds Rapyd\'s payment_method_options block', () => {
  for (const choice of ['challenge-pass', 'frictionless']) {
    const r = simulateExternal3DS(choice, 'Visa');
    eq(r.transStatus, 'Y', choice);
    eq(r.challenged, choice === 'challenge-pass', `${choice} challenged`);
    const pmo = externalTdsOptions(r);
    // exactly the documented fields — and never 3d_required alongside
    eq(Object.keys(pmo).sort(), ['3d_version', 'cavv', 'ds_trans_id', 'eci']);
    eq(pmo['3d_version'], '2.2.0');
    eq(pmo.eci, '05');
    eq(pmo.cavv, DUMMY_CAVV);
    ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pmo.ds_trans_id), 'ds_trans_id is a UUID');
    ok(!('3d_required' in pmo), 'no 3d_required');
    eq(ext3dsDecision(r), { callRapyd: true, payment_method_options: pmo });
  }
  eq(externalTdsOptions(simulateExternal3DS('frictionless', 'Mastercard')).eci, '02', 'Mastercard ECI');
  // the CAVV is 20 bytes Base64 (Rapyd's description) and reads as dummy
  eq(atob(DUMMY_CAVV), 'SIMULATED-CAVV-00000');
  eq(atob(DUMMY_CAVV).length, 20);
  eq(EXT3DS_PMO_PATHS, Object.keys(EXT3DS_PLACEHOLDER).map((k) => `payment_method_options.${k}`));
});

test('ext3ds: a fail means NO Rapyd request', () => {
  for (const choice of ['challenge-fail', 'frictionless-fail', 'garbage', undefined]) {
    const r = simulateExternal3DS(choice, 'Visa');
    eq(r.transStatus, 'N', String(choice));
    ok(!r.authenticationValue, 'no CAVV on a fail');
    eq(externalTdsOptions(r), null);
    eq(ext3dsDecision(r), { callRapyd: false, payment_method_options: null });
  }
  eq(ext3dsDecision(null).callRapyd, false, 'no result → no call');
  // a forged pass without a CAVV is still not a pass
  eq(ext3dsDecision({ transStatus: 'Y', eci: '05' }).callRapyd, false);
  eq(EXT3DS_CHOICES.length, 4);
});

test('ext3ds: SE preset, AReq summary and the seam line', () => {
  const before = ext3dsPreset();
  setExt3dsPreset('fail'); eq(ext3dsPreset(), 'fail');
  setExt3dsPreset('bogus'); eq(ext3dsPreset(), 'fail', 'unknown values ignored');
  setExt3dsPreset(before);
  const req = authRequestSummary({ last4: '1111', brand: 'Visa', amount: '10', currency: 'USD', merchant: 'rapyd.shop' });
  ok(req.acctNumber.endsWith('1111') && !/\d{5}/.test(req.acctNumber), 'masked PAN only');
  ok(seamTdsLine('own-fields', 'external').includes('payment_method_options'), 'own fields: external runs first');
  for (const k of ['embedded', 'wallets', 'hosted']) ok(seamTdsLine(k, 'external').includes('doesn’t apply'), `${k}: n/a`);
  eq(seamTdsLine('hosted', 'rapyd'), null);
  ok(seamLinesHTML('hosted', { tds: 'external' }).includes('<b>3DS</b>'), 'explainer gets a 3DS line');
  ok(!seamLinesHTML('hosted').includes('<b>3DS</b>'), 'no line without a provider');
  const w = seamExtWrapHTML('<i></i>');
  ok(w.includes('seam-ext') && !w.includes('seam-rapyd') && w.includes('simulated'), 'own grey marker, not Rapyd\'s');
  ok(!EXT_TDS_LABEL.startsWith('Rapyd'), 'never labelled Rapyd');
});

/* ── Direct Apple Pay / Google Pay — mock token, real sandbox call ── */
const PCI = { model: 'own-fields', env: 'sandbox' };
const TK = { model: 'toolkit', env: 'sandbox' };
const dwBody = (wallet, variant, ctx = PCI) => directPaymentBody({
  wallet, variant, ...ctx, amount: '149.99', currency: 'USD', description: 'Oak chair', reference: 'SIMULATED-ref', now: 1767225600000,
});
const hasSimMarker = (o) => JSON.stringify(o).includes(SIM_MARK)
  || JSON.stringify(o).includes(btoa('SIMULATED').slice(0, 10)); // base64 of a SIMULATED-… string

test('direct wallet: availability — Own Card Fields (PCI) only, nothing direct in live', () => {
  eq(WALLET_INTEGRATIONS.map(([k]) => k), ['checkout', 'encrypted', 'decrypted']);
  ok(walletAvailability('checkout', TK).ok && walletAvailability('checkout', { model: 'toolkit', env: 'live' }).ok, 'checkout (real) everywhere');
  ok(walletAvailability('encrypted', PCI).ok && walletAvailability('decrypted', PCI).ok, 'both on Own Card Fields');
  for (const v of ['encrypted', 'decrypted']) {
    const off = walletAvailability(v, TK);
    ok(!off.ok && /Own Card Fields only/.test(off.reason) && /PCI/.test(off.reason), `${v}: refused on the toolkit, with a reason`);
  }
  eq(effectiveWalletIntegration(TK, 'encrypted'), 'checkout', 'encrypted falls back to Off on the toolkit');
  for (const v of ['encrypted', 'decrypted']) ok(!walletAvailability(v, { model: 'own-fields', env: 'live' }).ok, `${v}: never in live`);
  ok(!walletAvailability('bogus', PCI).ok, 'unknown variant');
  eq(effectiveWalletIntegration(TK, 'decrypted'), 'checkout', 'falls back to Off');
  eq(effectiveWalletIntegration(PCI, 'decrypted'), 'decrypted');
  const before = walletIntegration();
  setWalletIntegration('encrypted'); eq(walletIntegration(), 'encrypted');
  setWalletIntegration('nope'); eq(walletIntegration(), 'encrypted', 'unknown values ignored');
  setWalletIntegration(before);
});

test('direct wallet: encrypted bodies forward the token unchanged (Rapyd\'s shape)', () => {
  const a = dwBody('apple', 'encrypted');
  eq(a.payment_method.type, DIRECT_METHOD_TYPE, 'the card\'s method type, no *_apple_pay');
  eq(a.payment_method.digital_wallet.type, 'apple_pay');
  eq(Object.keys(a.payment_method.digital_wallet.details), ['token']);
  const t = a.payment_method.digital_wallet.details.token;
  eq(t, encryptedToken('apple'), 'token passed as the sheet returned it');
  eq(Object.keys(t).sort(), ['paymentData', 'paymentMethod', 'transactionIdentifier']);
  eq(Object.keys(t.paymentData).sort(), ['data', 'header', 'signature', 'version']);
  eq(Object.keys(t.paymentData.header).sort(), ['ephemeralPublicKey', 'publicKeyHash', 'transactionId']);
  eq(t.paymentData.version, 'EC_v1');
  ok(!('decrypted_data' in a.payment_method.digital_wallet.details), 'no card data in an encrypted body');
  ok(atob(t.paymentData.data).startsWith('SIMULATED-'), 'the payload decodes to a SIMULATED marker');
  eq([a.amount, a.currency, a.capture], [149.99, 'USD', true]);
  eq(a.metadata, { digital_wallet: 'apple_pay' }, 'metadata as in Rapyd\'s sample');

  const g = dwBody('google', 'encrypted');
  eq(g.payment_method.digital_wallet.type, 'google_pay');
  const d = g.payment_method.digital_wallet.details;
  eq(d.type, 'CARD', 'details.type beside token, as Rapyd\'s sample has it');
  eq([d.token.apiVersion, d.token.apiVersionMinor], [2, 0]);
  eq(d.token.paymentMethodData.tokenizationData.type, 'PAYMENT_GATEWAY');
  const raw = d.token.paymentMethodData.tokenizationData.token; // Google's JSON string, unchanged
  eq([typeof raw, JSON.parse(raw).protocolVersion], ['string', 'ECv2']);
  eq(d.token.paymentMethodData.type, 'CARD', 'Google\'s own shape');
  eq([d.token.paymentMethodData.info.cardNetwork, d.token.paymentMethodData.info.cardDetails], ['VISA', '1111']);
  eq(g.metadata, { digital_wallet: 'google_pay' });
  ok(hasSimMarker(a) && hasSimMarker(g), 'fake markers present');
  ok(!JSON.stringify(g).includes('4111'), 'no PAN anywhere in an encrypted body');
});

test('direct wallet: decrypted bodies carry DPAN + cryptogram (+ ECI)', () => {
  const a = dwBody('apple', 'decrypted');
  const ad = a.payment_method.digital_wallet.details;
  eq(Object.keys(ad), ['decrypted_data', 'brand_data']);
  const dd = ad.decrypted_data;
  eq(Object.keys(dd), ['applicationPrimaryAccountNumber', 'applicationExpirationDate', 'currencyCode', 'transactionAmount',
    'deviceManufacturerIdentifier', 'paymentDataType', 'paymentData']);
  ok(/^\d{6}$/.test(dd.applicationExpirationDate), 'YYMMDD');
  eq([dd.currencyCode, dd.transactionAmount, dd.paymentDataType], ['840', 14999, '3DSecure']);
  eq(Object.keys(dd.paymentData), ['onlinePaymentCryptogram', 'eciIndicator']);
  eq(dd.paymentData, { onlinePaymentCryptogram: SIM_CRYPTOGRAM, eciIndicator: '7' });
  eq(atob(SIM_CRYPTOGRAM), 'SIMULATED-CRYPTOGRAM');
  eq(atob(SIM_CRYPTOGRAM).length, 20, 'a cryptogram-sized dummy');
  eq(Object.keys(ad.brand_data), ['displayName', 'network', 'type']);
  ok(dd.deviceManufacturerIdentifier.startsWith(SIM_MARK), 'fake marker');

  const g = dwBody('google', 'decrypted');
  const gd = g.payment_method.digital_wallet.details;
  eq(Object.keys(gd.decrypted_data), ['gatewayMerchantId', 'messageExpiration', 'messageId', 'paymentMethod', 'paymentMethodDetails']);
  const pmd = gd.decrypted_data.paymentMethodDetails;
  eq(Object.keys(pmd), ['pan', 'expirationMonth', 'expirationYear', 'authMethod', 'cryptogram', 'eciIndicator']);
  eq([pmd.authMethod, pmd.eciIndicator, pmd.expirationMonth, pmd.expirationYear], ['CRYPTOGRAM_3DS', '07', 12, 2029], 'expiry as numbers');
  ok(/^\d{13}$/.test(gd.decrypted_data.messageExpiration), '13-digit ms timestamp');
  eq(Object.keys(gd.brand_data), ['cardDetails', 'cardNetwork']);
  ok(gd.decrypted_data.messageId.startsWith(SIM_MARK), 'fake marker');
  eq(gd.decrypted_data.gatewayMerchantId, GATEWAY_ID_PLACEHOLDER, 'the backend writes the access key in');
  // PAN_ONLY: no cryptogram, no ECI
  const po = directPaymentBody({ wallet: 'google', variant: 'decrypted', ...PCI, amount: '1', currency: 'USD', authMethod: 'PAN_ONLY' });
  eq(Object.keys(po.payment_method.digital_wallet.details.decrypted_data.paymentMethodDetails), ['pan', 'expirationMonth', 'expirationYear', 'authMethod']);
  eq(po.payment_method.digital_wallet.details.decrypted_data.paymentMethodDetails.authMethod, 'PAN_ONLY');
  // no "6DS": Rapyd's 3DS only for Google PAN_ONLY
  eq(po.payment_method_options, { '3d_required': true }, 'PAN_ONLY asks for Rapyd 3DS');
  for (const [w, v] of [['apple', 'encrypted'], ['apple', 'decrypted'], ['google', 'encrypted'], ['google', 'decrypted']]) {
    eq(dwBody(w, v).payment_method_options, { '3d_required': false }, `${w}/${v}: the wallet's SCA stands`);
  }
  ok(!needsRapyd3DS('apple', 'decrypted', 'PAN_ONLY') && !needsRapyd3DS('google', 'encrypted', 'PAN_ONLY'), 'PAN_ONLY means Google decrypted only');
  // AFT products stay AFT on a wallet payment — same options as the card checkout
  const aftBody = (aft, extra = {}) => directPaymentBody({ wallet: 'apple', variant: 'encrypted', ...PCI, amount: '50', currency: 'USD', aft, ...extra });
  eq(aftBody({ is_direct_purchase: true, purpose_code: 'crypto_currency', special_condition_indicator: 'crypto_currency_purchase' }).payment_method_options,
    { '3d_required': false, aft: true, is_direct_purchase: true, purpose_code: 'crypto_currency', special_condition_indicator: 'crypto_currency_purchase' });
  eq(aftBody({ is_direct_purchase: false, purpose_code: 'investment' }).payment_method_options,
    { '3d_required': false, aft: true, is_direct_purchase: false, purpose_code: 'investment' }, 'no special_condition_indicator unless the pack sets one');
  eq(aftBody({ is_direct_purchase: true, purpose_code: 'x' }, { wallet: 'google', variant: 'decrypted', authMethod: 'PAN_ONLY' }).payment_method_options['3d_required'], true, 'AFT keeps PAN_ONLY\'s 3DS');
  ok(!('aft' in aftBody(null).payment_method_options), 'no AFT fields for a non-AFT product');
  // routing fields as on every other payment, only when given
  const routed = directPaymentBody({ wallet: 'apple', variant: 'encrypted', ...PCI, amount: '1', currency: 'USD', ewallet: 'ewallet_x', descriptor: 'RAPYD SHOP' });
  eq([routed.ewallet, routed.statement_descriptor], ['ewallet_x', 'RAPYD SHOP']);
  ok(!('ewallet' in g) && !('statement_descriptor' in g), 'absent when not given');
  // FX: the wallet's own data follows what the sheet charged, Rapyd's amount the price
  const fx = directPaymentBody({ wallet: 'apple', variant: 'decrypted', ...PCI, amount: '10', currency: 'USD', charge: { amount: '9.25', currency: 'EUR' } });
  eq([fx.amount, fx.currency, fx.payment_method.digital_wallet.details.decrypted_data.currencyCode,
    fx.payment_method.digital_wallet.details.decrypted_data.transactionAmount], [10, 'USD', '978', 925]);
});

test('direct wallet: decrypted refused off the PCI path; bad input throws', () => {
  let threw = null;
  try { dwBody('apple', 'decrypted', TK); } catch (e) { threw = e.message; }
  ok(threw && /refused/.test(threw) && /PCI/.test(threw), 'no direct body on the toolkit');
  for (const bad of [() => dwBody('google', 'decrypted', { model: 'own-fields', env: 'live' }),
    () => dwBody('samsung', 'encrypted'), () => dwBody('apple', 'checkout')]) {
    let t = false; try { bad(); } catch { t = true; }
    ok(t, 'throws');
  }
  eq([currencyNumeric('eur'), currencyNumeric('XYZ')], ['978', null]);
  eq([minorUnits('149.99'), minorUnits('5'), minorUnits('1000', 0), minorUnits('0.1')], [14999, 500, 1000, 10]);
});

test('direct wallet: Google authMethod choice', () => {
  eq(GOOGLE_AUTH_METHODS, ['CRYPTOGRAM_3DS', 'PAN_ONLY']);
  const before = googleAuthMethod();
  setGoogleAuthMethod('PAN_ONLY'); eq(googleAuthMethod(), 'PAN_ONLY');
  setGoogleAuthMethod('nope'); eq(googleAuthMethod(), 'PAN_ONLY', 'unknown values ignored');
  setGoogleAuthMethod(before);
});

test('direct wallet: steps outside Rapyd, seam lines', () => {
  for (const w of ['apple', 'google']) for (const v of ['encrypted', 'decrypted']) {
    const steps = walletSteps(w, v);
    eq(steps.filter((s) => s.party === 'rapyd').length, 1, `${w}/${v}: one Rapyd step`);
    eq(steps[steps.length - 1].party, 'rapyd', 'Rapyd last');
    for (const s of steps.filter((x) => x.party !== 'rapyd')) {
      ok(!/[\n]/.test(s.line) && s.line.length < 200, 'one line each');
      if (s.link) ok(/^https:\/\/(developer\.apple\.com|developers\.google\.com)\//.test(s.link.href), 'links to Apple / Google docs');
    }
    eq(steps.some((s) => s.pci), v === 'decrypted', `${w}/${v}: PCI step only when decrypting`);
    ok(steps.some((s) => s.sheet), 'a sheet step');
  }
  ok(walletSteps('apple', 'encrypted').some((s) => /validation/i.test(s.title)), 'Apple merchant validation shown');
  eq(walletDataPaths('apple', 'decrypted'), ['payment_method.digital_wallet.details.decrypted_data', 'payment_method.digital_wallet.details.brand_data']);
  const leaves = leafPathsUnder(dwBody('apple', 'decrypted'), walletDataPaths('apple', 'decrypted'));
  ok(leaves.includes('payment_method.digital_wallet.details.decrypted_data.paymentData.eciIndicator'), 'leaf paths for the highlight');
  ok(!leaves.some((l) => l.startsWith('amount')), 'only under the prefixes');
  ok(/Rapyd decrypts/.test(seamWalletLine('embedded', 'encrypted')), 'encrypted: Rapyd decrypts');
  ok(/PCI/.test(seamWalletLine('own-fields', 'decrypted')), 'decrypted: PCI');
  eq(seamWalletLine('own-fields', 'checkout'), WALLET_SEAMS.checkout.ownFields);
  eq(seamWalletLine('own-fields', null), null);
  ok(seamLinesHTML('own-fields', { wallet: 'decrypted' }).includes('<b>Wallets</b>'), 'explainer gets a Wallets line');
  ok(seamLinesHTML('embedded', { wallet: 'encrypted' }).includes('seam-who third'), 'Apple / Google as a third party');
});

test('aftOptions: every AFT payment carries the block, no exemptions', () => {
  const crypto = { aft: true, purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency' };
  eq(aftOptions(crypto), { aft: true, is_direct_purchase: true, purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency' });
  eq(aftOptions(crypto, false).is_direct_purchase, false, 'the page\'s fund-wallet fork');
  eq(aftOptions({ ...crypto, is_direct_purchase: false }, true).is_direct_purchase, false, 'a wallet deposit is never a direct purchase');
  eq(aftOptions({ aft: true, purpose_code: 'high_risk_securities' }), { aft: true, is_direct_purchase: true, purpose_code: 'high_risk_securities' }, 'no indicator unless the pack sets one');
  eq(aftOptions({ aft: false }), null);
  eq(aftOptions({}), null);
});

test('add a card: the route follows the integration path, the toolkit mode and the MID\'s 3DS', () => {
  eq(addCardMethod({ model: 'toolkit', env: 'sandbox', profile: 'SC1', toolkitMode: 'hosted' }), 'htp-redirect');
  eq(addCardMethod({ model: 'toolkit', env: 'sandbox', profile: 'SC1', toolkitMode: 'embedded' }), 'htp-toolkit');
  eq(addCardMethod({ model: 'toolkit', env: 'live', toolkitMode: 'wallets' }), 'htp-toolkit');
  eq(addCardMethod({ model: 'own-fields', env: 'sandbox', profile: 'SC1' }), 's2s-rapyd');
  eq(addCardMethod({ model: 'own-fields', env: 'sandbox', profile: 'SC3' }), 's2s-rapyd');
  eq(addCardMethod({ model: 'own-fields', env: 'sandbox', profile: 'SC2' }), 's2s-external', 'SC2 runs an external 3DS provider');
  eq(addCardMethod({ model: 'own-fields', env: 'live', profile: 'SC2' }), 'htp-toolkit', 'no raw card in live');
});

test('add a card: HTP, $0-auth and external-3DS bodies', () => {
  const urls = { complete: 'https://x.test/complete/?for=card', cancel: 'https://x.test/cancel/?for=card' };
  const h = htpBody({ customer: 'cus_1', country: 'GB', recurrence_type: 'recurring', urls, now: 1767225600000 });
  eq(h, {
    customer: 'cus_1', country: 'GB', language: 'en', complete_url: urls.complete, cancel_url: urls.cancel,
    complete_payment_url: urls.complete, error_payment_url: urls.cancel, page_expiration: 1767229200,
    card_fields: { recurrence_type: 'recurring' },
  });
  const card = { number: '4111 1111 1111 1111', expiry: '12 / 27', cvv: '123', name: 'Jordan Taylor' };
  const z = zeroAuthBody({ card, recurrence_type: 'unscheduled', customer: 'cus_1', currency: 'GBP', reference: 'pb_x', descriptor: 'RAPYD SHOP',
    ewallet: 'ewallet_1', address: { country: 'GB' }, email: 'j@example.com', client: { language: 'en' }, urls });
  eq([z.amount, z.capture, z.save_payment_method, z.initiation_type, z.customer, z.ewallet], [0, false, true, 'customer_present', 'cus_1', 'ewallet_1']);
  eq(z.payment_method_options, { '3d_required': true }, '3DS is mandatory for card verification');
  eq(z.payment_method.fields.number, '4111111111111111');
  eq(z.payment_method.fields.recurrence_type, 'unscheduled');
  ok(z.address && z.receipt_email && z.client_details, 'the 3DS context Rapyd asks for');
  const tds = { '3d_version': '2.2.0', cavv: 'x', eci: '05', ds_trans_id: 'y' };
  const e = externalAddBody({ card, recurrence_type: 'recurring', customer: 'cus_1', tds, urls });
  eq(Object.keys(e), ['customer', 'type', 'fields', 'complete_payment_url', 'error_payment_url', 'payment_method_options']);
  eq([e.type, e.fields.recurrence_type, e.payment_method_options], ['gb_visa_card', 'recurring', tds]);
  ok(!('3d_required' in e.payment_method_options), 'no Rapyd 3DS alongside the merchant\'s results');
  const c = cardToolkitConfig('hp_card_1', '#7437F5');
  eq([c.id, c.page_type, c.wait_on_payment_redirect], ['hp_card_1', 'card_token', true]);
});

test('add a card: follows the LIVE toolkit mode, wherever it was changed', () => {
  const before = toolkitMode();
  setToolkitMode('hosted');
  eq(sharedToolkitMode(), 'hosted');
  setToolkitMode('wallets');
  eq(sharedToolkitMode(), 'wallets');
  setToolkitMode(before);
  eq(sharedToolkitMode(), before);
});

test('add a card: webhooks are stitched across ref / customer / card scopes', () => {
  const ps = { event_id: 'wh_ps', type: 'PAYMENT_SUCCEEDED', received_at: 1000 };
  const cpmc = { event_id: 'wh_c', type: 'CUSTOMER_PAYMENT_METHOD_CREATED', received_at: 2000 };
  const pu = { event_id: 'wh_pu', type: 'PAYMENT_UPDATED', received_at: 4000 };
  const old = { event_id: 'wh_old', type: 'PAYMENT_SUCCEEDED', received_at: 10 };
  const out = stitchEvents({ ref: [pu, ps], customer: [pu, ps, old], card: [cpmc] }, 500);
  eq(out.map((e) => e.event_id), ['wh_ps', 'wh_c', 'wh_pu'], 'deduped, oldest first, earlier runs dropped');
  eq(out[0].via, ['ref', 'customer']);
  eq(out[1].via, ['card'], 'a card event links only by its card id');
  eq(stitchEvents({ customer: [{ type: 'X', received_at: 7 }, { type: 'X', received_at: 7 }] }).length, 1, 'no event id → type + time');
  eq(expectedAddCardEvents('s2s-rapyd'), ['PAYMENT_SUCCEEDED', 'CUSTOMER_PAYMENT_METHOD_CREATED', 'CARD_ADDED_SUCCESSFULLY', 'PAYMENT_UPDATED']);
  eq(expectedAddCardEvents('htp-toolkit'), expectedAddCardEvents('s2s-rapyd'), 'the hosted page verifies the card the same way');
  eq(expectedAddCardEvents('htp-redirect'), expectedAddCardEvents('s2s-rapyd'));
  eq(expectedAddCardEvents('s2s-external'), ['CUSTOMER_PAYMENT_METHOD_CREATED', 'CARD_ADDED_SUCCESSFULLY'], 'no Rapyd payment');
  ok(expectedAddCardEvents('s2s-rapyd').every((t) => ADD_CARD_EVENTS[t]), 'every expected event is explained');
});

/* ── Wallet (site/wallet.js) ── */
test('wallet: packs opt in — gambling + crypto deposit/withdraw, home off', () => {
  const g = walletConfig('igaming'), c = walletConfig('crypto');
  eq([g.currency, g.country, g.depositLabel, g.aft], ['EUR', 'MT', 'Deposit', null]);
  eq([c.currency, c.country, c.depositLabel], ['USD', 'US', 'Deposit']);
  eq(c.aft, { purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency' });
  eq([g.octCategory, c.octCategory], ['online_gambling', 'non_money_transfer'], 'which data.oct.* verdict judges a withdrawal');
  eq(walletConfig('home'), null, 'home runs no wallet');
  eq(walletConfig('nope'), null);
});

test('wallet: a pending deposit is what the checkout charges (ahead of the bag)', () => {
  const base = { vertical: 'gaming', env: 'sandbox', productOverride: null, selectedProduct: null, walletDeposit: null,
    cart: { vertical: 'gaming', lines: [{ productId: 'spins', qty: 1 }] } };
  withState(base, () => {
    eq(activeProduct().id, 'spins', 'no deposit → the bag');
    setPendingDeposit('gaming', '25.00', 'EUR');
    const p = activeProduct();
    eq([p.id, p.amount, p.currency, p.billing, p.cta, p.deposit, p.aft], [DEPOSIT_ID, '25.00', 'EUR', 'one_time', 'Deposit', true, false]);
    eq(orderItems(p)[0].id, DEPOSIT_ID, 'the ledger item marks it a deposit');
    withState({ env: 'live' }, () => eq(activeProduct().amount, '0.01', 'live clamp still applies'));
    clearPendingDeposit();
    eq(activeProduct().id, 'spins');
  });
  withState({ ...base, vertical: 'crypto', cart: null, walletDeposit: { vertical: 'crypto', amount: '50.00', currency: 'USD' } }, () => {
    const p = activeProduct();
    eq([p.aft, p.purpose_code, p.special_condition_indicator, p.is_direct_purchase], [true, 'crypto_currency', 'cryptocurrency', false],
      'crypto deposits keep the AFT indicators, funding a balance');
  });
  withState({ ...base, vertical: 'ecommerce', cart: null, walletDeposit: { vertical: 'ecommerce', amount: '5.00', currency: 'GBP' } }, () => {
    ok(activeProduct().id !== DEPOSIT_ID, 'a pack without a wallet ignores a deposit');
  });
  withState({ ...base, walletDeposit: { vertical: 'crypto', amount: '5.00', currency: 'USD' } }, () => {
    eq(activeProduct().id, 'spins', 'a deposit for another skin is ignored');
  });
  eq(depositProduct(walletConfig('igaming'), { amount: '10.00' }).currency, 'EUR');
});

const W = { customerId: 'cus_me', vertical: 'gaming', env: 'sandbox' };
const dep = (amount, status, extra = {}) => ({ kind: 'payment', vertical: 'gaming', env: 'sandbox', customer_id: 'cus_me',
  items: [{ id: DEPOSIT_ID, name: 'Wallet deposit', qty: 1 }], amount, currency: 'EUR', status, refunds: [], created_at: 1, ...extra });
const po = (amount, status, extra = {}) => ({ kind: 'payout', vertical: 'gaming', env: 'sandbox', customer_id: 'cus_me',
  amount, currency: 'EUR', status, refunds: [], created_at: 2, ...extra });

test('wallet: balance = trusted deposits − refunds − every payout that hasn\'t failed', () => {
  const list = [
    dep('50.00', 'completed', { refunds: [{ status: 'completed', amount: 5, currency: 'EUR' }, { status: 'pending', amount: 9, currency: 'EUR' }] }),
    dep('20.00', 'pending'),                 // not yet trusted → incoming only
    dep('10.00', 'failed'),                  // declined → nothing
    po('10.00', 'completed'),
    po('7.50', 'pending'),                   // reserved while in flight
    po('3.00', 'failed'),                    // failed payout gives the money back
    dep('99.00', 'completed', { customer_id: 'cus_other' }),
    dep('99.00', 'completed', { vertical: 'crypto' }),
    dep('99.00', 'completed', { env: 'live' }),
    dep('99.00', 'completed', { currency: 'USD' }),
    { kind: 'payment', vertical: 'gaming', env: 'sandbox', customer_id: 'cus_me', items: [{ id: 'spins' }], amount: '50.00', currency: 'EUR', status: 'completed', refunds: [] },
  ];
  eq(walletBalance(list, W, 'EUR'), { available: '27.50', incoming: '20.00', outgoing: '7.50', currency: 'EUR' });
  eq(walletEntries(list, W).length, 7, 'only this shopper\'s deposits + payouts here (other currencies listed, not counted)');
  eq(walletEntries(list, { ...W, customerId: null }), [], 'a guest has no wallet');
  ok(isDepositEntry(list[0]) && !isDepositEntry(list[10]), 'a shop purchase is not a deposit');
  eq(walletBalance([po('5.00', 'completed')], W, 'EUR').available, '0.00', 'never negative');
  eq(walletBalance([dep('0.10', 'completed'), dep('0.20', 'completed')], W, 'EUR').available, '0.30', 'minor units — no float drift');
});

test('wallet: withdraw limits (validAmount + never above the available balance)', () => {
  eq(withdrawProblem('27.50', '27.50', 'EUR'), null);
  eq(withdrawProblem('27.51', '27.50', 'EUR').code, 'balance');
  ok(/27\.50 EUR/.test(withdrawProblem('30', '27.50', 'EUR').message), 'names the limit');
  for (const bad of ['', '0', '-1', '27.505', '1e1', 'abc']) eq(withdrawProblem(bad, '27.50', 'EUR')?.code, 'amount', bad);
  eq(withdrawProblem('1', '0.00', 'EUR').code, 'empty');
  eq(withdrawProblem('5', '10', 'JPY'), null);
  eq(withdrawProblem('5.5', '10', 'JPY').code, 'amount', 'JPY has no decimals');
  eq(depositProblem('25', 'EUR'), null);
  eq(depositProblem('25.001', 'EUR').code, 'amount');
});

test('wallet: withdraw chips — 10 / 20 when covered, plus All', () => {
  eq(withdrawChips('27.50', 'EUR'), [{ label: '10', amount: '10.00' }, { label: '20', amount: '20.00' }, { label: 'All', amount: '27.50' }]);
  eq(withdrawChips('15.00', 'EUR').map((c) => c.label), ['10', 'All']);
  eq(withdrawChips('20.00', 'EUR').map((c) => c.label), ['10', 'All'], 'All covers the exact 20');
  eq(withdrawChips('5', 'EUR'), [{ label: 'All', amount: '5.00' }]);
  eq(withdrawChips('0.00', 'EUR'), []);
});

test('wallet: payout method type from GET /v1/payout_method_types', () => {
  const list = [
    { payout_method_type: 'us_debit_visa_card', category: 'card' },
    { payout_method_type: 'us_visa_card', category: 'card' },
    { payout_method_type: 'us_mastercard_card', category: 'card' },
    { payout_method_type: 'us_amex_card', category: 'card', status: 0 },
    { payout_method_type: 'us_ach_bank', category: 'bank' },
    { payout_method_type: 'mt_visa_card', category: 'card' },
  ];
  eq(pickPayoutMethodType(list, { country: 'US', brand: 'Visa' }), 'us_visa_card');
  eq(pickPayoutMethodType(list, { country: 'US', brand: 'Mastercard' }), 'us_mastercard_card');
  eq(pickPayoutMethodType(list, { country: 'US', brand: 'Amex' }), 'us_debit_visa_card', 'unavailable (status 0) is skipped');
  eq(pickPayoutMethodType(list, { country: 'MT', brand: 'Mastercard' }), 'mt_visa_card');
  eq(pickPayoutMethodType(list, { country: 'GB', brand: 'Visa' }), null);
  eq(pickPayoutMethodType(null, { country: 'US' }), null);
  eq(fallbackPayoutMethodType('MT', 'Visa'), 'mt_visa_card');
});

test('wallet: beneficiary/sender from required fields — saved card_id, else the sandbox test card', () => {
  const required = {
    beneficiary_required_fields: [
      { name: 'first_name', is_required: true }, { name: 'card_number', is_required: true },
      { name: 'card_expiration_month', is_required: true }, { name: 'email', is_required: true },
      { name: 'phone_number', is_required: true }, { name: 'date_of_birth', is_required: false },
    ],
    sender_required_fields: [
      { name: 'company_name', is_required: true }, { name: 'city', is_required: true }, { name: 'identification_value', is_required: true },
    ],
  };
  const identity = customers.getIdentity();
  const tok = fillParties(required, { dest: { kind: 'token', card_id: 'card_abc' }, identity, merchant: 'rapyd.coin', country: 'US' });
  eq(tok.beneficiary.card_id, 'card_abc');
  ok(!('card_number' in tok.beneficiary), 'a token never carries a PAN');
  eq([tok.beneficiary.first_name, tok.beneficiary.email], [identity.name.split(' ')[0], identity.email]);
  eq(tok.missing, { beneficiary: ['phone_number'], sender: ['identification_value'] });
  eq([tok.sender.company_name, tok.sender.city], ['rapyd.coin', 'New York']);
  const tc = fillParties(required, { dest: { kind: 'test' }, identity, merchant: 'rapyd.spin', country: 'MT' });
  eq([tc.beneficiary.card_number, tc.beneficiary.card_expiration_month], [SANDBOX_PAYOUT_CARD.card_number, '12']);
  eq(tc.sender.city, 'Valletta');
  const bare = fillParties(null, { dest: { kind: 'token', card_id: 'card_x' }, identity, merchant: 'm', country: 'US' });
  eq(Object.keys(bare.beneficiary).sort(), ['card_id', 'first_name', 'last_name'], 'no lookup → the documented card_id minimum');
  eq(bare.sender, { company_name: 'm' });
});

test('wallet: Create Payout body', () => {
  const b = payoutBody({
    amount: '12.50', currency: 'EUR', country: 'MT', methodType: 'mt_visa_card',
    beneficiary: { card_id: 'card_abc', first_name: 'J', last_name: 'T' }, sender: { company_name: 'rapyd.spin' },
    reference: 'wd_1_abc', description: 'Withdrawal to Visa •••• 1111', descriptor: 'R'.repeat(40), ewallet: 'ewallet_x',
  });
  eq(Object.keys(b), ['ewallet', 'payout_amount', 'payout_currency', 'sender_currency', 'sender_country', 'beneficiary_country',
    'sender_entity_type', 'beneficiary_entity_type', 'payout_method_type', 'beneficiary', 'sender', 'merchant_reference_id',
    'description', 'statement_descriptor', 'confirm_automatically']);
  eq([b.payout_amount, b.payout_currency, b.sender_currency, b.beneficiary_country, b.sender_entity_type, b.beneficiary_entity_type],
    [12.5, 'EUR', 'EUR', 'MT', 'company', 'individual']);
  eq([b.statement_descriptor.length, b.confirm_automatically], [35, true]);
  const liveBody = payoutBody({ amount: '0.01', currency: 'USD', country: 'US', methodType: 'us_visa_card', beneficiary: {}, sender: {}, reference: 'r', description: 'd', ewallet: null });
  ok(!('ewallet' in liveBody) && !('statement_descriptor' in liveBody), 'no wallet (live injects it) / no descriptor when none');
  ok(newReference('wd').length <= 45, 'payout references fit Create Payout\'s 45-char limit');
  eq(requiredFieldsQuery({ methodType: 'us_visa_card', country: 'US', currency: 'USD', amount: '10' }), {
    payout_method_type: 'us_visa_card', sender_country: 'US', sender_currency: 'USD', beneficiary_country: 'US',
    payout_currency: 'USD', sender_entity_type: 'company', beneficiary_entity_type: 'individual', payout_amount: '10',
  });
});

/* A Retrieve Card Eligibility Details `data` (docs.rapyd.net/en/
   retrieve-card-eligibility-details.html) — field names from that page. */
const eligData = (over = {}) => ({
  scheme: 'VISA', card_type: 'consumer', product_type: 'Credit', billing_currency: 'USD', issuer: 'Demo Bank', issuer_country: 'US',
  oct: {
    money_transfer_domestic: 'standard', money_transfer_international: 'standard',
    non_money_transfer_domestic: 'fast_funds', non_money_transfer_international: 'not_supported',
    online_gambling_domestic: 'standard', online_gambling_international: 'not_supported',
  },
  aft: { domestic: true, international: false },
  ...over,
});

test('wallet: eligibility body — saved card_id, else the sandbox card number; always oct', () => {
  eq(ELIGIBILITY_TRANSACTION_TYPE, 'oct');
  eq(eligibilityBody({ kind: 'token', card_id: 'card_abc' }), { card_id: 'card_abc', transaction_type: 'oct' });
  eq(eligibilityBody({ kind: 'test' }), { card_number: SANDBOX_PAYOUT_CARD.card_number, transaction_type: 'oct' });
  ok(!('card_number' in eligibilityBody({ kind: 'token', card_id: 'card_x' })), 'a token never carries a PAN');
});

test('wallet: eligibility → payout route (issuer_country → beneficiary_country, billing_currency → payout_currency)', () => {
  const dom = payoutRoute(eligData(), { currency: 'USD', country: 'US' });
  eq([dom.ok, dom.beneficiaryCountry, dom.payoutCurrency, dom.senderCurrency, dom.fx, dom.scope, dom.octField, dom.oct, dom.unknown, dom.scheme],
    [true, 'US', 'USD', 'USD', false, 'domestic', 'non_money_transfer_domestic', 'fast_funds', false, 'VISA']);
  // A GB card billed in GBP, withdrawn from a USD balance: international + FX.
  const gb = payoutRoute(eligData({ issuer_country: 'gb', billing_currency: 'gbp', oct: { non_money_transfer_international: 'standard' } }),
    { currency: 'USD', country: 'US' });
  eq([gb.ok, gb.beneficiaryCountry, gb.payoutCurrency, gb.senderCurrency, gb.fx, gb.scope], [true, 'GB', 'GBP', 'USD', true, 'international']);
  // The pack's OCT family picks the verdict: gambling winnings.
  const mt = payoutRoute(eligData({ issuer_country: 'MT', billing_currency: 'EUR' }), { currency: 'EUR', country: 'MT', octCategory: 'online_gambling' });
  eq([mt.ok, mt.octField, mt.oct, mt.fx], [true, 'online_gambling_domestic', 'standard', false]);
  // No billing currency → the balance currency, flagged.
  const nb = payoutRoute(eligData({ billing_currency: null }), { currency: 'USD', country: 'US' });
  eq([nb.ok, nb.payoutCurrency, nb.currencyFallback, nb.fx], [true, 'USD', true, false]);
  // unknown / null / absent verdicts: go ahead, flagged — Rapyd is the judge.
  for (const v of ['unknown', null, undefined]) {
    const r = payoutRoute(eligData({ oct: { non_money_transfer_domestic: v } }), { currency: 'USD', country: 'US' });
    eq([r.ok, r.unknown], [true, true], String(v));
  }
  eq(payoutRoute(eligData({ oct: null }), { currency: 'USD', country: 'US' }).unknown, true, 'no oct object');
  eq(payoutRoute(eligData(), { currency: 'USD', country: 'US', octCategory: 'bogus' }).octField, 'non_money_transfer_domestic', 'unknown family → default');
});

test('wallet: ineligible card ⇒ no payout (not_supported, or no issuer_country)', () => {
  const no = payoutRoute(eligData({ issuer_country: 'GB' }), { currency: 'USD', country: 'US' });
  eq([no.ok, no.code, no.octField, no.oct], [false, 'not_eligible', 'non_money_transfer_international', 'not_supported']);
  ok(/international withdrawals/.test(no.message), 'shopper copy names why');
  const gam = payoutRoute(eligData({ issuer_country: 'DE', billing_currency: 'EUR' }), { currency: 'EUR', country: 'MT', octCategory: 'online_gambling' });
  eq([gam.ok, gam.code], [false, 'not_eligible']);
  for (const d of [eligData({ issuer_country: null }), eligData({ issuer_country: 'USA' }), {}, null, 'x']) {
    const r = payoutRoute(d, { currency: 'USD', country: 'US' });
    eq([r.ok, r.code, 'beneficiaryCountry' in r], [false, 'no_country', false], JSON.stringify(d));
  }
});

test('wallet: payout body follows the route — FX keeps sender_currency, fixes sender_amount', () => {
  const route = payoutRoute(eligData({ issuer_country: 'GB', billing_currency: 'GBP', oct: { non_money_transfer_international: 'standard' } }),
    { currency: 'USD', country: 'US' });
  const args = {
    amount: '20.00', currency: 'USD', country: 'US', payoutCurrency: route.payoutCurrency, beneficiaryCountry: route.beneficiaryCountry,
    methodType: 'gb_visa_card', beneficiary: { card_id: 'card_abc' }, sender: { company_name: 'rapyd.coin' }, reference: 'r', description: 'd',
  };
  const fx = payoutBody(args);
  eq([fx.sender_amount, fx.sender_currency, fx.payout_currency, fx.beneficiary_country, fx.sender_country, fx.confirm_automatically],
    [20, 'USD', 'GBP', 'GB', 'US', true]);
  ok(!('payout_amount' in fx), 'FX: the balance-side amount is fixed, Rapyd converts');
  eq(Object.keys(fx)[0], 'sender_amount');
  const liveFx = payoutBody({ ...args, amount: '0.01', live: true });
  eq([liveFx.payout_amount, liveFx.payout_currency, 'sender_amount' in liveFx], [0.01, 'GBP', false], 'live: payout_amount (the backend caps it)');
  const same = payoutBody({ ...args, payoutCurrency: 'USD', beneficiaryCountry: 'US', methodType: 'us_visa_card' });
  eq([same.payout_amount, 'sender_amount' in same, same.beneficiary_country], [20, false, 'US']);
  eq(requiredFieldsQuery({ methodType: 'gb_visa_card', country: 'US', currency: 'USD', amount: '20', beneficiaryCountry: 'GB', payoutCurrency: 'GBP' }), {
    payout_method_type: 'gb_visa_card', sender_country: 'US', sender_currency: 'USD', beneficiary_country: 'GB',
    payout_currency: 'GBP', sender_entity_type: 'company', beneficiary_entity_type: 'individual', payout_amount: '20',
  });
  const req = { beneficiary_required_fields: [{ name: 'country', is_required: true }], sender_required_fields: [{ name: 'country', is_required: true }, { name: 'city', is_required: true }] };
  const p2 = fillParties(req, { dest: { kind: 'token', card_id: 'card_abc' }, identity: customers.getIdentity(), merchant: 'm', country: 'US', beneficiaryCountry: 'GB' });
  eq([p2.beneficiary.country, p2.sender.country, p2.sender.city], ['GB', 'US', 'New York'], 'beneficiary in the issuer\'s country, sender at home');
});

test('wallet: Rapyd payout status → ledger outcome', () => {
  eq(['Completed', 'Created', 'Pending', 'Confirmation', 'Hold', 'Error', 'Declined', 'Canceled', 'Expired', 'Returned', undefined].map(payoutOutcome),
    ['completed', 'pending', 'pending', 'pending', 'pending', 'failed', 'failed', 'failed', 'failed', 'failed', 'pending']);
  eq(classify({ type: 'PAYOUT_COMPLETED' }), 'success');
  eq(classify({ type: 'PAYOUT_FAILED' }), 'failure');
});

test('pickBackend: staging hosts use the staging backend, all others production', () => {
  const urls = { production: 'https://prod.example/', staging: 'https://stage.example' };
  eq(pickBackend({ hostname: 'rapyd.shop', ...urls }), 'https://prod.example');
  eq(pickBackend({ hostname: 'www.rapyd.shop', ...urls }), 'https://prod.example');
  eq(pickBackend({ hostname: 'localhost', ...urls }), 'https://prod.example');
  eq(pickBackend({ hostname: 'staging.rapyd.shop', ...urls }), 'https://stage.example');
  eq(pickBackend({ hostname: 'project-abc-rapyd-se.vercel.app', ...urls }), 'https://stage.example');
  eq(pickBackend({ hostname: 'evil-vercel.app.example.com', ...urls }), 'https://prod.example');
  // no staging configured → production; nothing configured → the default
  eq(pickBackend({ hostname: 'staging.rapyd.shop', production: 'https://prod.example' }), 'https://prod.example');
  eq(pickBackend({ hostname: 'rapyd.shop' }), 'https://rapyd-backend.vercel.app');
});


/* ── tags (js/tags/) ── */
// The pre-registry logic, verbatim — the defaults must reproduce it exactly.
const OLD_httpLabel = (st) => (st ? `HTTP ${esc(st)}` : 'NO RESPONSE');
const OLD_httpOk = (st) => st >= 200 && st < 400;
function OLD_paymentBadge(httpStatus, data) {
  const d = data?.data;
  if (d?.status === 'CLO' && d?.paid) return ['PAID · CLO', 'success'];
  if (d?.status === 'ACT') return ['ACTION · ACT', 'pending'];
  if (data?.error) return [String(data.error), 'failure'];
  if (d?.status) return [String(d.status), 'pending'];
  return [OLD_httpLabel(httpStatus), OLD_httpOk(httpStatus) ? 'success' : 'failure'];
}
const TAG_FIXTURES = [
  [200, { data: { status: 'CLO', paid: true } }], [200, { data: { status: 'CLO', paid: false } }],
  [200, { data: { status: 'ACT', paid: false, next_action: '3d_verification' } }],
  [400, { error: 'ERROR_PROCESSING_CARD' }], [402, null], [0, null], [500, {}], [undefined, undefined],
  [200, { data: { status: 'ERR' } }], [302, { data: {} }],
];

test('tags: defaults reproduce the old paymentBadge for every fixture', () => {
  setPublished(null); setDraft(null);
  for (const [st, body] of TAG_FIXTURES) eq(paymentBadge(st, body), OLD_paymentBadge(st, body), `status ${st}`);
});

test('tags: defaults reproduce the old httpLabel + ok colour', () => {
  for (const st of [200, 201, 302, 399, 400, 402, 500, 0, undefined, null]) {
    eq(httpLabel(st), OLD_httpLabel(st), `label ${st}`);
    eq(resolveTag('http.status', httpCtx(st)).tone, OLD_httpOk(st) ? 'success' : 'failure', `tone ${st}`);
  }
  // an error body turns a 200 red only where the caller passes it
  eq(resolveTag('http.status', httpCtx(200, 'ERR')).tone, 'failure');
  eq(resolveTag('http.status', httpCtx(200, 'ERR')).label, 'HTTP 200');
});

test('tags: the response card still paints HTTP 200 + PAID · CLO', () => {
  const html = paymentResponseCardHTML({ id: 'x', n: '5', httpStatus: 200, data: { data: { status: 'CLO', paid: true } } });
  ok(html.includes('<span class="wh-pill success">HTTP 200</span>'), 'http pill');
  ok(html.includes('<span class="wh-pill success">PAID · CLO</span>'), 'result pill');
  ok(html.includes('<span class="beat-state ok">PAID · CLO</span>'), 'header badge');
});

test('tags: beat.header defaults keep the old badge/kind pairs', () => {
  eq(resolveBeatBadge('request.sent'), { badge: 'signed & sent', badgeKind: 'ok' });
  eq(resolveBeatBadge('request.sending'), { badge: 'sending…', badgeKind: 'live' });
  eq(resolveBeatBadge('request.prepared'), { badge: 'prepared', badgeKind: '' });
  eq(resolveBeatBadge('sim.passed'), { badge: 'Simulated · passed', badgeKind: 'sim' });
  eq(resolveBeatBadge('response.error', { error: 'ERROR_X' }), { badge: 'ERROR_X', badgeKind: 'err' });
  eq(resolveBeatBadge('payout.eligible', { country: 'GB', currency: 'GBP' }), { badge: '→ GB · GBP', badgeKind: 'ok' });
  eq(resolveBeatBadge('no.such.key'), { badge: '', badgeKind: '' });
});

test('tags: a published override changes the label + tone; draft wins; reset restores', () => {
  setPublished({ version: 3, slots: { 'payment.result': { rules: [
    { id: 'p', when: { all: [{ field: 'data.status', op: 'eq', value: 'CLO' }, { field: 'data.paid', op: 'eq', value: true }] }, label: 'Captured · {data.status}', tone: 'info' },
  ], fallback: { slot: 'http.status' } } } });
  eq(paymentBadge(200, { data: { status: 'CLO', paid: true } }), ['Captured · CLO', 'info']);
  eq(paymentBadge(402, null), ['HTTP 402', 'failure'], 'falls through to http.status');
  setDraft({ slots: { 'payment.result': { rules: [{ id: 'd', label: 'DRAFT', tone: 'neutral' }] } } });
  eq(paymentBadge(200, { data: { status: 'CLO', paid: true } }), ['DRAFT', 'neutral']);
  setDraft(null); setPublished(null);
  eq(paymentBadge(200, { data: { status: 'CLO', paid: true } }), ['PAID · CLO', 'success']);
});

test('tags: hidden rules/entries render nothing', () => {
  setPublished({ slots: { 'beat.header': { entries: { 'request.sent': { label: 'x', tone: 'success', hidden: true } } },
    'http.status': { rules: [{ id: 'h', label: 'gone', tone: 'success', hidden: true }] } } });
  eq(resolveBeatBadge('request.sent'), { badge: '', badgeKind: '' });
  eq(pillHTML(resolveTag('http.status', httpCtx(200))), '');
  setPublished(null);
});

test('tags: templates only fill allowlisted fields and the pill escapes', () => {
  setPublished({ slots: { 'payment.result': { rules: [{ id: 'a', label: '{data.status} {secret} {constructor}', tone: 'success' }] } } });
  const t = resolveTag('payment.result', paymentCtx(200, { data: { status: '<img src=x onerror=alert(1)>' } }));
  eq(t.label, '<img src=x onerror=alert(1)> {secret} {constructor}');
  const html = pillHTML(t);
  ok(!html.includes('<img'), 'escaped');
  ok(html.includes('&lt;img'), 'as text');
  setPublished(null);
});

test('tags: unknown tones/ops/slots degrade safely', () => {
  setPublished({ slots: {
    'payment.result': { rules: [{ id: 'z', when: { all: [{ field: 'data.status', op: 'regex', value: '.*' }] }, label: 'never', tone: 'success' },
      { id: 'y', label: 'odd', tone: 'rainbow' }] },
    'not.a.slot': { rules: [] },
  } });
  eq(resolveTag('payment.result', paymentCtx(200, { data: { status: 'CLO' } })).label, 'odd');
  eq(resolveTag('payment.result', paymentCtx(200, {})).tone, 'neutral');
  eq(whClass('rainbow'), 'neutral'); eq(beatClass('rainbow'), '');
  eq(sanitizeConfig({ slots: { 'not.a.slot': {} } }).slots, {});
  eq(sanitizeConfig('junk'), null);
  setPublished(null);
});

test('tags: withConfig scopes an override without touching the app layers', () => {
  setPublished({ slots: { 'beat.header': { entries: { 'request.sent': { label: 'PUB', tone: 'success' } } } } });
  const scoped = withConfig({ slots: { 'beat.header': { entries: { 'request.sent': { label: 'DRAFT', tone: 'info' } } } } }, () => resolveBeatBadge('request.sent'));
  eq(scoped, { badge: 'DRAFT', badgeKind: 'live' });
  eq(withConfig({ slots: {} }, () => resolveBeatBadge('request.sent')), { badge: 'signed & sent', badgeKind: 'ok' }, 'scoped = defaults beneath');
  eq(resolveBeatBadge('request.sent'), { badge: 'PUB', badgeKind: 'ok' }, 'published again outside');
  setPublished(null);
});

test('tags: every default label only uses its own placeholders', () => {
  for (const [id, def] of Object.entries(TAG_SLOTS)) {
    const items = def.kind === 'rules' ? [...def.rules, ...(def.fallback?.label ? [def.fallback] : [])] : Object.values(def.entries);
    for (const it of items) {
      const allowed = def.kind === 'rules' ? def.fields : it.vars || [];
      for (const [, name] of String(it.label).matchAll(/\{([a-z0-9_.]+)\}/gi)) ok(allowed.includes(name), `${id}: {${name}}`);
    }
  }
});

test('tags: a step override wins for that step only; others follow the shared one', () => {
  setPublished({ slots: {
    'beat.header': { entries: { 'request.sent': { label: 'SHARED', tone: 'success' } } },
    'beat.header:pay': { entries: { 'request.sent': { label: 'ONLY PAY', tone: 'info' } } },
    'payment.result:pay-res': { rules: [{ id: 'x', label: 'OCF {data.status}', tone: 'success' }] },
    'http.status:fx': { rules: [{ id: 'h', label: 'FX {http.status}', tone: 'info' }] },
  } });
  eq(resolveBeatBadge('request.sent', {}, 'pay'), { badge: 'ONLY PAY', badgeKind: 'live' });
  eq(resolveBeatBadge('request.sent', {}, 'checkout'), { badge: 'SHARED', badgeKind: 'ok' });
  eq(resolveBeatBadge('request.failed', {}, 'pay'), { badge: 'failed', badgeKind: 'err' }, 'unlisted key → default');
  eq(paymentBadge(200, { data: { status: 'CLO', paid: true } }, 'pay-res'), ['OCF CLO', 'success']);
  eq(paymentBadge(200, { data: { status: 'CLO', paid: true } }, 'dw-res'), ['PAID · CLO', 'success']);
  ok(paymentResponseCardHTML({ id: 'beat-pay-res', httpStatus: 200, data: { data: { status: 'CLO', paid: true } } }).includes('OCF CLO'), 'card id → step');
  ok(!paymentResponseCardHTML({ id: 'beat-express-res', httpStatus: 200, data: { data: { status: 'CLO', paid: true } } }).includes('OCF'), 'other step untouched');
  ok(httpPillHTML(200, null, 'fx').includes('FX 200'), 'http per step');
  ok(httpPillHTML(200, null, 'pay-res').includes('HTTP 200'));
  ok(beatCardHTML({ id: 'beat-pay', method: 'POST', path: '/v1/payments', badgeKey: 'request.sent', inner: '' }).includes('ONLY PAY'), 'beatCardHTML resolves for its id');
  setPublished(null);
});

test('tags: the journey map only names real steps and keys', () => {
  for (const j of JOURNEYS) for (const c of j.calls) ok(CALLS[c], `${j.id}: unknown call ${c}`);
  for (const [id, c] of Object.entries(CALLS)) {
    for (const side of ['req', 'res']) {
      if (!c[side]) continue;
      for (const st of c[side].states) ok(TAG_SLOTS['beat.header'].entries[st.key], `${id}.${side}: unknown key ${st.key}`);
      ok(/^[a-z0-9-]{1,40}$/.test(c[side].step), `${id}.${side}: bad step id`);
    }
  }
  eq(Object.keys(STEPS).length, new Set(Object.keys(STEPS)).size);
  ok(STEPS['pay-res'] && STEPS['pay-res'].side === 'res', 'pay-res mapped');
});

test('tags: unknown step slots are dropped by sanitizeConfig', () => {
  const c = sanitizeConfig({ slots: { 'beat.header:BAD STEP': { entries: {} }, 'nope:pay': { rules: [] }, 'beat.header:pay': { entries: {} } } });
  eq(Object.keys(c.slots), ['beat.header:pay']);
});

test('no network calls were made', () => {
  const calls = window.__NETWORK_CALLS__;
  ok(Array.isArray(calls), 'tripwire not installed — open tests/index.html, not unit.js');
  eq(calls, [], 'network calls');
});

/* ── Run + report ── */
async function run() {
  const results = [];
  for (const { name, fn } of cases) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, error: String(err?.message || err) }); }
  }
  return results;
}

const results = await run();
const list = document.getElementById('results');
for (const r of results) {
  // plain text only (textContent) — failure messages echo the XSS fixtures
  const li = document.createElement('li');
  li.className = r.ok ? 'ok' : 'err';
  li.textContent = `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`;
  if (!r.ok) {
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = r.error;
    li.appendChild(why);
  }
  list.appendChild(li);
}
const failures = results.filter((r) => !r.ok).map(({ name, error }) => ({ name, error }));
const passed = results.length - failures.length;
const summary = document.getElementById('summary');
summary.className = failures.length ? 'err' : 'ok';
summary.textContent = `${passed}/${results.length} passed`;
window.__TEST_RESULTS__ = { passed, failed: failures.length, failures };
document.title = failures.length ? `FAIL ${failures.length}` : `PASS ${passed}`;
