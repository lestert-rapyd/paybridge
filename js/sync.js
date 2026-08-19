/* ─────────────────────────────────────────────────────────────
   Sync helpers: which form field maps to which request path,
   plus card-brand detection and input formatting.
   ───────────────────────────────────────────────────────────── */

/** left field id → request-body path(s) it populates */
export const FIELD_MAP = {
  'f-number': ['payment_method.fields.number'],
  'f-expiry': ['payment_method.fields.expiration_month', 'payment_method.fields.expiration_year'],
  'f-cvv':    ['payment_method.fields.cvv'],
  'f-name':   ['payment_method.fields.name'],
  // "save my card" adds the whole stored-credential block
  'f-save':   ['save_payment_method', 'customer', 'payment_method.fields.recurrence_type'],
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
