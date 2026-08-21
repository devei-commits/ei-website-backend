/**
 * PO exception paths (Flowchart "Hold · Amend · Cancel"):
 *
 *   HOLD    any post-draft → exception_status='on_hold' (reason) — pauses workflow
 *   RESUME  on_hold → cleared
 *   CANCEL  before GRN complete → exception_status='cancelled' + status='Cancelled'
 *           · CFO gate when amount > ₹5L · reopens the linked PR (Planning re-plans)
 *   AMEND   post-approval, pre-dispatch → resets approval + vendor loop, status→Draft
 *
 * exception_status is a separate axis from status/approval_status so hold/cancel
 * never clobber workflow state. Vendor-reject lives in the vendor loop already.
 */
const PurchaseOrder = require('./models');
const PoTracking = require('../poTracking/models');
const ProcurementRequest = require('../procurementRequests/models');
const PoApprovalLog = require('./poApprovalLog.model');
const { computePoAmountFromItems, REGULAR_CFO_THRESHOLD } = require('./poApprovalMatrix');
const { userCanActAs } = require('./poApprovalRoles');

const PO_ATTRS = [
  'id', 'order_id', 'status', 'items', 'form_data', 'vendor_name', 'payment_terms',
  'approval_status', 'approved_at', 'exception_status', 'exception_reason', 'exception_at',
  'exception_by', 'amendment_count',
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
  return res.status(409).json({ error: 'PO exception columns are not migrated on this database yet.', code: 'EXCEPTION_SCHEMA_MISSING' });
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
    if (!isMissingColumnError(err)) console.warn('[poException] writeLog failed:', err && err.message ? err.message : err);
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
  return { po, tracking };
}

function computeState(po, tracking) {
  const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
  const exceptionStatus = po.get('exception_status') || null;
  const poStatus = String(po.get('status') || '').trim().toLowerCase();
  const approval = String(po.get('approval_status') || '').trim();
  const amount = computePoAmountFromItems(po.get('items'));
  const grnComplete = !!(t && t.grn_complete_at);
  const shipped = !!(t && t.shipped_at);
  const sent = !!(t && t.po_released_at);
  const isCompleted = poStatus === 'completed';
  const isCancelled = exceptionStatus === 'cancelled';
  const isOnHold = exceptionStatus === 'on_hold';

  return {
    id: String(po.get('id')),
    orderId: po.get('order_id'),
    poStatus: po.get('status') ?? null,
    approvalStatus: approval || null,
    exceptionStatus,
    exceptionReason: po.get('exception_reason') ?? null,
    exceptionAt: po.get('exception_at') ?? null,
    exceptionBy: po.get('exception_by') ?? null,
    amendmentCount: Number(po.get('amendment_count') || 0),
    amount,
    grnComplete,
    shipped,
    onHold: isOnHold,
    cancelled: isCancelled,
    canHold: !isOnHold && !isCancelled && !isCompleted,
    canResume: isOnHold,
    canCancel: !isCancelled && !isCompleted && !grnComplete,
    requiresCfoToCancel: amount > REGULAR_CFO_THRESHOLD,
    // A PO can only ever reach status 'Released' after approval_status was already 'approved'
    // (enforced at release time in both createPurchaseOrder and updatePurchaseOrder), so
    // poStatus === 'released' is itself proof of a passed approval gate — needed as a fallback
    // here because older/legacy POs can carry status 'Released' without a tracking row (or one
    // whose po_released_at was never stamped), which previously made them permanently
    // un-amendable even though they are plainly live, issued purchase orders.
    canAmend: !isOnHold && !isCancelled && !isCompleted && !shipped && !grnComplete && (approval === 'approved' || sent || poStatus === 'released'),
  };
}

async function syncRequestStatus(po, status) {
  const fd = po.get('form_data');
  const raw = fd && typeof fd === 'object' ? (fd.requestId ?? fd.request_id) : null;
  const reqId = parseInt(String(raw ?? '').replace(/\D/g, '') || '0', 10);
  if (!Number.isFinite(reqId) || reqId <= 0) return;
  try {
    await ProcurementRequest.update({ status }, { where: { id: reqId } });
  } catch (e) {
    console.warn('[poException] syncRequestStatus failed:', e && e.message ? e.message : e);
  }
}

/** GET /purchase-orders/:id/exception */
async function getExceptionState(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    return res.json(computeState(po, tracking));
  } catch (err) {
    console.error('getExceptionState error', err);
    return res.status(500).json({ error: 'Failed to load PO exception state' });
  }
}

/** POST /purchase-orders/:id/exception/hold  { reason } */
async function holdPo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking);
    if (state.cancelled) return res.status(409).json({ error: 'PO is cancelled.', code: 'PO_CANCELLED' });
    if (state.onHold) return res.status(409).json({ error: 'PO is already on hold.', code: 'ALREADY_ON_HOLD' });
    if (!state.canHold) return res.status(409).json({ error: 'PO cannot be held at its current stage.', code: 'CANNOT_HOLD' });
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    if (!reason) return res.status(400).json({ error: 'A reason is required to hold the PO.' });

    const actor = actorFromReq(req);
    try {
      await po.update({ exception_status: 'on_hold', exception_reason: reason, exception_at: new Date(), exception_by: actor.name });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }
    await writeLog(id, { action: 'po_hold', fromStatus: state.exceptionStatus, toStatus: 'on_hold', actor, note: reason });
    return res.json(computeState(po, tracking));
  } catch (err) {
    console.error('holdPo error', err);
    return res.status(500).json({ error: 'Failed to hold PO' });
  }
}

/** POST /purchase-orders/:id/exception/resume  { note? } */
async function resumePo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking);
    if (!state.onHold) return res.status(409).json({ error: 'PO is not on hold.', code: 'NOT_ON_HOLD' });

    const actor = actorFromReq(req);
    const note = req.body && req.body.note ? String(req.body.note) : null;
    try {
      await po.update({ exception_status: null, exception_reason: null, exception_at: null, exception_by: null });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }
    await writeLog(id, { action: 'po_resume', fromStatus: 'on_hold', toStatus: null, actor, note });
    return res.json(computeState(po, tracking));
  } catch (err) {
    console.error('resumePo error', err);
    return res.status(500).json({ error: 'Failed to resume PO' });
  }
}

/** POST /purchase-orders/:id/exception/cancel  { reason } */
async function cancelPo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking);
    if (state.cancelled) return res.status(409).json({ error: 'PO is already cancelled.', code: 'ALREADY_CANCELLED' });
    if (!state.canCancel) {
      return res.status(409).json({ error: 'PO cannot be cancelled after GRN completion.', code: 'CANNOT_CANCEL' });
    }
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    if (!reason) return res.status(400).json({ error: 'A reason is required to cancel the PO.' });

    const actor = actorFromReq(req);
    // CFO gate above the threshold (payables risk).
    if (state.requiresCfoToCancel && !userCanActAs(actor.role, 'cfo')) {
      return res.status(403).json({
        error: `CFO approval is required to cancel a PO above ₹${REGULAR_CFO_THRESHOLD.toLocaleString('en-IN')}.`,
        code: 'CFO_REQUIRED',
      });
    }

    try {
      await po.update({ exception_status: 'cancelled', exception_reason: reason, exception_at: new Date(), exception_by: actor.name, status: 'Cancelled' });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }
    // Reopen the linked PR so Planning can re-plan.
    await syncRequestStatus(po, 'New');
    await writeLog(id, { action: 'po_cancelled', fromStatus: state.exceptionStatus, toStatus: 'cancelled', actor, note: reason, amount: state.amount });
    return res.json(computeState(po, tracking));
  } catch (err) {
    console.error('cancelPo error', err);
    return res.status(500).json({ error: 'Failed to cancel PO' });
  }
}

/** POST /purchase-orders/:id/exception/amend  { reason } */
async function amendPo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadCtx(id);
    if (schemaMissing) return schemaError(res);
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    const state = computeState(po, tracking);
    if (state.cancelled) return res.status(409).json({ error: 'PO is cancelled.', code: 'PO_CANCELLED' });
    if (state.onHold) return res.status(409).json({ error: 'Resume the PO before amending.', code: 'PO_ON_HOLD' });
    if (!state.canAmend) {
      return res.status(409).json({ error: 'PO can only be amended after approval and before dispatch/GRN.', code: 'CANNOT_AMEND' });
    }
    const reason = req.body && req.body.reason ? String(req.body.reason) : null;
    if (!reason) return res.status(400).json({ error: 'A reason is required to amend the PO.' });

    const actor = actorFromReq(req);
    // Reset approval + status back to Draft so it re-flows review → approve → send.
    try {
      await po.update({
        status: 'Draft',
        approval_status: 'changes_requested',
        approved_at: null,
        amendment_count: state.amendmentCount + 1,
      });
    } catch (err) { if (isMissingColumnError(err)) return schemaError(res); throw err; }
    // Reset the vendor loop so the amended PO must be re-sent and re-acknowledged.
    if (tracking) {
      try {
        await tracking.update({
          po_released_at: null, po_released_note: null, sent_channel: null, ack_sla_due_at: null,
          vendor_confirmed_at: null, vendor_confirmed_note: null, vendor_rejected_at: null, vendor_rejected_note: null,
        });
      } catch (e) {
        if (!isMissingColumnError(e)) console.warn('[poException] amend tracking reset failed:', e && e.message ? e.message : e);
      }
    }
    await syncRequestStatus(po, 'PO Draft');
    await writeLog(id, { action: 'po_amended', fromStatus: state.approvalStatus, toStatus: 'changes_requested', actor, note: reason });
    return res.json(computeState(po, tracking));
  } catch (err) {
    console.error('amendPo error', err);
    return res.status(500).json({ error: 'Failed to amend PO' });
  }
}

module.exports = {
  getExceptionState,
  holdPo,
  resumePo,
  cancelPo,
  amendPo,
  computeState, // exported for unit tests
};
