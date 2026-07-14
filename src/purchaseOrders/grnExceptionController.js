/**
 * GRN-stage PO exceptions (Flowchart: Short-supply · QC-fail RTV) — PO-side only.
 *
 * Reads goods_received_notes READ-ONLY (received qty + qc_status); never mutates
 * the GRN module. The physical return transfer + payables adjustment for an RTV
 * remain warehouse/treasury concerns and are out of scope here.
 *
 *   SHORT-CLOSE  partial GRN → accept received qty as final, reopen PR balance,
 *                override the match variance so payment proceeds on received qty.
 *   RTV          QC-fail (grn.qc_status='Rejected') → raise a return-to-vendor,
 *                record a debit-note ref, and BLOCK payment/close until resolved.
 */
const PurchaseOrder = require('./models');
const PoTracking = require('../poTracking/models');
const ProcurementRequest = require('../procurementRequests/models');
const PoApprovalLog = require('./poApprovalLog.model');
const GoodsReceivedNote = require('../grn/models');
const { computeThreeWayMatch } = require('./threeWayMatch');

const PO_ATTRS = [
  'id', 'order_id', 'status', 'items', 'form_data', 'exception_status',
  'short_closed_at', 'short_close_note', 'rtv_status', 'rtv_reason', 'rtv_debit_note_ref', 'rtv_at',
];

function isMissingColumnError(err) {
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '42703';
}
function actorFromReq(req) {
  const u = req.user || {};
  return {
    id: Number.isFinite(Number(u.id)) ? Number(u.id) : null,
    name: u.fullName || u.email || 'Unknown',
    role: String(u.role || '').trim().toLowerCase() || null,
  };
}
function schemaError(res) {
  return res.status(409).json({ error: 'PO GRN-exception columns are not migrated on this database yet.', code: 'GRN_EXCEPTION_SCHEMA_MISSING' });
}

async function writeLog(id, { action, toStatus, actor, note }) {
  try {
    await PoApprovalLog.create({
      purchase_order_id: id, action, to_status: toStatus || null,
      actor_id: actor.id, actor_name: actor.name, actor_role: actor.role,
      note: note ? String(note).slice(0, 1000) : null,
    });
  } catch (err) {
    if (!isMissingColumnError(err)) console.warn('[poGrnException] writeLog failed:', err && err.message ? err.message : err);
  }
}

async function loadCtx(id) {
  let po;
  try {
    po = await PurchaseOrder.findByPk(id, { attributes: PO_ATTRS });
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
function grnIsComplete(tracking, grnRows) {
  const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
  if (t && t.grn_complete_at) return true;
  return (grnRows || []).some((g) => String(g.status || '').toLowerCase().replace(/\s+/g, '') === 'grncomplete' || String(g.stage || '') === 'grn_completed');
}

/** Read-only QC-fail detection from GRN qc_status (header + per-line). */
function detectQcFail(grnRows) {
  for (const g of grnRows || []) {
    if (String(g.qc_status || '').trim().toLowerCase() === 'rejected') return true;
    const lines = Array.isArray(g.line_items) ? g.line_items : [];
    if (lines.some((l) => String((l && l.qcStatus) || '').trim().toLowerCase() === 'rejected')) return true;
  }
  return false;
}

function computeState(po, tracking, grns) {
  const grnRows = grnPlainRows(grns);
  const grnComplete = grnIsComplete(tracking, grnRows);
  const match = computeThreeWayMatch({ poItems: po.get('items'), grnRows, invoiceAmount: null });
  const partialLines = match.lines
    .filter((l) => l.orderedQty > 0 && l.receivedQty + 1e-6 < l.orderedQty)
    .map((l) => ({ code: l.code, name: l.name, unit: l.unit, orderedQty: l.orderedQty, receivedQty: l.receivedQty, balanceQty: Math.round((l.orderedQty - l.receivedQty) * 1000) / 1000 }));
  const partialReceipt = grnComplete && partialLines.length > 0;
  const qcFailed = detectQcFail(grnRows);

  const shortClosed = !!po.get('short_closed_at');
  const rtvStatus = po.get('rtv_status') || null;
  const rtvRaised = rtvStatus === 'raised';
  const cancelled = String(po.get('exception_status') || '') === 'cancelled';

  return {
    id: String(po.get('id')),
    orderId: po.get('order_id'),
    grnComplete,
    partialReceipt,
    partialLines,
    qcFailed,
    shortClosed,
    shortCloseNote: po.get('short_close_note') ?? null,
    shortClosedAt: po.get('short_closed_at') ?? null,
    rtvStatus,
    rtvRaised,
    rtvReason: po.get('rtv_reason') ?? null,
    rtvDebitNoteRef: po.get('rtv_debit_note_ref') ?? null,
    rtvAt: po.get('rtv_at') ?? null,
    canShortClose: grnComplete && partialReceipt && !shortClosed && !cancelled,
    canRaiseRtv: grnComplete && !rtvRaised && !cancelled,
    canResolveRtv: rtvRaised,
  };
}

async function syncRequestStatus(po, status) {
  const fd = po.get('form_data');
  const raw = fd && typeof fd === 'object' ? (fd.requestId ?? fd.request_id) : null;
  const reqId = parseInt(String(raw ?? '').replace(/\D/g, '') || '0', 10);
  if (!Number.isFinite(reqId) || reqId <= 0) return;
  try { await ProcurementRequest.update({ status }, { where: { id: reqId } }); }
  catch (e) { console.warn('[poGrnException] syncRequestStatus failed:', e && e.message ? e.message : e); }
}

/** GET /purchase-orders/:id/grn-exception */
async function getGrnExceptionState(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    return res.json(computeState(po, tracking, grns));
  } catch (err) {
    console.error('getGrnExceptionState error', err);
    return res.status(500).json({ error: 'Failed to load GRN exception state' });
  }
}

/** POST /purchase-orders/:id/grn-exception/short-close  { note } */
async function shortClosePo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking, grns);
    if (state.shortClosed) return res.status(409).json({ error: 'PO balance is already short-closed.', code: 'ALREADY_SHORT_CLOSED' });
    if (!state.canShortClose) return res.status(409).json({ error: 'No open short-supply balance to close on this PO.', code: 'CANNOT_SHORT_CLOSE' });

    const note = req.body && req.body.note ? String(req.body.note) : null;
    const actor = actorFromReq(req);
    try {
      await po.update({ short_closed_at: new Date(), short_close_note: note });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }

    // Accept partial receipt: override the match variance so payment proceeds on received qty.
    try {
      if (tracking) await tracking.update({ match_status: 'overridden', matched_at: new Date(), match_note: `Short-closed: ${note || 'partial receipt accepted'}` });
      else await PoTracking.create({ purchase_order_id: id, match_status: 'overridden', matched_at: new Date(), match_note: `Short-closed: ${note || 'partial receipt accepted'}` });
    } catch (e) {
      if (!isMissingColumnError(e)) console.warn('[poGrnException] short-close match override failed:', e && e.message ? e.message : e);
    }
    // Reopen the linked PR so Planning re-plans the shortfall balance.
    await syncRequestStatus(po, 'New');
    await writeLog(id, { action: 'po_short_closed', toStatus: 'short_closed', actor, note });
    return res.json(computeState(po, tracking, grns));
  } catch (err) {
    console.error('shortClosePo error', err);
    return res.status(500).json({ error: 'Failed to short-close PO' });
  }
}

/** POST /purchase-orders/:id/grn-exception/rtv  { reason, debitNoteRef } */
async function raiseRtv(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking, grns);
    if (state.rtvRaised) return res.status(409).json({ error: 'An RTV is already raised for this PO.', code: 'RTV_ALREADY_RAISED' });
    if (!state.canRaiseRtv) return res.status(409).json({ error: 'RTV can only be raised after GRN and before closure/cancel.', code: 'CANNOT_RAISE_RTV' });
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    if (!reason) return res.status(400).json({ error: 'A reason is required to raise an RTV.' });

    const actor = actorFromReq(req);
    const debitNoteRef = req.body && req.body.debitNoteRef ? String(req.body.debitNoteRef).slice(0, 120) : null;
    try {
      await po.update({ rtv_status: 'raised', rtv_reason: reason, rtv_debit_note_ref: debitNoteRef, rtv_at: new Date() });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }
    await writeLog(id, { action: 'po_rtv_raised', toStatus: 'rtv_raised', actor, note: debitNoteRef ? `${reason} · DN ${debitNoteRef}` : reason });
    return res.json(computeState(po, tracking, grns));
  } catch (err) {
    console.error('raiseRtv error', err);
    return res.status(500).json({ error: 'Failed to raise RTV' });
  }
}

/** POST /purchase-orders/:id/grn-exception/rtv-resolve  { note } */
async function resolveRtv(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, grns, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking, grns);
    if (!state.rtvRaised) return res.status(409).json({ error: 'No open RTV to resolve.', code: 'NO_OPEN_RTV' });

    const note = req.body && req.body.note ? String(req.body.note) : null;
    const actor = actorFromReq(req);
    try {
      await po.update({ rtv_status: 'resolved' });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }
    await writeLog(id, { action: 'po_rtv_resolved', toStatus: 'rtv_resolved', actor, note });
    return res.json(computeState(po, tracking, grns));
  } catch (err) {
    console.error('resolveRtv error', err);
    return res.status(500).json({ error: 'Failed to resolve RTV' });
  }
}

module.exports = {
  getGrnExceptionState,
  shortClosePo,
  raiseRtv,
  resolveRtv,
  computeState, // exported for unit tests
  detectQcFail,
};
