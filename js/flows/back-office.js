/* ─────────────────────────────────────────────────────────────
   Client Back Office — the merchant-ops surface. Lists every payment
   made this session (from either flow) with its LIVE status, and lets
   an SE fire a refund off any completed one.

   Reuses the same right-hand engine-room panels as the customer-facing
   flows (renderJSONView, headersHTML/fillSignature) — the right panel
   doesn't care who initiated the call. Only paints those panels while
   this tab is actually active (mirrors the guard in webhooks.js), so it
   can never clobber the client flow's own Request/Response while hidden.
   ───────────────────────────────────────────────────────────── */

import { state } from '../state.js';
import { VERTICALS } from '../verticals.js';
import { createRefund } from '../api.js';
import { renderJSONView } from '../json-view.js';
import { setActiveTab } from '../ui.js';
import { headersHTML, fillSignature, newSaltTimestamp } from '../signing.js';
import { getLedger, subscribeLedger, recordRefund, updateRefund } from '../ledger.js';

const $ = (s, r = document) => r.querySelector(s);

const PHASE_LABEL = {
  created: 'Created',
  pending_3ds: 'Pending · 3DS',
  awaiting_confirmation: 'Awaiting confirmation',
  completed: 'Completed',
  failed: 'Failed',
  declined: 'Declined',
  error: 'Error',
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusKind(status) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'failure';
  return 'pending';
}

function pill(text, kind) { return `<span class="wh-pill ${kind}">${text}</span>`; }

function refundLineHTML(r) {
  const kind = statusKind(r.status);
  const amt = r.amount != null ? `${r.amount} ${r.currency || ''}`.trim() : 'reconverted at current rate';
  return `
    <div class="bo-refund-line">
      ${pill(r.status, kind)}
      <span class="bo-refund-amt">${amt}</span>
      ${r.reason ? `<span class="bo-refund-reason-txt">${esc(r.reason)}</span>` : ''}
    </div>`;
}

function refundPanelHTML(e) {
  return `
    <div class="bo-refund-panel">
      <div class="bo-refund-field">
        <label>Reason</label>
        <input type="text" class="bo-refund-input" id="bo-reason-${e.reference}" placeholder="e.g. Faulty merchandise" />
      </div>
      <div class="bo-refund-field">
        <label>Amount — FX-safe (editable, defaults to what the customer paid)</label>
        <div class="bo-refund-amtfield">
          <input type="text" class="bo-refund-input bo-refund-amount" id="bo-amount-${e.reference}" value="${e.amount}" />
          <span class="bo-refund-currency">${e.currency}</span>
        </div>
      </div>
      <div class="bo-refund-actions">
        <button class="bo-refund-btn safe" data-ref="${e.reference}" data-mode="safe">Refund — FX-safe</button>
        <button class="bo-refund-btn naive" data-ref="${e.reference}" data-mode="naive">Refund — naive (reconverts)</button>
      </div>
    </div>`;
}

function rowHTML(e) {
  const v = VERTICALS[e.vertical];
  const fxBadge = e.requested_currency
    ? `<span class="bo-fx-badge">FX → ${e.requested_currency} · ${e.fixed_side}</span>`
    : '';
  return `
    <div class="bo-row">
      <div class="bo-row-head">
        <div class="bo-row-main">
          <span class="bo-model-tag">${e.model === 'toolkit' ? 'Toolkit' : 'Own fields'}</span>
          <span class="bo-vertical">${v?.label || e.vertical}</span>
          <code class="bo-ref">${e.reference}</code>
        </div>
        <div class="bo-row-side">
          <span class="bo-amt">${e.amount} ${e.currency}</span>
          ${pill(PHASE_LABEL[e.phase] || e.status, statusKind(e.status))}
        </div>
      </div>
      ${fxBadge}
      ${e.refunds.length ? `<div class="bo-refunds">${e.refunds.map(refundLineHTML).join('')}</div>` : ''}
      ${e.status === 'completed' ? refundPanelHTML(e) : ''}
    </div>`;
}

export function render() {
  if (state.leftView !== 'backoffice') return;
  const el = $('#backoffice');
  if (!el) return;
  const entries = getLedger();
  if (!entries.length) {
    el.innerHTML = `<div class="eng-empty"><div class="ee-ico">🗂️</div><div class="ee-text">Payments made this session will show up here, live, whichever flow made them.</div></div>`;
    return;
  }
  el.innerHTML = `<div class="bo-list">${entries.map(rowHTML).join('')}</div>`;
}

/* ── Right panel: this action's own request/response ─────── */
function renderBoRequest(body) {
  const el = $('#panel-request');
  if (!el || state.leftView !== 'backoffice') return;
  const st = newSaltTimestamp();
  el.innerHTML = `
    <div class="req-headline"><span class="method-pill post">POST</span><span class="req-path">/v1/refunds</span></div>
    ${headersHTML(st)}
    <div class="req-bodylabel"><p class="eng-label">Request body</p><span class="hint">back office · refund</span></div>
    ${renderJSONView(body)}`;
  fillSignature(el, 'post', '/v1/refunds', st, body);
}
function renderBoResponse(data, ok) {
  const el = $('#panel-response');
  if (!el || state.leftView !== 'backoffice') return;
  el.innerHTML = `
    <div class="eng-pillrow">
      <span class="wh-pill ${ok ? 'success' : 'failure'}">HTTP ${ok ? 200 : 400}</span>
      <span class="wh-pill ${ok ? 'success' : 'failure'}">${ok ? 'REFUND CREATED' : 'ERROR'}</span>
    </div>
    ${renderJSONView(data ?? { error: 'no response body' })}`;
}

/* ── Fire a refund ────────────────────────────────────────── */
async function fireRefund(reference, mode) {
  const entry = getLedger().find(e => e.reference === reference);
  if (!entry) return;

  const reasonEl = $(`#bo-reason-${reference}`);
  const reason = reasonEl?.value || '';
  const refundRef = `${reference}_refund_${Date.now()}`;

  let amount = null;
  let currency = null;
  if (mode === 'safe') {
    const amountEl = $(`#bo-amount-${reference}`);
    const parsed = Number(amountEl?.value);
    if (!Number.isFinite(parsed) || parsed <= 0) return; // guard against a blank/invalid amount
    amount = parsed;
    currency = entry.currency;
  }
  // naive mode: no amount/currency — reconverts the merchant's received
  // amount at the current rate, which is exactly the trap this demo shows.

  recordRefund(reference, { reference: refundRef, amount, currency, reason });

  const body = {
    payment: entry.payment_id,
    merchant_reference_id: refundRef,
    reason,
    ...(amount != null ? { amount, currency } : {}),
    env: state.env,
  };
  renderBoRequest(body);
  setActiveTab('request');

  try {
    const { httpStatus, data } = await createRefund(body);
    renderBoResponse(data, httpStatus < 400);
    setActiveTab('response');

    const d = data?.data;
    if (d?.id) updateRefund(reference, refundRef, { refund_id: d.id, amount: d.amount ?? amount, currency: d.currency ?? currency });
    if (data?.error) updateRefund(reference, refundRef, { status: 'failed' });
  } catch (err) {
    renderBoResponse({ error: 'network_error', message: err.message }, false);
    setActiveTab('response');
    updateRefund(reference, refundRef, { status: 'failed' });
  }
}

export function mount() {
  subscribeLedger(() => { if (state.leftView === 'backoffice') render(); });

  $('#backoffice').addEventListener('click', e => {
    const btn = e.target.closest('.bo-refund-btn[data-ref]');
    if (!btn) return;
    btn.disabled = true;
    fireRefund(btn.dataset.ref, btn.dataset.mode).finally(() => { btn.disabled = false; });
  });
}
