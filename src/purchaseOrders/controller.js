const PurchaseOrder = require('./models');

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
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

async function listPurchaseOrders(req, res) {
  try {
    const rows = await PurchaseOrder.findAll({ order: [['order_date', 'DESC'], ['id', 'DESC']] });
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
    const row = await PurchaseOrder.findByPk(id);
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
    const row = await PurchaseOrder.create(payload);
    res.status(201).json(formatRow(row));
  } catch (err) {
    console.error('createPurchaseOrder error', err);
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
}

async function updatePurchaseOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PurchaseOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });
    const payload = bodyToUpdatePayload(req.body || {});
    if (Object.keys(payload).length === 0) return res.json(formatRow(row));
    await row.update(payload);
    res.json(formatRow(row));
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
