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

/** H11: true if the PR linked via a PO's form_data.requestId still has a pending stock check. */
async function linkedPrStockCheckPending(formData) {
  try {
    const raw = formData && typeof formData === 'object' ? (formData.requestId ?? formData.request_id) : null;
    const id = parseInt(String(raw ?? '').replace(/\D/g, '') || '0', 10);
    if (!Number.isFinite(id) || id <= 0) return false;
    const pr = await ProcurementRequest.findByPk(id, { attributes: ['stock_check_status'] });
    const scs = String((pr && pr.stock_check_status) || '').trim().toLowerCase();
    return ['pending', 'requested', 'in progress'].includes(scs);
  } catch (e) {
    console.warn('[purchaseOrders] linkedPrStockCheckPending check failed:', e && e.message ? e.message : e);
    return false; // fail-open: never block a legitimate release on a lookup error
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
    // C6: a PO cannot be created already 'Released' unless it carries approval_status 'approved'.
    if (String(payload.status || '').trim().toLowerCase() === 'released') {
      if (String(payload.approval_status || '').trim().toLowerCase() !== 'approved') {
        return res.status(409).json({
          error: 'PO_NOT_APPROVED',
          message: 'Purchase order must be approved before it can be released.',
        });
      }
      // H11: cannot create-as-released against a PR with a pending stock check.
      if (await linkedPrStockCheckPending(payload.form_data)) {
        return res.status(409).json({
          error: 'STOCK_CHECK_PENDING',
          message: 'The linked procurement request has an incomplete stock check — resolve it before releasing the PO.',
        });
      }
    }
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
    // Must be read with the approval columns: the release gate below inspects `approval_status`,
    // and PO_SAFE_ATTRIBUTES does not select it — so `row.get('approval_status')` came back
    // undefined and every release was refused with PO_NOT_APPROVED regardless of the real value.
    // Same three-step fallback getPurchaseOrderById uses, for schemas without those columns.
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
    // C6: block release of an un-approved PO. approval_status must be 'approved' (the
    // approval workflow is the only way in). Previously status could be set to 'Released'
    // with no check and no audit row, bypassing the CFO/threshold matrix entirely.
    const wasReleased = String(row.get('status') || '').trim().toLowerCase() === 'released';
    const wantsRelease =
      payload.status !== undefined && String(payload.status || '').trim().toLowerCase() === 'released';
    if (wantsRelease && !wasReleased) {
      const appr = String(row.get('approval_status') || '').trim().toLowerCase();
      if (appr !== 'approved') {
        return res.status(409).json({
          error: 'PO_NOT_APPROVED',
          message: 'Purchase order must be approved before it can be released.',
        });
      }
      // H11: cannot release a PO whose linked PR still has a pending stock check. This gate
      // previously lived only in the PR update path; releasing from the PO side bypassed it.
      const blocked = await linkedPrStockCheckPending(row.get('form_data'));
      if (blocked) {
        return res.status(409).json({
          error: 'STOCK_CHECK_PENDING',
          message: 'The linked procurement request has an incomplete stock check — resolve it before releasing the PO.',
        });
      }
    }
    await row.update(payload);
    // Connecting date == expected date: when per-item connecting dates were edited, push them
    // onto any existing active GRN rows for this PO so the Warehouse GRN tracker stays in sync.
    if (
      body.formData && typeof body.formData === 'object' && !Array.isArray(body.formData) &&
      body.formData.connectingDateByItem && typeof body.formData.connectingDateByItem === 'object'
    ) {
      try {
        const { syncGrnExpectedDatesForPo } = require('../grn/shipmentBatchController');
        await syncGrnExpectedDatesForPo(id, row.get('form_data'));
      } catch (e) {
        console.warn('[purchaseOrders] syncGrnExpectedDatesForPo failed:', e && e.message ? e.message : e);
      }
    }
    const nextStatus = String(row.get('status') || '').trim().toLowerCase();
    if (nextStatus === 'released') {
      const fd = row.get('form_data');
      const merged =
        fd && typeof fd === 'object' && !Array.isArray(fd) ? fd : {};
      await syncProcurementRequestStatusFromPoFormData(merged, 'PO Released');
    }
    // C6: audit the release transition (approved → released) to po_approval_log.
    if (nextStatus === 'released' && !wasReleased) {
      try {
        const PoApprovalLog = require('./poApprovalLog.model');
        await PoApprovalLog.create({
          purchase_order_id: id,
          action: 'po_released',
          from_status: 'approved',
          to_status: 'released',
          actor_name: (req.user && (req.user.name || req.user.email)) || null,
          actor_role: (req.user && req.user.role) || null,
          note: 'Released after approval.',
        });
      } catch (e) {
        console.warn('[purchaseOrders] po_approval_log release write failed:', e && e.message ? e.message : e);
      }
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

/**
 * PATCH /:id/connecting-dates — set the per-line "connecting date" (expected arrival) on a PO.
 * Body: { updates: { "<lineKey>": "YYYY-MM-DD" | null, ... } } where lineKey is "rm-<id>" / "pm-<id>"
 * or the item code. Stored as `connectingDate` on each matching item in the PO's items JSON (no schema
 * change). Surfaced against Planned/PO qty in Items Involved via buildPoBreakdownByKey.
 */
async function updatePoConnectingDates(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PurchaseOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });

    const updates = req.body && req.body.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates must be an object of lineKey -> date' });
    }

    const rawItems = row.get('items');
    const items = Array.isArray(rawItems) ? rawItems.map((it) => ({ ...it })) : [];
    let changed = 0;
    for (const it of items) {
      const rmKey = it.raw_material_id != null ? `rm-${it.raw_material_id}` : null;
      const pmKey = it.pack_material_id != null ? `pm-${it.pack_material_id}` : null;
      const code = it.code || it.itemCode || it.sku || null;
      let val;
      if (rmKey && updates[rmKey] !== undefined) val = updates[rmKey];
      else if (pmKey && updates[pmKey] !== undefined) val = updates[pmKey];
      else if (code && updates[code] !== undefined) val = updates[code];
      else continue;
      it.connectingDate = val == null || String(val).trim() === '' ? null : String(val).trim();
      changed += 1;
    }
    if (changed === 0) return res.status(400).json({ error: 'No matching PO lines for the given keys' });

    row.set('items', items);
    row.changed('items', true); // JSON mutation must be flagged for Sequelize to persist it
    await row.save();
    res.json({ id, updated: changed, items });
  } catch (err) {
    console.error('updatePoConnectingDates error:', err);
    res.status(500).json({ error: 'Failed to update connecting dates' });
  }
}

module.exports = {
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrder,
  updatePoConnectingDates,
  deletePurchaseOrder,
};
