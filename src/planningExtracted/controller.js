const { Op } = require('sequelize');
const PlanningExtracted = require('./models');
const PlanningBomOverride = require('./planningBomOverrideModel');
const PlanningBatch = require('./planningBatchModel');
const SalesOrder = require('../salesOrders/models');
const { Order } = require('../orders/models');
const { Product } = require('../products/models');
const WarehouseInventory = require('../warehouseInventory/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const BOM = require('../bom/models');
const { ReservedBatchItem } = require('../fulfillment/models');

/** Whether `sent_batch_indices` includes this 0-based batch index (coerces string/number from JSON). */
function isBatchIndexSent(sentRaw, batchIndex0) {
  const sent = Array.isArray(sentRaw) ? sentRaw : [];
  return sent.some((x) => Number(x) === Number(batchIndex0));
}

function daysLeftDisplay(dueDate) {
  if (!dueDate) return '';
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const diff = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Today';
  return `${diff} days`;
}

function addDaysDateOnly(baseDate, days) {
  if (!baseDate) return '';
  const d = new Date(`${String(baseDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

/** When SO has no expected_shipment_date yet, prefer FG master lead; else SO form hints; else 45/90. */
function inferFallbackLeadDaysForPlanningRow(prod, so) {
  const n = prod && prod.lead_time_days != null ? Number(prod.lead_time_days) : null;
  if (n != null && Number.isFinite(n) && n >= 0) return Math.floor(n);
  return inferDefaultLeadTimeDays(so);
}

function inferDefaultLeadTimeDays(so) {
  const formData = so && typeof so.form_data === 'object' && so.form_data !== null ? so.form_data : {};
  const hints = [
    formData.orderType,
    formData.order_type,
    formData.type,
    formData.orderCategory,
    formData.order_category,
    formData.requestType,
    formData.request_type,
    formData.businessType,
    formData.business_type,
    formData.productType,
    formData.product_type,
    formData.notes,
  ]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  // Standard finished product: 45 days; customisation / bespoke work: 90 days.
  if (
    hints.includes('customis')
    || hints.includes('customiz')
    || hints.includes('bespoke')
    || hints.includes('tailor-made')
    || hints.includes('tailor made')
  ) {
    return 90;
  }
  return 45;
}

function parseOrderQtyNum(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse product fill size to KG per unit.
 * Supports formats like: 100g, 0.1 kg, 100 ml, 0.1 L.
 * For volume units, convert using SG (kg = liters * specific gravity).
 */
function parseFillSizeToKgPerUnit(fillSizeRaw, sg = 1) {
  const text = String(fillSizeRaw || '').trim().toLowerCase();
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*([a-z]+)/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = String(m[2] || '').toLowerCase();
  if (!(Number.isFinite(value) && value > 0)) return null;
  const specificGravity = Number(sg) > 0 ? Number(sg) : 1;

  if (unit.startsWith('kg')) return value;
  if (unit === 'g' || unit === 'gm' || unit === 'gms' || unit.startsWith('gram')) return value / 1000;
  if (unit === 'ml' || unit === 'millilitre' || unit === 'milliliter' || unit === 'milliliters' || unit === 'millilitres') {
    return (value / 1000) * specificGravity;
  }
  if (unit === 'l' || unit === 'lt' || unit === 'ltr' || unit === 'litre' || unit === 'liter' || unit === 'liters' || unit === 'litres') {
    return value * specificGravity;
  }
  return null;
}

function inferBlendSpecificGravity(rmLines) {
  const lines = Array.isArray(rmLines) ? rmLines : [];
  let weighted = 0;
  let pctSum = 0;
  for (const line of lines) {
    const pct = Number(line?.pct_w_w ?? line?.pct ?? 0);
    const sg = Number(line?.specific_gravity);
    if (!(Number.isFinite(pct) && pct > 0 && Number.isFinite(sg) && sg > 0)) continue;
    weighted += pct * sg;
    pctSum += pct;
  }
  if (pctSum <= 0) return 1;
  return weighted / pctSum;
}

function estimateTotalKgFromRmLines({ rmLines, orderQty, batchSizeKg, batchesRequired }) {
  const lines = Array.isArray(rmLines) ? rmLines : [];
  if (lines.length === 0) return 0;

  let totalKg = 0;
  for (const line of lines) {
    const quantity = Number(line?.quantity);
    if (Number.isFinite(quantity) && quantity > 0) {
      totalKg += quantity;
      continue;
    }

    const pct = Number(line?.pct_w_w ?? line?.pct ?? 0);
    if (Number.isFinite(pct) && pct > 0 && Number(batchSizeKg) > 0 && Number(batchesRequired) > 0) {
      totalKg += (Number(batchSizeKg) * pct / 100) * Number(batchesRequired);
      continue;
    }

    const qtyPerUnit = Number(line?.qty_per_unit ?? line?.qty);
    if (Number.isFinite(qtyPerUnit) && qtyPerUnit > 0 && Number(orderQty) > 0) {
      const sg = Number(line?.specific_gravity) || 1; // default SG fallback requested
      totalKg += Number(orderQty) * qtyPerUnit * sg;
    }
  }

  return Math.round(totalKg * 1000) / 1000;
}

function estimateOrderTotalKg({ orderQty, product, rmLines, batchSizeKg, batchesRequired }) {
  const qty = Number(orderQty) || 0;
  if (qty <= 0) return 0;
  const blendSg = inferBlendSpecificGravity(rmLines);
  const kgPerUnit = parseFillSizeToKgPerUnit(product?.fill_size, blendSg);
  if (kgPerUnit != null && kgPerUnit > 0) {
    return Math.round(qty * kgPerUnit * 1000) / 1000;
  }
  return estimateTotalKgFromRmLines({ rmLines, orderQty: qty, batchSizeKg, batchesRequired });
}

function formatRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const so = d.salesOrder || {};
  const prod = d.product || {};
  const fallbackLeadDays = inferFallbackLeadDaysForPlanningRow(prod, so);
  const dueDateResolved =
    d.due_date ||
    so.expected_shipment_date ||
    addDaysDateOnly(d.order_date || so.order_date, fallbackLeadDays) ||
    '';
  return {
    id: String(d.id),
    soNumber: so.order_id || '',
    salesOrderId: so.id,
    customerName: so.customer_name || '',
    expectedShipmentDate: so.expected_shipment_date || '',
    soStatus: so.status || '',
    productName: prod.product_name || '',
    productCode: prod.product_code || '',
    orderQty: d.order_qty_display || '',
    totalKg: d.total_kg_display || '',
    orderDate: d.order_date || '',
    dueDate: dueDateResolved,
    daysLeft: daysLeftDisplay(dueDateResolved),
    batchSize: d.batch_size_display || '',
    batchesRequired: d.batches_required ?? 0,
    bomStatus: d.bom_status || '',
    approvedBy: d.approved_by || '',
    rawMaterials: Array.isArray(d.raw_materials) ? d.raw_materials : [],
    packagingMaterials: Array.isArray(d.packaging_materials) ? d.packaging_materials : [],
    color: d.color || undefined,
    sales_order_id: d.sales_order_id,
    product_id: d.product_id,
    batchCount: d.batch_count != null ? Number(d.batch_count) : null,
    batchSizeKg: d.batch_size_kg != null ? Number(d.batch_size_kg) : null,
    plannedStartDate: d.planned_start_date || null,
    productionLine: d.production_line || null,
    bomConfirmedAt: d.bom_confirmed_at || null,
    customBatches: Array.isArray(d.custom_batches) ? d.custom_batches : null,
    sentBatchIndices: Array.isArray(d.sent_batch_indices) ? d.sent_batch_indices : [],
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

const RESERVE_DEBUG = process.env.RESERVE_DEBUG !== '0';

/** kg tolerance for float compare; PCS treated as integers but allow tiny float noise */
const RESERVE_EPS_KG = 1e-4;
const RESERVE_EPS_PCS = 1e-6;

/**
 * Recompute warehouse_inventory.reserved for given RM/PM ids from sum of reserved_batch_items.
 * Central table stays in sync so feasibility and everywhere else see correct reserved/available.
 * Formula: reserved = sum(quantity_reserved) for that item; available = SIH - reserved.
 */
async function syncWarehouseReserved(affectedRmIds, affectedPmIds) {
  for (const rid of affectedRmIds) {
    const sum = await ReservedBatchItem.sum('quantity_reserved', { where: { raw_material_id: rid } });
    const val = sum != null ? Number(sum) : 0;
    await WarehouseInventory.update(
      { reserved: val },
      { where: { item_type: 'RM', raw_material_id: rid } }
    );
    if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] syncWarehouseReserved RM', { raw_material_id: rid, sum_from_reserved_batch_items: val, 'warehouse_inventory.reserved': val });
  }
  for (const pid of affectedPmIds) {
    const sum = await ReservedBatchItem.sum('quantity_reserved', { where: { pack_material_id: pid } });
    const val = sum != null ? Number(sum) : 0;
    await WarehouseInventory.update(
      { reserved: val },
      { where: { item_type: 'PM', pack_material_id: pid } }
    );
    if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] syncWarehouseReserved PM', { pack_material_id: pid, sum_from_reserved_batch_items: val, 'warehouse_inventory.reserved': val });
  }
}

/**
 * Reserve stock for a planning extracted row when BOM is confirmed.
 * Uses raw_materials and packaging_materials on the row (with quantities); resolves RM/PM by id or code.
 */
async function reserveStockForPlanningExtracted(planningExtractedId, planRow) {
  const plain = planRow.get ? planRow.get({ plain: true }) : planRow;
  const rawMaterials = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
  const packagingMaterials = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];
  const affectedRmIds = new Set();
  const affectedPmIds = new Set();

  for (const line of rawMaterials) {
    let rmId = line.raw_material_id != null ? line.raw_material_id : null;
    if (rmId == null && (line.code || line.rm_code)) {
      const rm = await RawMaterial.findOne({ where: { code: line.code || line.rm_code } });
      if (rm) rmId = rm.id;
    }
    if (rmId == null) continue;
    const qty = Number(line.quantity);
    if (!(qty > 0)) continue;
    const w = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    const stockInHand = Number(w?.stock_in_hand) || 0;
    const reservedExisting = Number(w?.reserved) || 0;
    const free = Math.max(0, stockInHand - reservedExisting);
    const reserveQty = Math.min(qty, free);
    if (reserveQty <= RESERVE_EPS_KG) continue;
    await ReservedBatchItem.create({
      planning_extracted_id: planningExtractedId,
      raw_material_id: rmId,
      pack_material_id: null,
      quantity_reserved: reserveQty,
      unit: line.unit || 'KG',
    });
    affectedRmIds.add(rmId);
    await syncWarehouseReserved([rmId], []);
  }

  for (const line of packagingMaterials) {
    let pmId = line.pack_material_id != null ? line.pack_material_id : null;
    if (pmId == null && (line.code || line.pm_code)) {
      const pm = await PackMaterial.findOne({ where: { code: line.code || line.pm_code } });
      if (pm) pmId = pm.id;
    }
    if (pmId == null) continue;
    const qty = Number(line.quantity);
    if (!(qty > 0)) continue;
    const w = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    const stockInHand = Number(w?.stock_in_hand) || 0;
    const reservedExisting = Number(w?.reserved) || 0;
    const free = Math.max(0, stockInHand - reservedExisting);
    const reserveQty = Math.min(qty, free);
    if (reserveQty <= RESERVE_EPS_PCS) continue;
    await ReservedBatchItem.create({
      planning_extracted_id: planningExtractedId,
      raw_material_id: null,
      pack_material_id: pmId,
      quantity_reserved: reserveQty,
      unit: line.unit || 'PCS',
    });
    affectedPmIds.add(pmId);
    await syncWarehouseReserved([], [pmId]);
  }

  if (affectedRmIds.size || affectedPmIds.size) {
    await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
  }
}

/**
 * Release reservations for a planning extracted row when BOM is unconfirmed.
 */
async function releaseStockForPlanningExtracted(planningExtractedId) {
  const rows = await ReservedBatchItem.findAll({
    where: { planning_extracted_id: planningExtractedId },
    attributes: ['raw_material_id', 'pack_material_id'],
  });
  const affectedRmIds = new Set();
  const affectedPmIds = new Set();
  for (const r of rows) {
    if (r.raw_material_id) affectedRmIds.add(r.raw_material_id);
    if (r.pack_material_id) affectedPmIds.add(r.pack_material_id);
  }
  await ReservedBatchItem.destroy({ where: { planning_extracted_id: planningExtractedId } });
  if (affectedRmIds.size || affectedPmIds.size) {
    await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
  }
}

/**
 * Sum required reservation qty per RM/PM id (same id resolution as reserveStockForPlanningExtracted).
 */
async function aggregateReservationQuantities(planRow) {
  const plain = planRow.get ? planRow.get({ plain: true }) : planRow;
  const rawMaterials = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
  const packagingMaterials = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];
  const rmTotals = new Map();
  const pmTotals = new Map();

  for (const line of rawMaterials) {
    let rmId = line.raw_material_id != null ? line.raw_material_id : null;
    if (rmId == null && (line.code || line.rm_code)) {
      const rm = await RawMaterial.findOne({ where: { code: line.code || line.rm_code } });
      if (rm) rmId = rm.id;
    }
    if (rmId == null) continue;
    const qty = Number(line.quantity);
    if (!(qty > 0)) continue;
    const prev = rmTotals.get(rmId) || {
      qty: 0,
      unit: line.unit || 'KG',
      code: line.code || line.rm_code || '',
      name: line.name || '',
    };
    prev.qty += qty;
    rmTotals.set(rmId, prev);
  }

  for (const line of packagingMaterials) {
    let pmId = line.pack_material_id != null ? line.pack_material_id : null;
    if (pmId == null && (line.code || line.pm_code)) {
      const pm = await PackMaterial.findOne({ where: { code: line.code || line.pm_code } });
      if (pm) pmId = pm.id;
    }
    if (pmId == null) continue;
    const qty = Number(line.quantity);
    if (!(qty > 0)) continue;
    const prev = pmTotals.get(pmId) || {
      qty: 0,
      unit: line.unit || 'PCS',
      code: line.code || line.pm_code || '',
      name: line.name || '',
    };
    prev.qty += qty;
    pmTotals.set(pmId, prev);
  }

  return { rmTotals, pmTotals };
}

/**
 * Ensure the planning row has BOM lines with positive quantities to reserve.
 * Full need vs free is not required: we reserve up to free stock (see reserveStockForPlanningExtracted); shortages remain for POs.
 */
async function validateWarehouseStockForReservation(planRow) {
  const { rmTotals, pmTotals } = await aggregateReservationQuantities(planRow);
  if (rmTotals.size === 0 && pmTotals.size === 0) {
    return {
      ok: false,
      message: 'No materials with positive quantity to reserve. Adjust the BOM or batch sizes.',
      code: 'EMPTY_RESERVATION',
      details: [],
    };
  }
  return { ok: true };
}

/**
 * Ensure every sales order line (SO with items) has a planning_extracted row.
 * SOs created without the API, or before auto-create was added, may have no rows — this sync fixes that.
 */
async function syncPlanningExtractedFromSalesOrders() {
  const soRows = await SalesOrder.findAll({
    attributes: ['id', 'order_id', 'order_date', 'expected_shipment_date', 'items', 'created_by'],
    order: [['id', 'ASC']],
  });
  let created = 0;
  for (const soRow of soRows) {
    const so = soRow.get ? soRow.get({ plain: true }) : soRow;
    const items = Array.isArray(so.items) ? so.items : [];
    if (items.length === 0) continue;

    for (const item of items) {
      let productId = item.product_id || item.productId;
      // Fallback: resolve by product_code / productCode when product_id missing
      if (!productId && (item.product_code || item.productCode)) {
        const code = item.product_code || item.productCode;
        const prodByCode = await Product.findOne({
          where: { product_code: code },
          attributes: ['product_id'],
        });
        if (prodByCode) {
          const plainProd = prodByCode.get ? prodByCode.get({ plain: true }) : prodByCode;
          productId = plainProd.product_id;
        }
      }
      if (!productId) continue;

      const product = await Product.findByPk(productId);
      if (!product) continue;
      const existing = await PlanningExtracted.findOne({
        where: { sales_order_id: so.id, product_id: productId },
      });

      let rawMaterials = [];
      let packagingMaterials = [];
      const bom = await BOM.findOne({ where: { product_id: productId } });
      if (bom) {
        const b = bom.get ? bom.get({ plain: true }) : bom;
        rawMaterials = Array.isArray(b.rm_lines) ? b.rm_lines : [];
        packagingMaterials = Array.isArray(b.pm_lines) ? b.pm_lines : [];
      }
      const hasBomLines =
        rawMaterials.length > 0 || packagingMaterials.length > 0;

      const prodPlain = product.get ? product.get({ plain: true }) : product;
      const orderQty = parseOrderQtyNum(item.quantity || item.orderedQty || 0);
      const batchSizeKg = Number(prodPlain.batch_size_kg) || 100;
      const batchesRequired = batchSizeKg > 0 ? Math.ceil(orderQty / batchSizeKg) : 1;
      const estimatedTotalKg = estimateOrderTotalKg({ orderQty, product: prodPlain, rmLines: rawMaterials, batchSizeKg, batchesRequired });
      const safeTotalKg = estimatedTotalKg > 0
        ? estimatedTotalKg
        : (Math.round(batchSizeKg * batchesRequired * 1000) / 1000);

      if (existing) {
        await existing.update({
          order_qty_display: `${orderQty} units`,
          total_kg_display: `${safeTotalKg} KG`,
          order_date: so.order_date || null,
          due_date: so.expected_shipment_date || null,
          batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
          batches_required: batchesRequired,
          batch_size_kg: batchSizeKg,
          raw_materials: rawMaterials,
          packaging_materials: packagingMaterials,
          approved_by: so.created_by || null,
        });
      } else {
        await PlanningExtracted.create({
          sales_order_id: so.id,
          product_id: productId,
          order_qty_display: `${orderQty} units`,
          total_kg_display: `${safeTotalKg} KG`,
          order_date: so.order_date || null,
          due_date: so.expected_shipment_date || null,
          batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
          batches_required: batchesRequired,
          batch_count: 0,
          batch_size_kg: batchSizeKg,
          bom_status: bom && hasBomLines ? 'Confirmed' : 'Pending',
          bom_confirmed_at: bom && hasBomLines ? new Date() : null,
          approved_by: so.created_by || null,
          raw_materials: rawMaterials,
          packaging_materials: packagingMaterials,
        });
        created++;
      }
    }
  }
  if (created > 0) {
    console.log('[planning-extracted] Sync from sales_orders: created %d missing planning_extracted row(s)', created);
  }
}

async function listPlanningExtracted(req, res) {
  try {
    await syncPlanningExtractedFromSalesOrders();

    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    const normalizeInt = (v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? null : n;
    };

    if (wantsPagination) {
      const limit = limitQ != null ? normalizeInt(limitQ) : 20;
      const offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }

      const total = await PlanningExtracted.count();
      const rows = await PlanningExtracted.findAll({
        include: [
          { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'order_date', 'expected_shipment_date', 'status', 'form_data'], required: false },
          { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'], required: false },
        ],
        order: [['due_date', 'ASC'], ['id', 'ASC']],
        limit,
        offset,
      });
      return res.json({ rows: rows.map(formatRow), total, limit, offset });
    }

    const rows = await PlanningExtracted.findAll({
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'order_date', 'expected_shipment_date', 'status', 'form_data'], required: false },
        { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'], required: false },
      ],
      order: [['due_date', 'ASC'], ['id', 'ASC']],
    });
    res.json(rows.map(formatRow));
  } catch (err) {
    console.error('listPlanningExtracted error', err);
    res.status(500).json({ error: 'Failed to list planning extracted' });
  }
}

async function getPlanningExtractedById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningExtracted.findByPk(id, {
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'order_date', 'expected_shipment_date', 'status', 'form_data'] },
        { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] },
      ],
    });
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });
    res.json(formatRow(row));
  } catch (err) {
    console.error('getPlanningExtractedById error', err);
    res.status(500).json({ error: 'Failed to fetch planning extracted' });
  }
}

async function updatePlanningExtracted(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningExtracted.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });
    const prevBomConfirmedAt = row.get ? row.get('bom_confirmed_at') : row.bom_confirmed_at;
    const body = req.body || {};
    const camelToSnake = {
      orderQty: 'order_qty_display', totalKg: 'total_kg_display', orderDate: 'order_date', dueDate: 'due_date',
      batchSize: 'batch_size_display', batchesRequired: 'batches_required', bomStatus: 'bom_status', approvedBy: 'approved_by',
      rawMaterials: 'raw_materials', packagingMaterials: 'packaging_materials', color: 'color',
      batchCount: 'batch_count', batchSizeKg: 'batch_size_kg', plannedStartDate: 'planned_start_date',
      productionLine: 'production_line', bomConfirmedAt: 'bom_confirmed_at',
      customBatches: 'custom_batches',
      sentBatchIndices: 'sent_batch_indices',
    };
    const allowed = [
      'order_qty_display', 'total_kg_display', 'order_date', 'due_date',
      'batch_size_display', 'batches_required', 'bom_status', 'approved_by',
      'raw_materials', 'packaging_materials', 'color',
      'batch_count', 'batch_size_kg', 'planned_start_date', 'production_line', 'bom_confirmed_at',
      'custom_batches', 'sent_batch_indices',
    ];
    for (const key of allowed) {
      if (body[key] !== undefined) row.set(key, body[key]);
    }
    for (const [camel, snake] of Object.entries(camelToSnake)) {
      if (body[camel] !== undefined) row.set(snake, body[camel]);
    }

    const nowBomConfirmedAt = row.get ? row.get('bom_confirmed_at') : row.bom_confirmed_at;
    if (prevBomConfirmedAt == null && nowBomConfirmedAt != null) {
      const v = await validateWarehouseStockForReservation(row);
      if (!v.ok) {
        return res.status(400).json({
          error: v.message,
          code: v.code,
          details: v.details,
        });
      }
    }

    await row.save();

    // Reserve or release stock when BOM is confirmed or unconfirmed (central warehouse_inventory.reserved)
    if (prevBomConfirmedAt == null && nowBomConfirmedAt != null) {
      await reserveStockForPlanningExtracted(id, row);
      // If this planning row belongs to a website order, move it to in_production stage.
      const so = await SalesOrder.findByPk(row.sales_order_id, { attributes: ['order_id'] });
      const soNo = so && (so.get ? so.get('order_id') : so.order_id);
      if (soNo) await Order.update({ fulfillment_stage: 'in_production' }, { where: { so_no: soNo } });
    } else if (prevBomConfirmedAt != null && nowBomConfirmedAt == null) {
      await releaseStockForPlanningExtracted(id);
      const so = await SalesOrder.findByPk(row.sales_order_id, { attributes: ['order_id'] });
      const soNo = so && (so.get ? so.get('order_id') : so.order_id);
      if (soNo) await Order.update({ fulfillment_stage: 'in_development' }, { where: { so_no: soNo } });
    }

    const updated = await PlanningExtracted.findByPk(id, {
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'order_date', 'expected_shipment_date', 'status', 'form_data'] },
        { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] },
      ],
    });
    res.json(formatRow(updated));
  } catch (err) {
    console.error('updatePlanningExtracted error', err);
    res.status(500).json({ error: 'Failed to update planning extracted' });
  }
}

/**
 * GET /:id/bom-override — custom BOM for this planning extracted row (swapped/edited in Plan Batches).
 * Returns { rmLines, pmLines }. When no override exists yet, returns 200 with empty arrays (avoids 404 noise in console).
 */
async function getBomOverride(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningBomOverride.findOne({ where: { planning_extracted_id: id } });
    const rmLines = row && Array.isArray(row.rm_lines) ? row.rm_lines : [];
    const pmLines = row && Array.isArray(row.pm_lines) ? row.pm_lines : [];
    res.json({ rmLines, pmLines });
  } catch (err) {
    console.error('getBomOverride error', err);
    res.status(500).json({ error: 'Failed to fetch BOM override' });
  }
}

/**
 * PUT /:id/bom-override — create or update custom BOM for this planning extracted row.
 * Body: { rmLines, pmLines }. Also syncs planning_extracted.raw_materials and packaging_materials from override
 * so items-involved and other flows use the custom BOM.
 */
async function putBomOverride(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id);
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const body = req.body || {};
    const rmLines = Array.isArray(body.rmLines) ? body.rmLines : [];
    const pmLines = Array.isArray(body.pmLines) ? body.pmLines : [];

    const [override] = await PlanningBomOverride.findOrCreate({
      where: { planning_extracted_id: id },
      defaults: { rm_lines: rmLines, pm_lines: pmLines },
    });
    if (!override) return res.status(500).json({ error: 'Failed to create BOM override' });
    override.rm_lines = rmLines;
    override.pm_lines = pmLines;
    await override.save();

    const batchSizeKg = Number(planRow.batch_size_kg) || 500;
    const orderQtyNum = parseInt(String(planRow.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
    const totalKg = parseFloat(String(planRow.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
    const rawMaterials = rmLines.map((line) => {
      const pct = line.pct_w_w ?? line.pct ?? 0;
      const quantity = (batchSizeKg * pct) / 100;
      return {
        raw_material_id: line.raw_material_id ?? null,
        name: line.inci_name ?? line.name ?? line.rm_code ?? '',
        quantity: Math.round(quantity * 1000) / 1000,
        unit: line.uom || 'KG',
        code: line.rm_code ?? line.code ?? '',
      };
    });
    const unitsFraction = totalKg > 0 ? batchSizeKg / totalKg : 0;
    const unitsForBatch = Math.ceil(orderQtyNum * unitsFraction) || 0;
    const packagingMaterials = pmLines.map((line) => {
      const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
      const required = unitsForBatch * qtyPerUnit;
      return {
        pack_material_id: line.pack_material_id ?? null,
        name: line.description ?? line.name ?? line.pm_code ?? '',
        quantity: Math.ceil(required),
        unit: 'PCS',
        code: line.pm_code ?? line.code ?? '',
      };
    });
    planRow.raw_materials = rawMaterials;
    planRow.packaging_materials = packagingMaterials;
    await planRow.save();

    res.json({
      rmLines: override.rm_lines || [],
      pmLines: override.pm_lines || [],
    });
  } catch (err) {
    console.error('putBomOverride error', err);
    res.status(500).json({ error: 'Failed to save BOM override' });
  }
}

/**
 * Resolve BOM copy for a planning extracted row: override first, else product BOM.
 * Used when creating/updating planning_batches so each batch gets the current BOM snapshot.
 */
async function getBomCopyForPlanning(planningExtractedId) {
  const override = await PlanningBomOverride.findOne({ where: { planning_extracted_id: planningExtractedId } });
  if (override && ((Array.isArray(override.rm_lines) && override.rm_lines.length > 0) || (Array.isArray(override.pm_lines) && override.pm_lines.length > 0))) {
    return { rmLines: override.rm_lines || [], pmLines: override.pm_lines || [] };
  }

  // If batch-level BOM edits were saved previously (planning_batches.rm_lines/pm_lines),
  // reuse an existing batch BOM copy as the template for any newly created batches.
  // This fixes cases where per-batch swaps/BOM editor changes should flow into "add more batches".
  const lastExistingBatch = await PlanningBatch.findOne({
    where: { planning_extracted_id: planningExtractedId },
    order: [['sequence', 'DESC']],
    attributes: ['rm_lines', 'pm_lines'],
  });
  const lastBatchPlain = lastExistingBatch && lastExistingBatch.get ? lastExistingBatch.get({ plain: true }) : lastExistingBatch;
  const lastRmLines = Array.isArray(lastBatchPlain?.rm_lines) ? lastBatchPlain.rm_lines : [];
  const lastPmLines = Array.isArray(lastBatchPlain?.pm_lines) ? lastBatchPlain.pm_lines : [];
  if (lastRmLines.length > 0 || lastPmLines.length > 0) {
    return { rmLines: lastRmLines, pmLines: lastPmLines };
  }

  const planRow = await PlanningExtracted.findByPk(planningExtractedId, { attributes: ['product_id'] });
  if (!planRow || planRow.product_id == null) return { rmLines: [], pmLines: [] };
  const bom = await BOM.findOne({ where: { product_id: planRow.product_id }, attributes: ['rm_lines', 'pm_lines'] });
  if (!bom) return { rmLines: [], pmLines: [] };
  return {
    rmLines: Array.isArray(bom.rm_lines) ? bom.rm_lines : [],
    pmLines: Array.isArray(bom.pm_lines) ? bom.pm_lines : [],
  };
}

/**
 * GET /batches/all — list all planning_batches with planning extracted, product, SO (for Batches menu).
 * Each row includes sent: true if that batch's sequence is in the PI's sent_batch_indices.
 */
async function listAllBatches(req, res) {
  try {
    const rows = await PlanningBatch.findAll({
      include: [{
        model: PlanningExtracted,
        as: 'planningExtracted',
        required: true,
        attributes: ['id', 'sales_order_id', 'product_id', 'order_qty_display', 'total_kg_display', 'due_date', 'bom_status', 'sent_batch_indices', 'custom_batches'],
        include: [
          { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name'] },
          { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] },
        ],
      }],
      order: [[{ model: PlanningExtracted, as: 'planningExtracted' }, 'due_date', 'ASC'], ['sequence', 'ASC']],
    });
    const list = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const plan = d.planningExtracted || {};
      const sentIndices = Array.isArray(plan.sent_batch_indices) ? plan.sent_batch_indices : [];
      const sent = sentIndices.includes(d.sequence - 1);
      return {
        id: d.id,
        planningExtractedId: d.planning_extracted_id,
        sequence: d.sequence,
        batchCode: d.batch_code,
        sizeKg: d.size_kg != null ? Number(d.size_kg) : null,
        sent,
        sentBatchIndices: sentIndices,
        soNumber: plan.salesOrder?.order_id || '',
        customerName: plan.salesOrder?.customer_name || '',
        productName: plan.product?.product_name || '',
        productCode: plan.product?.product_code || '',
        orderQty: plan.order_qty_display || '',
        totalKg: plan.total_kg_display || '',
        dueDate: plan.due_date || '',
        bomStatus: plan.bom_status || '',
        rmLines: d.rm_lines || [],
        pmLines: d.pm_lines || [],
      };
    });
    res.json(list);
  } catch (err) {
    console.error('listAllBatches error', err);
    res.status(500).json({ error: 'Failed to list batches' });
  }
}

/**
 * GET /sent-summary — returns per-SO sent batch indices for Production to allow scheduling only for sent batches.
 */
async function getSentBatchSummary(req, res) {
  try {
    const rows = await PlanningExtracted.findAll({
      attributes: ['id', 'sent_batch_indices'],
      include: [{ model: SalesOrder, as: 'salesOrder', attributes: ['order_id'], required: true }],
    });
    const list = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const so = d.salesOrder || {};
      const sentBatchIndices = Array.isArray(d.sent_batch_indices) ? d.sent_batch_indices : [];
      return { soNumber: so.order_id || '', sentBatchIndices };
    });
    res.json(list);
  } catch (err) {
    console.error('getSentBatchSummary error', err);
    res.status(500).json({ error: 'Failed to fetch sent summary' });
  }
}

/**
 * GET /:id/batches — list batch-specific BOM rows for this planning extracted (batch_code, size_kg, rm_lines, pm_lines).
 */
async function listBatches(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id);
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const rows = await PlanningBatch.findAll({
      where: { planning_extracted_id: id },
      order: [['sequence', 'ASC']],
    });
    res.json(rows.map(formatBatchRow));
  } catch (err) {
    console.error('listBatches error', err);
    res.status(500).json({ error: 'Failed to list batches' });
  }
}

/**
 * POST /:id/batches — create or update planning_batches from customBatches; each batch gets current BOM copy (override or product BOM).
 * Body: { batches: [ { sizeKg }, ... ] }. Batch codes: PE-{planningId}-B1, PE-{planningId}-B2, ...
 */
async function createOrUpdateBatches(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id);
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const body = req.body || {};
    const batches = Array.isArray(body.batches) ? body.batches : [];
    const bomCopy = await getBomCopyForPlanning(id);
    const existing = await PlanningBatch.findAll({ where: { planning_extracted_id: id }, order: [['sequence', 'ASC']] });
    if (batches.length > existing.length && existing.length > 0) {
      const lastRow = existing[existing.length - 1];
      const lastIdx = (Number(lastRow.sequence) || existing.length) - 1;
      const sentRaw = planRow.get ? planRow.get('sent_batch_indices') : planRow.sent_batch_indices;
      if (!isBatchIndexSent(sentRaw, lastIdx)) {
        return res.status(400).json({
          error: 'Send the latest batch to production before adding more batches.',
          code: 'LAST_BATCH_NOT_SENT',
        });
      }
    }
    for (let i = 0; i < batches.length; i++) {
      const seq = i + 1;
      const batchCode = `PE-${id}-B${seq}`;
      const sizeKg = batches[i].sizeKg != null ? Number(batches[i].sizeKg) : (batches[i].size_kg != null ? Number(batches[i].size_kg) : null);
      const existingRow = existing[i];
      if (existingRow) {
        existingRow.batch_code = batchCode;
        if (sizeKg != null) existingRow.size_kg = sizeKg;

        // Preserve per-batch BOM edits.
        // Only backfill rm_lines/pm_lines from the current BOM copy when the existing row is empty.
        const hasRm = Array.isArray(existingRow.rm_lines) ? existingRow.rm_lines.length > 0 : false;
        const hasPm = Array.isArray(existingRow.pm_lines) ? existingRow.pm_lines.length > 0 : false;
        if (!hasRm) existingRow.rm_lines = bomCopy.rmLines;
        if (!hasPm) existingRow.pm_lines = bomCopy.pmLines;
        await existingRow.save();
      } else {
        await PlanningBatch.create({
          planning_extracted_id: id,
          sequence: seq,
          batch_code: batchCode,
          size_kg: sizeKg,
          rm_lines: bomCopy.rmLines,
          pm_lines: bomCopy.pmLines,
        });
      }
    }
    if (existing.length > batches.length) {
      await PlanningBatch.destroy({
        where: { planning_extracted_id: id, sequence: { [Op.gt]: batches.length } },
      });
    }
    const updated = await PlanningBatch.findAll({ where: { planning_extracted_id: id }, order: [['sequence', 'ASC']] });
    await planRow.update({ batch_count: updated.length });
    res.json(updated.map((r) => formatBatchRow(r)));
  } catch (err) {
    console.error('createOrUpdateBatches error', err);
    res.status(500).json({ error: 'Failed to save batches' });
  }
}

function formatBatchRow(r) {
  const d = r.get ? r.get({ plain: true }) : r;
  return {
    id: d.id,
    planningExtractedId: d.planning_extracted_id,
    sequence: d.sequence,
    batchCode: d.batch_code,
    sizeKg: d.size_kg != null ? Number(d.size_kg) : null,
    rmLines: d.rm_lines || [],
    pmLines: d.pm_lines || [],
  };
}

/**
 * GET /:id/batches/add-one — not used (add-one is POST)
 * GET /:id/batches/:batchId — get one batch by planning_batches.id
 */
async function getBatchById(req, res) {
  try {
    const planningId = parseInt(req.params.id, 10);
    const batchId = parseInt(req.params.batchId, 10);
    if (Number.isNaN(planningId) || Number.isNaN(batchId)) return res.status(400).json({ error: 'Invalid id or batchId' });
    const batch = await PlanningBatch.findOne({
      where: { id: batchId, planning_extracted_id: planningId },
    });
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json(formatBatchRow(batch));
  } catch (err) {
    console.error('getBatchById error', err);
    res.status(500).json({ error: 'Failed to fetch batch' });
  }
}

/**
 * POST /:id/batches/add-one — add one new batch with BOM copied from product master (not override).
 * New batch gets sequence = max+1, batch_code = PE-{id}-B{seq}, size_kg = 500 default.
 */
async function addOneBatchFromMaster(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id, {
      attributes: ['id', 'product_id', 'batch_size_kg', 'sent_batch_indices'],
    });
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const productId = planRow.product_id;
    const defaultSizeKg = Number(planRow.batch_size_kg) || 500;

    const existing = await PlanningBatch.findAll({
      where: { planning_extracted_id: id },
      attributes: ['sequence'],
      order: [['sequence', 'DESC']],
    });
    if (existing.length > 0) {
      const sentRaw = planRow.get ? planRow.get('sent_batch_indices') : planRow.sent_batch_indices;
      const topSeq = Number(existing[0].sequence) || existing.length;
      const lastIdx = topSeq - 1;
      if (!isBatchIndexSent(sentRaw, lastIdx)) {
        return res.status(400).json({
          error: 'Send the latest batch to production before adding another.',
          code: 'LAST_BATCH_NOT_SENT',
        });
      }
    }
    const nextSeq = existing.length === 0 ? 1 : (existing[0].sequence || 0) + 1;
    const batchCode = `PE-${id}-B${nextSeq}`;

    let rmLines = [];
    let pmLines = [];
    if (productId != null) {
      const bom = await BOM.findOne({ where: { product_id: productId }, attributes: ['rm_lines', 'pm_lines'] });
      if (bom) {
        rmLines = Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
        pmLines = Array.isArray(bom.pm_lines) ? bom.pm_lines : [];
      }
    }

    const batch = await PlanningBatch.create({
      planning_extracted_id: id,
      sequence: nextSeq,
      batch_code: batchCode,
      size_kg: defaultSizeKg,
      rm_lines: rmLines,
      pm_lines: pmLines,
    });
    const cnt = await PlanningBatch.count({ where: { planning_extracted_id: id } });
    await PlanningExtracted.update({ batch_count: cnt }, { where: { id } });
    res.status(201).json(formatBatchRow(batch));
  } catch (err) {
    console.error('addOneBatchFromMaster error', err);
    res.status(500).json({ error: 'Failed to add batch' });
  }
}

/**
 * Create one rework planning_batch for the given planning_extracted_id.
 * Batch code: PE-{id}-rw-01, rw-02, ... Also appends to sent_batch_indices.
 * Returns the new PlanningBatch instance (for production to create BMR-YYYY-NNN-rw-01).
 */
async function createRworkPlanningBatch(planningExtractedId, sourcePlanningBatchId = null) {
  const id = planningExtractedId;
  // Optional: copy BOM from an existing planning batch (so rework inherits per-batch edits/swap).
  // When not provided, falls back to SO override/product master via getBomCopyForPlanning().
  const planRow = await PlanningExtracted.findByPk(id, { attributes: ['id', 'product_id', 'batch_size_kg'] });
  if (!planRow) return null;
  const defaultSizeKg = Number(planRow.batch_size_kg) || 500;

  const existing = await PlanningBatch.findAll({
    where: { planning_extracted_id: id },
    attributes: ['sequence', 'batch_code'],
    order: [['sequence', 'DESC']],
  });
  const nextSeq = existing.length === 0 ? 1 : (existing[0].sequence || 0) + 1;
  const rwNums = existing
    .map((b) => ((b.batch_code || '').match(/-rw-(\d+)$/) || [])[1])
    .filter(Boolean)
    .map((n) => parseInt(n, 10));
  const nextRwNum = rwNums.length === 0 ? 1 : Math.max(...rwNums) + 1;
  const rwSuffix = String(nextRwNum).padStart(2, '0');
  const batchCode = `PE-${id}-rw-${rwSuffix}`;

  let bomCopy = null;
  if (sourcePlanningBatchId != null) {
    const srcPb = await PlanningBatch.findByPk(sourcePlanningBatchId, { attributes: ['rm_lines', 'pm_lines'] });
    const srcPlain = srcPb && srcPb.get ? srcPb.get({ plain: true }) : srcPb;
    const srcRm = Array.isArray(srcPlain?.rm_lines) ? srcPlain.rm_lines : [];
    const srcPm = Array.isArray(srcPlain?.pm_lines) ? srcPlain.pm_lines : [];
    // Only use source BOM when it actually has content.
    if (srcRm.length > 0 || srcPm.length > 0) {
      bomCopy = { rmLines: srcRm, pmLines: srcPm };
    }
  }
  if (!bomCopy) {
    bomCopy = await getBomCopyForPlanning(id);
  }
  const batch = await PlanningBatch.create({
    planning_extracted_id: id,
    sequence: nextSeq,
    batch_code: batchCode,
    size_kg: defaultSizeKg,
    rm_lines: bomCopy.rmLines || [],
    pm_lines: bomCopy.pmLines || [],
  });

  const plan = await PlanningExtracted.findByPk(id, { attributes: ['id', 'sent_batch_indices'] });
  if (plan) {
    const sentRaw = plan.get ? plan.get('sent_batch_indices') : plan.sent_batch_indices;
    const sent = Array.isArray(sentRaw) ? sentRaw : [];
    const indexToAdd = nextSeq - 1;
    if (!sent.includes(indexToAdd)) {
      const nextSent = [...sent, indexToAdd].sort((a, b) => a - b);
      await plan.update({ sent_batch_indices: nextSent });
    }
  }
  const batchCnt = await PlanningBatch.count({ where: { planning_extracted_id: id } });
  await PlanningExtracted.update({ batch_count: batchCnt }, { where: { id } });

  return batch;
}

/**
 * POST /:id/batches/add-rework — add one rework batch to the planning table (same planning_extracted).
 * Used when a batch fails and production continues with a new batch. Batch code: PE-{id}-rw-01, rw-02, ...
 */
async function addRworkBatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const batch = await createRworkPlanningBatch(id);
    if (!batch) return res.status(404).json({ error: 'Planning extracted not found' });
    res.status(201).json(formatBatchRow(batch));
  } catch (err) {
    console.error('addRworkBatch error', err);
    res.status(500).json({ error: 'Failed to add rework batch' });
  }
}

/**
 * PUT /:id/batches/:batchId — update one batch's BOM (rm_lines, pm_lines) and/or size_kg.
 * Body: { rmLines?, pmLines?, sizeKg? }
 */
async function updateBatch(req, res) {
  try {
    const planningId = parseInt(req.params.id, 10);
    const batchId = parseInt(req.params.batchId, 10);
    if (Number.isNaN(planningId) || Number.isNaN(batchId)) return res.status(400).json({ error: 'Invalid id or batchId' });
    const batch = await PlanningBatch.findOne({
      where: { id: batchId, planning_extracted_id: planningId },
    });
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const body = req.body || {};
    if (Array.isArray(body.rmLines)) batch.rm_lines = body.rmLines;
    if (Array.isArray(body.pmLines)) batch.pm_lines = body.pmLines;
    if (body.sizeKg != null) batch.size_kg = Number(body.sizeKg);
    await batch.save();
    res.json(formatBatchRow(batch));
  } catch (err) {
    console.error('updateBatch error', err);
    res.status(500).json({ error: 'Failed to update batch' });
  }
}

/**
 * GET /items-involved — aggregated RM/PM from planning batches released to production (sent), consolidated by item.
 * Only batches whose sequence is in the PI's sent_batch_indices are included (production phase).
 * When no batches are sent, falls back to confirmed planning_extracted. Used by Planning Items Involved tab.
 */
async function getItemsInvolved(req, res) {
  try {
    const rmAgg = new Map(); // key: raw_material_id -> { totalRequired, unit, productNames, planningExtractedIds, name, code, batchCount }
    const pmAgg = new Map(); // key: pack_material_id -> { totalRequired, unit, productNames, planningExtractedIds, name, code, batchCount }

    const batches = await PlanningBatch.findAll({
      include: [{
        model: PlanningExtracted,
        as: 'planningExtracted',
        required: true,
        attributes: ['id', 'order_qty_display', 'total_kg_display', 'product_id', 'sent_batch_indices', 'packaging_materials'],
        include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] }],
      }],
      order: [['planning_extracted_id', 'ASC'], ['sequence', 'ASC']],
    });

    // Only include batches that have been released to production (sent)
    const sentBatches = batches.filter((b) => {
      const plain = b.get ? b.get({ plain: true }) : b;
      const plan = plain.planningExtracted || {};
      const sentIndices = Array.isArray(plan.sent_batch_indices) ? plan.sent_batch_indices : [];
      return sentIndices.includes((plain.sequence || 1) - 1);
    });

    if (sentBatches.length > 0) {
      const rmCodes = new Set();
      const pmCodes = new Set();
      for (const b of sentBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const plan = plain.planningExtracted || {};
        const rms = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        for (const line of rms) {
          const code = line.rm_code || line.code;
          if (code) rmCodes.add(code);
        }
        const pms = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
        for (const line of pms) {
          const code = line.pm_code || line.code;
          if (code) pmCodes.add(code);
        }
        if (pms.length === 0) {
          for (const p of Array.isArray(plan.packaging_materials) ? plan.packaging_materials : []) {
            if (p.code) pmCodes.add(p.code);
          }
        }
      }
      const rmByCode = new Map();
      const rmByName = new Map();
      if (rmCodes.size > 0) {
        const rmsList = await RawMaterial.findAll({ where: { code: { [Op.in]: [...rmCodes] } }, attributes: ['id', 'code', 'name'] });
        for (const r of rmsList) {
          rmByCode.set(r.code, r);
          const key = String(r.name || '').trim().toLowerCase();
          if (key) rmByName.set(key, r);
        }
      }
      const pmByCode = new Map();
      const pmByName = new Map();
      if (pmCodes.size > 0) {
        const pmsList = await PackMaterial.findAll({ where: { code: { [Op.in]: [...pmCodes] } }, attributes: ['id', 'code', 'description'] });
        for (const p of pmsList) {
          pmByCode.set(p.code, p);
          const key = String(p.description || '').trim().toLowerCase();
          if (key) pmByName.set(key, p);
        }
      }

      for (const batch of sentBatches) {
        const plain = batch.get ? batch.get({ plain: true }) : batch;
        const plan = plain.planningExtracted || {};
        const productName = plan.product?.product_name || '';
        const planId = plan.id;
        const sizeKg = Number(plain.size_kg) || 0;
        const orderQty = parseInt(String(plan.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
        const totalKg = parseFloat(String(plan.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
        const kgPerUnit = orderQty > 0 && totalKg > 0 ? totalKg / orderQty : 1;
        const unitsForBatch = kgPerUnit > 0 ? sizeKg / kgPerUnit : 0;

        const rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        const rmIdsInThisBatch = new Set();
        for (const line of rmLines) {
          let id = line.raw_material_id != null ? Number(line.raw_material_id) : null;
          let resolvedRm = null;
          if (id == null && (line.rm_code || line.code)) {
            const rm = rmByCode.get(line.rm_code || line.code);
            if (rm) {
              id = rm.id;
              resolvedRm = rm;
            }
          }
          if (id == null && (line.inci_name || line.name)) {
            const nameKey = String(line.inci_name || line.name || '').trim().toLowerCase();
            const rm = nameKey ? rmByName.get(nameKey) : null;
            if (rm) {
              id = rm.id;
              resolvedRm = rm;
            }
          }
          if (id == null || Number.isNaN(id)) continue;
          rmIdsInThisBatch.add(id);
          const pct = line.pct_w_w ?? line.pct ?? 0;
          const qty = (sizeKg * pct) / 100;
          const unit = line.uom || 'KG';
          const name = resolvedRm?.name || line.inci_name || line.name || line.rm_code || '';
          const code = resolvedRm?.code || line.rm_code || line.code || '';
          if (!rmAgg.has(id)) {
            rmAgg.set(id, { totalRequired: 0, unit, productNames: [], planningExtractedIds: [], name, code, batchCount: 0 });
          }
          const agg = rmAgg.get(id);
          agg.totalRequired += qty;
          if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
          if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
          if (name) agg.name = name;
          if (code) agg.code = code;
        }
        for (const id of rmIdsInThisBatch) {
          if (rmAgg.has(id)) rmAgg.get(id).batchCount += 1;
        }

        let pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
        // Batches often store RM lines only; PI still has packaging_materials from BOM confirm.
        if (pmLines.length === 0) {
          const pkg = Array.isArray(plan.packaging_materials) ? plan.packaging_materials : [];
          const oq = orderQty;
          pmLines = pkg.map((p) => {
            const totalPcs = Number(p.quantity) || 0;
            const qpu = oq > 0 ? totalPcs / oq : totalPcs;
            return {
              pack_material_id: p.pack_material_id,
              pm_code: p.code,
              code: p.code,
              description: p.name,
              name: p.name,
              qty_per_unit: qpu,
              qty: qpu,
            };
          });
        }
        const pmIdsInThisBatch = new Set();
        for (const line of pmLines) {
          let id = line.pack_material_id != null ? Number(line.pack_material_id) : null;
          let resolvedPm = null;
          if (id == null && (line.pm_code || line.code)) {
            const pm = pmByCode.get(line.pm_code || line.code);
            if (pm) {
              id = pm.id;
              resolvedPm = pm;
            }
          }
          if (id == null && (line.description || line.name)) {
            const nameKey = String(line.description || line.name || '').trim().toLowerCase();
            const pm = nameKey ? pmByName.get(nameKey) : null;
            if (pm) {
              id = pm.id;
              resolvedPm = pm;
            }
          }
          if (id == null || Number.isNaN(id)) continue;
          pmIdsInThisBatch.add(id);
          const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
          const qty = unitsForBatch * qtyPerUnit;
          const unit = 'PCS';
          const name = resolvedPm?.description || line.description || line.name || line.pm_code || '';
          const code = resolvedPm?.code || line.pm_code || line.code || '';
          if (!pmAgg.has(id)) {
            pmAgg.set(id, { totalRequired: 0, unit, productNames: [], planningExtractedIds: [], name, code, batchCount: 0 });
          }
          const agg = pmAgg.get(id);
          agg.totalRequired += qty;
          if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
          if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
          if (name) agg.name = name;
          if (code) agg.code = code;
        }
        for (const id of pmIdsInThisBatch) {
          if (pmAgg.has(id)) pmAgg.get(id).batchCount += 1;
        }
      }
    }

    if (rmAgg.size === 0 && pmAgg.size === 0) {
      const confirmed = await PlanningExtracted.findAll({
        where: { bom_confirmed_at: { [Op.ne]: null } },
        include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] }],
        order: [['id', 'ASC']],
      });
      const fallbackRmCodes = new Set();
      const fallbackPmCodes = new Set();
      for (const row of confirmed) {
        const plain = row.get ? row.get({ plain: true }) : row;
        for (const r of Array.isArray(plain.raw_materials) ? plain.raw_materials : []) {
          if (r.code) fallbackRmCodes.add(r.code);
        }
        for (const p of Array.isArray(plain.packaging_materials) ? plain.packaging_materials : []) {
          if (p.code) fallbackPmCodes.add(p.code);
        }
      }
      const fallbackRmByCode = new Map();
      const fallbackRmByName = new Map();
      const fallbackPmByCode = new Map();
      const fallbackPmByName = new Map();
      if (fallbackRmCodes.size > 0) {
        const rmsList = await RawMaterial.findAll({ where: { code: { [Op.in]: [...fallbackRmCodes] } }, attributes: ['id', 'code', 'name'] });
        for (const r of rmsList) {
          fallbackRmByCode.set(r.code, r);
          const key = String(r.name || '').trim().toLowerCase();
          if (key) fallbackRmByName.set(key, r);
        }
      }
      if (fallbackPmCodes.size > 0) {
        const pmsList = await PackMaterial.findAll({ where: { code: { [Op.in]: [...fallbackPmCodes] } }, attributes: ['id', 'code', 'description'] });
        for (const p of pmsList) {
          fallbackPmByCode.set(p.code, p);
          const key = String(p.description || '').trim().toLowerCase();
          if (key) fallbackPmByName.set(key, p);
        }
      }
      for (const row of confirmed) {
        const plain = row.get ? row.get({ plain: true }) : row;
        const productName = plain.product?.product_name || '';
        const planId = plain.id;
        const rms = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
        for (const r of rms) {
          let id = r.raw_material_id != null ? Number(r.raw_material_id) : null;
          if (id == null && r.code) {
            const rm = fallbackRmByCode.get(r.code);
            if (rm) id = rm.id;
          }
          if (id == null && r.name) {
            const rm = fallbackRmByName.get(String(r.name).trim().toLowerCase());
            if (rm) id = rm.id;
          }
          if (id == null || Number.isNaN(id)) continue;
          const qty = Number(r.quantity) || 0;
          const unit = r.unit || 'KG';
          if (!rmAgg.has(id)) {
            rmAgg.set(id, { totalRequired: 0, unit, productNames: [], planningExtractedIds: [], name: r.name || '', code: r.code || '', batchCount: 0 });
          }
          const agg = rmAgg.get(id);
          agg.totalRequired += qty;
          if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
          if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
          if (r.name) agg.name = r.name;
          if (r.code) agg.code = r.code;
        }
        const pms = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];
        for (const p of pms) {
          let id = p.pack_material_id != null ? Number(p.pack_material_id) : null;
          if (id == null && p.code) {
            const pm = fallbackPmByCode.get(p.code);
            if (pm) id = pm.id;
          }
          if (id == null && p.name) {
            const pm = fallbackPmByName.get(String(p.name).trim().toLowerCase());
            if (pm) id = pm.id;
          }
          if (id == null || Number.isNaN(id)) continue;
          const qty = Number(p.quantity) || 0;
          const unit = p.unit || 'PCS';
          if (!pmAgg.has(id)) {
            pmAgg.set(id, { totalRequired: 0, unit, productNames: [], planningExtractedIds: [], name: p.name || '', code: p.code || '', batchCount: 0 });
          }
          const agg = pmAgg.get(id);
          agg.totalRequired += qty;
          if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
          if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
          if (p.name) agg.name = p.name;
          if (p.code) agg.code = p.code;
        }
      }
    }

    const allRmIds = [...rmAgg.keys()];
    const allPmIds = [...pmAgg.keys()];
    const whWhere = [];
    if (allRmIds.length) whWhere.push({ item_type: 'RM', raw_material_id: { [Op.in]: allRmIds } });
    if (allPmIds.length) whWhere.push({ item_type: 'PM', pack_material_id: { [Op.in]: allPmIds } });
    const [whRows, rmsList, pmsList] = await Promise.all([
      whWhere.length ? WarehouseInventory.findAll({ where: { [Op.or]: whWhere } }) : Promise.resolve([]),
      allRmIds.length ? RawMaterial.findAll({ where: { id: allRmIds }, attributes: ['id', 'code', 'name'] }) : Promise.resolve([]),
      allPmIds.length ? PackMaterial.findAll({ where: { id: allPmIds }, attributes: ['id', 'code', 'description'] }) : Promise.resolve([]),
    ]);
    const toNum = (v) => (v != null && v !== '' ? Number(v) : 0);
    const sihByRm = new Map();
    const sihByPm = new Map();
    const whIdByRm = new Map();
    const whIdByPm = new Map();
    const batchNumberByRm = new Map();
    const batchNumberByPm = new Map();
    const expiryByRm = new Map();
    const expiryByPm = new Map();
    const reservedByRm = new Map();
    const reservedByPm = new Map();
    const inTransitByRm = new Map();
    const inTransitByPm = new Map();
    const reorderPtByRm = new Map();
    const reorderPtByPm = new Map();
    const avgMoByRm = new Map();
    const avgMoByPm = new Map();
    const statusByRm = new Map();
    const statusByPm = new Map();
    for (const w of whRows) {
      const s = toNum(w.stock_in_hand);
      const whId = w.id;
      const batchNumber = w.batch_number || null;
      const expiryDate = w.expiry_date || null;
      const reserved = toNum(w.reserved);
      const inTransit = toNum(w.in_transit);
      const reorderPt = toNum(w.reorder_pt);
      const avgMo = toNum(w.avg_mo);
      let status = (w.qc_status || 'In Stock').trim();
      if (status === 'In Stock' && reorderPt > 0) {
        if (s < reorderPt * 0.5) status = 'Critical';
        else if (s < reorderPt) status = 'Low Stock';
      }
      if (s <= 0 && status === 'In Stock') status = 'Out of Stock';
      if (w.item_type === 'RM' && w.raw_material_id) {
        sihByRm.set(w.raw_material_id, s);
        whIdByRm.set(w.raw_material_id, whId);
        if (batchNumber) batchNumberByRm.set(w.raw_material_id, batchNumber);
        if (expiryDate) expiryByRm.set(w.raw_material_id, expiryDate);
        reservedByRm.set(w.raw_material_id, reserved);
        inTransitByRm.set(w.raw_material_id, inTransit);
        reorderPtByRm.set(w.raw_material_id, reorderPt);
        avgMoByRm.set(w.raw_material_id, avgMo);
        statusByRm.set(w.raw_material_id, status);
      }
      if (w.item_type === 'PM' && w.pack_material_id) {
        sihByPm.set(w.pack_material_id, s);
        whIdByPm.set(w.pack_material_id, whId);
        if (batchNumber) batchNumberByPm.set(w.pack_material_id, batchNumber);
        if (expiryDate) expiryByPm.set(w.pack_material_id, expiryDate);
        reservedByPm.set(w.pack_material_id, reserved);
        inTransitByPm.set(w.pack_material_id, inTransit);
        reorderPtByPm.set(w.pack_material_id, reorderPt);
        avgMoByPm.set(w.pack_material_id, avgMo);
        statusByPm.set(w.pack_material_id, status);
      }
    }
    const rmInfo = new Map(rmsList.map((r) => [r.id, { code: r.code, name: r.name }]));
    const pmInfo = new Map(pmsList.map((p) => [p.id, { code: p.code, name: p.description || p.code }]));

    const out = [];
    for (const [id, agg] of rmAgg) {
      // "sih" in the items-involved API should represent *available/free* stock
      // (stock_in_hand minus already-reserved quantities). Otherwise the UI
      // can incorrectly think there is no shortage and disable "Release to Planning".
      const stockInHand = sihByRm.get(id) ?? 0;
      const reserved = reservedByRm.get(id) ?? 0;
      const sih = Math.max(0, stockInHand - reserved);
      const surplusShortage = sih - agg.totalRequired;
      const plannedQty = Number(
        await ReservedBatchItem.sum('quantity_reserved', {
          where: {
            raw_material_id: id,
            production_batch_id: { [Op.ne]: null },
          },
        })
      ) || 0;
      const info = rmInfo.get(id) || {};
      out.push({
        type: 'RM',
        raw_material_id: id,
        pack_material_id: null,
        code: info.code || agg.code || `RM-${id}`,
        name: info.name || agg.name || `RM ${id}`,
        category: 'RM',
        usedInProducts: agg.productNames,
        planningExtractedIds: agg.planningExtractedIds,
        totalRequired: agg.totalRequired,
        unit: agg.unit,
        batchCount: agg.batchCount ?? 0,
        sih,
        surplusShortage,
        coverage: agg.totalRequired > 0 ? Math.min(100, Math.round((sih / agg.totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByRm.get(id) ?? null,
        batchNumber: batchNumberByRm.get(id) ?? null,
        expiryDate: expiryByRm.get(id) ?? null,
        reserved,
        plannedQty,
        inTransit: inTransitByRm.get(id) ?? 0,
        reorderPt: reorderPtByRm.get(id) ?? 0,
        avgMo: avgMoByRm.get(id) ?? 0,
        status: statusByRm.get(id) ?? 'In Stock',
      });
    }
    for (const [id, agg] of pmAgg) {
      const stockInHand = sihByPm.get(id) ?? 0;
      const reserved = reservedByPm.get(id) ?? 0;
      const sih = Math.max(0, stockInHand - reserved);
      const surplusShortage = sih - agg.totalRequired;
      const plannedQty = Number(
        await ReservedBatchItem.sum('quantity_reserved', {
          where: {
            pack_material_id: id,
            production_batch_id: { [Op.ne]: null },
          },
        })
      ) || 0;
      const info = pmInfo.get(id) || {};
      out.push({
        type: 'PM',
        raw_material_id: null,
        pack_material_id: id,
        code: info.code || agg.code || `PM-${id}`,
        name: info.name || agg.name || `PM ${id}`,
        category: 'PM',
        usedInProducts: agg.productNames,
        planningExtractedIds: agg.planningExtractedIds,
        totalRequired: agg.totalRequired,
        unit: agg.unit,
        batchCount: agg.batchCount ?? 0,
        sih,
        surplusShortage,
        coverage: agg.totalRequired > 0 ? Math.min(100, Math.round((sih / agg.totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByPm.get(id) ?? null,
        batchNumber: batchNumberByPm.get(id) ?? null,
        expiryDate: expiryByPm.get(id) ?? null,
        reserved,
        plannedQty,
        inTransit: inTransitByPm.get(id) ?? 0,
        reorderPt: reorderPtByPm.get(id) ?? 0,
        avgMo: avgMoByPm.get(id) ?? 0,
        status: statusByPm.get(id) ?? 'In Stock',
      });
    }

    // Stable ordering for pagination.
    out.sort((a, b) => {
      const aCode = a.code || '';
      const bCode = b.code || '';
      if (aCode !== bCode) return aCode.localeCompare(bCode);

      const aType = a.type || '';
      const bType = b.type || '';
      if (aType !== bType) return aType.localeCompare(bType);

      const aId = (a.raw_material_id ?? a.pack_material_id ?? 0) || 0;
      const bId = (b.raw_material_id ?? b.pack_material_id ?? 0) || 0;
      return Number(aId) - Number(bId);
    });

    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    if (wantsPagination) {
      const normalizeInt = (v) => {
        const n = parseInt(String(v), 10);
        return Number.isNaN(n) ? null : n;
      };

      const limit = limitQ != null ? normalizeInt(limitQ) : 20;
      const offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }

      return res.json({
        rows: out.slice(offset, offset + limit),
        total: out.length,
        limit,
        offset,
      });
    }

    res.json(out);
  } catch (err) {
    console.error('getItemsInvolved error', err);
    res.status(500).json({ error: 'Failed to fetch items involved' });
  }
}

/**
 * GET /:id/items-involved — items (RM/PM) for a single planning extracted row with SIH from warehouse.
 * Same shape as global items-involved but for one PI only (for Order Management / RM Plan view).
 */
async function getItemsInvolvedByPlanningId(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningExtracted.findByPk(id, {
      include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] }],
    });
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });

    const plain = row.get ? row.get({ plain: true }) : row;
    const rmIds = [];
    const pmIds = [];
    const rmReq = new Map(); // id -> { quantity, unit, name, code }
    const pmReq = new Map();

    let rms = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
    let pms = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];

    const productId = plain.product_id ?? plain.product?.product_id;
    if (productId != null && (rms.length === 0 || pms.length === 0)) {
      const bomRows = await BOM.findAll({ where: { product_id: productId }, limit: 1 });
      const bom = bomRows[0];
      if (bom) {
        const bomPlain = bom.get ? bom.get({ plain: true }) : bom;
        if (rms.length === 0 && Array.isArray(bomPlain.rm_lines) && bomPlain.rm_lines.length > 0) {
          const batchSizeKg = Number(plain.batch_size_kg) || 500;
          for (const line of bomPlain.rm_lines) {
            let rid = line.raw_material_id != null ? Number(line.raw_material_id) : null;
            if (rid == null && line.rm_code) {
              const rm = await RawMaterial.findOne({ where: { code: line.rm_code }, attributes: ['id'] });
              if (rm) rid = rm.id;
            }
            if (rid == null || Number.isNaN(rid)) continue;
            const pct = line.pct_w_w ?? line.pct ?? 0;
            const quantity = (batchSizeKg * pct) / 100;
            rms.push({
              raw_material_id: rid,
              name: line.inci_name ?? line.name ?? line.rm_code ?? '',
              quantity: Math.round(quantity * 1000) / 1000,
              unit: line.uom || 'KG',
              code: line.rm_code ?? line.code ?? '',
            });
          }
        }
        if (pms.length === 0 && Array.isArray(bomPlain.pm_lines) && bomPlain.pm_lines.length > 0) {
          const orderQtyNum = parseInt(String(plain.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
          const totalKg = parseFloat(String(plain.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
          const batchSizeKg = Number(plain.batch_size_kg) || 500;
          const unitsFraction = totalKg > 0 ? batchSizeKg / totalKg : 0;
          const unitsForBatch = Math.ceil(orderQtyNum * unitsFraction) || 0;
          for (const line of bomPlain.pm_lines) {
            let pid = line.pack_material_id != null ? Number(line.pack_material_id) : null;
            if (pid == null && line.pm_code) {
              const pm = await PackMaterial.findOne({ where: { code: line.pm_code }, attributes: ['id'] });
              if (pm) pid = pm.id;
            }
            if (pid == null || Number.isNaN(pid)) continue;
            const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
            const required = unitsForBatch * qtyPerUnit;
            pms.push({
              pack_material_id: pid,
              name: line.description ?? line.name ?? line.pm_code ?? '',
              quantity: Math.ceil(required),
              unit: 'PCS',
              code: line.pm_code ?? line.code ?? '',
            });
          }
        }
      }
    }

    // Resolve raw_material_id / pack_material_id by code or name when missing (planning_extracted often has code/name only)
    const rmCodes = [...new Set(rms.map((r) => (r.code || '').trim()).filter(Boolean))];
    const rmNames = [...new Set(rms.map((r) => (r.name || '').trim()).filter(Boolean))];
    const pmCodes = [...new Set(pms.map((p) => (p.code || '').trim()).filter(Boolean))];
    const pmNames = [...new Set(pms.map((p) => (p.name || '').trim()).filter(Boolean))];
    let rmByCode = {};
    let rmByName = {};
    let pmByCode = {};
    let pmByName = {};
    if (rmCodes.length > 0 || rmNames.length > 0) {
      const rmWhere = rmCodes.length && rmNames.length
        ? { [Op.or]: [{ code: { [Op.in]: rmCodes } }, { name: { [Op.in]: rmNames } }] }
        : (rmCodes.length ? { code: { [Op.in]: rmCodes } } : { name: { [Op.in]: rmNames } });
      const rmRows = await RawMaterial.findAll({ where: rmWhere, attributes: ['id', 'code', 'name'] });
      rmRows.forEach((x) => {
        const d = x.get ? x.get({ plain: true }) : x;
        if (d.code) rmByCode[d.code] = d.id;
        if (d.name) rmByName[String(d.name).trim().toLowerCase()] = d.id;
      });
    }
    if (pmCodes.length > 0 || pmNames.length > 0) {
      const pmWhere = pmCodes.length && pmNames.length
        ? { [Op.or]: [{ code: { [Op.in]: pmCodes } }, { description: { [Op.in]: pmNames } }] }
        : (pmCodes.length ? { code: { [Op.in]: pmCodes } } : { description: { [Op.in]: pmNames } });
      const pmRows = await PackMaterial.findAll({ where: pmWhere, attributes: ['id', 'code', 'description'] });
      pmRows.forEach((x) => {
        const d = x.get ? x.get({ plain: true }) : x;
        if (d.code) pmByCode[d.code] = d.id;
        if (d.description) pmByName[String(d.description).trim().toLowerCase()] = d.id;
      });
    }
    for (const r of rms) {
      if (r.raw_material_id != null && !Number.isNaN(Number(r.raw_material_id))) continue;
      const code = (r.code || '').trim();
      const nameKey = (r.name || '').trim().toLowerCase();
      if (code && rmByCode[code]) r.raw_material_id = rmByCode[code];
      else if (nameKey && rmByName[nameKey]) r.raw_material_id = rmByName[nameKey];
    }
    for (const p of pms) {
      if (p.pack_material_id != null && !Number.isNaN(Number(p.pack_material_id))) continue;
      const code = (p.code || '').trim();
      const nameKey = (p.name || '').trim().toLowerCase();
      if (code && pmByCode[code]) p.pack_material_id = pmByCode[code];
      else if (nameKey && pmByName[nameKey]) p.pack_material_id = pmByName[nameKey];
    }

    for (const r of rms) {
      const rid = r.raw_material_id != null ? Number(r.raw_material_id) : null;
      if (rid == null || Number.isNaN(rid)) continue;
      rmIds.push(rid);
      rmReq.set(rid, { quantity: Number(r.quantity) || 0, unit: r.unit || 'KG', name: r.name || '', code: r.code || '' });
    }
    for (const p of pms) {
      const pid = p.pack_material_id != null ? Number(p.pack_material_id) : null;
      if (pid == null || Number.isNaN(pid)) continue;
      pmIds.push(pid);
      pmReq.set(pid, { quantity: Number(p.quantity) || 0, unit: p.unit || 'PCS', name: p.name || '', code: p.code || '' });
    }

    const whWhere = [];
    if (rmIds.length) whWhere.push({ item_type: 'RM', raw_material_id: { [Op.in]: rmIds } });
    if (pmIds.length) whWhere.push({ item_type: 'PM', pack_material_id: { [Op.in]: pmIds } });
    const [whRows, rmsList, pmsList] = await Promise.all([
      whWhere.length ? WarehouseInventory.findAll({ where: { [Op.or]: whWhere } }) : Promise.resolve([]),
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'] }) : Promise.resolve([]),
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : Promise.resolve([]),
    ]);

    const sihByRm = new Map();
    const reservedByRm = new Map();
    const whIdByRm = new Map();
    const batchByRm = new Map();
    const expiryByRm = new Map();
    const sihByPm = new Map();
    const reservedByPm = new Map();
    const whIdByPm = new Map();
    const batchByPm = new Map();
    const expiryByPm = new Map();
    for (const w of whRows) {
      const s = Number(w.stock_in_hand) || 0;
      const resv = Number(w.reserved) || 0;
      if (w.item_type === 'RM' && w.raw_material_id) {
        sihByRm.set(w.raw_material_id, s);
        reservedByRm.set(w.raw_material_id, resv);
        whIdByRm.set(w.raw_material_id, w.id);
        if (w.batch_number) batchByRm.set(w.raw_material_id, w.batch_number);
        if (w.expiry_date) expiryByRm.set(w.raw_material_id, w.expiry_date);
      }
      if (w.item_type === 'PM' && w.pack_material_id) {
        sihByPm.set(w.pack_material_id, s);
        reservedByPm.set(w.pack_material_id, resv);
        whIdByPm.set(w.pack_material_id, w.id);
        if (w.batch_number) batchByPm.set(w.pack_material_id, w.batch_number);
        if (w.expiry_date) expiryByPm.set(w.pack_material_id, w.expiry_date);
      }
    }

    const rmInfo = new Map(rmsList.map((r) => [r.id, { code: r.code, name: r.name }]));
    const pmInfo = new Map(pmsList.map((p) => [p.id, { code: p.code, name: p.description || p.code }]));

    const out = [];
    let idx = 0;
    for (const rid of rmIds) {
      const req = rmReq.get(rid) || {};
      const sih = sihByRm.get(rid) ?? 0;
      const reserved = reservedByRm.get(rid) ?? 0;
      const netStock = sih - reserved;
      const totalRequired = req.quantity || 0;
      const info = rmInfo.get(rid) || {};
      const name = req.name || info.name || `RM ${rid}`;
      const code = req.code || info.code || `RM-${rid}`;
      out.push({
        id: String(++idx),
        type: 'RM',
        raw_material_id: rid,
        pack_material_id: null,
        code,
        name,
        item: name,
        category: 'RM',
        usedInProducts: plain.product ? [plain.product.product_name || plain.product.product_code] : [],
        planningExtractedIds: [id],
        totalRequired,
        unit: req.unit || 'KG',
        sih,
        reserved,
        netStock,
        surplusShortage: netStock - totalRequired,
        coverage: totalRequired > 0 ? Math.min(100, Math.round((sih / totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByRm.get(rid) ?? null,
        batchNumber: batchByRm.get(rid) ?? null,
        expiryDate: expiryByRm.get(rid) ?? null,
      });
    }
    for (const pid of pmIds) {
      const req = pmReq.get(pid) || {};
      const sih = sihByPm.get(pid) ?? 0;
      const reserved = reservedByPm.get(pid) ?? 0;
      const netStock = sih - reserved;
      const totalRequired = req.quantity || 0;
      const info = pmInfo.get(pid) || {};
      const name = req.name || info.name || `PM ${pid}`;
      const code = req.code || info.code || `PM-${pid}`;
      out.push({
        id: String(++idx),
        type: 'PM',
        raw_material_id: null,
        pack_material_id: pid,
        code,
        name,
        item: name,
        category: 'PM',
        usedInProducts: plain.product ? [plain.product.product_name || plain.product.product_code] : [],
        planningExtractedIds: [id],
        totalRequired,
        unit: req.unit || 'PCS',
        sih,
        reserved,
        netStock,
        surplusShortage: netStock - totalRequired,
        coverage: totalRequired > 0 ? Math.min(100, Math.round((sih / totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByPm.get(pid) ?? null,
        batchNumber: batchByPm.get(pid) ?? null,
        expiryDate: expiryByPm.get(pid) ?? null,
      });
    }

    console.log('[planningExtracted][items-involved-by-id]', {
      planningExtractedId: id,
      rows: out.map((r) => ({
        code: r.code,
        type: r.type,
        sih: r.sih,
        reserved: r.reserved,
        netStock: r.netStock,
        totalRequired: r.totalRequired,
        surplusShortage: r.surplusShortage,
      })),
    });
    res.json(out);
  } catch (err) {
    console.error('getItemsInvolvedByPlanningId error', err);
    res.status(500).json({ error: 'Failed to fetch items involved for planning line' });
  }
}

module.exports = {
  listPlanningExtracted,
  getPlanningExtractedById,
  updatePlanningExtracted,
  getBomOverride,
  putBomOverride,
  listAllBatches,
  getSentBatchSummary,
  listBatches,
  getBatchById,
  createOrUpdateBatches,
  addOneBatchFromMaster,
  addRworkBatch,
  updateBatch,
  getItemsInvolved,
  getItemsInvolvedByPlanningId,
  getBomCopyForPlanning,
  createRworkPlanningBatch,
  syncWarehouseReserved,
  reserveStockForPlanningExtracted,
  releaseStockForPlanningExtracted,
};
