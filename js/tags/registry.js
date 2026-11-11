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
