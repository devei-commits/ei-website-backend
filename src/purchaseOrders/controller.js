const PurchaseOrder = require('./models');
const { syncZohoPurchaseOrderForPo, syncZohoBillForPo } = require('../services/zohoPurchaseOrderSync');
const zohoEnv = require('../services/zohoEnv');

// Some environments may not have Zoho columns migrated yet.
// Keep read queries restricted to columns that always exist, so the PO APIs don't 500.
const PO_SAFE_ATTRIBUTES = [
  'id',
  'order_id',
  'vendor_name',
  'branch',
  'order_date',
  'expected_shipment_date',
  'reference',
  'payment_terms',
  'status',
  'order_status',
  'form_data',
  'items',
  'created_at',
  'updated_at',
];

// When Zoho columns exist in DB, include them during sync so:
// - we can detect "already_has_zoho_purchase_order" (idempotency)
// - vendor bill creation can see zoho_purchase_order_id
const PO_SYNC_ATTRIBUTES = [
  ...PO_SAFE_ATTRIBUTES,
  'zoho_purchase_order_id',
  'zoho_bill_id',
];

function isMissingColumnError(err, columnName) {
  const code = err?.original?.code ?? err?.parent?.code;
  if (code === '42703') return true; // postgres undefined_column
  const msg = err?.message ? String(err.message) : '';
  const col = columnName ? String(columnName) : '';
  return col && msg.toLowerCase().includes(`column "${col.toLowerCase()}" does not exist`);
}

async function safeUpdateZohoColumn(row, columnName, value) {
  if (value == null || value === '') return;
  try {
    await row.update({ [columnName]: value });
  } catch (err) {
    if (isMissingColumnError(err, columnName)) {
      // DB schema doesn't yet include zoho_* columns; PO creation should still succeed.
      return;
    }
    throw err;
  }
}

async function safeReloadForZohoSync(row) {
  // Environments may not have zoho_* columns migrated yet.
  try {
    await row.reload({ attributes: PO_SYNC_ATTRIBUTES });
    return;
  } catch (err) {
    if (isMissingColumnError(err, 'zoho_purchase_order_id') || isMissingColumnError(err, 'zoho_bill_id')) {
      await row.reload({ attributes: PO_SAFE_ATTRIBUTES });
      return;
    }
    throw err;
  }
}

function formatRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    type: 'PO',
    orderId: d.order_id,
    customerName: '',
    vendorName: d.vendor_name,
    orderDate: d.order_date || '',
    expectedShipmentDate: d.expected_shipment_date || '',
    reference: d.reference || '',
    paymentTerms: d.payment_terms || '',
    status: d.status || 'Draft',
    items: Array.isArray(d.items) ? d.items : [],
    formData: d.form_data && typeof d.form_data === 'object' ? d.form_data : {},
    orderStatus: d.order_status && typeof d.order_status === 'object' ? d.order_status : { orderStatus: '', invoiced: '', payment: '', packed: '', shipped: '', deliveryMethod: '' },
    zohoPurchaseOrderId: d.zoho_purchase_order_id ?? null,
    zohoBillId: d.zoho_bill_id ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function attachZohoSyncToResponse(out, zohoPo, zohoBill) {
  if (!zohoEnv.booksEnabled) return;
  const zs = {};
  if (zohoPo.synced && zohoPo.purchaseorderId) {
    zs.purchase_order = { synced: true, purchaseorder_id: zohoPo.purchaseorderId };
  } else if (
    zohoPo.error &&
    zohoPo.error !== 'zoho_disabled' &&
    zohoPo.error !== 'po_sync_disabled' &&
    zohoPo.error !== 'already_has_zoho_purchase_order'
  ) {
    zs.purchase_order = { synced: false, error: zohoPo.error };
  }
  if (zohoBill.synced && zohoBill.billId) {
    zs.bill = { synced: true, bill_id: zohoBill.billId };
  } else if (
    zohoBill.error &&
    zohoBill.error !== 'zoho_disabled' &&
    zohoBill.error !== 'bill_sync_disabled' &&
    zohoBill.error !== 'already_has_zoho_bill' &&
    zohoBill.error !== 'bill_not_eligible'
  ) {
    zs.bill = { synced: false, error: zohoBill.error };
  }
  if (Object.keys(zs).length) out.zoho_sync = zs;
}

/**
 * Run Zoho PO + Bill sync for a persisted row; updates zoho_* columns and returns API shape + zoho_sync.
 * @param {*} row - Sequelize PurchaseOrder instance
 * @param {Record<string, unknown>} body - original request body
 */
async function syncZohoAndFormatRow(row, body) {
  await safeReloadForZohoSync(row);
  const zohoPo = await syncZohoPurchaseOrderForPo(row, body);
  if (zohoPo.synced && zohoPo.purchaseorderId) {
    await safeUpdateZohoColumn(row, 'zoho_purchase_order_id', zohoPo.purchaseorderId);
  }
  await safeReloadForZohoSync(row);
  const zohoBill = await syncZohoBillForPo(row, body, { purchaseorderId: zohoPo.purchaseorderId });
  if (zohoBill.synced && zohoBill.billId) {
    await safeUpdateZohoColumn(row, 'zoho_bill_id', zohoBill.billId);
  }
  await safeReloadForZohoSync(row);
  const out = formatRow(row);
  attachZohoSyncToResponse(out, zohoPo, zohoBill);
  return out;
}

async function listPurchaseOrders(req, res) {
  try {
    let rows = null;
    try {
      // Prefer including Zoho columns when present (helps UI verification).
      rows = await PurchaseOrder.findAll({
        attributes: PO_SYNC_ATTRIBUTES,
        order: [['order_date', 'DESC'], ['id', 'DESC']],
      });
    } catch (err) {
      // Older DB schemas may not have zoho_* columns yet.
      if (isMissingColumnError(err, 'zoho_purchase_order_id') || isMissingColumnError(err, 'zoho_bill_id')) {
        rows = await PurchaseOrder.findAll({
          attributes: PO_SAFE_ATTRIBUTES,
          order: [['order_date', 'DESC'], ['id', 'DESC']],
        });
      } else {
        throw err;
      }
    }
    res.json(rows.map(formatRow));
  } catch (err) {
    console.error('listPurchaseOrders error', err);
    res.status(500).json({ error: 'Failed to list purchase orders' });
  }
}

async function getPurchaseOrderById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    let row = null;
    try {
      row = await PurchaseOrder.findByPk(id, { attributes: PO_SYNC_ATTRIBUTES });
    } catch (err) {
      if (isMissingColumnError(err, 'zoho_purchase_order_id') || isMissingColumnError(err, 'zoho_bill_id')) {
        row = await PurchaseOrder.findByPk(id, { attributes: PO_SAFE_ATTRIBUTES });
      } else {
        throw err;
      }
    }
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });
    res.json(formatRow(row));
  } catch (err) {
    console.error('getPurchaseOrderById error', err);
    res.status(500).json({ error: 'Failed to fetch purchase order' });
  }
}

function toDateOnly(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (s === '' || s.toLowerCase() === 'invalid date') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function bodyToPayload(body) {
  const formData = body.formData && typeof body.formData === 'object' ? body.formData : {};
  const items = Array.isArray(body.items) ? body.items : [];
  const orderStatus = body.orderStatus && typeof body.orderStatus === 'object' ? body.orderStatus : {};
  return {
    order_id: body.orderId ?? formData.poNumber ?? formData.orderId ?? '',
    vendor_name: body.vendorName ?? formData.vendorName ?? null,
    branch: body.branch ?? formData.branch ?? null,
    order_date: toDateOnly(body.orderDate ?? formData.orderDate),
    expected_shipment_date: toDateOnly(body.expectedShipmentDate ?? formData.expectedShipmentDate),
    reference: body.reference ?? formData.reference ?? null,
    payment_terms: body.paymentTerms ?? formData.paymentTerms ?? null,
    status: body.status ?? 'Draft',
    order_status: orderStatus,
    form_data: formData,
    items,
  };
}

/** Build payload with only fields that are present in body (partial update). */
function bodyToUpdatePayload(body) {
  body = body || {};
  const formData = body.formData && typeof body.formData === 'object' ? body.formData : {};
  const payload = {};
  if (body.orderId !== undefined || formData.poNumber !== undefined || formData.orderId !== undefined) payload.order_id = body.orderId ?? formData.poNumber ?? formData.orderId ?? '';
  if (body.vendorName !== undefined || formData.vendorName !== undefined) payload.vendor_name = body.vendorName ?? formData.vendorName ?? null;
  if (body.branch !== undefined || formData.branch !== undefined) payload.branch = body.branch ?? formData.branch ?? null;
  if (body.orderDate !== undefined || formData.orderDate !== undefined) payload.order_date = toDateOnly(body.orderDate ?? formData.orderDate);
  if (body.expectedShipmentDate !== undefined || formData.expectedShipmentDate !== undefined) payload.expected_shipment_date = toDateOnly(body.expectedShipmentDate ?? formData.expectedShipmentDate);
  if (body.reference !== undefined || formData.reference !== undefined) payload.reference = body.reference ?? formData.reference ?? null;
  if (body.paymentTerms !== undefined || formData.paymentTerms !== undefined) payload.payment_terms = body.paymentTerms ?? formData.paymentTerms ?? null;
  if (body.status !== undefined) payload.status = body.status ?? 'Draft';
  if (body.orderStatus !== undefined) payload.order_status = body.orderStatus && typeof body.orderStatus === 'object' ? body.orderStatus : {};
  if (body.formData !== undefined) payload.form_data = body.formData && typeof body.formData === 'object' ? body.formData : {};
  if (body.items !== undefined) payload.items = Array.isArray(body.items) ? body.items : [];
  return payload;
}

async function createPurchaseOrder(req, res) {
  try {
    const payload = bodyToPayload(req.body || {});
    if (!payload.order_id || !String(payload.order_id).trim()) return res.status(400).json({ error: 'orderId or poNumber is required' });
    // Some DB schemas may not include Zoho sync columns yet.
    // Limit what Postgres returns so INSERT ... RETURNING doesn't reference missing columns.
    const row = await PurchaseOrder.create(payload, { returning: PO_SAFE_ATTRIBUTES });
    const body = req.body || {};
    const zohoPo = await syncZohoPurchaseOrderForPo(row, body);
    if (zohoPo.synced && zohoPo.purchaseorderId) {
      await safeUpdateZohoColumn(row, 'zoho_purchase_order_id', zohoPo.purchaseorderId);
    }
    await safeReloadForZohoSync(row);
    const zohoBill = await syncZohoBillForPo(row, body, { purchaseorderId: zohoPo.purchaseorderId });
    if (zohoBill.synced && zohoBill.billId) {
      await safeUpdateZohoColumn(row, 'zoho_bill_id', zohoBill.billId);
    }
    await safeReloadForZohoSync(row);
    const out = formatRow(row);
    attachZohoSyncToResponse(out, zohoPo, zohoBill);
    res.status(201).json(out);
  } catch (err) {
    console.error('createPurchaseOrder error', err);
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
}

async function updatePurchaseOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PurchaseOrder.findByPk(id, { attributes: PO_SAFE_ATTRIBUTES });
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });
    const body = req.body || {};
    const payload = bodyToUpdatePayload(body);
    // Shallow-merge form_data so partial updates (e.g. request link, release) keep vendorClientId / quoteId.
    if (
      body.formData !== undefined &&
      body.formData &&
      typeof body.formData === 'object' &&
      !Array.isArray(body.formData)
    ) {
      const prev = row.get('form_data');
      const existing =
        prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};
      payload.form_data = { ...existing, ...body.formData };
    }
    if (Object.keys(payload).length === 0) {
      const out = await syncZohoAndFormatRow(row, body);
      return res.json(out);
    }
    await row.update(payload);
    const out = await syncZohoAndFormatRow(row, body);
    res.json(out);
  } catch (err) {
    console.error('updatePurchaseOrder error', err);
    res.status(500).json({ error: 'Failed to update purchase order' });
  }
}

async function deletePurchaseOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await PurchaseOrder.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'Purchase order not found' });
    res.status(204).send();
  } catch (err) {
    console.error('deletePurchaseOrder error', err);
    res.status(500).json({ error: 'Failed to delete purchase order' });
  }
}

module.exports = {
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
};
