/* ─────────────────────────────────────────────────────────────
   Vertical definitions.
   Brand stays "PayBridge" — client-side merchants are PayBridge
   sub-brands. Only context, product framing, colours and copy change.
   ───────────────────────────────────────────────────────────── */

export const VERTICALS = {
  ecommerce: {
    id: 'ecommerce',
    label: 'Retail',
    dot: '#5600ef',
    merchant: 'PayBridge Shop',
    descriptor: 'PayBridge - Shop',
    domain: 'shop.paybridge.com',
    headline: 'Secure checkout',
    cta: 'Pay',
    successNote: 'Order confirmed — we’re packing it now. Dispatch and tracking details will land in your inbox shortly.',
    product: {
      thumb: ['#5600ef', '#a855f7'],
      name: 'Oak Lounge Chair',
      desc: 'Walnut finish · Qty 1',
      amount: '149.00',
      currency: 'GBP',
      symbol: '£',
      country: 'GB',
      delivery: 'Free',
    },
  },

  crypto: {
    id: 'crypto',
    label: 'Crypto',
    dot: '#00ff89',
    merchant: 'PayBridge Coin',
    descriptor: 'PayBridge - Coin',
    domain: 'coin.paybridge.io',
    headline: 'Buy crypto instantly',
    cta: 'Buy',
    successNote: 'Top-up confirmed — ≈ 0.00075 BTC is on its way to your wallet address. Network confirmations usually take a few minutes.',
    product: {
      thumb: ['#00b36b', '#00ff89'],
      name: 'Bitcoin',
      desc: 'You receive ≈ 0.00075 BTC',
      amount: '50.00',
      currency: 'USD',
      symbol: '$',
      country: 'US',
      delivery: null,
    },
  },

  gaming: {
    id: 'gaming',
    label: 'iGaming',
    dot: '#ff007a',
    merchant: 'PayBridge Play',
    descriptor: 'PayBridge - Play',
    domain: 'play.paybridge.bet',
    headline: 'Add funds to your wallet',
    cta: 'Deposit',
    successNote: 'Funds added — your new balance is available to play right away. Withdrawals return to this card.',
    product: {
      thumb: ['#c4005f', '#ff007a'],
      name: 'Account Deposit',
      desc: 'Funds available instantly',
      amount: '50.00',
      currency: 'EUR',
      symbol: '€',
      country: 'MT',
      delivery: null,
    },
  },
};

export const VERTICAL_ORDER = ['ecommerce', 'crypto', 'gaming'];
