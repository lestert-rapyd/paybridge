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
   persistence (customers.js — never a PAN/CVV, never live) and the Orders
   page's grouping (ledger.ordersFor).
   ───────────────────────────────────────────────────────────── */

import { esc } from '../js/ui.js';
import { brandLabel, currencyDecimals, validAmount, detectBrand } from '../js/sync.js';
import { classify, isTrusted, isTrustedFor } from '../js/classify.js';
import { renderJSONView, highlightPaths } from '../js/json-view.js';
import { refundedTotals, settlementOf, ordersFor } from '../js/ledger.js';
// api.js has no top-level I/O (BACKEND_URL only reads a <meta>); only the
// two pure generators are exercised — nothing here calls request().
import { newReference, newIdempotencyKey } from '../js/api.js';
// The bag rules (pure, catalog passed in) and the one path the flows read it
// through — verticals.js activeProduct(). Neither touches the DOM or network.
import {
  cartLines, addToCart, setLineQty, removeLine, clearCart, cartCount,
  resolveLines, lineTotal, cartTotal, cartProblem, cartAsProduct, MAX_QTY,
} from '../js/site/cart.js';
import { VERTICALS, activeProduct, pricedProduct, orderItems } from '../js/verticals.js';
import { state } from '../js/state.js';
// The customer store: its serialize/restore pair is pure; the live store is
// pointed at an in-memory stand-in below, so no test writes real localStorage.
import * as customers from '../js/customers.js';
import { SKINS } from '../js/skins.js';

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

/* ── skins — the three built-in Rapyd merchants ── */
test('skins: exactly the three Rapyd merchants, ids stable', () => {
  eq(Object.keys(SKINS), ['ecommerce', 'crypto', 'gaming']);
  eq(['ecommerce', 'crypto', 'gaming'].map((id) => [VERTICALS[id].merchant, VERTICALS[id].domain, VERTICALS[id].descriptor, VERTICALS[id].pack]), [
    ['rapyd.shop', 'rapyd.shop', 'RAPYD SHOP', 'home'],
    ['rapyd.coin', 'rapyd.coin', 'RAPYD COIN', 'crypto'],
    ['rapyd.spin', 'rapyd.spin', 'RAPYD SPIN', 'igaming'],
  ]);
  eq(VERTICALS.gaming.label, 'Gambling');
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
