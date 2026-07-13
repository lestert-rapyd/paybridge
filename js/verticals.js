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
    merchant: 'PayBridge Store',
    descriptor: 'RAPYD*PAYBRIDGE STORE',
    domain: 'shop.paybridge.com',
    headline: 'Secure checkout',
    cta: 'Pay',
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
    merchant: 'PayBridge Exchange',
    descriptor: 'RAPYD*PB EXCHANGE',
    domain: 'buy.paybridge.io',
    headline: 'Buy crypto instantly',
    cta: 'Buy',
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
    descriptor: 'RAPYD*PB PLAY',
    domain: 'play.paybridge.bet',
    headline: 'Add funds to your wallet',
    cta: 'Deposit',
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
