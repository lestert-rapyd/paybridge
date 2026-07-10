/* ─────────────────────────────────────────────────────────────
   Own Card Fields flow (PCI-DSS model).
   Merchant fields collect the card; submit fires the real Rapyd
   POST /v1/payments. Focus/typing highlights + updates the live
   request body in the Request tab. Renders into the tabbed panels.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import { createDirectPayment } from '../api.js';
import { renderJSON, highlightPaths } from '../json-view.js';
import { setActiveTab, setStatus } from '../ui.js';
import {
  FIELD_MAP, FIELD_LABEL, detectBrand,
  formatNumber, formatExpiry, parseExpiry,
} from '../sync.js';

const $ = (s, r = document) => r.querySelector(s);

const card = { number: '', expiry: '', cvv: '', name: '' };
let tds = false;
let focusedId = null;
let sent = false;

const ACCESS_KEY = 'rak_' + randHex(20).toUpperCase();
let sig = freshSig();

function randHex(n) { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return s; }
function randB64(n) { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
function freshSig() { return { salt: randHex(12), timestamp: Math.floor(Date.now() / 1000).toString(), signature: randB64(43) + '=' }; }

/* ── Request bodies ──────────────────────────────────────── */
function displayBody() {
  const p = VERTICALS[state.vertical].product;
  const { type } = detectBrand(card.number);
  const { month, year } = parseExpiry(card.expiry);
  const body = {
    amount: Number(p.amount),
    currency: p.currency,
    capture: true,
    payment_method: {
      type,
      fields: {
        number: card.number.replace(/\s/g, ''),
        expiration_month: month,
        expiration_year: year,
        cvv: card.cvv,
        name: card.name,
      },
    },
    merchant_reference_id: state.reference || '(assigned on submit)',
  };
  if (tds) body.payment_method_options = { '3d_required': true };
  return body;
}

function postBody() {
  const b = displayBody();
  b.merchant_reference_id = state.reference;
  return { ...b, env: state.env };
}

/* ── Left panel markup ───────────────────────────────────── */
export function renderPaymentHTML() {
  const v = VERTICALS[state.vertical];
  const p = v.product;
  return `
    <div class="co-field">
      <label>Card number</label>
      <div class="co-input">
        <span class="field-ico">💳</span>
        <input id="f-number" inputmode="numeric" autocomplete="cc-number" placeholder="4111 1111 1111 1111" maxlength="23" />
        <span class="card-brand" id="card-brand"></span>
      </div>
      <div class="field-map" id="map-f-number"></div>
    </div>
    <div class="co-row">
      <div class="co-field">
        <label>Expiry</label>
        <div class="co-input"><input id="f-expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="12 / 27" maxlength="7" /></div>
        <div class="field-map" id="map-f-expiry"></div>
      </div>
      <div class="co-field">
        <label>CVV</label>
        <div class="co-input"><input id="f-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" /></div>
        <div class="field-map" id="map-f-cvv"></div>
      </div>
    </div>
    <div class="co-field">
      <label>Name on card</label>
      <div class="co-input"><input id="f-name" autocomplete="cc-name" placeholder="Jordan Taylor" /></div>
      <div class="field-map" id="map-f-name"></div>
    </div>
    <label class="co-tds">
      <input type="checkbox" id="f-tds" ${tds ? 'checked' : ''} />
      <span>Require 3-D Secure <em>· adds <code>payment_method_options</code></em></span>
    </label>
    <button class="co-cta" id="pay-btn">${v.cta} ${p.symbol}${p.amount}</button>
    <div class="co-secure">🔒 Card posts from this page to <b>&nbsp;/v1/payments</b></div>`;
}

/* ── Request panel ───────────────────────────────────────── */
function headerRows() {
  const host = state.env === 'live' ? 'api.rapyd.net' : 'sandboxapi.rapyd.net';
  return `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">https://${host}/v1/payments</span></div>
    <p class="eng-label">Headers</p>
    <div class="req-headers">
      <div><span class="hk">access_key:</span> <span class="hv">${ACCESS_KEY}</span></div>
      <div><span class="hk">salt:</span> <span class="hv">${sig.salt}</span></div>
      <div><span class="hk">timestamp:</span> <span class="hv">${sig.timestamp}</span></div>
      <div><span class="hk">signature:</span> <span class="hv">${sig.signature}</span></div>
      <div><span class="hk">Content-Type:</span> <span class="hv">application/json</span></div>
    </div>`;
}

function renderRequest() {
  const el = $('#panel-request');
  if (!el) return;
  el.innerHTML = `
    ${headerRows()}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">${sent ? 'signed &amp; sent' : 'updates as you type'}</span></div>
    <div class="code" id="req-json">${renderJSON(displayBody())}</div>`;
  applyHighlight();
}

function applyHighlight() {
  highlightPaths($('#req-json'), focusedId ? (FIELD_MAP[focusedId] || []) : []);
}

/* ── Response panel ──────────────────────────────────────── */
function renderResponse(httpStatus, data) {
  const ok = httpStatus < 400;
  $('#panel-response').innerHTML = `
    <div class="resp-http ${ok ? 'ok' : 'err'}"><span class="rc">HTTP ${httpStatus}</span></div>
    <div class="code">${renderJSON(data ?? { error: 'no response body' })}</div>`;
}

/* ── Outcome → status + webhooks panel ───────────────────── */
function interpretOutcome(httpStatus, data) {
  const d = data?.data;
  const wh = $('#panel-webhooks');
  if (d?.status === 'CLO' && d?.paid) {
    setStatus('Paid · CLO', 'ok');
    toast('✅ Payment complete — status CLO, paid: true');
    wh.innerHTML = lifecycleHint('PAYMENT_COMPLETED', 'Rapyd would fire this webhook to your server.', 'ok');
  } else if (d?.status === 'ACT' && d?.next_action === '3d_verification') {
    setStatus('3DS required', 'action');
    toast('🔐 3-D Secure required');
    wh.innerHTML = `
      <div class="tds-prompt">
        <div class="tds-title">3-D Secure challenge required</div>
        <div class="tds-desc">Payment is <code>ACT</code> · <code>paid:false</code> · <code>next_action: 3d_verification</code>. The customer completes the challenge, then Rapyd fires the outcome webhook.</div>
        <button class="mini-cta" id="open-3ds">Open 3DS challenge ↗</button>
      </div>`;
    $('#open-3ds')?.addEventListener('click', () => window.open(d.redirect_url, '_blank', 'noopener'));
  } else {
    setStatus('Declined', 'error');
    toast(`❌ ${data?.message || data?.error || 'Payment failed'}`, 'err');
    wh.innerHTML = lifecycleHint('PAYMENT_FAILED', data?.message || 'The payment was declined.', 'err');
  }
}

function lifecycleHint(evt, desc, cls) {
  return `<div class="wh-hint ${cls}"><div class="wh-evt">${evt}</div>
    <div class="wh-desc">${desc} <em>Live webhook delivery is wired in Phase 4.</em></div></div>`;
}

/* ── Submit ──────────────────────────────────────────────── */
async function pay() {
  const btn = $('#pay-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Processing…';
  setStatus('Processing…', 'processing');
  state.reference = `pb_${state.vertical}_${Date.now()}`;
  sig = freshSig();
  sent = true;
  renderRequest();
  setActiveTab('response');
  $('#panel-response').innerHTML = `<div class="eng-sending"><span class="spin"></span>Awaiting Rapyd response…</div>`;
  try {
    const { httpStatus, data } = await createDirectPayment(postBody());
    renderResponse(httpStatus, data);
    interpretOutcome(httpStatus, data);
  } catch (err) {
    renderResponse(0, { error: 'network_error', message: err.message });
    setStatus('Error', 'error');
    toast(`❌ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    sent = false;
  }
}

/* ── Fields ──────────────────────────────────────────────── */
function updateBrand() {
  const el = $('#card-brand');
  if (el) el.textContent = detectBrand(card.number).brand;
}
function showMap(id) { const el = document.getElementById(`map-${id}`); if (el) el.textContent = `↳ maps to  ${FIELD_LABEL[id]}`; }
function hideMaps() { document.querySelectorAll('.field-map').forEach(e => (e.textContent = '')); }

function fillTestCard() {
  const set = (id, val) => { const el = $(`#${id}`); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('f-number', '4111 1111 1111 1111');
  set('f-expiry', '12 / 27');
  set('f-cvv', '123');
  set('f-name', 'Jordan Taylor');
}

export function mount() {
  const els = { number: $('#f-number'), expiry: $('#f-expiry'), cvv: $('#f-cvv'), name: $('#f-name') };
  els.number.value = card.number;
  els.expiry.value = card.expiry;
  els.cvv.value    = card.cvv;
  els.name.value   = card.name;
  updateBrand();
  sent = false;
  renderRequest();

  const wire = (key, el, formatter) => {
    el.addEventListener('input', () => {
      if (formatter) el.value = formatter(el.value);
      card[key] = el.value;
      if (key === 'number') updateBrand();
      setStatus('Drafting request', 'drafting');
      renderRequest();
    });
    el.addEventListener('focus', () => { focusedId = el.id; showMap(el.id); applyHighlight(); });
    el.addEventListener('blur',  () => { focusedId = null; hideMaps(); applyHighlight(); });
  };
  wire('number', els.number, formatNumber);
  wire('expiry', els.expiry, formatExpiry);
  wire('cvv',    els.cvv,    v => v.replace(/\D/g, '').slice(0, 4));
  wire('name',   els.name,   null);

  $('#f-tds').addEventListener('change', e => { tds = e.target.checked; renderRequest(); });
  $('#pay-btn').addEventListener('click', pay);
  $('#use-test')?.addEventListener('click', fillTestCard);
}

/* ── Toast ───────────────────────────────────────────────── */
function toast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
