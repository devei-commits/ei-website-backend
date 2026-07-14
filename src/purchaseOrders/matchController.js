/**
 * 3-way match + Payment → Closed controller (Flowchart Sub-flow I).
 *
 *   GRN DONE + Invoice → [3-way match PO↔GRN↔Invoice]
 *        pass → record payment → mark PAID → CLOSE PO (status Completed)
 *        variance → payment/close blocked unless explicitly overridden (with note)
 *
 * Invoice / match / final-payment / closure state lives on po_tracking (the per-PO
 * lifecycle record). GRN received/billed qty is read from goods_received_notes.line_items.
 */
const PurchaseOrder = require('./models');
const PoTracking = require('../poTracking/models');
const ProcurementRequest = require('../procurementRequests/models');
const PoApprovalLog = require('./poApprovalLog.model');
const GoodsReceivedNote = require('../grn/models');
const { computeThreeWayMatch } = require('./threeWayMatch');

// Treasury linkage is optional — the 3-way match must work even if Treasury is absent.
let createOutwardFromSource = null;
let TreasuryOutwardPayment = null;
try { ({ createOutwardFromSource } = require('../treasury/sourceLink')); } catch (_e) { /* optional */ }
try { ({ TreasuryOutwardPayment } = require('../treasury/models')); } catch (_e) { /* optional */ }

const PAYMENT_MODES = ['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'other'];

/** Parse "Net 30" / "Net-45" style terms → days; default 7. */
function paymentTermDays(paymentTerms) {
  const m = String(paymentTerms || '').match(/net\s*-?\s*(\d{1,3})/i);
  if (m) return Math.min(180, parseInt(m[1], 10));
  return 7;
}
function addDaysDateOnly(dateOnly, days) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(dateOnly || '')) ? String(dateOnly) : todayDateOnly();
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isMissingColumnError(err) {
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '42703';
}
function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}
function actorFromReq(req) {
  const u = req.user || {};
  return {
    id: Number.isFinite(Number(u.id)) ? Number(u.id) : null,
    name: u.fullName || u.email || 'Unknown',
    role: String(u.role || '').trim().toLowerCase() || null,
  };
}

async function writeLog(id, { action, fromStatus, toStatus, actor, note, amount }) {
  try {
    await PoApprovalLog.create({
      purchase_order_id: id,
      action,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      amount: amount != null ? amount : null,
      actor_id: actor.id,
      actor_name: actor.name,
      actor_role: actor.role,
      note: note ? String(note).slice(0, 1000) : null,
    });
  } catch (err) {
    if (!isMissingColumnError(err)) console.warn('[poMatch] writeLog failed:', err && err.message ? err.message : err);
  }
}

function schemaError(res) {
  return res.status(409).json({ error: 'PO lifecycle columns are not migrated on this database yet.', code: 'MATCH_SCHEMA_MISSING' });
}

async function loadContext(id) {
  let po;
  try {
    po = await PurchaseOrder.findByPk(id, { attributes: ['id', 'order_id', 'status', 'items', 'form_data', 'vendor_name', 'payment_terms', 'rtv_status', 'short_closed_at'] });
  } catch (err) {
    if (isMissingColumnError(err)) return { schemaMissing: true };
    throw err;
  }
  if (!po) return { notFound: true };
  const tracking = await PoTracking.findOne({ where: { purchase_order_id: id } });
  const grns = await GoodsReceivedNote.findAll({ where: { purchase_order_id: id } }).catch(() => []);
  return { po, tracking, grns };
}

function grnPlainRows(grns) {
  return (grns || []).map((g) => (g.get ? g.get({ plain: true }) : g));
}

/** True when any GRN for this PO is completed (grn_complete_at set, or a GRN row is 'GRN Complete'). */
function grnIsComplete(tracking, grnRows) {
  const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
  if (t && t.grn_complete_at) return true;
  return (grnRows || []).some((g) => String(g.status || '').toLowerCase().replace(/\s+/g, '') === 'grncomplete' || String(g.stage || '') === 'grn_completed');
}

/** Look up the Treasury outward payment linked to this PO, if any. */
async function loadTreasuryLink(id) {
  if (!TreasuryOutwardPayment) return null;
  try {
    const row = await TreasuryOutwardPayment.findOne({
      where: { source_ref_type: 'purchase_order', source_ref_id: id },
      order: [['id', 'DESC']],
    });
    if (!row) return null;
    const d = row.get ? row.get({ plain: true }) : row;
    return {
      outwardId: d.id,
      outwardCode: d.outward_code,
      status: d.status,
      netAmount: d.net_amount != null ? Number(d.net_amount) : null,
      utr: d.utr_reference ?? null,
      paidAt: d.paid_at ?? null,
    };
  } catch (e) {
    console.warn('[poMatch] loadTreasuryLink failed:', e && e.message ? e.message : e);
    return null;
  }
}

async function buildMatchState(id, po, tracking, grns) {
  const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
  const grnRows = grnPlainRows(grns);
  const invoiceAmount = t && t.invoice_amount != null ? Number(t.invoice_amount) : null;
  const match = computeThreeWayMatch({ poItems: po.get('items'), grnRows, invoiceAmount });
  const grnComplete = grnIsComplete(tracking, grnRows);

  const treasury = await loadTreasuryLink(id);
  const treasuryPaid = !!(treasury && (treasury.status === 'paid' || treasury.status === 'reconciled'));

  const storedMatch = t?.match_status || null;
  // Paid when the final-payment date is stamped (manual or via Treasury execution), or Treasury marks it paid.
  const isPaid = !!(t && (t.final_paid_at || t.payment_transaction_no)) || treasuryPaid;
  const isClosed = !!(t && t.closed_at);
  const sentToTreasury = !!treasury;
  // An open RTV (QC-fail return to vendor) blocks payment + close until resolved.
  const rtvRaised = String(po.get('rtv_status') || '') === 'raised';
  const shortClosed = !!po.get('short_closed_at');
  // Payment/close allowed when computed verdict passes OR an override was stored (match_status='overridden').
  const matchCleared = match.verdict === 'pass' || storedMatch === 'overridden';

  return {
    id: String(id),
    orderId: po.get('order_id'),
    poStatus: po.get('status') ?? null,
    grnComplete,
    match, // { lines, totals, verdict }
    matchStatus: storedMatch,
    matchNote: t?.match_note ?? null,
    invoice: {
      invoiceNo: t?.invoice_no ?? null,
      invoiceDate: t?.invoice_date ?? null,
      invoiceAmount,
    },
    payment: {
      advancePaidAt: t?.advance_paid_at ?? null,
      finalPaidAt: t?.final_paid_at ?? null,
      finalPaidAmount: t && t.final_paid_amount != null ? Number(t.final_paid_amount) : null,
      transactionNo: t?.payment_transaction_no ?? null,
      mode: t?.payment_mode ?? null,
      transactionDate: t?.payment_transaction_date ?? null,
      isPaid,
    },
    treasury: treasury
      ? { outwardId: treasury.outwardId, outwardCode: treasury.outwardCode, status: treasury.status, netAmount: treasury.netAmount, utr: treasury.utr, paidAt: treasury.paidAt }
      : null,
    sentToTreasury,
    rtvRaised,
    shortClosed,
    closure: {
      closedAt: t?.closed_at ?? null,
      closedNote: t?.closed_note ?? null,
      isClosed,
    },
    // Gating flags for the UI. An open RTV blocks payment/treasury/close.
    hasInvoice: invoiceAmount != null,
    canPay: grnComplete && matchCleared && !isPaid && !rtvRaised,
    canClose: grnComplete && matchCleared && !isClosed && !rtvRaised,
    canSendToTreasury: grnComplete && matchCleared && !sentToTreasury && !isPaid && !rtvRaised,
    matchCleared,
  };
}

async function upsertTracking(id, tracking, patch) {
  if (tracking) { await tracking.update(patch); return tracking; }
  return PoTracking.create({ purchase_order_id: id, ...patch });
}

/** GET /purchase-orders/:id/match */
async function getMatchState(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadContext(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    return res.json(await buildMatchState(id, po, tracking, grns));
  } catch (err) {
    console.error('getMatchState error', err);
    return res.status(500).json({ error: 'Failed to load 3-way match' });
  }
}

/** POST /purchase-orders/:id/match/invoice  { invoiceNo, invoiceDate, invoiceAmount } */
async function captureInvoice(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadContext(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const b = req.body || {};
    const amount = Number(b.invoiceAmount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'A positive invoiceAmount is required.' });
    const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.invoiceDate || '')) ? String(b.invoiceDate) : todayDateOnly();

    // Recompute verdict with the new invoice to store an initial match_status.
    const grnRows = grnPlainRows(grns);
    const match = computeThreeWayMatch({ poItems: po.get('items'), grnRows, invoiceAmount: amount });
    const nextMatch = match.verdict === 'pass' ? 'pass' : 'variance';

    const updated = await upsertTracking(id, tracking, {
      invoice_no: b.invoiceNo ? String(b.invoiceNo).slice(0, 100) : null,
      invoice_date: invoiceDate,
      invoice_amount: amount,
      match_status: nextMatch,
      matched_at: new Date(),
      match_note: null,
    }).catch((err) => { if (isMissingColumnError(err)) return '__SCHEMA__'; throw err; });
    if (updated === '__SCHEMA__') return schemaError(res);

    await writeLog(id, { action: 'invoice_captured', toStatus: nextMatch, actor: actorFromReq(req), note: b.invoiceNo || null, amount });
    return res.json(await buildMatchState(id, po, updated, grns));
  } catch (err) {
    console.error('captureInvoice error', err);
    return res.status(500).json({ error: 'Failed to capture invoice' });
  }
}

/** POST /purchase-orders/:id/match/override  { note }  — accept a variance to proceed. */
async function overrideMatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadContext(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    if (!t || t.invoice_amount == null) return res.status(409).json({ error: 'Capture the vendor invoice before overriding the match.', code: 'NO_INVOICE' });
    const note = req.body && req.body.note ? String(req.body.note) : null;
    if (!note) return res.status(400).json({ error: 'A justification note is required to override a variance.' });

    const updated = await upsertTracking(id, tracking, { match_status: 'overridden', matched_at: new Date(), match_note: note })
      .catch((err) => { if (isMissingColumnError(err)) return '__SCHEMA__'; throw err; });
    if (updated === '__SCHEMA__') return schemaError(res);
    await writeLog(id, { action: 'match_override', toStatus: 'overridden', actor: actorFromReq(req), note });
    return res.json(await buildMatchState(id, po, updated, grns));
  } catch (err) {
    console.error('overrideMatch error', err);
    return res.status(500).json({ error: 'Failed to override match' });
  }
}

/** POST /purchase-orders/:id/match/pay  { mode, transactionNo, amount, date } */
async function recordFinalPayment(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadContext(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const state = await buildMatchState(id, po, tracking, grns);
    if (!state.grnComplete) return res.status(409).json({ error: 'GRN is not complete for this PO.', code: 'GRN_INCOMPLETE' });
    if (!state.matchCleared) return res.status(409).json({ error: '3-way match has a variance. Resolve or override it before paying.', code: 'MATCH_NOT_CLEARED' });
    if (state.rtvRaised) return res.status(409).json({ error: 'An RTV (return to vendor) is open — resolve it before paying.', code: 'RTV_RAISED' });
    if (state.payment.isPaid) return res.status(409).json({ error: 'Final payment already recorded.', code: 'ALREADY_PAID' });

    const b = req.body || {};
    const amount = Number(b.amount);
    const modeRaw = String(b.mode || '').trim().toLowerCase();
    const mode = PAYMENT_MODES.includes(modeRaw) ? modeRaw : 'other';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : todayDateOnly();

    const updated = await upsertTracking(id, tracking, {
      final_paid_at: date,
      final_paid_amount: Number.isFinite(amount) && amount > 0 ? amount : (state.invoice.invoiceAmount ?? null),
      payment_transaction_no: b.transactionNo ? String(b.transactionNo).slice(0, 100) : null,
      payment_mode: mode,
      payment_transaction_date: date,
    }).catch((err) => { if (isMissingColumnError(err)) return '__SCHEMA__'; throw err; });
    if (updated === '__SCHEMA__') return schemaError(res);

    await writeLog(id, { action: 'final_payment', toStatus: 'paid', actor: actorFromReq(req), note: b.transactionNo || mode, amount });
    return res.json(await buildMatchState(id, po, updated, grns));
  } catch (err) {
    console.error('recordFinalPayment error', err);
    return res.status(500).json({ error: 'Failed to record payment' });
  }
}

/** POST /purchase-orders/:id/match/close  { note } */
async function closePo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadContext(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const state = await buildMatchState(id, po, tracking, grns);
    if (state.closure.isClosed) return res.status(409).json({ error: 'PO is already closed.', code: 'ALREADY_CLOSED' });
    if (!state.grnComplete) return res.status(409).json({ error: 'GRN is not complete for this PO.', code: 'GRN_INCOMPLETE' });
    if (!state.matchCleared) return res.status(409).json({ error: '3-way match has a variance. Resolve or override it before closing.', code: 'MATCH_NOT_CLEARED' });
    if (state.rtvRaised) return res.status(409).json({ error: 'An RTV (return to vendor) is open — resolve it before closing.', code: 'RTV_RAISED' });

    const note = req.body && req.body.note ? String(req.body.note) : null;
    const updated = await upsertTracking(id, tracking, { closed_at: new Date(), closed_note: note })
      .catch((err) => { if (isMissingColumnError(err)) return '__SCHEMA__'; throw err; });
    if (updated === '__SCHEMA__') return schemaError(res);

    // Mark the PO row + linked request as completed.
    await po.update({ status: 'Completed' });
    try {
      const fd = po.get('form_data');
      const raw = fd && typeof fd === 'object' ? (fd.requestId ?? fd.request_id) : null;
      const reqId = parseInt(String(raw ?? '').replace(/\D/g, '') || '0', 10);
      if (Number.isFinite(reqId) && reqId > 0) await ProcurementRequest.update({ status: 'Completed' }, { where: { id: reqId } });
    } catch (e) {
      console.warn('[poMatch] request status sync on close failed:', e && e.message ? e.message : e);
    }

    // Recompute the vendor's rating on close (Flowchart CLOSED downstream). Best-effort.
    try {
      const { recomputeVendorRating } = require('./vendorRating');
      const fd = po.get('form_data');
      const vendorClientId = fd && typeof fd === 'object' ? (fd.vendorClientId ?? fd.vendor_client_id ?? null) : null;
      await recomputeVendorRating({ vendorClientId, vendorName: po.get('vendor_name') });
    } catch (e) {
      console.warn('[poMatch] vendor rating recompute on close failed:', e && e.message ? e.message : e);
    }

    await writeLog(id, { action: 'po_closed', toStatus: 'closed', actor: actorFromReq(req), note });
    return res.json(await buildMatchState(id, po, updated, grns));
  } catch (err) {
    console.error('closePo error', err);
    return res.status(500).json({ error: 'Failed to close PO' });
  }
}

/**
 * POST /purchase-orders/:id/match/treasury
 * Push the vendor payable into Treasury (Flowchart Sub-flow I → Treasury outward).
 * Treasury runs its cashflow-gated approval + execution; on execute it stamps the
 * PO's payment fields back via applyReceiptToSource.
 */
async function sendToTreasury(req, res) {
  try {
    if (!createOutwardFromSource) return res.status(503).json({ error: 'Treasury module is not available.', code: 'TREASURY_UNAVAILABLE' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadContext(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const state = await buildMatchState(id, po, tracking, grns);
    if (!state.grnComplete) return res.status(409).json({ error: 'GRN is not complete for this PO.', code: 'GRN_INCOMPLETE' });
    if (!state.matchCleared) return res.status(409).json({ error: '3-way match has a variance. Resolve or override it before sending to Treasury.', code: 'MATCH_NOT_CLEARED' });
    if (state.rtvRaised) return res.status(409).json({ error: 'An RTV (return to vendor) is open — resolve it before sending to Treasury.', code: 'RTV_RAISED' });
    if (state.sentToTreasury) return res.status(409).json({ error: `Already sent to Treasury (${state.treasury?.outwardCode}).`, code: 'ALREADY_SENT' });

    const amount = state.invoice.invoiceAmount ?? state.match.totals.receivedPayable;
    if (!(Number(amount) > 0)) return res.status(409).json({ error: 'No payable amount — capture the vendor invoice first.', code: 'NO_AMOUNT' });

    const fd = po.get('form_data');
    const vendorClientId = fd && typeof fd === 'object' ? (fd.vendorClientId ?? fd.vendor_client_id ?? null) : null;
    const orderId = po.get('order_id') || `PO-${id}`;
    const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    const paymentTerms = po.get('payment_terms');
    const dueDate = addDaysDateOnly(t?.grn_complete_at || todayDateOnly(), paymentTermDays(paymentTerms));

    const { payment, created } = await createOutwardFromSource(
      {
        sourceModule: 'procurement',
        sourceSubtype: 'PO Vendor Payment',
        sourceRefType: 'purchase_order',
        sourceRefId: id,
        sourceRefLabel: orderId,
        payeeType: 'vendor',
        payeeId: vendorClientId || null,
        payeeName: po.get('vendor_name') || 'Vendor',
        purpose: `Payment for ${orderId} (3-way match cleared)`,
        amount: Number(amount),
        dueDate,
        autoSubmit: true,
      },
      req,
    );

    const outwardCode = (payment.get ? payment.get({ plain: true }) : payment).outward_code;
    await writeLog(id, { action: 'sent_to_treasury', toStatus: 'submitted', actor: actorFromReq(req), note: outwardCode, amount: Number(amount) });
    const out = await buildMatchState(id, po, tracking, grns);
    out.treasuryJustCreated = created;
    return res.json(out);
  } catch (err) {
    console.error('sendToTreasury error', err);
    return res.status(500).json({ error: 'Failed to send payable to Treasury' });
  }
}

module.exports = {
  getMatchState,
  captureInvoice,
  overrideMatch,
  recordFinalPayment,
  sendToTreasury,
  closePo,
};
