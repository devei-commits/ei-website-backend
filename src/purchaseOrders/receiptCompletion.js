/**
 * Auto-complete a PO purely on full warehouse receipt.
 *
 * Business rule: once every line on a PO has had its full ordered quantity confirmed
 * received in the warehouse (summed across all its GRNs), the PO itself should move to
 * status 'Completed' — independent of invoice capture, 3-way match, or payment.
 *
 * This is deliberately separate from matchController.closePo(), which still governs the
 * *financial* close (invoice match + payment) via po_tracking.closed_at — that flow is
 * untouched and can still run before or after this fires; both write the same
 * purchase_orders.status='Completed' value, so whichever runs first "wins" and the other
 * is a harmless no-op.
 */
const PurchaseOrder = require('./models');
const GoodsReceivedNote = require('../grn/models');
const PoApprovalLog = require('./poApprovalLog.model');
const { computeThreeWayMatch } = require('./threeWayMatch');

function isMissingColumnError(err) {
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '42703';
}

/**
 * A GRN created from Procurement can complete with rcvdQty left at 0/missing on its lines —
 * applyGrnCompletionToInventory (grn/controller.js) already treats that as a full receipt and
 * falls back to poQty when booking warehouse stock, but that fallback is in-memory only and
 * never gets written back onto line_items. Mirror the same fallback here (only for GRNs whose
 * status is already 'GRN Complete') so this check agrees with what was actually booked into
 * inventory, instead of undercounting completed GRNs that never had rcvdQty typed in.
 */
function normalizeGrnRowsForReceipt(grnRows) {
  return (grnRows || []).map((g) => {
    if (String(g.status || '').trim() !== 'GRN Complete') return g;
    const lines = Array.isArray(g.line_items) ? g.line_items : [];
    const nextLines = lines.map((line) => {
      const raw = Number(line.rcvdQty ?? line.rcvd_qty);
      if (Number.isFinite(raw) && raw > 0) return line;
      const poQty = Number(line.poQty ?? line.po_qty ?? 0) || 0;
      return poQty > 0 ? { ...line, rcvdQty: poQty } : line;
    });
    return { ...g, line_items: nextLines };
  });
}

/**
 * Check whether every PO line's received qty (across all its GRNs) now meets its
 * ordered qty, and if so flip purchase_orders.status to 'Completed'. Best-effort,
 * idempotent, and self-gating — safe to call after any GRN receipt-quantity change;
 * never throws into the caller's request/commit path.
 */
async function maybeCompletePoOnFullReceipt(poId) {
  const id = Number(poId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    const po = await PurchaseOrder.findByPk(id, {
      attributes: ['id', 'order_id', 'status', 'items', 'exception_status'],
    });
    if (!po) return;
    const status = String(po.get('status') || '');
    if (status === 'Completed') return; // already there — nothing to do
    if (String(po.get('exception_status') || '') === 'cancelled') return; // never auto-complete a cancelled PO

    const items = po.get('items');
    if (!Array.isArray(items) || !items.length) return;

    const grns = await GoodsReceivedNote.findAll({ where: { purchase_order_id: id } }).catch(() => []);
    const grnRows = normalizeGrnRowsForReceipt(grns.map((g) => (g.get ? g.get({ plain: true }) : g)));
    // invoiceAmount: null so the verdict never depends on billing — only qty lines matter here.
    const match = computeThreeWayMatch({ poItems: items, grnRows, invoiceAmount: null });
    if (!match.lines.length || !match.totals.qtyLinesOk) return;

    await po.update({ status: 'Completed' });
    try {
      await PoApprovalLog.create({
        purchase_order_id: id,
        action: 'auto_completed_full_receipt',
        from_status: status || null,
        to_status: 'Completed',
        actor_id: null,
        actor_name: 'System',
        actor_role: null,
        note: 'All PO line quantities confirmed received in warehouse.',
      });
    } catch (e) {
      if (!isMissingColumnError(e)) console.warn('[receiptCompletion] log write failed:', e && e.message ? e.message : e);
    }
  } catch (e) {
    console.warn('[receiptCompletion] maybeCompletePoOnFullReceipt failed:', e && e.message ? e.message : e);
  }
}

module.exports = { maybeCompletePoOnFullReceipt };
