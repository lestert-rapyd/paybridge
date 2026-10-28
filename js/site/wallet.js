/* ─────────────────────────────────────────────────────────────
   The merchant site's Wallet — the RULES (pure). The page, its engine-
   room beats and the withdraw orchestration live in wallet-page.js.

   What the balance is: the MERCHANT's own ledger of what the shopper
   holds with it (store credit / a player or trading balance) — not a
   Rapyd wallet. The demo's only Rapyd wallets are the MIDs' collection
   wallets (profiles.js ewallets): every deposit lands in one, and every
   withdrawal is paid OUT of one. A shopper's balance is a merchant-side
   liability against those funds, so it's derived — never stored — from
   this tab's ledger (js/ledger.js), exactly like the back office's
   wallet tile:

     + a deposit       a payment whose item is DEPOSIT_ID, credited only
                       once the ledger marks it completed — which happens
                       only on a TRUSTED outcome (verified webhook for the
                       payment's env + id, or our own Retrieve Payment)
     − its refunds     completed back-office refunds of a deposit
     − a withdrawal    a payout entry, debited while pending (so it can't
                       be withdrawn twice) and for good once completed;
                       a failed payout gives the money back

   Deposit = a real payment through the EXISTING checkout: the deposit is
   folded into the one product every flow already charges (verticals.js
   pricedProduct → depositProduct below), so own fields / toolkit / saved
   card, the seam, FX and the live 0.01 clamp all apply unchanged.

   Withdraw = a real Rapyd CARD PAYOUT (POST /v1/payouts), to the
   shopper's saved card_*** (beneficiary.card_id) or — sandbox only — to
   Rapyd's published sandbox payout card. Field names:
     Create Payout              docs.rapyd.net/en/create-payout.html
     Get Payout Required Fields docs.rapyd.net/en/get-payout-required-fields.html
     List Payout Method Types   docs.rapyd.net/en/list-payout-method-types.html
     Card payout guide          docs.rapyd.net/en/card-payout.html
   (The `card_id` beneficiary shape is from Create Payout's "Payout to
   Card: Beneficiary Object with card_id" example; the page doesn't
   define the field in its parameter table.)

   Pure apart from reading state.walletDeposit — no DOM, no network — so
   tests/unit.js pins the arithmetic, the limits and the body builder.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { PACKS } from '../packs.js';
import { currencyDecimals, validAmount } from '../sync.js';

/** The item id a deposit payment carries (ledger entry items[0].id). */
export const DEPOSIT_ID = 'wallet-deposit';

/* Rapyd's sandbox card for card payouts (card payout guide: 4111111111111111).
   The guide's sample expiry (10/20) is in the past, so a future one is used.
   Sandbox ONLY — live refuses card_number outright (backend hasRawCard). */
export const SANDBOX_PAYOUT_CARD = Object.freeze({
  brand: 'Visa', last4: '1111',
  card_number: '4111111111111111', card_expiration_month: '12', card_expiration_year: '30',
});

/* ── Config ─────────────────────────────────────────────── */

/** The pack's wallet rule with the copy resolved, or null when the pack
    doesn't run a wallet. `packId` is the PACK (VERTICALS[x].pack). */
export function walletConfig(packId) {
  const w = PACKS[packId]?.wallet;
  if (!w) return null;
  return {
    currency: w.currency,
    country: w.country,
    chips: Array.isArray(w.chips) ? w.chips : [],
    aft: w.aft || null,
    depositLabel: w.depositLabel || 'Top up',
    withdrawLabel: 'Withdraw',
  };
}

/* ── Money in minor units ───────────────────────────────── */
const dpOf = (cur) => currencyDecimals(cur);
const toMinor = (amount, cur) => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 10 ** dpOf(cur)) : 0;
};
const fromMinor = (minor, cur) => (minor / 10 ** dpOf(cur)).toFixed(dpOf(cur));

/* ── Deposit ────────────────────────────────────────────── */

/** The deposit as ONE product — the shape every flow already charges
    (activeProduct()). One-time (unscheduled if the card is saved), never a
    subscription. With the pack's AFT rule the indicators ride along as
    is_direct_purchase:false: the money funds a balance, it buys nothing yet. */
export function depositProduct(cfg, { amount, currency } = {}) {
  const label = cfg.depositLabel;
  const note = 'Funds added — your balance is updated and ready to use. Withdrawals go back to your card.';
  const p = {
    id: DEPOSIT_ID, pill: label, billing: 'one_time', cta: label, deposit: true,
    thumb: null, cat: 'Wallet',
    name: label === 'Deposit' ? 'Wallet deposit' : 'Wallet top-up',
    desc: 'Credited to your balance',
    amount: String(amount), currency: currency || cfg.currency, country: cfg.country,
    delivery: null,
    successNote: note, fundedNote: note,
    aft: false,
  };
  if (cfg.aft) {
    p.aft = true;
    p.purpose_code = cfg.aft.purpose_code;
    p.special_condition_indicator = cfg.aft.special_condition_indicator;
    p.is_direct_purchase = false;
  }
  return p;
}

/** The pending deposit for `verticalId` ({ vertical, amount, currency }) or
    null. Set by the wallet page, read by verticals.js pricedProduct(). */
export function pendingDeposit(verticalId = state.vertical) {
  const d = state.walletDeposit;
  return d && d.vertical === verticalId ? d : null;
}
export function setPendingDeposit(verticalId, amount, currency) {
  state.walletDeposit = { vertical: verticalId, amount: String(amount), currency };
}
export function clearPendingDeposit() { state.walletDeposit = null; }

export const isDepositEntry = (e) => !!e && e.kind === 'payment'
  && Array.isArray(e.items) && e.items.some((i) => i?.id === DEPOSIT_ID);
export const isPayoutEntry = (e) => !!e && e.kind === 'payout';

/* ── Balance ────────────────────────────────────────────── */

/** This shopper's wallet movements at this merchant, in this env, newest
    first: deposits (payments of DEPOSIT_ID) and payouts. A guest has none —
    the balance belongs to an account (customerId). */
export function walletEntries(list, { customerId, vertical, env } = {}) {
  if (!customerId) return [];
  return (list || [])
    .filter((e) => e && e.vertical === vertical && e.env === env && e.customer_id === customerId
      && (isDepositEntry(e) || isPayoutEntry(e)))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/** { available, incoming, outgoing } as currency strings ("40.00"):
    available = completed deposits − their completed refunds − every payout
    that hasn't failed; incoming = deposits still awaiting a trusted outcome;
    outgoing = payouts still in flight (already out of `available`). Only
    movements in `currency` count — the balance is held in one currency. */
export function walletBalance(list, ctx = {}, currency) {
  let avail = 0, incoming = 0, outgoing = 0;
  for (const e of walletEntries(list, ctx)) {
    if (e.currency !== currency) continue;
    const amt = toMinor(e.amount, currency);
    if (isDepositEntry(e)) {
      if (e.status === 'completed') {
        avail += amt;
        for (const r of e.refunds || []) {
          if (r.status === 'completed' && (r.currency || currency) === currency) avail -= toMinor(r.amount, currency);
        }
      } else if (e.status !== 'failed') incoming += amt;
    } else if (e.status !== 'failed') {
      avail -= amt;
      if (e.status !== 'completed') outgoing += amt;
    }
  }
  return {
    available: fromMinor(Math.max(0, avail), currency),
    incoming: fromMinor(incoming, currency),
    outgoing: fromMinor(outgoing, currency),
    currency,
  };
}

/* ── Limits ─────────────────────────────────────────────── */

/** Why this deposit can't go ahead, or null. Shopper copy. */
export function depositProblem(amount, currency) {
  return validAmount(amount, currency) ? null : { code: 'amount', message: 'Enter an amount to add.' };
}

/** Why this withdrawal can't go ahead, or null. The amount must pass
    validAmount (no more decimals than the currency has) and may never
    exceed the AVAILABLE balance (in-flight payouts are already out of it). */
export function withdrawProblem(amount, available, currency) {
  if (toMinor(available, currency) <= 0) return { code: 'empty', message: 'There’s nothing to withdraw yet.' };
  if (!validAmount(amount, currency)) return { code: 'amount', message: 'Enter an amount to withdraw.' };
  if (toMinor(amount, currency) > toMinor(available, currency)) {
    return { code: 'balance', message: `You can withdraw up to ${fromMinor(toMinor(available, currency), currency)} ${currency}.` };
  }
  return null;
}

/** Withdraw amount chips: 10 and 20 when the balance covers them, plus
    "All" (the whole available balance). [{ label, amount }]. */
export function withdrawChips(available, currency) {
  const max = toMinor(available, currency);
  if (max <= 0) return [];
  const out = [10, 20].map((n) => toMinor(n, currency)).filter((m) => m < max)
    .map((m) => ({ label: fromMinor(m, currency).replace(/\.0+$/, ''), amount: fromMinor(m, currency) }));
  out.push({ label: 'All', amount: fromMinor(max, currency) });
  return out;
}

/* ── Payout method type ─────────────────────────────────── */

/** "Visa" → "visa", "American Express" → "americanexpress". */
export const brandKey = (brand) => String(brand || 'visa').toLowerCase().replace(/[^a-z]/g, '') || 'visa';

/** The card payout type to use from GET /v1/payout_method_types' `data`:
    the exact <cc>_<brand>_card, else any card type naming the brand, else
    the first card type for the country; null when the MID offers none.
    status 0 = "not available" (List Payout Method Types). */
export function pickPayoutMethodType(list, { country, brand } = {}) {
  const cc = String(country || '').toLowerCase();
  const b = brandKey(brand);
  const cards = (Array.isArray(list) ? list : []).filter((t) => t
    && typeof t.payout_method_type === 'string' && t.payout_method_type.startsWith(`${cc}_`)
    && (t.category == null || t.category === 'card') && t.status !== 0);
  const exact = cards.find((t) => t.payout_method_type === `${cc}_${b}_card`);
  return (exact || cards.find((t) => t.payout_method_type.includes(b)) || cards[0])?.payout_method_type || null;
}

/** When the method list couldn't be read: the documented naming pattern
    (us_visa_card, us_mastercard_card — Create Payout / card payout guide). */
export const fallbackPayoutMethodType = (country, brand) => `${String(country || 'us').toLowerCase()}_${brandKey(brand)}_card`;

/* ── Beneficiary / sender ───────────────────────────────── */

/* Demo sender (the merchant, a company) addresses per country — dummy values. */
const MERCHANT_ADDRESS = {
  US: { address: '123 First Avenue', city: 'New York', state: 'NY', postcode: '10001' },
  MT: { address: '1 Triq il-Kbira', city: 'Valletta', state: '', postcode: 'VLT 1000' },
  GB: { address: '1 Demo Street', city: 'London', state: '', postcode: 'EC1A 1BB' },
};
const CARD_FIELDS = ['card_number', 'card_expiration_month', 'card_expiration_year', 'card_cvv'];

const splitName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || 'Jordan', last: parts.slice(1).join(' ') || parts[0] || 'Taylor' };
};

/**
 * The payout's beneficiary (the shopper, an individual) and sender (the
 * merchant, a company), filled from Get Payout Required Fields. Always
 * carries the documented minimum (beneficiary first/last name + the card;
 * sender company_name — the card_id example), then every field Rapyd lists
 * that we hold a demo value for. `missing` names required fields we had no
 * value for — the call still goes out (Rapyd is the judge, its error shows in
 * the engine room); the SE sees the gap on the card.
 * @param required  data from the required-fields call, or null
 * @param ctx       { dest: { kind: 'token', card_id } | { kind: 'test' },
 *                    identity: { name, email, date_of_birth, nationality, address },
 *                    merchant: string, country }
 */
export function fillParties(required, { dest, identity = {}, merchant = '', country } = {}) {
  const { first, last } = splitName(identity.name);
  const addr = identity.address || {};
  const card = dest?.kind === 'token'
    ? { card_id: dest.card_id }
    : { card_number: SANDBOX_PAYOUT_CARD.card_number,
        card_expiration_month: SANDBOX_PAYOUT_CARD.card_expiration_month,
        card_expiration_year: SANDBOX_PAYOUT_CARD.card_expiration_year };
  const benValues = {
    first_name: first, last_name: last, name: `${first} ${last}`.trim(),
    email: identity.email, address: addr.line_1, city: addr.city, postcode: addr.zip,
    state: addr.state, country, date_of_birth: identity.date_of_birth, nationality: identity.nationality,
    ...card,
  };
  const ma = MERCHANT_ADDRESS[country] || MERCHANT_ADDRESS.US;
  const senderValues = {
    company_name: merchant, name: merchant, country, ...ma,
    date_of_incorporation: '01/01/2015',
  };

  const beneficiary = { ...card, first_name: first, last_name: last };
  const sender = { company_name: merchant };
  const missing = { beneficiary: [], sender: [] };
  const apply = (fields, values, target, gaps) => {
    for (const f of Array.isArray(fields) ? fields : []) {
      const name = typeof f?.name === 'string' ? f.name : null;
      if (!name || name in target) continue;
      // A token beneficiary's card is card_id — the raw card fields Rapyd
      // lists for the method type are covered by it.
      if (dest?.kind === 'token' && CARD_FIELDS.includes(name)) continue;
      const v = values[name];
      if (v !== undefined && v !== null && v !== '') target[name] = v;
      else if (f.is_required) gaps.push(name);
    }
  };
  apply(required?.beneficiary_required_fields, benValues, beneficiary, missing.beneficiary);
  apply(required?.sender_required_fields, senderValues, sender, missing.sender);
  return { beneficiary, sender, missing };
}

/* ── Create Payout body ─────────────────────────────────── */

/**
 * POST /v1/payouts for a domestic card payout from the profile's wallet:
 * the shopper (individual) is paid in the balance currency; the merchant
 * (company) sends the same currency, so there is no FX leg and
 * confirm_automatically is a no-op made explicit (it only matters for FX —
 * Create Payout). `ewallet` is the sandbox profile's wallet; omitted in live,
 * where the backend injects the live wallet.
 */
export function payoutBody({ amount, currency, country, methodType, beneficiary, sender, reference, description, descriptor, ewallet }) {
  const body = {};
  if (ewallet) body.ewallet = ewallet;
  Object.assign(body, {
    payout_amount: validAmount(amount, currency) ? Number(amount) : amount,
    payout_currency: currency,
    sender_currency: currency,
    sender_country: country,
    beneficiary_country: country,
    sender_entity_type: 'company',
    beneficiary_entity_type: 'individual',
    payout_method_type: methodType,
    beneficiary,
    sender,
    merchant_reference_id: reference,
    description,
  });
  if (descriptor) body.statement_descriptor = String(descriptor).slice(0, 35); // Create Payout: ≤ 35
  body.confirm_automatically = true;
  return body;
}

/** The required-fields query for this payout (all seven are sent — every
    documented example carries them; sender_country is confirmed required). */
export function requiredFieldsQuery({ methodType, country, currency, amount }) {
  return {
    payout_method_type: methodType,
    sender_country: country, sender_currency: currency,
    beneficiary_country: country, payout_currency: currency,
    sender_entity_type: 'company', beneficiary_entity_type: 'individual',
    payout_amount: amount,
  };
}

/* ── Payout status ──────────────────────────────────────── */

/** Rapyd payout status → the ledger's 'completed' | 'failed' | 'pending'.
    Completed = the beneficiary received the funds; Error / Declined /
    Canceled / Expired / Returned are final failures; Created / Pending /
    Confirmation / Hold are still in flight (Create Payout status list). */
export function payoutOutcome(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'completed';
  if (['error', 'declined', 'canceled', 'cancelled', 'expired', 'returned'].includes(s)) return 'failed';
  return 'pending';
}
