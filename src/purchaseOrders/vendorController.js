/**
 * PO → Vendor loop controller (Flowchart Sub-flow F + SENT/ACK).
 *
 *   APPROVED --send--> SENT (po_released_at, 48h ack SLA clock)
 *   SENT --acknowledge--> ACKNOWLEDGED (vendor_confirmed_at)
 *   SENT --reject-->      REJECTED (vendor_rejected_at)
 *
 * Reuses po_tracking (the existing vendor/shipment timeline) so IssuedPOsView's
 * stage stepper and the "Initiate Transit" gate keep working unchanged. Audit
 * events are appended to po_approval_log (the unified PO workflow log).
 */
const PurchaseOrder = require('./models');
const PoTracking = require('../poTracking/models');
const ProcurementRequest = require('../procurementRequests/models');
const PoApprovalLog = require('./poApprovalLog.model');

const ACK_SLA_DAYS = 2; // 48h ack SLA (DATEONLY granularity)
const SEND_CHANNELS = ['portal', 'email', 'whatsapp'];

function isMissingColumnError(err) {
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '42703';
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysDateOnly(dateOnly, days) {
  if (!dateOnly) return null;
  const d = new Date(`${String(dateOnly).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function actorFromReq(req) {
  const u = req.user || {};
  return {
    id: Number.isFinite(Number(u.id)) ? Number(u.id) : null,
    name: u.fullName || u.email || 'Unknown',
    role: String(u.role || '').trim().toLowerCase() || null,
  };
}

/** Derive the vendor-loop stage from tracking timestamps. */
function deriveVendorStatus(t) {
  if (!t) return 'not_sent';
  if (t.vendor_rejected_at) return 'rejected';
  if (t.vendor_confirmed_at) return 'acknowledged';
  if (t.po_released_at) return 'sent';
  return 'not_sent';
}

/** SLA flag while awaiting ack: ok within window, warn on due day, bad once overdue. */
function slaLevelFor(status, dueDateOnly) {
  if (status !== 'sent' || !dueDateOnly) return null;
  const today = todayDateOnly();
  if (today > dueDateOnly) return 'bad';
  if (today === dueDateOnly) return 'warn';
  return 'ok';
}

async function loadPoAndTracking(id) {
  const po = await PurchaseOrder.findByPk(id, { attributes: ['id', 'order_id', 'status', 'form_data', 'approval_status'] })
    .catch((err) => {
      if (isMissingColumnError(err)) return '__SCHEMA__';
      throw err;
    });
  if (po === '__SCHEMA__') return { schemaMissing: true };
  if (!po) return { notFound: true };
  const tracking = await PoTracking.findOne({ where: { purchase_order_id: id } });
  return { po, tracking };
}

async function upsertTracking(id, tracking, patch) {
  if (tracking) {
    await tracking.update(patch);
    return tracking;
  }
  return PoTracking.create({ purchase_order_id: id, ...patch });
}

async function writeLog(id, { action, fromStatus, toStatus, actor, note }) {
  try {
    await PoApprovalLog.create({
      purchase_order_id: id,
      action,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      actor_id: actor.id,
      actor_name: actor.name,
      actor_role: actor.role,
      note: note ? String(note).slice(0, 1000) : null,
    });
  } catch (err) {
    if (!isMissingColumnError(err)) {
      console.warn('[poVendor] writeLog failed:', err && err.message ? err.message : err);
    }
  }
}

async function syncRequestStatus(po, status) {
  const fd = po.get('form_data');
  const raw = fd && typeof fd === 'object' ? (fd.requestId ?? fd.request_id) : null;
  if (raw == null || raw === '') return;
  const digits = String(raw).replace(/\D/g, '');
  const reqId = parseInt(digits || '0', 10);
  if (!Number.isFinite(reqId) || reqId <= 0) return;
  try {
    await ProcurementRequest.update({ status }, { where: { id: reqId } });
  } catch (e) {
    console.warn('[poVendor] syncRequestStatus failed:', e && e.message ? e.message : e);
  }
}

function buildVendorState(id, po, tracking) {
  const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
  const vendorStatus = deriveVendorStatus(t);
  const dueDateOnly = t?.ack_sla_due_at || (t?.po_released_at ? addDaysDateOnly(t.po_released_at, ACK_SLA_DAYS) : null);
  return {
    id: String(id),
    orderId: po.get('order_id'),
    approvalStatus: po.get('approval_status') ?? null,
    poStatus: po.get('status') ?? null,
    vendorStatus,
    sentAt: t?.po_released_at ?? null,
    sentChannel: t?.sent_channel ?? null,
    ackSlaDueAt: dueDateOnly,
    slaLevel: slaLevelFor(vendorStatus, dueDateOnly),
    acknowledgedAt: t?.vendor_confirmed_at ?? null,
    ackNote: t?.vendor_confirmed_note ?? null,
    rejectedAt: t?.vendor_rejected_at ?? null,
    rejectNote: t?.vendor_rejected_note ?? null,
    // Reject-recovery (Flowchart: buyer re-sends after renegotiation, or reopens the PR).
    canResend: vendorStatus === 'rejected',
    canReopen: vendorStatus === 'rejected',
  };
}

/** POST /purchase-orders/:id/vendor/send  { channel, note } */
async function sendPoToVendor(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadPoAndTracking(id);
    if (schemaMissing) return res.status(409).json({ error: 'Approval columns not migrated on this database yet.', code: 'APPROVAL_SCHEMA_MISSING' });
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const approval = String(po.get('approval_status') || '').trim();
    if (approval !== 'approved') {
      return res.status(409).json({
        error: 'PO must be Approved before sending to the vendor.',
        code: 'APPROVAL_REQUIRED',
      });
    }

    const channelRaw = String((req.body && req.body.channel) || 'portal').trim().toLowerCase();
    const channel = SEND_CHANNELS.includes(channelRaw) ? channelRaw : 'portal';
    const note = req.body && req.body.note ? String(req.body.note) : null;

    const existing = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    const releasedAt = existing?.po_released_at || todayDateOnly();
    const patch = {
      po_released_at: releasedAt,
      sent_channel: channel,
      ack_sla_due_at: addDaysDateOnly(releasedAt, ACK_SLA_DAYS),
    };
    if (note) patch.po_released_note = note;
    const updatedTracking = await upsertTracking(id, tracking, patch);

    // Move the PO onto the issued axis so it surfaces in Issued POs + request syncs.
    const curStatus = String(po.get('status') || '').trim().toLowerCase();
    if (curStatus !== 'released') {
      await po.update({ status: 'Released' });
      await syncRequestStatus(po, 'PO Released');
    }
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[poVendor] inTransit sync after send failed:', e && e.message ? e.message : e);
    }

    await writeLog(id, { action: 'send_to_vendor', fromStatus: 'approved', toStatus: 'sent', actor: actorFromReq(req), note: note || `via ${channel}` });
    return res.json(buildVendorState(id, po, updatedTracking));
  } catch (err) {
    console.error('sendPoToVendor error', err);
    return res.status(500).json({ error: 'Failed to send PO to vendor' });
  }
}

/** POST /purchase-orders/:id/vendor/acknowledge  { note } */
async function acknowledgePo(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadPoAndTracking(id);
    if (schemaMissing) return res.status(409).json({ error: 'Approval columns not migrated on this database yet.', code: 'APPROVAL_SCHEMA_MISSING' });
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    if (!t || !t.po_released_at) return res.status(409).json({ error: 'PO has not been sent to the vendor yet.', code: 'NOT_SENT' });
    if (t.vendor_rejected_at) return res.status(409).json({ error: 'PO was rejected by the vendor.', code: 'ALREADY_REJECTED' });

    const note = req.body && req.body.note ? String(req.body.note) : null;
    const updatedTracking = await upsertTracking(id, tracking, {
      vendor_confirmed_at: todayDateOnly(),
      ...(note ? { vendor_confirmed_note: note } : {}),
    });
    await writeLog(id, { action: 'vendor_ack', fromStatus: 'sent', toStatus: 'acknowledged', actor: actorFromReq(req), note });
    return res.json(buildVendorState(id, po, updatedTracking));
  } catch (err) {
    console.error('acknowledgePo error', err);
    return res.status(500).json({ error: 'Failed to record vendor acknowledgement' });
  }
}

/** POST /purchase-orders/:id/vendor/reject  { note } */
async function rejectPoByVendor(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadPoAndTracking(id);
    if (schemaMissing) return res.status(409).json({ error: 'Approval columns not migrated on this database yet.', code: 'APPROVAL_SCHEMA_MISSING' });
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    if (!t || !t.po_released_at) return res.status(409).json({ error: 'PO has not been sent to the vendor yet.', code: 'NOT_SENT' });
    if (t.vendor_confirmed_at) return res.status(409).json({ error: 'PO was already acknowledged by the vendor.', code: 'ALREADY_ACKED' });

    const note = req.body && req.body.note ? String(req.body.note) : null;
    const updatedTracking = await upsertTracking(id, tracking, {
      vendor_rejected_at: todayDateOnly(),
      ...(note ? { vendor_rejected_note: note } : {}),
    });
    await writeLog(id, { action: 'vendor_reject', fromStatus: 'sent', toStatus: 'rejected', actor: actorFromReq(req), note });
    return res.json(buildVendorState(id, po, updatedTracking));
  } catch (err) {
    console.error('rejectPoByVendor error', err);
    return res.status(500).json({ error: 'Failed to record vendor rejection' });
  }
}

/**
 * POST /purchase-orders/:id/vendor/resend  { channel, note }
 * After a rejection + renegotiation, re-send the (unchanged) PO to the vendor.
 * Clears the rejection and restarts the ack-SLA clock. Terms changes → use Amend.
 */
async function resendToVendor(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadPoAndTracking(id);
    if (schemaMissing) return res.status(409).json({ error: 'Approval columns not migrated on this database yet.', code: 'APPROVAL_SCHEMA_MISSING' });
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    if (String(po.get('approval_status') || '').trim() !== 'approved') {
      return res.status(409).json({ error: 'PO must be Approved to re-send.', code: 'APPROVAL_REQUIRED' });
    }
    const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    if (!t || !t.vendor_rejected_at) return res.status(409).json({ error: 'PO is not in a rejected state.', code: 'NOT_REJECTED' });

    const channelRaw = String((req.body && req.body.channel) || t.sent_channel || 'portal').trim().toLowerCase();
    const channel = SEND_CHANNELS.includes(channelRaw) ? channelRaw : 'portal';
    const note = req.body && req.body.note ? String(req.body.note) : null;
    const releasedAt = todayDateOnly();
    const updatedTracking = await upsertTracking(id, tracking, {
      vendor_rejected_at: null,
      vendor_rejected_note: null,
      po_released_at: releasedAt,
      sent_channel: channel,
      ack_sla_due_at: addDaysDateOnly(releasedAt, ACK_SLA_DAYS),
      ...(note ? { po_released_note: note } : {}),
    });
    await writeLog(id, { action: 'vendor_resend', fromStatus: 'rejected', toStatus: 'sent', actor: actorFromReq(req), note: note || `re-sent via ${channel}` });
    return res.json(buildVendorState(id, po, updatedTracking));
  } catch (err) {
    console.error('resendToVendor error', err);
    return res.status(500).json({ error: 'Failed to re-send PO to vendor' });
  }
}

/**
 * POST /purchase-orders/:id/vendor/reopen  { note }
 * Vendor won't fulfil: cancel this PO and reopen the linked PR so Planning can
 * re-plan / pick an alternate vendor (Flowchart: "buyer picks alt vendor · PR reopens").
 */
async function reopenAfterReject(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadPoAndTracking(id);
    if (schemaMissing) return res.status(409).json({ error: 'Approval columns not migrated on this database yet.', code: 'APPROVAL_SCHEMA_MISSING' });
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });

    const t = tracking ? (tracking.get ? tracking.get({ plain: true }) : tracking) : null;
    if (!t || !t.vendor_rejected_at) return res.status(409).json({ error: 'PO is not in a rejected state.', code: 'NOT_REJECTED' });

    const note = req.body && req.body.note ? String(req.body.note) : null;
    const actor = actorFromReq(req);
    const reason = `Vendor rejected — reopened for alternate vendor${note ? `: ${note}` : ''}`;
    try {
      await po.update({ exception_status: 'cancelled', exception_reason: reason, exception_at: new Date(), exception_by: actor.name, status: 'Cancelled' });
    } catch (e) {
      // exception columns may be unmigrated — still reopen the PR below.
      if (!isMissingColumnError(e)) throw e;
    }
    await syncRequestStatus(po, 'New');
    await writeLog(id, { action: 'vendor_reopen_pr', fromStatus: 'rejected', toStatus: 'cancelled', actor, note: reason });
    return res.json(buildVendorState(id, po, tracking));
  } catch (err) {
    console.error('reopenAfterReject error', err);
    return res.status(500).json({ error: 'Failed to reopen PR after rejection' });
  }
}

/** GET /purchase-orders/:id/vendor */
async function getVendorState(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { po, tracking, notFound, schemaMissing } = await loadPoAndTracking(id);
    if (schemaMissing) return res.status(409).json({ error: 'Approval columns not migrated on this database yet.', code: 'APPROVAL_SCHEMA_MISSING' });
    if (notFound) return res.status(404).json({ error: 'Purchase order not found' });
    return res.json(buildVendorState(id, po, tracking));
  } catch (err) {
    console.error('getVendorState error', err);
    return res.status(500).json({ error: 'Failed to load vendor state' });
  }
}

module.exports = {
  sendPoToVendor,
  acknowledgePo,
  rejectPoByVendor,
  resendToVendor,
  reopenAfterReject,
  getVendorState,
};
