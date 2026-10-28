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

   Optional product fields the merchant site (js/site/) reads when present:
   `cat` (shop-card category), `tagline` + `about` (product page copy),
   `specs` ([label, value] rows). `thumb: null` renders the neutral
   "product shot" placeholder (every built-in product uses it — product
   imagery is deliberately a placeholder); `thumb: [c1, c2]` + `glyph`
   would paint a gradient tile instead, for a customer pack that wants one.
   ───────────────────────────────────────────────────────────── */

export const PACKS = {
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
        thumb: null, cat: 'Buy crypto',
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
        thumb: null, cat: 'Recurring buy',
        name: 'Bitcoin DCA Plan',
        desc: 'Auto-buy BTC · monthly',
        amount: '25.00', currency: 'USD', symbol: '$', country: 'US',
        delivery: null,
        successNote: 'DCA plan active — your first buy just executed. Future buys run automatically every month, no action needed.',
      },
      {
        id: 'coinplus', pill: 'Coin+', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '⭐',
        thumb: null, cat: 'Membership',
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
    label: 'Gambling',
    headline: 'Add funds to your wallet',
    cta: 'Deposit',
    successNote: 'Funds added — your new balance is available to play right away. Withdrawals return to this card.',
    kycAtSignup: false,
    products: [
      {
        id: 'spins', pill: '50 Spins', billing: 'one_time', cta: 'Buy', glyph: '🎲',
        thumb: null, cat: 'Casino',
        name: '50 Spins Pack',
        desc: 'Credited instantly',
        amount: '50.00', currency: 'EUR', symbol: '€', country: 'MT',
        delivery: null,
        successNote: 'Spins credited — good luck! Winnings withdraw back to this card.',
      },
      {
        id: 'adfree', pill: 'Ad-free', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '✨',
        thumb: null, cat: 'Membership',
        name: 'Ad-free Play',
        desc: 'No interruptions · monthly',
        amount: '12.00', currency: 'EUR', symbol: '€', country: 'MT',
        delivery: null,
        successNote: 'Ad-free active — enjoy uninterrupted play. Bills to this card automatically each month.',
      },
    ],
  },
  // Home & living — the rapyd.shop prototype's catalog (four furniture
  // one-offs, three monthly refills). Neutral placeholders, no glyph tiles.
  home: {
    id: 'home',
    label: 'Home & living',
    headline: 'Secure checkout',
    cta: 'Pay',
    successNote: 'We’ve got your order and are packing it now! Dispatch and tracking details will land in your inbox shortly.',
    kycAtSignup: false,
    products: [
      {
        id: 'oak', pill: 'Lounge Chair', billing: 'one_time', thumb: null, cat: 'Furniture',
        name: 'Oak Lounge Chair', desc: 'Walnut finish',
        tagline: 'Timeless comfort, naturally refined',
        about: 'Crafted from solid oak, this lounge chair brings warmth, character and effortless elegance to any space. Designed for slow mornings, quiet evenings and everything in between.',
        specs: [['Colour', 'Natural Oak'], ['Country of origin', 'Denmark'], ['SKU', 'OLC-240-NAT']],
        amount: '149.00', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
      },
      {
        id: 'vanity', pill: 'Vanity', billing: 'one_time', thumb: null, cat: 'Furniture',
        name: 'Teak Vanity Cupboard', desc: 'Natural finish',
        tagline: 'Storage with a softer edge',
        about: 'Reclaimed teak with brass pulls and soft-close doors. Water-resistant oil finish built for bathrooms that actually get used.',
        specs: [['Colour', 'Natural Teak'], ['Country of origin', 'Indonesia'], ['SKU', 'TVC-110-NAT']],
        amount: '449.00', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
      },
      {
        id: 'table', pill: 'Dining Table', billing: 'one_time', thumb: null, cat: 'Furniture',
        name: 'Teak Dining Table', desc: 'Oiled teak · seats 6',
        tagline: 'Built for long dinners',
        about: 'A solid teak top on tapered legs, finished by hand. Seats six comfortably and only gets better with age.',
        specs: [['Colour', 'Oiled Teak'], ['Country of origin', 'Indonesia'], ['SKU', 'TDT-600-OIL']],
        amount: '1449.00', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
      },
      {
        id: 'riser', pill: 'Monitor Riser', billing: 'one_time', thumb: null, cat: 'Furniture',
        name: 'Walnut Monitor Riser', desc: 'Walnut',
        tagline: 'Desk, decluttered',
        about: 'Lifts your screen to eye level and hides the keyboard underneath. Solid walnut, felt feet.',
        specs: [['Colour', 'Walnut'], ['Country of origin', 'Portugal'], ['SKU', 'WMR-060-WAL']],
        amount: '119.00', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
      },
      {
        id: 'incense', pill: 'Incense', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', thumb: null, cat: 'Scents',
        name: 'Aromatique Incense', desc: 'Cedar, Amber, Fig',
        tagline: 'A new ritual every month',
        about: 'Thirty hand-rolled sticks across three seasonal scents, delivered monthly.',
        specs: [['Contents', '3 scents / month'], ['Country of origin', 'Japan'], ['SKU', 'AIN-SUB-M']],
        amount: '12.99', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
        successNote: 'You’re subscribed. Your first delivery ships this week and we’ll charge your saved card each month until you cancel.',
      },
      {
        id: 'spray', pill: 'Room Spray', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', thumb: null, cat: 'Scents',
        name: 'Room Spray 3-Pack', desc: 'Citrus, Sandalwood, Birch',
        tagline: 'Fresh rooms, on repeat',
        about: 'Three 100 ml room sprays, refilled every month so you never run out.',
        specs: [['Contents', '3 × 100 ml'], ['Country of origin', 'United Kingdom'], ['SKU', 'RSP-SUB-M']],
        amount: '12.99', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
        successNote: 'You’re subscribed. Your first delivery ships this week and we’ll charge your saved card each month until you cancel.',
      },
      {
        id: 'leather', pill: 'Moisturiser', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', thumb: null, cat: 'Cleaning',
        name: 'Leather Moisturiser', desc: '150 ml refill',
        tagline: 'Keep leather supple',
        about: 'A beeswax-based conditioner refill for sofas, bags and boots. Arrives monthly.',
        specs: [['Contents', '150 ml'], ['Country of origin', 'Italy'], ['SKU', 'LMO-SUB-M']],
        amount: '3.99', currency: 'GBP', symbol: '£', country: 'GB', delivery: 'Free',
        successNote: 'You’re subscribed. Your first delivery ships this week and we’ll charge your saved card each month until you cancel.',
      },
    ],
  },
};
