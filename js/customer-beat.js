/* ─────────────────────────────────────────────────────────────
   The customer beat — POST /v1/customers as a step of its own.

   The cus_*** is a prerequisite (a card_*** token is held BY a customer;
   AFT needs its KYC), but the call that mints it used to be invisible: it
   was painted into the request panel for one tick and then overwritten by
   the payment, and the toolkit only logged a console line. This module gives
   it a place of its own on BOTH sides of the split:

     left  · the account step preceding the cart (accountPanelHTML) — the SE
             edits name/email, fires the call on its own clock, and the panel
             collapses into the created account row afterwards.
     right · a stacked, collapsible beat card (beatCardHTML) that survives the
             payment call, so its body/response stay inspectable. The flows
             render their own card below it with the same shell.
     webhooks · the expected CUSTOMER_* events, then whatever actually lands
             (pushed into webhooks.js, which owns #panel-webhooks).

   Creation stays LAZY as a fallback: an SE who skips the step and hits Pay
   still gets beat 1 out of the flow's own submit — through this same
   fireCreateCustomer(), so both paths paint identically.

   Record is keyed `${env}:${profile}` like customers.js's buckets: a cus_***
   minted under one sandbox MID does not exist under another, and neither does
   the call that made it.
   ───────────────────────────────────────────────────────────── */

import { state, setState } from './state.js';
import * as customers from './customers.js';
import { identityMode, usesCustomer } from './identity.js';
import { createCustomer } from './api.js';
import { renderJSONView, highlightPaths } from './json-view.js';
import { FIELD_MAP } from './sync.js';
import { headersHTML, fillSignature, newSaltTimestamp } from './signing.js';
import { setActiveTab, setStatus } from './ui.js';
import { setCustomerBeat } from './webhooks.js';

const $ = (s, r = document) => r.querySelector(s);

/* ── The beat record ─────────────────────────────────────── */
const records = new Map(); // `${env}:${profile}` -> record
const key = () => `${state.env}:${state.profile}`;

function record() {
  if (!records.has(key())) {
    records.set(key(), { state: 'draft', body: null, httpStatus: null, data: null, at: null });
    // A fired beat folds its card away (its job is done). The fold is per CARD
    // but the record is per env:profile, so a switch to a MID that has no
    // customer yet would inherit the fold and hide the draft the SE is about to
    // author. Anything back at 'draft' gets its card back open.
    openState.set('beat-cus', true);
  }
  const r = records.get(key());
  // Keep the record and the store in agreement in BOTH directions, so the card
  // can never contradict the account row:
  // · "Forget this profile" drops the customer — a 'created' beat with no
  //   customer would be a lie.
  // · a customer that arrived without going through this beat (a backfill, or a
  //   session restored some other way) still has to read as created.
  if (r.state === 'created' && !customers.getCustomerId()) {
    Object.assign(r, { state: 'draft', body: null, httpStatus: null, data: null, at: null });
    openState.set('beat-cus', true); // back to a draft — same reasoning as above
  } else if (r.state === 'draft' && customers.getCustomerId()) {
    r.state = 'created';
  }
  return r;
}

/** 'idle' (guest — no beat at all) | 'draft' | 'sending' | 'created' | 'error' */
export function beatState() {
  return usesCustomer() ? record().state : 'idle';
}
/** When the beat ran, for the back office's customer view. */
export const beatCreatedAt = () => record().at;
/** The stored request/response of the create call, for "View create call". */
export const beatRecord = () => ({ ...record() });

/* Push the state into webhooks.js (which owns #panel-webhooks and starts the
   CUSTOMER_* watch). One-way — that module never imports this one back. */
function syncWebhooks() {
  const st = beatState();
  setCustomerBeat({ id: st === 'created' ? customers.getCustomerId() : null, state: st });
}

/* ── Stacked beat cards (shared shell) ───────────────────────
   <details> open state has to be OWNED here: the flows rebuild the request
   panel's innerHTML on every keystroke, which would reset a native `open`.
   The toggle is delegated on document and preventDefault()s the native one so
   there's a single source of truth (the `toggle` event doesn't bubble, so
   delegating on it isn't an option). */
const openState = new Map();
const isOpen = (id) => (openState.has(id) ? openState.get(id) : true);

/** The card shell every beat uses — the flows pass their own inner block. */
export function beatCardHTML({ id, n, method, path, badge, badgeKind = '', inner }) {
  return `
    <details class="beat-card" id="${id}" ${isOpen(id) ? 'open' : ''}>
      <summary class="beat-head">
        <span class="beat-chev">▸</span>
        ${n ? `<span class="beat-n">${n}</span>` : ''}
        <span class="method-pill ${method.toLowerCase()}">${method.toUpperCase()}</span>
        <span class="req-path">${path}</span>
        ${badge ? `<span class="beat-state ${badgeKind}">${badge}</span>` : ''}
      </summary>
      <div class="beat-body">${inner}</div>
    </details>`;
}

document.addEventListener('click', (e) => {
  const head = e.target.closest('.beat-head');
  if (!head) return;
  e.preventDefault(); // own the toggle so a repaint can't lose it
  const card = head.closest('.beat-card');
  if (!card) return;
  const next = !isOpen(card.id);
  openState.set(card.id, next);
  card.open = next;
});

/* ── Request card ────────────────────────────────────────── */
const REQ_HINT = {
  draft: 'updates as you type',
  sending: 'signed &amp; sent',
  created: 'signed &amp; sent',
  error: 'signed &amp; sent',
};
function reqBadge(st) {
  if (st === 'created') return [customers.getCustomerId() || 'created', 'ok'];
  if (st === 'sending') return ['sending…', 'live'];
  if (st === 'error') return ['failed', 'err'];
  return ['beat 1 · runs first', ''];
}

/* What the card last rendered — the signature has to be computed over exactly
   that salt/timestamp/body pair, so it's stashed rather than re-derived. */
let painted = null;

/** '' for a guest — the panel then looks exactly as it did before this module. */
export function customerRequestCardHTML() {
  const st = beatState();
  if (st === 'idle') { painted = null; return ''; }
  const body = record().body || customers.enrichedCustomerBody();
  const salt = newSaltTimestamp();
  painted = { salt, body };
  const [badge, badgeKind] = reqBadge(st);
  return beatCardHTML({
    id: 'beat-cus', n: 1, method: 'POST', path: '/v1/customers', badge, badgeKind,
    inner: `
      ${headersHTML(salt)}
      <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${REQ_HINT[st]} · enriched, so the same customer is AFT-ready</span></div>
      <div id="req-json-cus">${renderJSONView(body)}</div>`,
  });
}

/** Sign the customer card in place. Scoped to the CARD, not the panel — two
    cards in one panel each carry their own .hv-sig, and a shared staleness
    counter would let one cancel the other (see signing.js). */
export function fillCustomerSignature() {
  const card = $('#beat-cus');
  if (!card || !painted) return;
  fillSignature(card, 'post', '/v1/customers', painted.salt, painted.body, 'beat-cus');
}

/* The active flow's field↔JSON highlighter. Rebuilding the card drops the
   .sync-hit classes with it, so it has to be re-applied — and only the flow
   knows which field is focused (own-fields owns FIELD_MAP + focusin). */
let reapplyHighlight = () => {};
export function setHighlightHook(fn) { reapplyHighlight = fn; }

/** Repaint ONLY the customer card — what a keystroke in the account step does,
    so the payment card's JSON and the SE's cursor are both left alone. */
export function refreshCustomerBeatCard() {
  const card = $('#beat-cus');
  if (!card) return;
  card.outerHTML = customerRequestCardHTML();
  fillCustomerSignature();
  applyCustomerHighlight(); // this card's own highlight — rebuilt with the card
  reapplyHighlight();       // and the flow's, for the payment card beside it
}

/* ── Response card ───────────────────────────────────────── */
export function customerResponseCardHTML() {
  const st = beatState();
  if (st === 'idle' || st === 'draft') return '';
  const r = record();
  if (st === 'sending') {
    return beatCardHTML({
      id: 'beat-cus-res', n: 1, method: 'POST', path: '/v1/customers', badge: 'sending…', badgeKind: 'live',
      inner: `<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>`,
    });
  }
  // Created, but this beat never saw the response (the customer came from
  // elsewhere) — better no card than a card claiming an empty body.
  if (st === 'created' && !r.data) return '';
  const ok = st === 'created';
  const id = r.data?.data?.id;
  return beatCardHTML({
    id: 'beat-cus-res', n: 1, method: 'POST', path: '/v1/customers',
    badge: ok ? 'CUSTOMER CREATED' : String(r.data?.error || 'ERROR'), badgeKind: ok ? 'ok' : 'err',
    inner: `
      <div class="eng-pillrow">
        <span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${r.httpStatus ?? 0}</span>
        <span class="wh-pill ${ok ? 'success' : 'failure'}">${ok ? 'CUSTOMER CREATED' : String(r.data?.error || 'ERROR')}</span>
      </div>
      ${renderJSONView(r.data ?? { error: 'no response body' })}
      ${ok && id ? `<div class="beat-foot">Every payment on this session now references <code>${id}</code> — and a saved card_*** is held under it.</div>` : ''}`,
  });
}

/* ── The fire action — shared by the account step and both flows ── */
let repaintPanels = () => {}; // set by app.js (it's the only module that knows the flows)
export function setPanelRepainter(fn) { repaintPanels = fn; }

export async function fireCreateCustomer() {
  const r = record();
  if (r.state === 'sending') return false;
  if (customers.getCustomerId()) return true; // already exists — the beat is done

  const body = customers.enrichedCustomerBody();
  Object.assign(r, { state: 'sending', body, httpStatus: null, data: null });
  setStatus('Creating customer…', 'processing');
  refreshAccountPanel();
  syncWebhooks();
  repaintPanels();
  setActiveTab('request');

  let httpStatus = 0, data = null;
  try {
    ({ httpStatus, data } = await createCustomer({ ...body, env: state.env, profile: state.profile }));
  } catch (err) {
    data = { error: 'network_error', message: err.message };
  }
  const id = data?.data?.id;
  r.httpStatus = httpStatus;
  r.data = data;

  if (httpStatus >= 400 || data?.error || !id) {
    r.state = 'error';
    setStatus('Error', 'error');
    syncWebhooks();
    refreshAccountPanel();
    repaintPanels();
    setActiveTab('response');
    return false;
  }

  r.state = 'created';
  r.at = Date.now();
  openState.set('beat-cus', false); // its job is done — fold it away, the payment is the live one
  setStatus('Customer created', 'ok');
  customers.setCustomerId(id);      // notifies: the chooser, the panel and the back office follow
  syncWebhooks();                   // starts the CUSTOMER_* watch
  refreshAccountPanel();
  repaintPanels();
  setActiveTab('response');
  return true;
}

/* ── Left panel: the account step ────────────────────────── */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/* The form mirrors the request body, in the body's own order — one field per
   row, so the SE can read straight across from a field to the line it writes.
   Every one is registered in sync.js FIELD_MAP, so focusing it lights that line
   up. `addresses[0].name` isn't listed: it tracks `name` rather than being typed.

   `kyc: true` marks the four enrichment fields. The BODY always carries them
   (one cus_*** has to be AFT-ready across all three verticals), but only a
   vertical where a real site would ask SHOWS them: a crypto onramp asks your
   nationality and occupation, a furniture shop does not. */
const ACCOUNT_FIELDS = [
  { id: 'f-cus-name',    path: 'name',            label: 'Full name',        autocomplete: 'name' },
  { id: 'f-cus-email',   path: 'email',           label: 'Email',            autocomplete: 'email', type: 'email' },
  { id: 'f-cus-dob',     path: 'date_of_birth',   label: 'Date of birth',    autocomplete: 'bday', kyc: true },
  { id: 'f-cus-birth',   path: 'birth_country',   label: 'Country of birth', autocomplete: 'off', kyc: true },
  { id: 'f-cus-nat',     path: 'nationality',     label: 'Nationality',      autocomplete: 'off', kyc: true },
  { id: 'f-cus-occ',     path: 'occupation',      label: 'Occupation',       autocomplete: 'organization-title', kyc: true },
  { id: 'f-cus-line1',   path: 'address.line_1',  label: 'Address',          autocomplete: 'address-line1' },
  { id: 'f-cus-city',    path: 'address.city',    label: 'City',             autocomplete: 'address-level2' },
  { id: 'f-cus-country', path: 'address.country', label: 'Country',          autocomplete: 'country-name' },
  { id: 'f-cus-zip',     path: 'address.zip',     label: 'Postcode',         autocomplete: 'postal-code' },
];
/** Verticals whose real-world equivalent runs KYC at signup. */
const KYC_VERTICALS = new Set(['crypto']);
const visibleAccountFields = () =>
  ACCOUNT_FIELDS.filter((f) => !f.kyc || KYC_VERTICALS.has(state.vertical));

/** The field a given id writes — used by the input handler. */
export const accountFieldPath = (id) => ACCOUNT_FIELDS.find((f) => f.id === id)?.path || null;

function accountFormHTML() {
  const st = beatState();
  const sending = st === 'sending';
  const r = record();
  const field = (f) => `
    <label class="acct-field">
      <span>${f.label}</span>
      <div class="co-input"><input id="${f.id}" ${f.type ? `type="${f.type}"` : ''} autocomplete="${f.autocomplete}" value="${esc(customers.getIdentityField(f.path))}" ${sending ? 'disabled' : ''} /></div>
    </label>`;
  return `
    <div class="acct-block" id="acct-block">
      <div class="acct-fields">${visibleAccountFields().map(field).join('')}</div>
      ${st === 'error' ? `<div class="acct-err">We couldn't save your details. Please try again.</div>` : ''}
    </div>`;
}

/** The primary action's label/state. steps.js renders the button — it owns the
    frame's layout, and this owns the beat — so the two choices can sit on one
    plane. The real reason for a failure is in the Response tab, not here. */
export function accountCtaState() {
  const st = beatState();
  return {
    sending: st === 'sending',
    label: st === 'sending' ? 'Creating…' : st === 'error' ? 'Try again' : 'Create account',
  };
}

/** The signed-in account, as a row. Three homes, one template: the account
    frame after the beat fires, frame 1's signed-in view, and the checkout
    frame's profile strip.

    A storefront shows you WHO you're signed in as — a name, an email, and what
    you have saved. Not the customer id it holds for you, not the currency of an
    order you haven't placed, and not a door into the merchant's own admin. The
    cus_*** lives in the response, the request bodies and the webhook, one pane
    to the right. */
export function customerRowHTML() {
  const id = customers.getIdentity();
  const n = customers.credentials().length;
  return `
    <div class="acct-block created" id="acct-block">
      <div class="acct-row">
        <span class="acct-tick">✓</span>
        <div class="acct-row-main">
          <div class="acct-row-name">${esc(id.name)}<span class="acct-row-mail">${esc(id.email)}</span></div>
          <div class="acct-row-id">${n ? `${n} saved card${n > 1 ? 's' : ''}` : 'No saved cards yet'}</div>
        </div>
      </div>
    </div>`;
}

/* The checkout frame's profile strip — who is paying, stated as fact. A guest
   says so; an account chosen but never created says the beat still has to run
   (the lazy fallback), so the strip never implies a cus_*** that doesn't exist. */
function stripHTML() {
  const cus = customers.getCustomerId();
  if (cus) return customerRowHTML();
  if (identityMode() === 'guest') {
    return `
      <div class="acct-block strip" id="acct-block">
        <div class="acct-row">
          <span class="acct-tick guest">–</span>
          <div class="acct-row-main">
            <div class="acct-row-name">Guest checkout</div>
            <div class="acct-row-id">Nothing will be saved for next time.</div>
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="acct-block strip" id="acct-block">
      <div class="acct-row">
        <span class="acct-tick pending">·</span>
        <div class="acct-row-main">
          <div class="acct-row-name">Account not created yet</div>
          <div class="acct-row-id">Your account will be created when you place this order.</div>
        </div>
      </div>
    </div>`;
}

/** Step-aware: the FORM on the account frame, a read-only STRIP on the checkout
    frame. Both shells render this one call, so neither has to know the step —
    and refreshAccountPanel() keeps working on either, since every variant
    carries #acct-block. */
export function accountPanelHTML() {
  if (state.step === 'checkout') return stripHTML();
  if (state.step !== 'account') return '';
  if (customers.getCustomerId()) return customerRowHTML();
  // Returning against a merchant-vaulted card only: there's no customer object
  // to show. This used to return '' — which left the frame rendering the heading
  // "Create your account" and a Create button with NOTHING between them. The
  // form is what belongs here: this shopper has a saved card but no account yet,
  // so offering them one is exactly right.
  return accountFormHTML();
}

/** Repaint in place. Never called from the panel's own keystrokes — that would
    take the cursor with it. */
export function refreshAccountPanel() {
  syncAccountCta();
  const block = $('#acct-block');
  const html = accountPanelHTML();
  if (block) {
    if (html) block.outerHTML = html;
    else block.remove();
    return;
  }
  // The block can appear where there was none (mode switch, forget-profile) —
  // slot it after the chooser, which both shells render.
  if (html) $('.id-block')?.insertAdjacentHTML('afterend', html);
}

/* The primary action sits OUTSIDE the block — on one plane with "Skip for now",
   since they're two answers to the same question — so a beat transition
   (draft → sending → error) has to reach it separately from the block swap. */
function syncAccountCta() {
  const btn = $('#acct-create');
  if (!btn) return;
  const cta = accountCtaState();
  btn.disabled = cta.sending;
  btn.textContent = cta.label;
}

/* ── Wiring — document-delegated, once at module load (the blocks' innerHTML
   is rebuilt far more often than any mount() runs). ───────── */
document.addEventListener('input', (e) => {
  const path = accountFieldPath(e.target.id);
  if (!path) return;
  if (customers.getCustomerId()) return; // frozen — no update-customer call exists
  customers.setIdentityField(path, e.target.value);
  setStatus('Drafting request', 'drafting');
  refreshCustomerBeatCard();
});

/* The customer card's field↔JSON highlight lives HERE, not in a flow: the card
   is this module's (#req-json-cus), and the account frame renders under both
   models — the toolkit has no applyHighlight() of its own, so routing it
   through the flow left the toolkit's account frame dead. own-fields keeps
   owning the payment body's highlight. */
let cusFocusedId = null;
function applyCustomerHighlight() {
  highlightPaths($('#req-json-cus'), cusFocusedId ? (FIELD_MAP[cusFocusedId] || []) : []);
}
document.addEventListener('focusin', (e) => {
  if (!accountFieldPath(e.target.id)) return;
  cusFocusedId = e.target.id;
  applyCustomerHighlight();
});
document.addEventListener('focusout', (e) => {
  if (!accountFieldPath(e.target.id)) return;
  cusFocusedId = null;
  applyCustomerHighlight();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#acct-create')) { fireCreateCustomer(); return; }
  // leftView isn't a RESET_KEY, so the in-flight checkout survives the trip.
});

/* Credentials/customer changing (a save harvest, a profile re-key, forget) —
   repaint the step, but never over a field being typed into. */
customers.subscribeCustomers(() => {
  if (state.leftView !== 'client') return;
  // The card first: safe even mid-typing (it never touches the left panel), and
  // a customer arriving from a backfill has to reach the badge too.
  refreshCustomerBeatCard();
  syncWebhooks();
  if ($('#acct-block')?.contains(document.activeElement)) return;
  refreshAccountPanel();
});

/* ── Toast (same shape as own-fields') ───────────────────── */
function toast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

/** Called by app.js on every flow render: keep the webhook panel's customer
    section in step with the mode (guest ⇄ account) and the active MID. */
export function syncCustomerBeat() { syncWebhooks(); }
