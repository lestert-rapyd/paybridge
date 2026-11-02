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
   run from the back office). Crypto and forex products additionally
   carry the AFT indicators (aft / purpose_code / special_condition_
   indicator) — each only where the pack sets it; an unset indicator is
   left out of the request, never sent empty.

   `interval` (subscriptions): 'monthly' or 'annual' — the shopper-facing
   period wording ("/mo", "/yr") follows it (site/cart.js billingPeriod).
   The back office runs each MIT charge on demand either way.

   To add an industry: copy a pack, give it its own catalog and copy,
   and point a skin at it (skins.js `pack`).

   `wallet` (journey rule) — the merchant site's Wallet page (js/site/
   wallet.js): a balance the shopper deposits into (a real payment through
   the checkout) and withdraws from (a real Rapyd card payout). Gambling,
   crypto and forex merchants run exactly this deposit / withdraw journey,
   so those packs opt in; `null` keeps the page and its nav item off. Fields:
     currency, country  what the balance is held in; the payout's sender
                        currency and sender country (the beneficiary's
                        country and payout currency come from the card's
                        eligibility check — issuer country, billing currency)
     octCategory        which eligibility verdict judges a withdrawal
                        (data.oct.<family>_domestic|_international):
                        'online_gambling' for winnings, else (default)
                        'non_money_transfer'
     chips              suggested deposit amounts
     depositLabel       the shopper's verb ('Deposit'; 'Top up' when absent)
     aft                the deposit carries the pack's AFT indicators — only
                        where the pack's catalog already applies AFT (crypto,
                        forex), and then as is_direct_purchase:false (it
                        funds a balance)

   Optional product fields the merchant site (js/site/) reads when present:
   `cat` (shop-card category), `tagline` + `about` (product page copy),
   `specs` ([label, value] rows), and on an AFT one-off `fundedNote` +
   `dpLabels` (the checkout's is_direct_purchase fork: [now, later]).
   `thumb: null` renders the neutral "product shot" placeholder (every built-in product uses it — product
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
    wallet: {
      currency: 'USD', country: 'US', chips: ['25.00', '50.00', '100.00', '250.00'], depositLabel: 'Deposit',
      aft: { purpose_code: 'crypto_currency', special_condition_indicator: 'cryptocurrency' },
    },
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
        dpLabels: ['Buy BTC now', 'Add funds, buy later'],
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
    // No AFT: the igaming catalog never carried it (gambling deposits are
    // ordinary purchases under the merchant's gaming MCC).
    wallet: {
      currency: 'EUR', country: 'MT', chips: ['10.00', '20.00', '50.00', '100.00'], depositLabel: 'Deposit', aft: null,
      octCategory: 'online_gambling',
    },
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
  // Forex / CFD trading — a broker's trading account. Funding it is the
  // textbook AFT case: Rapyd's AFT guide lists "foreign exchange platforms"
  // and CFD / derivatives platforms as the merchants it's for, with
  // purpose_code `high_risk_securities` ("securities, options, derivatives
  // and foreign exchange") — docs.rapyd.net/en/creating-an-aft-payment.html.
  // That page documents only aft / is_direct_purchase / purpose_code under
  // payment_method_options, so no special_condition_indicator is set here.
  // The broker MCC (6211, security brokers/dealers) is the MID's acquiring
  // setup, not a request field — nothing to send. Regulated brokers verify
  // identity before an account trades, hence KYC at signup.
  forex: {
    id: 'forex',
    label: 'Forex trading',
    headline: 'Fund your trading account',
    cta: 'Fund',
    successNote: 'Funds received — your trading balance is updated and ready to trade. Withdrawals return to this card.',
    kycAtSignup: true,
    wallet: {
      currency: 'GBP', country: 'GB', chips: ['100.00', '250.00', '500.00', '1000.00'], depositLabel: 'Deposit',
      aft: { purpose_code: 'high_risk_securities' },
    },
    products: [
      {
        id: 'copy', pill: 'Copy trading', billing: 'one_time', cta: 'Invest', glyph: '📈',
        aft: true, purpose_code: 'high_risk_securities',
        thumb: null, cat: 'Copy trading',
        name: 'Copy-Trading Allocation',
        desc: 'Mirror the FX Majors strategy',
        tagline: 'Follow a strategy, not a screen',
        about: 'Allocate to the FX Majors strategy and every trade it places is mirrored in your account, in proportion. Stop copying at any time.',
        specs: [['Markets', 'EUR/USD, GBP/USD, USD/JPY'], ['Leverage', 'Up to 1:30'], ['Minimum', '£250']],
        amount: '250.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: null,
        successNote: 'Allocation live — your £250 is copying the FX Majors strategy from its next trade.',
        // is_direct_purchase: false → the AFT funds the trading balance instead
        fundedNote: 'Funds added — your trading balance is topped up. Start copying the strategy whenever you’re ready.',
        dpLabels: ['Start copying now', 'Add funds, copy later'],
      },
      {
        id: 'signals', pill: 'Pro Signals', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '📡',
        thumb: null, cat: 'Signals',
        name: 'Pro Signals',
        desc: 'Daily trade ideas · monthly',
        tagline: 'Entries, exits and the reasoning',
        about: 'Analyst trade ideas across the FX majors every trading day, with entry, stop and target levels and a short rationale.',
        specs: [['Coverage', '28 currency pairs'], ['Delivery', 'In-app + email'], ['Billing', 'Monthly']],
        amount: '29.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: null,
        successNote: 'Pro Signals active — today’s ideas are on your dashboard. Your card bills automatically each month.',
      },
      {
        id: 'datafeed', pill: 'Level 2 Data', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '📊',
        thumb: null, cat: 'Market data',
        name: 'Level 2 Data Feed',
        desc: 'Real-time depth of market · monthly',
        tagline: 'See the order book',
        about: 'Real-time depth-of-market and tick data on every instrument you trade, streamed into the platform.',
        specs: [['Latency', 'Real-time'], ['Instruments', 'FX, indices, metals'], ['Billing', 'Monthly']],
        amount: '15.00', currency: 'GBP', symbol: '£', country: 'GB',
        delivery: null,
        successNote: 'Level 2 data on — depth of market is streaming now. Bills to this card automatically each month.',
      },
    ],
  },
  // Digital content — a streaming service: plans (monthly / annual) and
  // one-off titles to rent or buy. Nothing ships (delivery null), no balance
  // to hold (wallet null), no identity check to watch a film.
  content: {
    id: 'content',
    label: 'Digital content',
    headline: 'Start watching',
    cta: 'Pay',
    successNote: 'You’re all set — it’s in your library and ready to watch on any device.',
    kycAtSignup: false,
    wallet: null,
    products: [
      {
        id: 'rent', pill: 'Rent', billing: 'one_time', cta: 'Rent', glyph: '🎬',
        thumb: null, cat: 'Rent',
        name: 'Harbour Lights — Rent', desc: '48-hour rental · HD',
        tagline: 'Watch tonight',
        about: 'A lighthouse keeper, a storm and a ship that shouldn’t be there. Start within 30 days; once you press play you have 48 hours to finish.',
        specs: [['Quality', 'HD'], ['Runtime', '1 h 54 min'], ['Window', '48 hours']],
        amount: '5.98', currency: 'SGD', symbol: 'S$', country: 'SG',
        delivery: null,
        successNote: 'Rental ready — Harbour Lights is in your library. You have 48 hours once you press play.',
      },
      {
        id: 'buy', pill: 'Buy', billing: 'one_time', cta: 'Buy', glyph: '🎞️',
        thumb: null, cat: 'Buy',
        name: 'Harbour Lights — Buy', desc: 'Yours to keep · 4K',
        tagline: 'Keep it forever',
        about: 'Own the film in 4K with HDR and the director’s commentary. Download it to watch offline on up to five devices.',
        specs: [['Quality', '4K HDR'], ['Extras', 'Commentary'], ['Devices', 'Up to 5']],
        amount: '19.98', currency: 'SGD', symbol: 'S$', country: 'SG',
        delivery: null,
        successNote: 'It’s yours — Harbour Lights is in your library to stream or download, for good.',
      },
      {
        id: 'season', pill: 'Season Pass', billing: 'one_time', cta: 'Buy', glyph: '📺',
        thumb: null, cat: 'Season pass',
        name: 'Tidewater — Season 2 Pass', desc: 'All 8 episodes · as they air',
        tagline: 'Every episode, as it lands',
        about: 'Every episode of Tidewater season 2, added to your library the moment it airs. No plan needed.',
        specs: [['Episodes', '8'], ['Quality', '4K HDR'], ['Released', 'Weekly']],
        amount: '24.98', currency: 'SGD', symbol: 'S$', country: 'SG',
        delivery: null,
        successNote: 'Season pass active — the episodes out so far are in your library; new ones land as they air.',
      },
      {
        id: 'monthly', pill: 'Standard', billing: 'subscription', interval: 'monthly', cta: 'Subscribe', glyph: '▶️',
        thumb: null, cat: 'Plans',
        name: 'Stream Standard', desc: 'HD · 2 screens · monthly',
        tagline: 'Everything in the catalogue',
        about: 'The whole catalogue in HD on two screens at once. Cancel any time.',
        specs: [['Quality', 'HD'], ['Screens', '2'], ['Billing', 'Monthly']],
        amount: '13.98', currency: 'SGD', symbol: 'S$', country: 'SG',
        delivery: null,
        successNote: 'Welcome to Stream Standard — start watching now. Your card bills automatically each month until you cancel.',
      },
      {
        id: 'annual', pill: 'Premium', billing: 'subscription', interval: 'annual', cta: 'Subscribe', glyph: '⭐',
        thumb: null, cat: 'Plans',
        name: 'Stream Premium', desc: '4K · 4 screens · annual',
        tagline: 'Two months on us',
        about: 'The whole catalogue in 4K HDR on four screens, with downloads — billed once a year for the price of ten months.',
        specs: [['Quality', '4K HDR'], ['Screens', '4'], ['Billing', 'Annual']],
        amount: '199.90', currency: 'SGD', symbol: 'S$', country: 'SG',
        delivery: null,
        successNote: 'Welcome to Stream Premium — start watching in 4K now. Your card bills automatically once a year until you cancel.',
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
    // Off. The rapyd.shop prototype's "store credit" was refund credit a
    // retailer spends at checkout — not a balance a shopper deposits into and
    // cashes out to a card, which is a gambling / forex / crypto journey (and
    // a retailer paying out to cards would be an unusual Rapyd setup to demo).
    // Opting in is one line: { currency: 'GBP', country: 'GB', chips: […] }
    // — the copy then reads "Top up".
    wallet: null,
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
