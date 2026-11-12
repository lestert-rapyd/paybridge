/* ─────────────────────────────────────────────────────────────
   Tag registry — every engine-room pill the Tag Studio can edit.

   The DEFAULTS here are the code's own answer and reproduce exactly what
   the flows painted before tags became data. Published overrides (the
   backend's cfg:tags:v1, edited by admins in the Tag Studio) replace a
   slot's rules / a dictionary entry; anything they don't name falls back
   to these. Keep the slot ids, field allowlists, ops and tones in sync
   with rapyd-backend utils/tag-config.js — the server rejects anything
   this file wouldn't understand.

   Two slot kinds:
     rules — ordered { when, label, tone, hidden }; the first match wins,
             else `fallback` ({ label, tone } or { slot } to delegate).
     dict  — key → { label, tone, hidden }; call sites name a key.

   Labels are TEXT templates: `{field}` placeholders from the slot's
   allowlist (rules) or the entry's `vars` (dict). Never HTML — every
   renderer escapes.
   ───────────────────────────────────────────────────────────── */

export const TONES = ['success', 'failure', 'pending', 'info', 'neutral', 'sim'];
export const OPS = ['eq', 'neq', 'in', 'exists', 'between'];
export const OP_LABELS = { eq: 'is', neq: 'is not', in: 'is one of', exists: 'is present', between: 'between' };
export const TONE_LABELS = { success: 'Success', failure: 'Failure', pending: 'Pending', info: 'Info', neutral: 'Neutral', sim: 'Simulated' };

/** How the Studio coerces a typed condition value. */
export const FIELD_TYPES = {
  'http.status': 'number', error: 'string', 'data.status': 'string', 'data.paid': 'boolean', 'data.next_action': 'string',
};

/** Example values the Studio previews dictionary badges with. */
export const SAMPLE_VARS = {
  error: 'ERROR_PROCESSING_CARD', status: 'CLO', id: 'cus_9f2c41e0', type: 'gb_visa_card', country: 'GB', currency: 'GBP',
};

const HTTP_SAMPLES = [
  { id: 'ok', label: '200 OK', ctx: { http: { status: 200 } } },
  { id: 'redirect', label: '302', ctx: { http: { status: 302 } } },
  { id: 'err-body', label: '200 + error body', ctx: { http: { status: 200 }, error: 'ERROR_PAYMENT' } },
  { id: 'declined', label: '402', ctx: { http: { status: 402 } } },
  { id: 'server', label: '500', ctx: { http: { status: 500 } } },
  { id: 'none', label: 'No response', ctx: { http: { status: 0 } } },
];

const PAYMENT_SAMPLES = [
  { id: 'clo-paid', label: 'CLO · paid', ctx: { http: { status: 200 }, data: { status: 'CLO', paid: true } } },
  { id: 'clo-unpaid', label: 'CLO · unpaid', ctx: { http: { status: 200 }, data: { status: 'CLO', paid: false } } },
  { id: 'act', label: 'ACT · 3DS', ctx: { http: { status: 200 }, data: { status: 'ACT', paid: false, next_action: '3d_verification' } } },
  { id: 'err', label: 'Error body', ctx: { http: { status: 400 }, error: 'ERROR_PROCESSING_CARD' } },
  { id: 'declined', label: '402, no body', ctx: { http: { status: 402 } } },
  { id: 'none', label: 'No response', ctx: { http: { status: 0 } } },
];

export const SLOTS = {
  'http.status': {
    kind: 'rules',
    group: 'Request cards',
    title: 'HTTP status',
    help: 'The HTTP pill on every response card. `error` is only passed by cards that also treat an error body as a failure.',
    fields: ['http.status', 'error'],
    rules: [
      { id: 'none', when: { all: [{ field: 'http.status', op: 'eq', value: 0 }] }, label: 'NO RESPONSE', tone: 'failure' },
      { id: 'error-body', when: { all: [{ field: 'error', op: 'exists' }] }, label: 'HTTP {http.status}', tone: 'failure' },
      { id: 'ok', when: { all: [{ field: 'http.status', op: 'between', value: [200, 399] }] }, label: 'HTTP {http.status}', tone: 'success' },
    ],
    fallback: { label: 'HTTP {http.status}', tone: 'failure' },
    samples: HTTP_SAMPLES,
  },
  'payment.result': {
    kind: 'rules',
    group: 'Request cards',
    title: 'Payment result',
    help: 'POST /v1/payments — the second pill and the card header badge.',
    fields: ['http.status', 'data.status', 'data.paid', 'data.next_action', 'error'],
    rules: [
      { id: 'paid', when: { all: [{ field: 'data.status', op: 'eq', value: 'CLO' }, { field: 'data.paid', op: 'eq', value: true }] }, label: 'PAID · {data.status}', tone: 'success' },
      { id: 'action', when: { all: [{ field: 'data.status', op: 'eq', value: 'ACT' }] }, label: 'ACTION · {data.status}', tone: 'pending' },
      { id: 'error', when: { all: [{ field: 'error', op: 'exists' }] }, label: '{error}', tone: 'failure' },
      { id: 'status', when: { all: [{ field: 'data.status', op: 'exists' }] }, label: '{data.status}', tone: 'pending' },
    ],
    fallback: { slot: 'http.status' },
    samples: PAYMENT_SAMPLES,
  },
  'beat.header': {
    kind: 'dict',
    group: 'Card headers',
    title: 'Card header badges',
    help: 'The badge at the right of each request/response card header.',
    entries: {
      'request.prepared':     { label: 'prepared', tone: 'neutral', note: 'Request drawn, not sent yet' },
      'request.sending':      { label: 'sending…', tone: 'pending', note: 'In flight' },
      'request.sent':         { label: 'signed & sent', tone: 'success', note: 'Request card after the call' },
      'request.failed':       { label: 'failed', tone: 'failure', note: 'Request card when the call failed' },
      'request.not_sent':     { label: 'not sent', tone: 'failure', note: 'External 3DS failed — Rapyd never called' },
      'response.error':       { label: '{error}', tone: 'failure', vars: ['error'], note: 'Any response card with an error code' },
      'sim.pending':          { label: 'Simulated', tone: 'sim', note: 'Simulated step outside Rapyd' },
      'sim.passed':           { label: 'Simulated · passed', tone: 'sim' },
      'sim.failed':           { label: 'Simulated · failed', tone: 'sim' },
      'wallet.sandbox':       { label: 'Sandbox', tone: 'neutral', note: 'Direct wallet, before the sheet returns' },
      'wallet.sent':          { label: 'Sent · sandbox', tone: 'pending', note: 'Direct wallet, sent' },
      'toolkit.express':      { label: 'express', tone: 'neutral', note: 'Express saved-token charge' },
      'fx.quoted':            { label: 'quoted', tone: 'success', note: 'GET /v1/fx_rates' },
      'customer.first':       { label: 'beat 1 · runs first', tone: 'neutral', note: 'POST /v1/customers, drafted' },
      'customer.id':          { label: '{id}', tone: 'success', vars: ['id'], note: 'POST /v1/customers, created' },
      'customer.created':     { label: 'CUSTOMER CREATED', tone: 'success' },
      'customer.found':       { label: 'customer', tone: 'success', note: 'Sign in with a customer ID' },
      'customer.saved_cards': { label: 'saved cards', tone: 'success', note: 'Account › payment methods' },
      'checkout.created':     { label: 'CHECKOUT CREATED', tone: 'success' },
      'addcard.page':         { label: 'PAGE CREATED', tone: 'success' },
      'addcard.3ds':          { label: 'ACT · 3DS', tone: 'success' },
      'addcard.status':       { label: '{status}', tone: 'success', vars: ['status'], note: 'Add-card $0-auth status' },
      'addcard.added':        { label: 'CARD ADDED', tone: 'success' },
      'addcard.saved':        { label: 'CARD SAVED', tone: 'success' },
      'addcard.saved_cards':  { label: 'SAVED CARDS', tone: 'success' },
      'payout.created':       { label: 'payout · {status}', tone: 'success', vars: ['status'] },
      'payout.fields':        { label: 'required fields', tone: 'success' },
      'payout.types':         { label: 'method types', tone: 'success' },
      'payout.type_picked':   { label: '→ {type}', tone: 'success', vars: ['type'] },
      'payout.eligibility':   { label: 'eligibility', tone: 'success' },
      'payout.eligible':      { label: '→ {country} · {currency}', tone: 'success', vars: ['country', 'currency'] },
      'payout.not_eligible':  { label: 'not eligible', tone: 'failure' },
      'payout.no_country':    { label: 'no issuer_country', tone: 'failure' },
    },
  },
};

export const SLOT_ORDER = Object.keys(SLOTS);

/* ── Journeys — the Tag Studio's map of WHERE each tag appears ────────────
   A step is one card on the engine room, identified by its card id without
   the `beat-` prefix (beatCardHTML derives it the same way), so a step's
   override lives in the slot `<slot>:<step>` (e.g. `beat.header:pay`,
   `payment.result:pay-res`). Anything a step doesn't override follows the
   shared slot, then the code default.

   CALLS lists each API call once (request card, response card, the states
   its header badge goes through); JOURNEYS orders calls the way the demo
   runs them. A call used by two journeys (the customer beat, the FX quote)
   is the same step in both — editing it in one edits it in the other. */

export const SCENARIOS = {
  prepared: 'Before sending',
  sending: 'In flight',
  success: 'Success',
  action: '3DS / action',
  failure: 'Failure',
};

const S_SENDING = { key: 'request.sending', when: 'While the call is in flight', scenarios: ['sending'] };
const S_SENT = { key: 'request.sent', when: 'After it was sent', scenarios: ['success', 'action'] };
const S_FAILED = { key: 'request.failed', when: 'When the call failed', scenarios: ['failure'] };
const S_PREPARED = { key: 'request.prepared', when: 'Drawn, not sent yet', scenarios: ['prepared'] };
const S_ERROR = { key: 'response.error', when: 'Rapyd returned an error', scenarios: ['failure'] };
const REQ_LIFECYCLE = [S_SENDING, S_SENT, S_FAILED];

export const CALLS = {
  'cus-lookup': {
    method: 'GET', path: '/v1/customers/{id}', title: 'Look up the customer',
    req: { step: 'cus-lookup', states: REQ_LIFECYCLE },
    res: { step: 'cus-lookup-res', http: true, states: [S_SENDING, { key: 'customer.found', when: 'Customer found', scenarios: ['success', 'action'] }, S_ERROR] },
  },
  cus: {
    method: 'POST', path: '/v1/customers', title: 'Create the customer (beat 1)',
    req: { step: 'cus', states: [{ key: 'customer.first', when: 'Drafted — runs before the payment', scenarios: ['prepared'] }, S_SENDING, { key: 'customer.id', when: 'Created — shows the cus_ id', scenarios: ['success', 'action'] }, S_FAILED] },
    res: { step: 'cus-res', http: true, states: [S_SENDING, { key: 'customer.created', when: 'Customer created', scenarios: ['success', 'action'] }, S_ERROR] },
  },
  'cus-get': {
    method: 'GET', path: '/v1/customers/{id}', title: 'Retrieve the customer (returning shopper)',
    req: { step: 'cus-get', states: [{ ...S_PREPARED, scenarios: ['prepared', 'sending', 'success', 'action', 'failure'] }] },
  },
  fx: {
    method: 'GET', path: '/v1/fx_rates', title: 'FX quote (when the shopper pays in another currency)',
    res: { step: 'fx', http: true, single: true, states: [{ key: 'fx.quoted', when: 'Quote returned', scenarios: ['success', 'action', 'prepared', 'sending'] }, { key: 'request.failed', when: 'Quote failed', scenarios: ['failure'] }] },
  },
  ext3ds: {
    method: '3DS', sim: true, path: 'Merchant → its 3DS server', title: 'External 3DS (simulated, outside Rapyd)',
    req: { step: 'ext3ds', states: [{ key: 'sim.pending', when: 'Always (simulated step)', scenarios: ['prepared', 'sending', 'success', 'action', 'failure'] }] },
  },
  pay: {
    method: 'POST', path: '/v1/payments', title: 'Create the payment',
    req: { step: 'pay', states: [{ ...S_SENT, scenarios: ['sending', 'success', 'action', 'failure'] }, { key: 'request.not_sent', when: 'Never sent — the merchant’s 3DS failed', scenarios: [] }] },
    res: { step: 'pay-res', http: true, rules: 'payment.result', states: [S_SENDING, { key: 'request.not_sent', when: 'Never sent — the merchant’s 3DS failed', scenarios: [] }] },
  },
  checkout: {
    method: 'POST', path: '/v1/checkout', title: 'Create the checkout page',
    req: { step: 'checkout', states: [{ ...S_SENT, scenarios: ['sending', 'success', 'action', 'failure'] }] },
    res: { step: 'checkout-res', http: true, states: [{ key: 'checkout.created', when: 'Checkout created', scenarios: ['success', 'action'] }, S_ERROR] },
  },
  express: {
    method: 'POST', path: '/v1/payments', title: 'Charge the saved card (express)',
    req: { step: 'express', states: [{ key: 'toolkit.express', when: 'Express charge', scenarios: ['prepared', 'sending', 'success', 'action', 'failure'] }] },
    res: { step: 'express-res', http: true, rules: 'payment.result', states: [] },
  },
  'dw-pay': {
    method: 'POST', path: '/v1/payments', title: 'Create the wallet payment (mock token, real sandbox call)',
    req: { step: 'dw-pay', states: [{ key: 'wallet.sandbox', when: 'Waiting for the shopper in the wallet sheet', scenarios: ['prepared'] }, { key: 'wallet.sent', when: 'Sent after the sheet returned', scenarios: ['sending', 'success', 'action', 'failure'] }] },
    res: { step: 'dw-res', http: true, rules: 'payment.result', states: [] },
  },
  'pm-list': {
    method: 'GET', path: '/v1/customers/{id}/payment_methods', title: 'List the saved cards',
    req: { step: 'pm-list', states: REQ_LIFECYCLE },
    res: { step: 'pm-list-res', http: true, states: [{ key: 'customer.saved_cards', when: 'Cards listed', scenarios: ['success', 'action'] }, S_ERROR] },
  },
  'ac-ext': {
    method: 'AUTH', sim: true, path: 'merchant’s 3DS provider', title: 'Merchant’s 3DS (simulated — external-3DS MIDs only)',
    req: { step: 'ac-ext', states: [{ key: 'sim.pending', when: 'Before the provider answers', scenarios: ['prepared', 'sending'] }, { key: 'sim.passed', when: 'Provider passed (transStatus Y)', scenarios: ['success', 'action'] }, { key: 'sim.failed', when: 'Provider failed', scenarios: ['failure'] }] },
  },
  'ac-1': {
    method: 'POST', path: 'hosted page · $0-auth · payment_methods', title: 'Add the card (route follows the drawer)',
    req: { step: 'ac-1', states: [S_PREPARED, ...REQ_LIFECYCLE] },
    res: { step: 'ac-1-res', http: true, states: [
      { key: 'addcard.page', when: 'Hosted page created', scenarios: ['success'] },
      { key: 'addcard.3ds', when: '$0-auth needs 3DS', scenarios: ['action'] },
      { key: 'addcard.status', when: '$0-auth status', scenarios: [] },
      { key: 'addcard.added', when: 'Card added (external 3DS)', scenarios: [] },
      S_ERROR,
    ] },
  },
  'ac-verify': {
    method: 'GET', path: '/v1/payments/{id}', title: 'Confirm the card was saved',
    req: { step: 'ac-verify', states: REQ_LIFECYCLE },
    res: { step: 'ac-verify-res', http: true, states: [{ key: 'addcard.saved', when: 'Card saved', scenarios: ['success', 'action'] }, { key: 'addcard.status', when: 'Not saved — shows the status', scenarios: [] }, S_ERROR] },
  },
  'ac-list': {
    method: 'GET', path: '/v1/customers/{id}/payment_methods', title: 'List the saved cards',
    req: { step: 'ac-list', states: REQ_LIFECYCLE },
    res: { step: 'ac-list-res', http: true, states: [{ key: 'addcard.saved_cards', when: 'Cards listed', scenarios: ['success', 'action'] }, S_ERROR] },
  },
  'po-elig': {
    method: 'POST', path: '/v1/cards/eligibility', title: 'Check the card can receive a payout',
    req: { step: 'po-elig', states: REQ_LIFECYCLE },
    res: { step: 'po-elig-res', http: true, states: [
      S_SENDING,
      { key: 'payout.eligible', when: 'Eligible — issuer country · currency', scenarios: ['success', 'action'] },
      { key: 'payout.eligibility', when: 'Answered, no routing decided', scenarios: [] },
      { key: 'payout.not_eligible', when: 'Card can’t receive payouts', scenarios: [] },
      { key: 'payout.no_country', when: 'No issuer country returned', scenarios: [] },
      S_ERROR,
    ] },
  },
  'po-types': {
    method: 'GET', path: '/v1/payout_method_types', title: 'Pick the payout method type',
    req: { step: 'po-types', states: REQ_LIFECYCLE },
    res: { step: 'po-types-res', http: true, states: [S_SENDING, { key: 'payout.type_picked', when: 'Type picked', scenarios: ['success', 'action'] }, { key: 'payout.types', when: 'Listed, none picked', scenarios: [] }, S_ERROR] },
  },
  'po-fields': {
    method: 'GET', path: '/v1/payout_methods/{type}/required_fields', title: 'Get the required fields',
    req: { step: 'po-fields', states: REQ_LIFECYCLE },
    res: { step: 'po-fields-res', http: true, states: [S_SENDING, { key: 'payout.fields', when: 'Fields returned', scenarios: ['success', 'action'] }, S_ERROR] },
  },
  'po-create': {
    method: 'POST', path: '/v1/payouts', title: 'Create the payout',
    req: { step: 'po-create', states: [S_PREPARED, ...REQ_LIFECYCLE] },
    res: { step: 'po-create-res', http: true, states: [S_SENDING, { key: 'payout.created', when: 'Payout created — shows its status', scenarios: ['success', 'action'] }, S_ERROR] },
  },
};

export const JOURNEYS = [
  { id: 'signin', group: 'Before checkout', title: 'Sign in with a customer ID', calls: ['cus-lookup'] },
  { id: 'customer', group: 'Before checkout', title: 'Create the customer', calls: ['cus', 'cus-get'] },
  { id: 'ocf', group: 'Checkout', title: 'Own Card Fields', calls: ['cus', 'fx', 'ext3ds', 'pay'] },
  { id: 'toolkit', group: 'Checkout', title: 'Checkout Toolkit', calls: ['cus', 'checkout', 'fx', 'express'] },
  { id: 'wallet', group: 'Checkout', title: 'Direct Apple Pay / Google Pay', calls: ['dw-pay'] },
  { id: 'saved', group: 'After checkout', title: 'Account · saved cards', calls: ['pm-list'] },
  { id: 'addcard', group: 'After checkout', title: 'Add a card', calls: ['ac-ext', 'ac-1', 'ac-verify', 'ac-list'] },
  { id: 'withdraw', group: 'After checkout', title: 'Withdraw (card payout)', calls: ['po-elig', 'po-types', 'po-fields', 'po-create'] },
];

/** Every step id → { call, side } (side: 'req' | 'res'). */
export const STEPS = Object.fromEntries(Object.entries(CALLS).flatMap(([call, c]) =>
  ['req', 'res'].filter((side) => c[side]).map((side) => [c[side].step, { call, side }])));

/** The journeys a call appears in (for "also in …"). */
export const journeysOf = (call) => JOURNEYS.filter((j) => j.calls.includes(call));

/** `payment.result:pay-res` → ['payment.result', 'pay-res']; `beat.header` → ['beat.header', null]. */
export function splitSlotId(id) {
  const i = String(id).indexOf(':');
  return i < 0 ? [id, null] : [id.slice(0, i), id.slice(i + 1)];
}
export const STEP_RE = /^[a-z0-9-]{1,40}$/;

/* ── Sequence — what each call is expected to produce ─────────────────────
   The engine room groups every call into one event: headers → request →
   response → the webhooks it fires. This block is the "expected" half of
   that view, kept as data so the Tag Studio can show it whole and the user
   can propose changes against it. Display only — nothing here gates a flow.

   EXPECT[call] is a list of variants; the first whose `path` (a substring of
   the call's path, optional) matches is used. Per scenario (SCENARIOS keys —
   `action` = 3DS / redirect pending, `success`, `failure`):
     criteria — response checks, { path, op, value } over the response JSON
                (paths as the JSON viewer prints them: data.status …)
     sync     — webhooks the call itself fires
     async    — an ASYNC id: webhooks that follow a later shopper/Rapyd step
   A webhook slot is { type | anyOf, links }, `links` mapping a path in the
   webhook to the id it must equal (payment, customer, card, payout, ref,
   checkout). A webhook is claimed by the first slot whose type matches and
   whose linked ids all agree (at least one must be comparable); anything
   about this run that no slot claims is listed under "Other events".

   Drafted 2026-11-12 from the webhook-studio evidence (add-card runs,
   wh:recent); rows marked `confirm: true` are not yet seen end to end. */

const PAY_LINKS = { 'data.id': 'payment', 'data.customer_token': 'customer' };
const CARD_LINKS = { 'data.id': 'card' };
const CARD_PAY_LINKS = { 'data.id': 'payment', 'data.customer_token': 'customer', 'data.payment_method': 'card' };

const PAY_EXPECT = {
  success: {
    criteria: [{ path: 'data.status', op: 'eq', value: 'CLO' }, { path: 'data.paid', op: 'eq', value: true }],
    sync: [{ type: 'PAYMENT_SUCCEEDED', links: PAY_LINKS }, { type: 'PAYMENT_COMPLETED', links: PAY_LINKS }],
  },
  action: {
    criteria: [{ path: 'data.status', op: 'eq', value: 'ACT' }, { path: 'data.next_action', op: 'eq', value: '3d_verification' }, { path: 'data.redirect_url', op: 'exists' }],
    sync: [{ type: 'PAYMENT_SUCCEEDED', links: PAY_LINKS }],
    async: 'pay-3ds',
  },
  failure: { criteria: [], sync: [{ type: 'PAYMENT_FAILED', links: PAY_LINKS, confirm: true }] },
};

export const EXPECT = {
  cus: [{ success: { criteria: [{ path: 'data.id', op: 'exists' }], sync: [{ type: 'CUSTOMER_CREATED', links: { 'data.id': 'customer' } }] } }],
  pay: [PAY_EXPECT],
  express: [PAY_EXPECT],
  'dw-pay': [PAY_EXPECT],
  checkout: [{
    success: { criteria: [{ path: 'data.id', op: 'exists' }, { path: 'data.redirect_url', op: 'exists' }], sync: [], async: 'checkout-pay' },
  }],
  'ac-1': [
    { path: '/hosted/', label: 'Hosted page (redirect or card toolkit)',
      success: { criteria: [{ path: 'data.id', op: 'exists' }, { path: 'data.redirect_url', op: 'exists' }], sync: [], async: 'ac-hosted' } },
    { path: '/v1/payments', label: '$0-auth with Rapyd 3DS',
      action: {
        criteria: [{ path: 'data.status', op: 'eq', value: 'ACT' }, { path: 'data.next_action', op: 'eq', value: '3d_verification' }, { path: 'data.redirect_url', op: 'exists' }],
        sync: [{ type: 'PAYMENT_SUCCEEDED', links: PAY_LINKS }, { type: 'CUSTOMER_PAYMENT_METHOD_CREATED', links: CARD_LINKS }],
        async: 'ac-3ds',
      },
      success: {
        criteria: [{ path: 'data.status', op: 'in', value: ['CLO', 'ACT'] }],
        sync: [{ type: 'PAYMENT_SUCCEEDED', links: PAY_LINKS }, { type: 'CUSTOMER_PAYMENT_METHOD_CREATED', links: CARD_LINKS },
          { type: 'CARD_ADDED_SUCCESSFULLY', links: CARD_LINKS }, { type: 'PAYMENT_UPDATED', links: CARD_PAY_LINKS }],
        confirm: true,
      } },
    { path: '/payment_methods', label: 'External 3DS — save the card directly',
      success: { criteria: [{ path: 'data.id', op: 'exists' }],
        sync: [{ type: 'CUSTOMER_PAYMENT_METHOD_CREATED', links: CARD_LINKS }, { type: 'CARD_ADDED_SUCCESSFULLY', links: CARD_LINKS }] } },
  ],
  'ac-verify': [{ success: { criteria: [{ path: 'data.payment_method', op: 'exists' }], sync: [] } }],
  'po-elig': [{ success: { criteria: [{ path: 'data.issuer_country', op: 'exists' }], sync: [] } }],
  'po-create': [{
    success: { criteria: [{ path: 'data.id', op: 'exists' }, { path: 'data.status', op: 'exists' }], sync: [], async: 'po-settle' },
  }],
};

/** Async events — their own card in the sequence, placed after the call they
    follow, holding the webhooks a later step (the shopper's 3DS, Rapyd's
    hosted page, settlement) produces. */
export const ASYNC = {
  'pay-3ds': {
    title: 'After the shopper’s 3DS', trigger: 'The shopper completes the challenge at redirect_url',
    sync: [{ type: 'PAYMENT_UPDATED', links: CARD_PAY_LINKS }, { type: 'PAYMENT_COMPLETED', links: PAY_LINKS }],
  },
  'checkout-pay': {
    title: 'After the shopper pays on the checkout', trigger: 'The shopper submits Rapyd’s checkout page / toolkit',
    sync: [{ type: 'PAYMENT_SUCCEEDED', links: { 'data.merchant_reference_id': 'ref', 'data.customer_token': 'customer' }, confirm: true },
      { type: 'PAYMENT_COMPLETED', links: { 'data.merchant_reference_id': 'ref', 'data.customer_token': 'customer' }, confirm: true }],
  },
  'ac-3ds': {
    title: 'After the card’s 3DS', trigger: 'The shopper completes the $0-auth challenge',
    sync: [{ type: 'CARD_ADDED_SUCCESSFULLY', links: CARD_LINKS }, { type: 'PAYMENT_UPDATED', links: CARD_PAY_LINKS }],
  },
  'ac-hosted': {
    title: 'After Rapyd’s card page', trigger: 'The shopper enters the card and passes 3DS on Rapyd’s page',
    sync: [{ type: 'PAYMENT_SUCCEEDED', links: { 'data.customer_token': 'customer' } }, { type: 'CUSTOMER_PAYMENT_METHOD_CREATED', links: CARD_LINKS },
      { type: 'CARD_ADDED_SUCCESSFULLY', links: CARD_LINKS }, { type: 'PAYMENT_UPDATED', links: { 'data.customer_token': 'customer', 'data.payment_method': 'card' } }],
  },
  'po-settle': {
    title: 'Payout settles', trigger: 'Rapyd completes (or fails) the payout',
    sync: [{ anyOf: ['PAYOUT_COMPLETED', 'PAYOUT_FAILED'], links: { 'data.id': 'payout' } }],
  },
};

/** What each webhook means — shown under it in the engine room. */
export const WEBHOOK_NOTES = {
  CUSTOMER_CREATED: 'The cus_*** now exists — data.id is the customer.',
  PAYMENT_SUCCEEDED: 'The payment was accepted. On a 3DS payment it is still pending 3d_verification — nothing authenticated yet; it carries the cus_*** (customer_token) but no card_*** yet.',
  PAYMENT_COMPLETED: 'The payment is final — captured and paid.',
  PAYMENT_UPDATED: 'The 3DS result landed on the payment — authentication data, with the cus_*** and the card_*** both recorded.',
  PAYMENT_FAILED: 'The payment failed — see data.failure_code / failure_message.',
  CUSTOMER_PAYMENT_METHOD_CREATED: 'Rapyd stored the card — the card_*** and its BIN details. Nothing on it points to a cus_*** or a payment_***; only the card id links it.',
  CARD_ADDED_SUCCESSFULLY: 'The same card object as CUSTOMER_PAYMENT_METHOD_CREATED, now carrying data.payment_account_reference.',
  PAYOUT_COMPLETED: 'The payout reached the beneficiary.',
  PAYOUT_FAILED: 'The payout failed.',
};

/** The variant of EXPECT that applies to a call made on `path`. */
export function expectFor(call, path = '') {
  const list = EXPECT[call];
  if (!list) return null;
  return list.find((v) => !v.path || String(path).includes(v.path)) || null;
}
