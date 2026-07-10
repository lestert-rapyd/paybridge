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
};

/** human label shown under a focused field */
export const FIELD_LABEL = {
  'f-number': 'payment_method.fields.number',
  'f-expiry': 'payment_method.fields.expiration_month / _year',
  'f-cvv':    'payment_method.fields.cvv',
  'f-name':   'payment_method.fields.name',
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
