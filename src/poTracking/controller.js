const PoTracking = require('./models');
const PurchaseOrder = require('../purchaseOrders/models');

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
    vendorConfirmedAt: d.vendor_confirmed_at,
    vendorConfirmedNote: d.vendor_confirmed_note,
    shippedAt: d.shipped_at,
    shippedNote: d.shipped_note,
    orderTrackingRef: d.order_tracking_ref,
    deliveredAt: d.delivered_at,
    deliveredNote: d.delivered_note,
    underGrnAt: d.under_grn_at,
    underGrnNote: d.under_grn_note,
    grnCompleteAt: d.grn_complete_at,
    grnCompleteNote: d.grn_complete_note,
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
    vendor_confirmed_at: b.vendorConfirmedAt ?? b.vendor_confirmed_at,
    vendor_confirmed_note: b.vendorConfirmedNote ?? b.vendor_confirmed_note,
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

    const po = await PurchaseOrder.findByPk(purchaseOrderId);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    let row = await PoTracking.findOne({ where: { purchase_order_id: purchaseOrderId } });
    if (!row) {
      row = await PoTracking.create({ purchase_order_id: purchaseOrderId });
    }
    res.json(formatTracking(row));
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

    const po = await PurchaseOrder.findByPk(purchaseOrderId);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const updates = bodyToTracking(req.body || {});
    let row = await PoTracking.findOne({ where: { purchase_order_id: purchaseOrderId } });
    if (!row) {
      row = await PoTracking.create({ purchase_order_id: purchaseOrderId, ...updates });
    } else {
      await row.update(updates);
    }
    res.json(formatTracking(row));
  } catch (err) {
    console.error('upsertByPurchaseOrderId (po-tracking) error', err);
    res.status(500).json({ error: 'Failed to update PO tracking' });
  }
}

module.exports = {
  getByPurchaseOrderId,
  upsertByPurchaseOrderId,
};
