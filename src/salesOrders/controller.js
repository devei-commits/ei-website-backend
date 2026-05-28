const SalesOrder = require('./models');

function formatRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    type: 'SO',
    orderId: d.order_id,
    customerName: d.customer_name,
    vendorName: '',
    orderDate: d.order_date || '',
    expectedShipmentDate: d.expected_shipment_date || '',
    status: d.status || 'Draft',
    items: Array.isArray(d.items) ? d.items : [],
    formData: d.form_data && typeof d.form_data === 'object' ? d.form_data : {},
    orderStatus: d.order_status && typeof d.order_status === 'object' ? d.order_status : { orderStatus: '', invoiced: '', payment: '', packed: '', shipped: '', deliveryMethod: '' },
    createdBy: d.created_by || null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

async function listSalesOrders(req, res) {
  try {
    const rows = await SalesOrder.findAll({ order: [['order_date', 'DESC'], ['id', 'DESC']] });
    res.json(rows.map(formatRow));
  } catch (err) {
    console.error('listSalesOrders error', err);
    res.status(500).json({ error: 'Failed to list sales orders' });
  }
}

async function getSalesOrderById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await SalesOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Sales order not found' });
    res.json(formatRow(row));
  } catch (err) {
    console.error('getSalesOrderById error', err);
    res.status(500).json({ error: 'Failed to fetch sales order' });
  }
}

function toDateOnly(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (s === '' || s.toLowerCase() === 'invalid date') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

const DEFAULT_SO_LINE_LEAD_DAYS = 45;

function addDaysToDateOnlyStr(dateOnlyStr, days) {
  const base = toDateOnly(dateOnlyStr);
  if (!base) return null;
  const d = new Date(`${base}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.floor(Number(days) || 0)));
  return d.toISOString().slice(0, 10);
}

/**
 * Expected delivery for a multi-product SO: order_date + max(product.lead_time_days), default 45 when unset.
 */
async function maxLeadDaysFromSoItems(items) {
  const list = Array.isArray(items) ? items : [];
  const ids = [
    ...new Set(
      list
        .map((i) => Number(i.product_id ?? i.productId))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  if (ids.length === 0) return DEFAULT_SO_LINE_LEAD_DAYS;
  const { Product } = require('../products/models');
  const prods = await Product.findAll({
    where: { product_id: ids },
    attributes: ['product_id', 'lead_time_days'],
  });
  let maxLead = 0;
  for (const p of prods) {
    const plain = p.get ? p.get({ plain: true }) : p;
    const n = plain.lead_time_days != null ? Number(plain.lead_time_days) : null;
    const d = n != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SO_LINE_LEAD_DAYS;
    if (d > maxLead) maxLead = d;
  }
  return maxLead > 0 ? maxLead : DEFAULT_SO_LINE_LEAD_DAYS;
}

function bodyToPayload(body) {
  const b = body || {};
  const formData = body.formData && typeof body.formData === 'object' ? body.formData : {};
  const items = Array.isArray(body.items) ? body.items : [];
  const orderStatus = body.orderStatus && typeof body.orderStatus === 'object' ? body.orderStatus : {};
  return {
    order_id: b.order_id ?? b.orderId ?? formData.order_id ?? formData.orderId ?? '',
    customer_name: b.customer_name ?? b.customerName ?? formData.customer_name ?? formData.customerName ?? null,
    branch: b.branch ?? formData.branch ?? null,
    order_date: toDateOnly(b.order_date ?? b.orderDate ?? formData.order_date ?? formData.orderDate),
    expected_shipment_date: toDateOnly(
      b.expected_shipment_date ?? b.expectedShipmentDate ?? formData.expected_shipment_date ?? formData.expectedShipmentDate
    ),
    reference: b.reference ?? formData.reference ?? null,
    payment_terms: b.payment_terms ?? b.paymentTerms ?? formData.payment_terms ?? formData.paymentTerms ?? null,
    status: b.status ?? 'Draft',
    order_status: b.order_status ?? orderStatus,
    form_data: formData,
    items,
    created_by: b.created_by ?? b.createdBy ?? null,
  };
}

/** Build payload with only fields that are present in body (partial update). */
function bodyToUpdatePayload(body) {
  body = body || {};
  const formData = body.formData && typeof body.formData === 'object' ? body.formData : {};
  const payload = {};
  if (body.order_id !== undefined || body.orderId !== undefined || formData.order_id !== undefined || formData.orderId !== undefined) {
    payload.order_id = body.order_id ?? body.orderId ?? formData.order_id ?? formData.orderId ?? '';
  }
  if (body.customer_name !== undefined || body.customerName !== undefined || formData.customer_name !== undefined || formData.customerName !== undefined) {
    payload.customer_name = body.customer_name ?? body.customerName ?? formData.customer_name ?? formData.customerName ?? null;
  }
  if (body.branch !== undefined || formData.branch !== undefined) payload.branch = body.branch ?? formData.branch ?? null;
  if (body.order_date !== undefined || body.orderDate !== undefined || formData.order_date !== undefined || formData.orderDate !== undefined) {
    payload.order_date = toDateOnly(body.order_date ?? body.orderDate ?? formData.order_date ?? formData.orderDate);
  }
  if (
    body.expected_shipment_date !== undefined ||
    body.expectedShipmentDate !== undefined ||
    formData.expected_shipment_date !== undefined ||
    formData.expectedShipmentDate !== undefined
  ) {
    payload.expected_shipment_date = toDateOnly(
      body.expected_shipment_date ?? body.expectedShipmentDate ?? formData.expected_shipment_date ?? formData.expectedShipmentDate
    );
  }
  if (body.reference !== undefined || formData.reference !== undefined) payload.reference = body.reference ?? formData.reference ?? null;
  if (body.payment_terms !== undefined || body.paymentTerms !== undefined || formData.payment_terms !== undefined || formData.paymentTerms !== undefined) {
    payload.payment_terms = body.payment_terms ?? body.paymentTerms ?? formData.payment_terms ?? formData.paymentTerms ?? null;
  }
  if (body.status !== undefined) payload.status = body.status ?? 'Draft';
  if (body.order_status !== undefined || body.orderStatus !== undefined) {
    const incoming = body.order_status !== undefined ? body.order_status : body.orderStatus;
    payload.order_status = incoming && typeof incoming === 'object' ? incoming : {};
  }
  if (body.formData !== undefined) payload.form_data = body.formData && typeof body.formData === 'object' ? body.formData : {};
  if (body.items !== undefined) payload.items = Array.isArray(body.items) ? body.items : [];
  return payload;
}

/**
 * When expected shipment is missing, set it from order_date + max FG lead time (same as create UI).
 * @param {Record<string, unknown>} payload
 */
async function applyDefaultExpectedShipmentDate(payload) {
  if (
    !payload.expected_shipment_date &&
    payload.order_date &&
    Array.isArray(payload.items) &&
    payload.items.length > 0
  ) {
    const maxLead = await maxLeadDaysFromSoItems(payload.items);
    payload.expected_shipment_date = addDaysToDateOnlyStr(payload.order_date, maxLead);
  }
}

/**
 * Planning rows for each SO line that resolves to a local product (same as POST /sales-orders).
 * @param {number} salesOrderId
 * @param {Record<string, unknown>} payload
 */
async function createPlanningExtractedRowsForSalesOrder(salesOrderId, payload) {
  if (!Array.isArray(payload.items) || payload.items.length === 0) return;
  const PlanningExtracted = require('../planningExtracted/models');
  const BOM = require('../bom/models');
  const { Product } = require('../products/models');
  const { buildPlanningKgFromSoLine } = require('../planningExtracted/orderKgMath');

  for (const item of payload.items) {
    const productId = item.product_id || item.productId;
    if (!productId) continue;

    const product = await Product.findByPk(productId);
    if (!product) continue;
    const prodPlain = product.get ? product.get({ plain: true }) : product;

    let rmLines = [];
    let pmLines = [];
    const bom = await BOM.findOne({ where: { product_id: productId } });
    if (bom) {
      const b = bom.get ? bom.get({ plain: true }) : bom;
      rmLines = Array.isArray(b.rm_lines) ? b.rm_lines : [];
      pmLines = Array.isArray(b.pm_lines) ? b.pm_lines : [];
    }

    const orderQty = item.quantity || item.orderedQty || 0;
    const packFromSo = String(item.pack || item.packSize || '').trim();
    const {
      safeTotalKg,
      batchSizeKg,
      batchesRequired,
      raw_materials,
      packaging_materials,
    } = buildPlanningKgFromSoLine({
      orderQty,
      product: prodPlain,
      rmLines,
      pmLines,
      fillSizeOverride: packFromSo,
      bom: bom ? (bom.get ? bom.get({ plain: true }) : bom) : null,
    });

    await PlanningExtracted.create({
      sales_order_id: salesOrderId,
      product_id: productId,
      order_qty_display: `${orderQty} units`,
      total_kg_display: safeTotalKg ? `${safeTotalKg} KG` : null,
      order_date: payload.order_date || null,
      due_date: payload.expected_shipment_date || null,
      batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
      batches_required: batchesRequired,
      batch_count: 0,
      batch_size_kg: batchSizeKg,
      bom_status: bom ? 'Confirmed' : 'Pending',
      // BOM is never auto-confirmed on SO creation: planner must confirm BOM + SG on first-batch flow.
      bom_confirmed_at: null,
      approved_by: payload.created_by,
      raw_materials,
      packaging_materials,
    });
  }
}

/**
 * Replace planning rows for a sales order (e.g. after re-import from Zoho).
 * @param {number} salesOrderId
 */
async function deletePlanningExtractedForSalesOrder(salesOrderId) {
  const PlanningExtracted = require('../planningExtracted/models');
  await PlanningExtracted.destroy({ where: { sales_order_id: salesOrderId } });
}

/**
 * Persist payload like POST /sales-orders: optional default shipment date, insert row, planning lines.
 * @param {Record<string, unknown>} payload
 */
async function persistSalesOrderWithPlanning(payload) {
  await applyDefaultExpectedShipmentDate(payload);
  const row = await SalesOrder.create(payload);
  await createPlanningExtractedRowsForSalesOrder(row.id, payload);
  return row;
}

/**
 * Update an existing row and rebuild planning like a fresh create.
 * @param {*} row Sequelize SalesOrder instance
 * @param {Record<string, unknown>} payload
 */
async function updateSalesOrderWithPlanningRebuild(row, payload) {
  await applyDefaultExpectedShipmentDate(payload);
  await row.update(payload);
  await deletePlanningExtractedForSalesOrder(row.id);
  await createPlanningExtractedRowsForSalesOrder(row.id, payload);
  return row;
}

async function createSalesOrder(req, res) {
  try {
    const payload = bodyToPayload(req.body || {});
    if (!payload.order_id || !String(payload.order_id).trim()) return res.status(400).json({ error: 'orderId is required' });
    if (!payload.created_by && req.user) {
      payload.created_by = req.user.fullName || req.user.email;
    }
    const row = await persistSalesOrderWithPlanning(payload);

    res.status(201).json(formatRow(row));
  } catch (err) {
    console.error('createSalesOrder error', err);
    res.status(500).json({ error: 'Failed to create sales order' });
  }
}

async function updateSalesOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await SalesOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Sales order not found' });
    const payload = bodyToUpdatePayload(req.body || {});
    if (Object.keys(payload).length === 0) return res.json(formatRow(row));
    await row.update(payload);
    res.json(formatRow(row));
  } catch (err) {
    console.error('updateSalesOrder error', err);
    res.status(500).json({ error: 'Failed to update sales order' });
  }
}

async function deleteSalesOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await SalesOrder.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'Sales order not found' });
    res.status(204).send();
  } catch (err) {
    console.error('deleteSalesOrder error', err);
    res.status(500).json({ error: 'Failed to delete sales order' });
  }
}

module.exports = {
  listSalesOrders,
  getSalesOrderById,
  createSalesOrder,
  updateSalesOrder,
  deleteSalesOrder,
  applyDefaultExpectedShipmentDate,
  createPlanningExtractedRowsForSalesOrder,
  deletePlanningExtractedForSalesOrder,
  persistSalesOrderWithPlanning,
  updateSalesOrderWithPlanningRebuild,
};
