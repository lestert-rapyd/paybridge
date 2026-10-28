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
   api.js reference/idempotency generators and ledger.refundedTotals.
   ───────────────────────────────────────────────────────────── */

import { esc } from '../js/ui.js';
import { brandLabel, currencyDecimals, validAmount, detectBrand } from '../js/sync.js';
import { classify, isTrusted, isTrustedFor } from '../js/classify.js';
import { renderJSONView, highlightPaths } from '../js/json-view.js';
import { refundedTotals, settlementOf } from '../js/ledger.js';
// api.js has no top-level I/O (BACKEND_URL only reads a <meta>); only the
// two pure generators are exercised — nothing here calls request().
import { newReference, newIdempotencyKey } from '../js/api.js';

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
