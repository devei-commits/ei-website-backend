const { Op } = require('sequelize');
const PurchaseOrder = require('../purchaseOrders/models');
const PoTracking = require('../poTracking/models');

const PO_SAFE_ATTRIBUTES = [
  'id',
  'order_id',
  'vendor_name',
  'order_date',
  'payment_terms',
  'status',
  'items',
  'form_data',
  'created_at',
  'updated_at',
];

function poGrandTotal(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, line) => {
    const qty = Number(line?.quantity ?? line?.qty ?? 0) || 0;
    const rate = Number(line?.rate ?? line?.unitPrice ?? line?.price ?? 0) || 0;
    return sum + qty * rate;
  }, 0);
}

function formatTrackingRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    poReleasedAt: d.po_released_at,
    poReleasedNote: d.po_released_note,
    advancePaidAt: d.advance_paid_at,
    advancePaidNote: d.advance_paid_note,
    paymentTransactionNo: d.payment_transaction_no,
    paymentMode: d.payment_mode,
    paymentTransactionDate: d.payment_transaction_date,
    vendorConfirmedAt: d.vendor_confirmed_at,
    shippedAt: d.shipped_at,
    deliveredAt: d.delivered_at,
    grnCompleteAt: d.grn_complete_at,
    updatedAt: d.updated_at,
  };
}

function formatTreasuryPo(po, tracking) {
  const d = po.get ? po.get({ plain: true }) : po;
  const items = Array.isArray(d.items) ? d.items : [];
  return {
    purchaseOrderId: String(d.id),
    poNumber: d.order_id || `PO-${d.id}`,
    vendorName: d.vendor_name || '',
    paymentTerms: d.payment_terms || '',
    status: d.status || '',
    orderDate: d.order_date || '',
    grandTotal: poGrandTotal(items),
    items: items.map((line) => ({
      description: line?.description ?? line?.name ?? line?.item ?? '',
      quantity: Number(line?.quantity ?? line?.qty ?? 0) || 0,
      rate: Number(line?.rate ?? line?.unitPrice ?? line?.price ?? 0) || 0,
      unit: line?.unit ?? line?.uom ?? '',
    })),
    formData: d.form_data && typeof d.form_data === 'object' ? d.form_data : {},
    tracking: formatTrackingRow(tracking),
    updatedAt: d.updated_at,
  };
}

/**
 * GET /treasury/purchase-orders
 * Released POs and drafts with payment / advance tracking for Treasury.
 */
async function listPurchaseOrdersForTreasury(req, res) {
  try {
    const trackingRows = await PoTracking.findAll({
      where: {
        [Op.or]: [
          { po_released_at: { [Op.ne]: null } },
          { advance_paid_at: { [Op.ne]: null } },
          { payment_transaction_no: { [Op.ne]: null } },
          { payment_transaction_date: { [Op.ne]: null } },
        ],
      },
      order: [['updated_at', 'DESC']],
    });

    const poIds = [...new Set(trackingRows.map((r) => r.purchase_order_id).filter(Boolean))];
    if (poIds.length === 0) {
      return res.json([]);
    }

    const pos = await PurchaseOrder.findAll({
      where: { id: { [Op.in]: poIds } },
      attributes: PO_SAFE_ATTRIBUTES,
    });
    const poById = new Map(pos.map((p) => [p.id, p]));
    const trackingByPoId = new Map(trackingRows.map((t) => [t.purchase_order_id, t]));

    const out = poIds
      .map((id) => {
        const po = poById.get(id);
        const tr = trackingByPoId.get(id);
        if (!po) return null;
        return formatTreasuryPo(po, tr);
      })
      .filter(Boolean);

    res.json(out);
  } catch (err) {
    console.error('listPurchaseOrdersForTreasury error', err);
    res.status(500).json({ error: 'Failed to load treasury purchase orders' });
  }
}

module.exports = {
  listPurchaseOrdersForTreasury,
};
