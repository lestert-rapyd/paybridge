/* ─────────────────────────────────────────────────────────────
   Sync helpers: which form field maps to which request path,
   plus card-brand detection, amount validation and input formatting.
   ───────────────────────────────────────────────────────────── */

/** left field id → request-body path(s) it populates */
export const FIELD_MAP = {
  'f-number': ['payment_method.fields.number'],
  'f-expiry': ['payment_method.fields.expiration_month', 'payment_method.fields.expiration_year'],
  'f-cvv':    ['payment_method.fields.cvv'],
  'f-name':   ['payment_method.fields.name'],
  // "save my card" adds the whole stored-credential block
  'f-save':   ['save_payment_method', 'customer', 'payment_method.fields.recurrence_type'],
  // "Require 3-D Secure" — the same shell as f-save, and it was the one editable
  // control on the checkout with no entry here, so focusing it lit nothing while
  // its sibling lit three rows (§8 law 9).
  'f-tds':    ['payment_method_options.3d_required'],
  // Account frame — these paths live in the POST /v1/customers body, so the
  // highlight targets the customer beat card's JSON (#req-json-cus) rather than
  // the payment body's (#req-json). The form lists them in body order, one per
  // row, so focusing a field lights up the line beside it.
  'f-cus-name':    ['name', 'addresses.0.name'], // the address name tracks it
  'f-cus-email':   ['email'],
  'f-cus-dob':     ['date_of_birth'],
  'f-cus-birth':   ['birth_country'],
  'f-cus-nat':     ['nationality'],
  'f-cus-occ':     ['occupation'],
  'f-cus-line1':   ['addresses.0.line_1'],
  'f-cus-city':    ['addresses.0.city'],
  'f-cus-country': ['addresses.0.country'],
  'f-cus-zip':     ['addresses.0.zip'],
  'tile-amount':   ['amount'],
  'tile-currency': ['currency'],
  'fx-currency':   ['requested_currency'],
  'fx-side':       ['fixed_side'],
};

/** Detect scheme from PAN → Rapyd payment_method type (GB methods are enabled on the account). */
export function detectBrand(number) {
  const n = (number || '').replace(/\D/g, '');
  if (/^4/.test(n))              return { brand: 'VISA',       type: 'gb_visa_card' };
  if (/^(5[1-5]|2[2-7])/.test(n)) return { brand: 'MASTERCARD', type: 'gb_mastercard_card' };
  return { brand: '', type: 'gb_visa_card' }; // default while empty/unknown
}

/* ── Display brand ───────────────────────────────────────────
   ONE answer to "what do we call this card" — replaces the four copies
   that had drifted (customers.js brandOf, screens.js cardLabel,
   back-office.js brandLabel, toolkit.js harvestCofToken). Accepts:
     · a PAN or IIN prefix          '4111…' / '5555 4444' / '3782'
     · a Rapyd payment_method type  'us_visa_card' / 'gb_mastercard_card'
     · a brand / scheme string      'VISA' / 'Mastercard' / 'american_express'
   Wallet hints (Apple/Google Pay) win, as screens.js's receipt did.
   Unknown → `fallback` ('Card' by default; pass null to detect "unknown"). */
const IIN_RULES = [
  [/^4/, 'Visa'],
  [/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/, 'Mastercard'],
  [/^3[47]/, 'Amex'],
  [/^(6011|64[4-9]|65)/, 'Discover'],
  [/^35(2[89]|[3-8])/, 'JCB'],
  [/^(30[0-5]|309|36|3[89])/, 'Diners Club'],
  [/^62/, 'UnionPay'],
  [/^(5018|5020|5038|5893|6304|6759|676[1-3])/, 'Maestro'],
];
const NAME_RULES = [
  [/apple/, 'Apple Pay'],
  [/google/, 'Google Pay'],
  [/visa/, 'Visa'],
  [/master/, 'Mastercard'],
  [/amex|express/, 'Amex'],          // american_express / americanexpress / amex
  [/discover/, 'Discover'],
  [/jcb/, 'JCB'],
  [/diners/, 'Diners Club'],
  [/union_?pay/, 'UnionPay'],
  [/maestro/, 'Maestro'],
  [/mada/, 'Mada'],
];

export function brandLabel(input, fallback = 'Card') {
  const raw = String(input ?? '').trim();
  if (!raw) return fallback;
  // Digits only (spaces/dashes allowed) → treat as a PAN / IIN prefix.
  if (/^[\d\s-]+$/.test(raw)) {
    const n = raw.replace(/\D/g, '');
    for (const [re, label] of IIN_RULES) if (re.test(n)) return label;
    return fallback;
  }
  const t = raw.toLowerCase();
  for (const [re, label] of NAME_RULES) if (re.test(t)) return label;
  return fallback;
}

/* ── Amounts ─────────────────────────────────────────────────
   ISO 4217 minor units. Everything not listed has 2. */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const FOUR_DECIMAL = new Set(['CLF', 'UYW']);

/** Minor-unit exponent for a currency code (ISO 4217). */
export function currencyDecimals(currency) {
  const c = String(currency || '').toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  if (FOUR_DECIMAL.has(c)) return 4;
  return 2;
}

/** True iff `amount` is a finite number > 0 with no more decimals than the
    currency allows — the gate before an amount goes into a request body
    (blank, "149.999" USD or "10.5" JPY would otherwise reach Rapyd). */
export function validAmount(amount, currency) {
  if (typeof amount !== 'number' && typeof amount !== 'string') return false;
  // Strings must be plain decimals — Number() would also take '0x10' / '1e3'.
  if (typeof amount === 'string' && !/^(\d+\.?\d*|\.\d+)$/.test(amount.trim())) return false;
  const n = typeof amount === 'number' ? amount : Number(amount.trim());
  if (!Number.isFinite(n) || n <= 0) return false;
  const scaled = n * 10 ** currencyDecimals(currency);
  // tolerance absorbs float noise (0.07 * 100 = 7.000000000000001)
  return Math.abs(scaled - Math.round(scaled)) < Math.max(1e-6, Math.abs(scaled) * 1e-12);
}

/** Group digits into blocks of 4, max 19 digits. */
export function formatNumber(value) {
  const digits = (value || '').replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

/** MM / YY with auto slash. */
export function formatExpiry(value) {
  let d = (value || '').replace(/\D/g, '').slice(0, 4);
  if (d.length >= 3) return `${d.slice(0, 2)} / ${d.slice(2)}`;
  return d;
}

/** "12 / 27" → { month:'12', year:'27' } */
export function parseExpiry(value) {
  const d = (value || '').replace(/\D/g, '');
  return { month: d.slice(0, 2), year: d.slice(2, 4) };
}

/** Luhn (mod-10) check on a PAN's digits — the same gate a real gateway runs. */
export function luhn(value) {
  const s = String(value || '').replace(/\D/g, '');
  if (s.length < 12) return false;
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = +s[i];
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** MM + 2-digit YY (as produced by parseExpiry) → a real, non-past expiry. */
export function expiryValid(month, year) {
  const m = parseInt(month, 10);
  if (!(m >= 1 && m <= 12)) return false;
  if (String(year).length !== 2) return false;
  const full = 2000 + parseInt(year, 10);
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  return full > curY || (full === curY && m >= curM);
}

/** Digits + a single decimal point — for the tile's editable amount field. */
export function formatAmount(value) {
  let v = (value || '').replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
  return v;
}
