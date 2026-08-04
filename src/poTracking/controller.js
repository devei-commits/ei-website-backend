const PoTracking = require('./models');
const PurchaseOrder = require('../purchaseOrders/models');

// Some DB schemas may not have Zoho sync columns migrated yet.
// PO-tracking endpoints only need the PO existence, so fetch a minimal column set.
const PO_TRACKING_SAFE_ATTRIBUTES = ['id'];

function formatTracking(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    purchaseOrderId: String(d.purchase_order_id),
    poReleasedAt: d.po_released_at,
    poReleasedNote: d.po_released_note,
    advancePaidAt: d.advance_paid_at,
    advancePaidNote: d.advance_paid_note,
    paymentTransactionNo: d.payment_transaction_no,
    paymentMode: d.payment_mode,
    paymentTransactionDate: d.payment_transaction_date,
    vendorConfirmedAt: d.vendor_confirmed_at,
    vendorConfirmedNote: d.vendor_confirmed_note,
    sentChannel: d.sent_channel,
    ackSlaDueAt: d.ack_sla_due_at,
    vendorRejectedAt: d.vendor_rejected_at,
    vendorRejectedNote: d.vendor_rejected_note,
    shippedAt: d.shipped_at,
    shippedNote: d.shipped_note,
    orderTrackingRef: d.order_tracking_ref,
    deliveredAt: d.delivered_at,
    deliveredNote: d.delivered_note,
    underGrnAt: d.under_grn_at,
    underGrnNote: d.under_grn_note,
    grnCompleteAt: d.grn_complete_at,
    grnCompleteNote: d.grn_complete_note,
    invoiceNo: d.invoice_no,
    invoiceDate: d.invoice_date,
    invoiceAmount: d.invoice_amount != null ? Number(d.invoice_amount) : null,
    matchStatus: d.match_status,
    matchedAt: d.matched_at,
    matchNote: d.match_note,
    finalPaidAt: d.final_paid_at,
    finalPaidAmount: d.final_paid_amount != null ? Number(d.final_paid_amount) : null,
    closedAt: d.closed_at,
    closedNote: d.closed_note,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function bodyToTracking(body) {
  const b = body || {};
  const raw = {
    po_released_at: b.poReleasedAt ?? b.po_released_at,
    po_released_note: b.poReleasedNote ?? b.po_released_note,
    advance_paid_at: b.advancePaidAt ?? b.advance_paid_at,
    advance_paid_note: b.advancePaidNote ?? b.advance_paid_note,
    payment_transaction_no: b.paymentTransactionNo ?? b.payment_transaction_no,
    payment_mode: b.paymentMode ?? b.payment_mode,
    payment_transaction_date: b.paymentTransactionDate ?? b.payment_transaction_date,
    vendor_confirmed_at: b.vendorConfirmedAt ?? b.vendor_confirmed_at,
    vendor_confirmed_note: b.vendorConfirmedNote ?? b.vendor_confirmed_note,
    sent_channel: b.sentChannel ?? b.sent_channel,
    ack_sla_due_at: b.ackSlaDueAt ?? b.ack_sla_due_at,
    vendor_rejected_at: b.vendorRejectedAt ?? b.vendor_rejected_at,
    vendor_rejected_note: b.vendorRejectedNote ?? b.vendor_rejected_note,
    shipped_at: b.shippedAt ?? b.shipped_at,
    shipped_note: b.shippedNote ?? b.shipped_note,
    order_tracking_ref: b.orderTrackingRef ?? b.order_tracking_ref,
    delivered_at: b.deliveredAt ?? b.delivered_at,
    delivered_note: b.deliveredNote ?? b.delivered_note,
    under_grn_at: b.underGrnAt ?? b.under_grn_at,
    under_grn_note: b.underGrnNote ?? b.under_grn_note,
    grn_complete_at: b.grnCompleteAt ?? b.grn_complete_at,
    grn_complete_note: b.grnCompleteNote ?? b.grn_complete_note,
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * GET /po-tracking/purchase-order/:purchaseOrderId
 * Returns tracking for the given purchase order (create empty if not exists).
 */
async function getByPurchaseOrderId(req, res) {
  try {
    const purchaseOrderId = parseInt(req.params.purchaseOrderId, 10);
    if (Number.isNaN(purchaseOrderId)) return res.status(400).json({ error: 'Invalid purchase order id' });

    const [po, row] = await Promise.all([
      PurchaseOrder.findByPk(purchaseOrderId, { attributes: PO_TRACKING_SAFE_ATTRIBUTES }),
      PoTracking.findOne({ where: { purchase_order_id: purchaseOrderId } }),
    ]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const trackingRow = row || await PoTracking.create({ purchase_order_id: purchaseOrderId });
    res.json(formatTracking(trackingRow));
  } catch (err) {
    console.error('getByPurchaseOrderId (po-tracking) error', err);
    res.status(500).json({ error: 'Failed to get PO tracking' });
  }
}

/**
 * PUT /po-tracking/purchase-order/:purchaseOrderId
 * Upsert tracking for the given purchase order.
 */
async function upsertByPurchaseOrderId(req, res) {
  try {
    const purchaseOrderId = parseInt(req.params.purchaseOrderId, 10);
    if (Number.isNaN(purchaseOrderId)) return res.status(400).json({ error: 'Invalid purchase order id' });

    const updates = bodyToTracking(req.body || {});
    const [po, row] = await Promise.all([
      PurchaseOrder.findByPk(purchaseOrderId, { attributes: PO_TRACKING_SAFE_ATTRIBUTES }),
      PoTracking.findOne({ where: { purchase_order_id: purchaseOrderId } }),
    ]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    // Detect the shipment-initiated transition (shipped_at newly set) BEFORE we mutate the row,
    // so we can materialize the In-Transit GRN exactly once.
    const prevShippedAt = row ? row.get('shipped_at') : null;
    const nowShippedAt = updates.shipped_at;
    const isShippedTransition =
      nowShippedAt != null && String(nowShippedAt).trim() !== '' &&
      (prevShippedAt == null || String(prevShippedAt).trim() === '');

    let trackingRow;
    if (row) {
      await row.update(updates);
      trackingRow = row;
    } else {
      trackingRow = await PoTracking.create({ purchase_order_id: purchaseOrderId, ...updates });
    }

    // Shipment initiated → surface the PO in Warehouse Inbound (GRN by PO). Idempotent: skips
    // when the PO already has an active GRN. Runs before the in-transit sync so it counts the new rows.
    if (isShippedTransition) {
      try {
        const { autoCreateInTransitGrnForShippedPo } = require('../grn/shipmentBatchController');
        await autoCreateInTransitGrnForShippedPo(purchaseOrderId);
      } catch (e) {
        console.warn('[po-tracking] auto-create In-Transit GRN on shipped failed:', e && e.message ? e.message : e);
      }
    }

    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[po-tracking] syncWarehouseInTransitAll failed:', e && e.message ? e.message : e);
    }
    res.json(formatTracking(trackingRow));
  } catch (err) {
    console.error('upsertByPurchaseOrderId (po-tracking) error', err);
    res.status(500).json({ error: 'Failed to update PO tracking' });
  }
}

module.exports = {
  getByPurchaseOrderId,
  upsertByPurchaseOrderId,
};
