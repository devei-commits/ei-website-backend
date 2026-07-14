const { softDeleteWhere, activeRowWhere } = require('../lib/softDelete');
const PurchaseOrder = require('./models');
const ProcurementRequest = require('../procurementRequests/models');
const { syncZohoPurchaseOrderForPo, syncZohoBillForPo } = require('../services/zohoPurchaseOrderSync');
const zohoEnv = require('../services/zohoEnv');
const { normalizePoType } = require('./poApprovalMatrix');

/**
 * When a draft PO is released (status → Released), keep procurement_requests.status in sync
 * so GET /procurement lists don't keep showing the request as "PO Draft".
 */
async function syncProcurementRequestStatusFromPoFormData(formData, status) {
  if (!formData || typeof formData !== 'object') return;
  const raw = formData.requestId ?? formData.request_id;
  if (raw == null || raw === '') return;
  const digits = String(raw).replace(/\D/g, '');
  const id = parseInt(digits || '0', 10);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    await ProcurementRequest.update({ status }, { where: { id } });
  } catch (e) {
    console.warn('[purchaseOrders] syncProcurementRequestStatusFromPoFormData failed:', e && e.message ? e.message : e);
  }
}

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

// Full read set incl. PO-type + approval-workflow columns (Sub-flow E).
// Reads fall back to PO_SYNC_ATTRIBUTES then PO_SAFE_ATTRIBUTES on older schemas.
const PO_APPROVAL_COLUMNS = [
  'po_type',
  'approval_status',
  'approval_required_role',
  'approval_amount',
  'submitted_for_review_at',
  'approved_at',
  'exception_status',
  'exception_reason',
  'exception_at',
  'amendment_count',
];
const PO_READ_ATTRIBUTES = [...PO_SYNC_ATTRIBUTES, ...PO_APPROVAL_COLUMNS];

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

/** Best-effort column write that no-ops if the column isn't in the DB yet (pre-migration prod). */
async function safeSetColumn(row, columnName, value) {
  try {
    await row.update({ [columnName]: value });
  } catch (err) {
    if (isMissingColumnError(err, columnName)) return;
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
    poType: d.po_type ?? (d.form_data && typeof d.form_data === 'object' ? d.form_data.poType : null) ?? 'regular',
    approvalStatus: d.approval_status ?? null,
    approvalRequiredRole: d.approval_required_role ?? null,
    approvalAmount: d.approval_amount != null ? Number(d.approval_amount) : null,
    submittedForReviewAt: d.submitted_for_review_at ?? null,
    approvedAt: d.approved_at ?? null,
    exceptionStatus: d.exception_status ?? null,
    exceptionReason: d.exception_reason ?? null,
    exceptionAt: d.exception_at ?? null,
    amendmentCount: d.amendment_count != null ? Number(d.amendment_count) : 0,
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
    const orderBy = [['order_date', 'DESC'], ['id', 'DESC']];
    let rows = null;
    try {
      // Prefer full set incl. Zoho + approval-workflow columns when present.
      rows = await PurchaseOrder.findAll({ where: activeRowWhere(), attributes: PO_READ_ATTRIBUTES, order: orderBy });
    } catch (err) {
      // Older DB schemas may not have approval / zoho columns yet — step down.
      if (!isMissingColumnError(err)) throw err;
      try {
        rows = await PurchaseOrder.findAll({ where: activeRowWhere(), attributes: PO_SYNC_ATTRIBUTES, order: orderBy });
      } catch (err2) {
        if (!isMissingColumnError(err2)) throw err2;
        rows = await PurchaseOrder.findAll({ where: activeRowWhere(), attributes: PO_SAFE_ATTRIBUTES, order: orderBy });
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
      row = await PurchaseOrder.findByPk(id, { attributes: PO_READ_ATTRIBUTES });
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
      try {
        row = await PurchaseOrder.findByPk(id, { attributes: PO_SYNC_ATTRIBUTES });
      } catch (err2) {
        if (!isMissingColumnError(err2)) throw err2;
        row = await PurchaseOrder.findByPk(id, { attributes: PO_SAFE_ATTRIBUTES });
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
  const b = body || {};
  const formData = body.formData && typeof body.formData === 'object' ? body.formData : {};
  const items = Array.isArray(body.items) ? body.items : [];
  const orderStatus = body.orderStatus && typeof body.orderStatus === 'object' ? body.orderStatus : {};
  return {
    order_id: b.order_id ?? b.orderId ?? formData.po_number ?? formData.poNumber ?? formData.order_id ?? formData.orderId ?? '',
    vendor_name: b.vendor_name ?? b.vendorName ?? formData.vendor_name ?? formData.vendorName ?? null,
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
  };
}

/** Resolve the PO type from any of the accepted body/formData shapes. */
function resolvePoTypeFromBody(body) {
  const b = body || {};
  const fd = b.formData && typeof b.formData === 'object' ? b.formData : {};
  return normalizePoType(b.po_type ?? b.poType ?? fd.poType ?? fd.po_type ?? 'regular');
}

/** Build payload with only fields that are present in body (partial update). */
function bodyToUpdatePayload(body) {
  body = body || {};
  const formData = body.formData && typeof body.formData === 'object' ? body.formData : {};
  const payload = {};
  if (
    body.order_id !== undefined ||
    body.orderId !== undefined ||
    formData.po_number !== undefined ||
    formData.poNumber !== undefined ||
    formData.order_id !== undefined ||
    formData.orderId !== undefined
  ) {
    payload.order_id =
      body.order_id ?? body.orderId ?? formData.po_number ?? formData.poNumber ?? formData.order_id ?? formData.orderId ?? '';
  }
  if (body.vendor_name !== undefined || body.vendorName !== undefined || formData.vendor_name !== undefined || formData.vendorName !== undefined) {
    payload.vendor_name = body.vendor_name ?? body.vendorName ?? formData.vendor_name ?? formData.vendorName ?? null;
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

async function createPurchaseOrder(req, res) {
  try {
    const payload = bodyToPayload(req.body || {});
    if (!payload.order_id || !String(payload.order_id).trim()) return res.status(400).json({ error: 'orderId or poNumber is required' });
    // Some DB schemas may not include Zoho sync columns yet.
    // Limit what Postgres returns so INSERT ... RETURNING doesn't reference missing columns.
    const row = await PurchaseOrder.create(payload, { returning: PO_SAFE_ATTRIBUTES });
    const body = req.body || {};
    // PO type lives authoritatively in form_data.poType; mirror to the denormalized
    // column best-effort (skipped silently on schemas that predate the column).
    await safeSetColumn(row, 'po_type', resolvePoTypeFromBody(body));
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
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[purchaseOrders] syncWarehouseInTransitAll after create failed:', e && e.message ? e.message : e);
    }
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
    const nextStatus = String(row.get('status') || '').trim().toLowerCase();
    if (nextStatus === 'released') {
      const fd = row.get('form_data');
      const merged =
        fd && typeof fd === 'object' && !Array.isArray(fd) ? fd : {};
      await syncProcurementRequestStatusFromPoFormData(merged, 'PO Released');
    }
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[purchaseOrders] syncWarehouseInTransitAll after update failed:', e && e.message ? e.message : e);
    }
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
    const n = await softDeleteWhere(PurchaseOrder, { id });
    if (n === 0) return res.status(404).json({ error: 'Purchase order not found' });
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[purchaseOrders] syncWarehouseInTransitAll after delete failed:', e && e.message ? e.message : e);
    }
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
