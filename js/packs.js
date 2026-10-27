/* ─────────────────────────────────────────────────────────────
   Industry packs — WHAT the merchant sells and how the journey reads.
   A pack is industry content, independent of whose brand is on it:
   the catalog, the shopper-facing verbs, the success copy, and the
   journey rules that real merchants in that industry follow (e.g.
   crypto runs KYC at signup). The merchant's identity — name, domain,
   colours — lives in js/skins.js; js/verticals.js composes the two.

   Each pack carries a small PRODUCT CATALOG: one-time products and
   subscription products. The product's billing nature — not a
   mechanical back-office switch — is what drives the stored-credential
   intent (`recurrence_type`): one-time + save → unscheduled (card-on-
   file, customer-present reuse); subscription → recurring (MIT charges
   run from the back office). Crypto products additionally carry the
   AFT indicators (aft / purpose_code / special_condition_indicator).

   To add an industry: copy a pack, give it its own catalog and copy,
   and point a skin at it (skins.js `pack`).
   ───────────────────────────────────────────────────────────── */

export const PACKS = {
  retail: {
    id: 'retail',
    label: 'Retail',
    headline: 'Secure checkout',
    cta: 'Pay',
    successNote: 'Order confirmed — we’re packing it now. Dispatch and tracking details will land in your inbox shortly.',
    kycAtSignup: false,
    products: [
      {
        id: 'chair', pill: 'Lounge Chair', billing: 'one_time', glyph: '🪑',
        thumb: ['#5600ef', '#a855f7'],
        name: 'Oak Lounge Chair',
        desc: 'Walnut finish · Qty 1',
        amount: '149.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: 'Free',
        successNote: 'Order confirmed — we’re packing it now. Dispatch and tracking details will land in your inbox shortly.',
      },
      {
        id: 'coffee-sub', pill: 'Coffee Club', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '☕',
        thumb: ['#7a3f12', '#c9803a'],
        name: 'Coffee Bean Club',
        desc: '250g single origin · monthly',
        amount: '18.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: 'Free',
        successNote: 'Subscription active — your first bag ships today. Future bags bill to this card automatically each month.',
      },
    ],
  },
  crypto: {
    id: 'crypto',
    label: 'Crypto',
    headline: 'Buy crypto instantly',
    cta: 'Buy',
    successNote: 'Top-up confirmed — ≈ 0.00075 BTC is on its way to your wallet address. Network confirmations usually take a few minutes.',
    kycAtSignup: true,
    products: [
      {
        id: 'btc', pill: 'Buy BTC', billing: 'one_time', glyph: '₿',
        aft: true, purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency',
        thumb: ['#00b36b', '#00ff89'],
        name: 'Bitcoin',
        desc: 'You receive ≈ 0.00075 BTC',
        amount: '50.00', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'Purchase confirmed — ≈ 0.00075 BTC is on its way to your wallet address. Network confirmations usually take a few minutes.',
        // is_direct_purchase: false → the AFT funds the fiat balance instead
        fundedNote: 'Funds added — your fiat balance is topped up and held. Buy BTC whenever you’re ready, at your price.',
      },
      {
        id: 'dca', pill: 'DCA Plan', billing: 'subscription', interval: 'monthly', cta: 'Start DCA', glyph: '🔁',
        aft: true, purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency',
        thumb: ['#0e7490', '#22d3ee'],
        name: 'Bitcoin DCA Plan',
        desc: 'Auto-buy BTC · monthly',
        amount: '25.00', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'DCA plan active — your first buy just executed. Future buys run automatically every month, no action needed.',
      },
      {
        id: 'coinplus', pill: 'Coin+', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '⭐',
        thumb: ['#4338ca', '#818cf8'],
        name: 'Coin+ Platform Fee',
        desc: 'Pro trading tier · monthly',
        amount: '9.99', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'Coin+ active — pro features unlocked. Your card bills automatically each month.',
      },
    ],
  },
  igaming: {
    id: 'igaming',
    label: 'iGaming',
    headline: 'Add funds to your wallet',
    cta: 'Deposit',
    successNote: 'Funds added — your new balance is available to play right away. Withdrawals return to this card.',
    kycAtSignup: false,
    products: [
      {
        id: 'spins', pill: '50 Spins', billing: 'one_time', cta: 'Buy', glyph: '🎲',
        thumb: ['#c4005f', '#ff007a'],
        name: '50 Spins Pack',
        desc: 'Credited instantly',
        amount: '50.00', currency: 'EUR', symbol: '€', country: 'MT',
        delivery: null,
        successNote: 'Spins credited — good luck! Winnings withdraw back to this card.',
      },
      {
        id: 'adfree', pill: 'Ad-free', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '✨',
        thumb: ['#7f1d1d', '#ef4444'],
        name: 'Ad-free Play',
        desc: 'No interruptions · monthly',
        amount: '12.00', currency: 'EUR', symbol: '€', country: 'MT',
        delivery: null,
        successNote: 'Ad-free active — enjoy uninterrupted play. Bills to this card automatically each month.',
      },
    ],
  },
};
