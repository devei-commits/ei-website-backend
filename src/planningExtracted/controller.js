const { Op } = require('sequelize');
const db = require('../../db');
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
const PurchaseOrder = require('../purchaseOrders/models');
const ProcurementRequest = require('../procurementRequests/models');
const { isPlanningQuotationOnlyProcurementRequest } = require('../lib/planningQuotationRequest');
const {
  parseOrderQtyNum,
  parseFillSizeToKgPerUnit,
  inferBlendSpecificGravity,
  buildPlanningKgFromSoLine,
  buildPlanningSnapshotFromBom,
  roundPlanningMaterialQty,
} = require('./orderKgMath');
const {
  resolveRmIdFromPlanningLine,
  resolvePmIdFromPlanningLine,
  resolveRmIdFromMaterialSnapshotRow,
} = require('../lib/planningRmResolve');
const { getCreatedAndRemainingUnitsFromPlanningRow } = require('./planningSlaUnits');
const { computePlanningSlaMeta } = require('../lib/planningSla');
const {
  backendNow,
  serializeInstantIndia,
  addDaysToIndiaDateOnly,
  daysLeftFromDueDateIndia,
} = require('../lib/indiaTime');
const { ProductionBatch } = require('../production/models');
const {
  isPlanningBatchEditableByProduction,
  planningBatchEditLockReason,
  validateUpdateOnlyBatchPayload,
} = require('./planningBatchEditLock');

/** Idempotent schema patch: adds bom_specific_gravity on Postgres if missing. Lazy, safe to call repeatedly. */
let bomSgColumnEnsured = false;
async function ensureBomSgColumn() {
  if (bomSgColumnEnsured) return;
  bomSgColumnEnsured = true;
  try {
    const dialect = db.getDialect && db.getDialect();
    if (dialect === 'postgres') {
      await db.query(
        'ALTER TABLE planning_extracted ADD COLUMN IF NOT EXISTS bom_specific_gravity NUMERIC(5,3)'
      );
    }
  } catch (e) {
    console.warn('[planning-extracted] ensureBomSgColumn:', e && e.message ? e.message : e);
  }
}

/** Whether `sent_batch_indices` includes this 0-based batch index (coerces string/number from JSON). */
function isBatchIndexSent(sentRaw, batchIndex0) {
  const sent = Array.isArray(sentRaw) ? sentRaw : [];
  return sent.some((x) => Number(x) === Number(batchIndex0));
}

/**
 * planning_batches rows that are already sent to production (PI.sent_batch_indices, 0-based index = sequence − 1).
 * Draft batches (e.g. auto-added B2 after B1 is sent) must not drive items-involved "used in" / planned split until sent.
 */
function filterPlanningBatchesSentToProduction(planPlain, planBatchesPlain) {
  const sentRaw = planPlain.sent_batch_indices;
  return planBatchesPlain.filter((bp) => {
    const seq = Number(bp.sequence);
    if (!Number.isFinite(seq) || seq < 1) return false;
    return isBatchIndexSent(sentRaw, seq - 1);
  });
}

function daysLeftDisplay(dueDate) {
  return daysLeftFromDueDateIndia(dueDate);
}

function addDaysDateOnly(baseDate, days) {
  return addDaysToIndiaDateOnly(baseDate, days);
}

/**
 * Warehouse QC/status uses raw stock_in_hand; items-involved NET uses free SIH + in-transit (see Planning UI).
 * When inbound PO covers the planning requirement, do not show Out of Stock / Critical for that row.
 */
function planningItemsInvolvedDisplayStatus(warehouseStatus, sihFree, inTransit, totalRequired) {
  const net = Number(sihFree) + (Number(inTransit) || 0) - (Number(totalRequired) || 0);
  if (net >= 0 && (warehouseStatus === 'Out of Stock' || warehouseStatus === 'Critical')) {
    return 'In Stock';
  }
  return warehouseStatus || 'In Stock';
}

/** Same as Planning.tsx `procurementRequestIsActiveForReleaseCount` — cancelled/rejected PRs do not count. */
function prStatusCountsTowardReleaseToPlanning(status) {
  const st = String(status ?? '').trim();
  if (!st) return true;
  if (/cancel/i.test(st)) return false;
  if (/reject/i.test(st)) return false;
  return true;
}

/** Same as Planning.tsx `normalizeMaterialCode` for PR line ↔ item matching. */
function normalizeMaterialCodeForReleaseMatch(code) {
  const c = String(code ?? '').trim().toLowerCase();
  return c
    .replace(/^ei[-_]?rm[-_]?/i, '')
    .replace(/^ei[-_]?pm[-_]?/i, '')
    .replace(/^rm[-_]?/i, '')
    .replace(/^pm[-_]?/i, '');
}

function procurementLineTypeGuess(line) {
  if (line.type) return String(line.type).trim().toUpperCase();
  if (line.raw_material_id != null) return 'RM';
  if (line.pack_material_id != null) return 'PM';
  return '';
}

function procurementLineMatchesReleaseItem(line, itemType, matId, matCode, matName) {
  if (procurementLineTypeGuess(line) !== itemType) return false;
  const idNum = Number(matId);
  const lineRm = Number(line.raw_material_id);
  const linePm = Number(line.pack_material_id);
  const lineMatId = itemType === 'RM' ? lineRm : linePm;
  if (Number.isFinite(idNum) && idNum > 0 && Number.isFinite(lineMatId) && lineMatId === idNum) return true;
  const codeItem = normalizeMaterialCodeForReleaseMatch(String(matCode || ''));
  const codeLine = normalizeMaterialCodeForReleaseMatch(String(line.code || ''));
  if (codeItem.length > 0 && codeLine.length > 0 && codeItem === codeLine) return true;
  const nameItem = String(matName || '').trim().toLowerCase();
  const nameLine = String(line.name || '').trim().toLowerCase();
  return nameItem.length > 0 && nameLine.length > 0 && nameItem === nameLine;
}

function sumProcurementReleaseQtyForItem(
  itemType,
  matId,
  matCode,
  matName,
  planningExtractedIds,
  allPrs,
  rmMetaById
) {
  const idSet = new Set();
  for (const x of planningExtractedIds || []) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) idSet.add(n);
  }
  if (idSet.size === 0) return 0;
  const { procurementOrPoLineQtyToKg, rmMetaForId } = require('../lib/itemsInvolvedRmDisplay');
  let sum = 0;
  for (const pr of allPrs) {
    const plain = pr.get ? pr.get({ plain: true }) : pr;
    if (!prStatusCountsTowardReleaseToPlanning(plain.status)) continue;
    if (isPlanningQuotationOnlyProcurementRequest(plain)) continue;
    const peId = Number(plain.planning_extracted_id);
    if (!idSet.has(peId)) continue;
    const items = Array.isArray(plain.items) ? plain.items : [];
    for (const line of items) {
      if (!procurementLineMatchesReleaseItem(line, itemType, matId, matCode, matName)) continue;
      if (itemType === 'RM' && rmMetaById) {
        sum += procurementOrPoLineQtyToKg(line, rmMetaForId(rmMetaById, matId));
      } else {
        sum += Number(line.quantity_requested ?? line.shortage ?? line.required ?? 0) || 0;
      }
    }
  }
  return sum;
}

/** Parse `reference` like `Planning PE-123` — same as Planning.tsx `plannedLinesFromBackend`. */
function planningExtractedIdFromPlanningPoReference(reference) {
  const ref = String(reference || '');
  const m = ref.match(/^Planning\s+PE-(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sumPlanningLinkedDraftPoQtyForItem(itemType, matId, planningExtractedIds, allPos, rmMetaById) {
  const idSet = new Set();
  for (const x of planningExtractedIds || []) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) idSet.add(n);
  }
  if (idSet.size === 0) return 0;
  const idNum = Number(matId);
  const { procurementOrPoLineQtyToKg, rmMetaForId } = require('../lib/itemsInvolvedRmDisplay');
  let sum = 0;
  for (const po of allPos) {
    const d = po.get ? po.get({ plain: true }) : po;
    const peId = planningExtractedIdFromPlanningPoReference(d.reference);
    if (peId == null || !idSet.has(peId)) continue;
    const items = Array.isArray(d.items) ? d.items : [];
    for (const line of items) {
      if (itemType === 'RM') {
        const rid = line.raw_material_id != null ? Number(line.raw_material_id) : NaN;
        if (Number.isFinite(idNum) && idNum > 0 && Number.isFinite(rid) && rid === idNum) {
          sum += rmMetaById
            ? procurementOrPoLineQtyToKg(line, rmMetaForId(rmMetaById, idNum))
            : Number(line.quantity ?? line.qty ?? line.poQty ?? 0) || 0;
        }
      } else {
        const pid = line.pack_material_id != null ? Number(line.pack_material_id) : NaN;
        const qty = line.quantity ?? line.qty ?? line.poQty;
        const n = qty != null ? Number(qty) : 0;
        if (Number.isFinite(idNum) && idNum > 0 && Number.isFinite(pid) && pid === idNum && n > 0) sum += n;
      }
    }
  }
  return sum;
}

/**
 * Qty committed via Release to Planning only — matches Planning.tsx `releasedQtyTowardPlanningGap`
 * (max of PR lines vs Planning-linked draft PO for the same PIs + item). Not batch/BOM allocation.
 */
function totalReleaseToPlanningQtyForAgg(itemType, matId, agg, allPrs, allPos, rmMetaById) {
  const prSum = sumProcurementReleaseQtyForItem(
    itemType,
    matId,
    agg.code,
    agg.name,
    agg.planningExtractedIds,
    allPrs,
    rmMetaById
  );
  const poDraftSum = sumPlanningLinkedDraftPoQtyForItem(
    itemType,
    matId,
    agg.planningExtractedIds,
    allPos,
    rmMetaById
  );
  return Math.max(prSum, poDraftSum);
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

function normalizeMassUom(raw) {
  const u = String(raw || '').trim().toUpperCase();
  if (u === 'G' || u === 'GM' || u === 'GMS' || u.startsWith('GRAM')) return 'GM';
  if (u === 'MG' || u.startsWith('MILLIGRAM')) return 'MG';
  return 'KG';
}

function normalizePackUom(_raw) {
  return 'PCS';
}

function normalizeRmLine(line) {
  const l = line && typeof line === 'object' ? line : {};
  const pct = Number(l.pct_w_w ?? l.pct ?? 0) || 0;
  return {
    ...l,
    pct_w_w: pct,
    uom: normalizeMassUom(l.uom ?? l.unit),
  };
}

function normalizePmLine(line) {
  const l = line && typeof line === 'object' ? line : {};
  const qtyPerUnit = Number(l.qty_per_unit ?? l.qty ?? 1) || 1;
  return {
    ...l,
    qty_per_unit: qtyPerUnit,
    uom: normalizePackUom(l.uom ?? l.unit),
  };
}

function normalizeRmLines(lines) {
  return Array.isArray(lines) ? lines.map((line) => normalizeRmLine(line)) : [];
}

function normalizePmLines(lines) {
  return Array.isArray(lines) ? lines.map((line) => normalizePmLine(line)) : [];
}

/**
 * Sync PI-level material snapshot from BOM lines so Items Involved required math
 * stays aligned with the latest BOM editor save.
 */
async function syncPlanningRowMaterialsFromBomLines(planRow, rmLines, pmLines) {
  if (!planRow) return;
  const batchSizeKg = Number(planRow.batch_size_kg) || 500;
  const orderQtyNum = parseInt(String(planRow.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
  const totalKg = parseFloat(String(planRow.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;

  const rmCodes = [
    ...new Set(
      (Array.isArray(rmLines) ? rmLines : [])
        .map((line) => String(line.rm_code ?? line.code ?? '').trim())
        .filter(Boolean)
    ),
  ];
  const pmCodes = [
    ...new Set(
      (Array.isArray(pmLines) ? pmLines : [])
        .map((line) => String(line.pm_code ?? line.code ?? '').trim())
        .filter(Boolean)
    ),
  ];
  const rmIdByCode = new Map();
  const pmIdByCode = new Map();
  if (rmCodes.length > 0) {
    const rows = await RawMaterial.findAll({
      where: { code: { [Op.in]: rmCodes } },
      attributes: ['id', 'code'],
    });
    for (const r of rows) rmIdByCode.set(r.code, r.id);
  }
  if (pmCodes.length > 0) {
    const rows = await PackMaterial.findAll({
      where: { code: { [Op.in]: pmCodes } },
      attributes: ['id', 'code'],
    });
    for (const p of rows) pmIdByCode.set(p.code, p.id);
  }

  const rawMaterials = (Array.isArray(rmLines) ? rmLines : []).map((line) => {
    const pct = line.pct_w_w ?? line.pct ?? 0;
    const quantity = totalKg > 0 ? (totalKg * pct) / 100 : (batchSizeKg * pct) / 100;
    const code = line.rm_code ?? line.code ?? '';
    const fromCode = code ? rmIdByCode.get(code) : null;
    const rawMaterialId =
      fromCode != null
        ? fromCode
        : line.raw_material_id != null
          ? Number(line.raw_material_id)
          : null;
    return {
      raw_material_id: rawMaterialId != null && !Number.isNaN(rawMaterialId) ? rawMaterialId : null,
      name: line.inci_name ?? line.name ?? code ?? '',
      quantity: roundPlanningMaterialQty(quantity),
      unit: 'KG',
      code,
    };
  });

  const packagingMaterials = (Array.isArray(pmLines) ? pmLines : []).map((line) => {
    const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
    const required = orderQtyNum * qtyPerUnit;
    const code = line.pm_code ?? line.code ?? '';
    const fromCode = code ? pmIdByCode.get(code) : null;
    const packMaterialId =
      fromCode != null
        ? fromCode
        : line.pack_material_id != null
          ? Number(line.pack_material_id)
          : null;
    return {
      pack_material_id: packMaterialId != null && !Number.isNaN(packMaterialId) ? packMaterialId : null,
      name: line.description ?? line.name ?? code ?? '',
      quantity: roundPlanningMaterialQty(required),
      unit: 'PCS',
      code,
    };
  });

  planRow.raw_materials = rawMaterials;
  planRow.packaging_materials = packagingMaterials;
  await planRow.save();
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
  const { remainingUnits } = getCreatedAndRemainingUnitsFromPlanningRow(d);
  const planningSla = computePlanningSlaMeta({
    createdAt: d.created_at,
    orderDate: d.order_date || so.order_date,
    bomConfirmedAt: d.bom_confirmed_at,
    remainingUnits,
  });
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
    bomConfirmedAt:
      d.bom_confirmed_at != null ? serializeInstantIndia(d.bom_confirmed_at) : null,
    bomSpecificGravity: d.bom_specific_gravity != null ? Number(d.bom_specific_gravity) : null,
    customBatches: Array.isArray(d.custom_batches) ? d.custom_batches : null,
    sentBatchIndices: Array.isArray(d.sent_batch_indices) ? d.sent_batch_indices : [],
    createdAt: d.created_at != null ? serializeInstantIndia(d.created_at) : null,
    updatedAt: d.updated_at != null ? serializeInstantIndia(d.updated_at) : null,
    planningSla,
  };
}

/** kg tolerance for float compare; PCS treated as integers but allow tiny float noise */
const RESERVE_EPS_KG = 1e-4;
const RESERVE_EPS_PCS = 1e-6;

/**
 * Recompute warehouse_inventory.reserved for given RM/PM ids from sum of reserved_batch_items.
 * Central table stays in sync so feasibility and everywhere else see correct reserved/available.
 * Formula: reserved = sum(quantity_reserved) for that item (planning + production batches); available = SIH - reserved.
 */
async function syncWarehouseReserved(affectedRmIds, affectedPmIds) {
  for (const rid of affectedRmIds) {
    const sum = await ReservedBatchItem.sum('quantity_reserved', {
      where: { raw_material_id: rid },
    });
    const val = sum != null ? Number(sum) : 0;
    const [updated] = await WarehouseInventory.update(
      { reserved: val },
      { where: { item_type: 'RM', raw_material_id: rid } }
    );
    if (!updated) {
      await WarehouseInventory.create({
        item_type: 'RM',
        raw_material_id: rid,
        wh_unit: 'KG',
        stock_in_hand: 0,
        reserved: val,
      });
    }
  }
  for (const pid of affectedPmIds) {
    const sum = await ReservedBatchItem.sum('quantity_reserved', {
      where: { pack_material_id: pid },
    });
    const val = sum != null ? Number(sum) : 0;
    const [updated] = await WarehouseInventory.update(
      { reserved: val },
      { where: { item_type: 'PM', pack_material_id: pid } }
    );
    if (!updated) {
      await WarehouseInventory.create({
        item_type: 'PM',
        pack_material_id: pid,
        wh_unit: 'PCS',
        stock_in_hand: 0,
        reserved: val,
      });
    }
  }
}

/**
 * Rebuild reserved_batch_items for this planning row from current planning_batches BOM/size.
 * This keeps warehouse reserved quantities in sync with "planned qty" after batch generation/edits.
 */
async function refreshReservationsFromPlanningBatches(planningExtractedId, planRowInput = null) {
  const planRow = planRowInput || await PlanningExtracted.findByPk(planningExtractedId);
  if (!planRow) return;
  const planPlain = planRow.get ? planRow.get({ plain: true }) : planRow;
  const batches = await PlanningBatch.findAll({
    where: { planning_extracted_id: planningExtractedId },
    order: [['sequence', 'ASC']],
  });
  const batchPlain = batches.map((b) => (b.get ? b.get({ plain: true }) : b));

  const oldRows = await ReservedBatchItem.findAll({
    where: { planning_extracted_id: planningExtractedId, production_batch_id: null, fulfillment_order_item_id: null },
    attributes: ['raw_material_id', 'pack_material_id'],
  });
  const affectedRmIds = new Set();
  const affectedPmIds = new Set();
  for (const r of oldRows) {
    if (r.raw_material_id != null) affectedRmIds.add(Number(r.raw_material_id));
    if (r.pack_material_id != null) affectedPmIds.add(Number(r.pack_material_id));
  }

  await ReservedBatchItem.destroy({
    where: { planning_extracted_id: planningExtractedId, production_batch_id: null, fulfillment_order_item_id: null },
  });

  const rms = await RawMaterial.findAll({ attributes: ['id', 'code', 'name'] });
  const pms = await PackMaterial.findAll({ attributes: ['id', 'code', 'description'] });
  const rmByCode = new Map();
  const rmByName = new Map();
  for (const rm of rms) {
    if (rm.code) rmByCode.set(String(rm.code), rm);
    if (rm.name) rmByName.set(String(rm.name).trim().toLowerCase(), rm);
  }
  const pmByCode = new Map();
  const pmByName = new Map();
  for (const pm of pms) {
    if (pm.code) pmByCode.set(String(pm.code), pm);
    if (pm.description) pmByName.set(String(pm.description).trim().toLowerCase(), pm);
  }

  const plannedRm = new Map();
  const plannedPm = new Map();
  if (batchPlain.length > 0) {
    for (const bp of batchPlain) {
      accumulatePlannedBatchIntoQtyMaps(bp, planPlain, rmByCode, rmByName, pmByCode, pmByName, plannedRm, plannedPm);
    }
  } else {
    // Fresh release-to-planning: before any batch split exists, use PI-level material snapshot.
    const rawMaterials = Array.isArray(planPlain.raw_materials) ? planPlain.raw_materials : [];
    const packagingMaterials = Array.isArray(planPlain.packaging_materials) ? planPlain.packaging_materials : [];

    for (const line of rawMaterials) {
      let rmId = line.raw_material_id != null ? Number(line.raw_material_id) : null;
      if (rmId == null && (line.code || line.rm_code)) {
        const rm = rmByCode.get(String(line.code || line.rm_code));
        if (rm) rmId = Number(rm.id);
      }
      if (rmId == null && line.name) {
        const rm = rmByName.get(String(line.name).trim().toLowerCase());
        if (rm) rmId = Number(rm.id);
      }
      if (rmId == null || Number.isNaN(rmId)) continue;
      const qty = Number(line.quantity) || 0;
      if (qty > 0) plannedRm.set(rmId, (plannedRm.get(rmId) || 0) + qty);
    }

    for (const line of packagingMaterials) {
      let pmId = line.pack_material_id != null ? Number(line.pack_material_id) : null;
      if (pmId == null && (line.code || line.pm_code)) {
        const pm = pmByCode.get(String(line.code || line.pm_code));
        if (pm) pmId = Number(pm.id);
      }
      if (pmId == null && line.name) {
        const pm = pmByName.get(String(line.name).trim().toLowerCase());
        if (pm) pmId = Number(pm.id);
      }
      if (pmId == null || Number.isNaN(pmId)) continue;
      const qty = Number(line.quantity) || 0;
      if (qty > 0) plannedPm.set(pmId, (plannedPm.get(pmId) || 0) + qty);
    }
  }

  for (const [rmId, qty] of plannedRm.entries()) {
    if (!(Number(qty) > RESERVE_EPS_KG)) continue;
    await ReservedBatchItem.create({
      planning_extracted_id: planningExtractedId,
      raw_material_id: rmId,
      pack_material_id: null,
      quantity_reserved: qty,
      unit: 'KG',
    });
    affectedRmIds.add(Number(rmId));
  }
  for (const [pmId, qty] of plannedPm.entries()) {
    if (!(Number(qty) > RESERVE_EPS_PCS)) continue;
    await ReservedBatchItem.create({
      planning_extracted_id: planningExtractedId,
      raw_material_id: null,
      pack_material_id: pmId,
      quantity_reserved: qty,
      unit: 'PCS',
    });
    affectedPmIds.add(Number(pmId));
  }
  await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
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
  try {
    const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[planningExtracted] syncWarehouseInTransitAll after reserve failed:', e && e.message ? e.message : e);
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
  try {
    const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[planningExtracted] syncWarehouseInTransitAll after release failed:', e && e.message ? e.message : e);
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
      // Preferred fallback for Excel-imported SO lines: resolve by SKU.
      if (!productId && item.sku) {
        const sku = String(item.sku).trim();
        if (sku) {
          const prodBySku = await Product.findOne({
            where: { zoho_sku_code: sku },
            attributes: ['product_id'],
          });
          if (prodBySku) {
            const plainProd = prodBySku.get ? prodBySku.get({ plain: true }) : prodBySku;
            productId = plainProd.product_id;
          }
        }
      }
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
      // Last fallback: resolve by product display name from imported line.
      if (!productId && (item.productName || item.name)) {
        const productName = String(item.productName || item.name).trim();
        if (productName) {
          const prodByName = await Product.findOne({
            where: { product_name: productName },
            attributes: ['product_id'],
          });
          if (prodByName) {
            const plainProd = prodByName.get ? prodByName.get({ plain: true }) : prodByName;
            productId = plainProd.product_id;
          }
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
      const packFromSo = String(item.pack || item.packSize || '').trim();
      const {
        safeTotalKg,
        batchSizeKg,
        batchesRequired,
        raw_materials: snapshotRm,
        packaging_materials: snapshotPm,
      } = buildPlanningKgFromSoLine({
        orderQty,
        product: prodPlain,
        rmLines: rawMaterials,
        pmLines: packagingMaterials,
        fillSizeOverride: packFromSo,
        bom: bom ? (bom.get ? bom.get({ plain: true }) : bom) : null,
      });

      let targetPlanRow = existing;
      if (existing) {
        await existing.update({
          order_qty_display: `${orderQty} units`,
          total_kg_display: `${safeTotalKg} KG`,
          order_date: so.order_date || null,
          due_date: so.expected_shipment_date || null,
          batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
          batches_required: batchesRequired,
          batch_size_kg: batchSizeKg,
          raw_materials: snapshotRm,
          packaging_materials: snapshotPm,
          approved_by: so.created_by || null,
        });
      } else {
        targetPlanRow = await PlanningExtracted.create({
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
          // BOM is never auto-confirmed on SO creation: planner must confirm BOM + SG on first-batch flow.
          bom_confirmed_at: null,
          approved_by: so.created_by || null,
          raw_materials: snapshotRm,
          packaging_materials: snapshotPm,
        });
        created++;
      }

      // Do not auto-reserve warehouse stock at planning sync time.
      // Reserved is owned by explicit BMR/BPR reserve transitions only.
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
    await ensureBomSgColumn();
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
      bomSpecificGravity: 'bom_specific_gravity',
      customBatches: 'custom_batches',
      sentBatchIndices: 'sent_batch_indices',
    };
    const allowed = [
      'order_qty_display', 'total_kg_display', 'order_date', 'due_date',
      'batch_size_display', 'batches_required', 'bom_status', 'approved_by',
      'raw_materials', 'packaging_materials', 'color',
      'batch_count', 'batch_size_kg', 'planned_start_date', 'production_line', 'bom_confirmed_at',
      'bom_specific_gravity',
      'custom_batches', 'sent_batch_indices',
    ];
    const applyBomConfirmedAt = (incoming) => {
      if (incoming === undefined) return;
      if (incoming === null || incoming === '') {
        row.set('bom_confirmed_at', null);
        return;
      }
      if (prevBomConfirmedAt == null) {
        row.set('bom_confirmed_at', backendNow());
        return;
      }
      const d = incoming instanceof Date ? incoming : new Date(incoming);
      row.set('bom_confirmed_at', Number.isNaN(d.getTime()) ? backendNow() : d);
    };

    for (const key of allowed) {
      if (key === 'bom_confirmed_at') {
        if (body[key] !== undefined) applyBomConfirmedAt(body[key]);
        continue;
      }
      if (body[key] !== undefined) row.set(key, body[key]);
    }
    for (const [camel, snake] of Object.entries(camelToSnake)) {
      if (camel === 'bomConfirmedAt') {
        if (body[camel] !== undefined) applyBomConfirmedAt(body[camel]);
        continue;
      }
      if (body[camel] !== undefined) row.set(snake, body[camel]);
    }

    const nowBomConfirmedAt = row.get ? row.get('bom_confirmed_at') : row.bom_confirmed_at;
    const nowBomSg = row.get ? row.get('bom_specific_gravity') : row.bom_specific_gravity;

    await row.save();

    // When BOM is confirmed, ensure each rm_lines[].specific_gravity is set for vessel-volume math.
    // Preserve per-line SG when already present; only fill missing lines from BOM-level SG.
    const bomSgNumeric = Number(nowBomSg);
    const isConfirming = prevBomConfirmedAt == null && nowBomConfirmedAt != null;
    const wroteSg = body.bomSpecificGravity !== undefined || body.bom_specific_gravity !== undefined;
    if (Number.isFinite(bomSgNumeric) && bomSgNumeric > 0 && (isConfirming || wroteSg)) {
      try {
        const override = await PlanningBomOverride.findOne({ where: { planning_extracted_id: id } });
        if (override) {
          const rmLinesRaw = Array.isArray(override.rm_lines) ? override.rm_lines : [];
          const fanned = rmLinesRaw.map((line) => {
            const lineSg = Number(line.specific_gravity);
            const hasLineSg = Number.isFinite(lineSg) && lineSg > 0;
            return { ...line, specific_gravity: hasLineSg ? lineSg : bomSgNumeric };
          });
          override.rm_lines = fanned;
          await override.save();
        }
      } catch (e) {
        console.warn('[planning-extracted] fan BOM SG to override rm_lines:', e && e.message ? e.message : e);
      }
    }

    // Reserved stock is intentionally NOT changed by BOM confirm/unconfirm.
    // It is changed only by explicit BMR/BPR reserve actions.
    if (prevBomConfirmedAt == null && nowBomConfirmedAt != null) {
      try {
        const { rmLines, pmLines } = await getBomCopyForPlanning(id);
        if (
          (Array.isArray(rmLines) && rmLines.length > 0) ||
          (Array.isArray(pmLines) && pmLines.length > 0)
        ) {
          await syncPlanningRowMaterialsFromBomLines(row, rmLines, pmLines);
        }
      } catch (e) {
        console.warn(
          '[planning-extracted] sync materials on BOM confirm:',
          e && e.message ? e.message : e
        );
      }
      // If this planning row belongs to a website order, move it to in_production stage.
      const so = await SalesOrder.findByPk(row.sales_order_id, { attributes: ['order_id'] });
      const soNo = so && (so.get ? so.get('order_id') : so.order_id);
      if (soNo) await Order.update({ fulfillment_stage: 'in_production' }, { where: { so_no: soNo } });
    } else if (prevBomConfirmedAt != null && nowBomConfirmedAt == null) {
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
    const rmLines = normalizeRmLines(row && Array.isArray(row.rm_lines) ? row.rm_lines : []);
    const pmLines = normalizePmLines(row && Array.isArray(row.pm_lines) ? row.pm_lines : []);
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
    const rmLines = normalizeRmLines(Array.isArray(body.rmLines) ? body.rmLines : []);
    const pmLines = normalizePmLines(Array.isArray(body.pmLines) ? body.pmLines : []);

    const [override] = await PlanningBomOverride.findOrCreate({
      where: { planning_extracted_id: id },
      defaults: { rm_lines: rmLines, pm_lines: pmLines },
    });
    if (!override) return res.status(500).json({ error: 'Failed to create BOM override' });
    override.rm_lines = rmLines;
    override.pm_lines = pmLines;
    await override.save();

    await syncPlanningRowMaterialsFromBomLines(planRow, rmLines, pmLines);

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
    return {
      rmLines: normalizeRmLines(override.rm_lines || []),
      pmLines: normalizePmLines(override.pm_lines || []),
    };
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
    return {
      rmLines: normalizeRmLines(lastRmLines),
      pmLines: normalizePmLines(lastPmLines),
    };
  }

  const planRow = await PlanningExtracted.findByPk(planningExtractedId, { attributes: ['product_id'] });
  if (!planRow || planRow.product_id == null) return { rmLines: [], pmLines: [] };
  const bom = await BOM.findOne({ where: { product_id: planRow.product_id }, attributes: ['rm_lines', 'pm_lines'] });
  if (!bom) return { rmLines: [], pmLines: [] };
  return {
    rmLines: normalizeRmLines(Array.isArray(bom.rm_lines) ? bom.rm_lines : []),
    pmLines: normalizePmLines(Array.isArray(bom.pm_lines) ? bom.pm_lines : []),
  };
}

/**
 * Material snapshot for Items Involved on BOM-confirmed PIs — uses override / latest batch BOM,
 * not a stale planning_extracted.raw_materials row left from pre-swap product master.
 */
async function getConfirmedPiMaterialSnapshot(planPlain) {
  const rmsDefault = Array.isArray(planPlain.raw_materials) ? planPlain.raw_materials : [];
  const pmsDefault = Array.isArray(planPlain.packaging_materials) ? planPlain.packaging_materials : [];
  if (!planPlain.bom_confirmed_at) {
    return { rawMaterials: rmsDefault, packagingMaterials: pmsDefault };
  }
  try {
    const planId = planPlain.id;
    const { rmLines, pmLines } = await getBomCopyForPlanning(planId);
    const hasLines =
      (Array.isArray(rmLines) && rmLines.length > 0) ||
      (Array.isArray(pmLines) && pmLines.length > 0);
    if (!hasLines) {
      return { rawMaterials: rmsDefault, packagingMaterials: pmsDefault };
    }
    const orderQty = parseOrderQtyNum(planPlain.order_qty_display);
    const totalKg = parseFloat(String(planPlain.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
    const batchSizeKg = Number(planPlain.batch_size_kg) || 500;
    const snap = buildPlanningSnapshotFromBom(rmLines, pmLines, orderQty, totalKg, batchSizeKg);
    return {
      rawMaterials: snap.raw_materials,
      packagingMaterials: snap.packaging_materials,
    };
  } catch (e) {
    console.warn(
      '[planning-extracted] getConfirmedPiMaterialSnapshot:',
      e && e.message ? e.message : e
    );
    return { rawMaterials: rmsDefault, packagingMaterials: pmsDefault };
  }
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
    const prodBmrByPlanningBatchId = await loadProductionBmrStatusByPlanningBatchIds(
      rows.map((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        return d.id;
      })
    );
    const list = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const plan = d.planningExtracted || {};
      const sentIndices = Array.isArray(plan.sent_batch_indices) ? plan.sent_batch_indices : [];
      // Type-safe sent check (handles JSON arrays containing "1" and 1 consistently).
      const sent = isBatchIndexSent(sentIndices, (Number(d.sequence) || 0) - 1);
      const productionBmrStatus = prodBmrByPlanningBatchId.has(d.id)
        ? prodBmrByPlanningBatchId.get(d.id)
        : null;
      const editable = isPlanningBatchEditableByProduction(productionBmrStatus);
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
        productionBmrStatus,
        editable,
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
    const prodBmrByPlanningBatchId = await loadProductionBmrStatusByPlanningBatchIds(
      rows.map((r) => (r.get ? r.get('id') : r.id))
    );
    res.json(rows.map((r) => formatBatchRow(r, prodBmrByPlanningBatchId)));
  } catch (err) {
    console.error('listBatches error', err);
    res.status(500).json({ error: 'Failed to list batches' });
  }
}

/**
 * POST /:id/batches — create or update planning_batches from customBatches; each batch gets current BOM copy (override or product BOM).
 * Body: { batches: [ { sizeKg }, ... ] }. Batch codes: PE-{planningId}-B1, PE-{planningId}-B2, ...
 * Optional: { updateOnlyBatchId } — edit-mode guard; rejects batch count changes.
 */
async function createOrUpdateBatches(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id);
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const body = req.body || {};
    const batches = Array.isArray(body.batches) ? body.batches : [];
    const updateOnlyBatchId =
      body.updateOnlyBatchId != null ? parseInt(body.updateOnlyBatchId, 10) : null;
    const bomCopy = await getBomCopyForPlanning(id);
    const existing = await PlanningBatch.findAll({ where: { planning_extracted_id: id }, order: [['sequence', 'ASC']] });
    if (updateOnlyBatchId != null && !Number.isNaN(updateOnlyBatchId)) {
      try {
        validateUpdateOnlyBatchPayload(batches, existing, updateOnlyBatchId);
      } catch (lockErr) {
        if (lockErr.status) {
          return res.status(lockErr.status).json({ error: lockErr.message, code: lockErr.code });
        }
        throw lockErr;
      }
    }
    if (batches.length > existing.length && existing.length > 0) {
      if (updateOnlyBatchId != null && !Number.isNaN(updateOnlyBatchId)) {
        return res.status(409).json({
          error: 'Edit batch cannot add planning batches. Use Add Batch to create a new row.',
          code: 'BATCH_COUNT_LOCKED',
        });
      }
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
        const existingId = existingRow.get ? existingRow.get('id') : existingRow.id;
        try {
          await assertPlanningBatchEditable(existingId);
        } catch (lockErr) {
          if (lockErr.status === 403) {
            return res.status(403).json({ error: lockErr.message, code: lockErr.code || 'BATCH_LOCKED_BY_PRODUCTION' });
          }
          throw lockErr;
        }
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
      if (updateOnlyBatchId != null && !Number.isNaN(updateOnlyBatchId)) {
        return res.status(409).json({
          error: 'Edit batch cannot remove planning batches.',
          code: 'BATCH_COUNT_LOCKED',
        });
      }
      for (let i = batches.length; i < existing.length; i += 1) {
        const rowToRemove = existing[i];
        const removeId = rowToRemove.get ? rowToRemove.get('id') : rowToRemove.id;
        try {
          await assertPlanningBatchEditable(removeId);
        } catch (lockErr) {
          if (lockErr.status === 403) {
            return res.status(403).json({ error: lockErr.message, code: lockErr.code || 'BATCH_LOCKED_BY_PRODUCTION' });
          }
          throw lockErr;
        }
      }
      await PlanningBatch.destroy({
        where: { planning_extracted_id: id, sequence: { [Op.gt]: batches.length } },
      });
    }
    const updated = await PlanningBatch.findAll({ where: { planning_extracted_id: id }, order: [['sequence', 'ASC']] });
    await planRow.update({ batch_count: updated.length });
    const prodBmrByPlanningBatchId = await loadProductionBmrStatusByPlanningBatchIds(
      updated.map((r) => (r.get ? r.get('id') : r.id))
    );
    // Planned batches are saved, but reserved stock is not auto-updated here.
    // Reserved updates only on explicit BMR/BPR reserve transitions.
    res.json(updated.map((r) => formatBatchRow(r, prodBmrByPlanningBatchId)));
  } catch (err) {
    console.error('createOrUpdateBatches error', err);
    res.status(500).json({ error: 'Failed to save batches' });
  }
}

function formatBatchRow(r, prodBmrByPlanningBatchId) {
  const d = r.get ? r.get({ plain: true }) : r;
  const productionBmrStatus =
    prodBmrByPlanningBatchId && prodBmrByPlanningBatchId.has(d.id)
      ? prodBmrByPlanningBatchId.get(d.id)
      : null;
  const editable = isPlanningBatchEditableByProduction(productionBmrStatus);
  return {
    id: d.id,
    planningExtractedId: d.planning_extracted_id,
    sequence: d.sequence,
    batchCode: d.batch_code,
    sizeKg: d.size_kg != null ? Number(d.size_kg) : null,
    rmLines: d.rm_lines || [],
    pmLines: d.pm_lines || [],
    productionBmrStatus,
    editable,
  };
}

/** Map planning_batches.id → production_batches.bmr_status (when linked). */
async function loadProductionBmrStatusByPlanningBatchIds(batchIds) {
  const ids = [...new Set((batchIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  const map = new Map();
  if (ids.length === 0) return map;
  const prodRows = await ProductionBatch.findAll({
    where: { planning_batch_id: { [Op.in]: ids } },
    attributes: ['planning_batch_id', 'bmr_status'],
  });
  for (const row of prodRows) {
    const d = row.get ? row.get({ plain: true }) : row;
    if (d.planning_batch_id != null) {
      map.set(Number(d.planning_batch_id), d.bmr_status || null);
    }
  }
  return map;
}

async function assertPlanningBatchEditable(batchId) {
  const prod = await ProductionBatch.findOne({
    where: { planning_batch_id: batchId },
    attributes: ['bmr_status'],
  });
  if (!prod) return null;
  const bmr = prod.get ? prod.get('bmr_status') : prod.bmr_status;
  if (!isPlanningBatchEditableByProduction(bmr)) {
    const err = new Error(planningBatchEditLockReason(bmr));
    err.status = 403;
    err.code = 'BATCH_LOCKED_BY_PRODUCTION';
    throw err;
  }
  return null;
}

/** When Planning updates size_kg on a sent batch, mirror to linked Production row if BMR is still draft. */
async function syncProductionBatchSizeFromPlanningBatch(planningBatchId, sizeKg) {
  const id = Number(planningBatchId);
  const kg = Number(sizeKg);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(kg) || kg < 0) return;
  const prod = await ProductionBatch.findOne({
    where: { planning_batch_id: id },
    attributes: ['id', 'bmr_status', 'batch_size'],
  });
  if (!prod) return;
  const bmr = prod.get ? prod.get('bmr_status') : prod.bmr_status;
  if (!isPlanningBatchEditableByProduction(bmr)) return;
  const rounded = Math.round(kg);
  const current = Number(prod.get ? prod.get('batch_size') : prod.batch_size);
  if (Number.isFinite(current) && current === rounded) return;
  await prod.update({ batch_size: rounded });
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
    const prodBmrByPlanningBatchId = await loadProductionBmrStatusByPlanningBatchIds([batchId]);
    res.json(formatBatchRow(batch, prodBmrByPlanningBatchId));
  } catch (err) {
    console.error('getBatchById error', err);
    res.status(500).json({ error: 'Failed to fetch batch' });
  }
}

/**
 * POST /:id/batches/add-one — add one new batch with BOM copied from product master (not override).
 * New batch gets sequence = max(sequence)+1, batch_code = PE-{id}-B{seq}.
 * size_kg defaults to min(remaining order kg, product batch_size_kg) when order total is known;
 * when the order is fully allocated, defaults to 0 so the planner can set buffer/over-production units.
 */
async function addOneBatchFromMaster(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id, {
      attributes: ['id', 'product_id', 'batch_size_kg', 'sent_batch_indices', 'total_kg_display'],
    });
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const productId = planRow.product_id;
    const defaultSizeKg = Number(planRow.batch_size_kg) || 500;

    const existing = await PlanningBatch.findAll({
      where: { planning_extracted_id: id },
      attributes: ['sequence', 'size_kg'],
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
    const nextSeq = existing.length === 0 ? 1 : (Number(existing[0].sequence) || 0) + 1;
    const batchCode = `PE-${id}-B${nextSeq}`;

    const plainPlan = planRow.get ? planRow.get({ plain: true }) : planRow;
    const totalKgPlan = parseFloat(String(plainPlan.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
    const sumAllocatedKg = existing.reduce((s, b) => {
      const sk = b.get ? b.get('size_kg') : b.size_kg;
      return s + (Number(sk) || 0);
    }, 0);
    const remainingKg = Math.max(0, totalKgPlan - sumAllocatedKg);
    let newSizeKg = defaultSizeKg;
    if (totalKgPlan > 0) {
      newSizeKg = remainingKg > 0 ? Math.min(remainingKg, defaultSizeKg) : 0;
    }

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
      size_kg: newSizeKg,
      rm_lines: rmLines,
      pm_lines: pmLines,
    });
    const cnt = await PlanningBatch.count({ where: { planning_extracted_id: id } });
    await PlanningExtracted.update({ batch_count: cnt }, { where: { id } });
    // Planned batches are saved, but reserved stock is not auto-updated here.
    // Reserved updates only on explicit BMR/BPR reserve transitions.
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
    try {
      await assertPlanningBatchEditable(batchId);
    } catch (lockErr) {
      if (lockErr.status === 403) {
        return res.status(403).json({ error: lockErr.message, code: lockErr.code || 'BATCH_LOCKED_BY_PRODUCTION' });
      }
      throw lockErr;
    }
    const body = req.body || {};
    if (Array.isArray(body.rmLines)) batch.rm_lines = normalizeRmLines(body.rmLines);
    if (Array.isArray(body.pmLines)) batch.pm_lines = normalizePmLines(body.pmLines);
    if (body.sizeKg !== undefined) {
      const n = Number(body.sizeKg);
      batch.size_kg = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (body.batchCode != null && String(body.batchCode).trim()) {
      batch.batch_code = String(body.batchCode).trim().slice(0, 64);
    }
    await batch.save();

    if (body.sizeKg !== undefined) {
      const savedId = batch.get ? batch.get('id') : batch.id;
      await syncProductionBatchSizeFromPlanningBatch(savedId, batch.size_kg);
    }

    // Keep PI-level required snapshot in sync when batch BOM lines are edited in the modal.
    const editedRmLines = Array.isArray(body.rmLines) ? batch.rm_lines : null;
    const editedPmLines = Array.isArray(body.pmLines) ? batch.pm_lines : null;
    if (editedRmLines || editedPmLines) {
      const planRow = await PlanningExtracted.findByPk(planningId);
      if (planRow) {
        const rmForSync = Array.isArray(editedRmLines) ? normalizeRmLines(editedRmLines) : normalizeRmLines(planRow.raw_materials || []);
        const pmForSync = Array.isArray(editedPmLines) ? normalizePmLines(editedPmLines) : normalizePmLines(planRow.packaging_materials || []);

        const [override] = await PlanningBomOverride.findOrCreate({
          where: { planning_extracted_id: planningId },
          defaults: { rm_lines: rmForSync, pm_lines: pmForSync },
        });
        if (override) {
          override.rm_lines = rmForSync;
          override.pm_lines = pmForSync;
          await override.save();
        }
        await syncPlanningRowMaterialsFromBomLines(planRow, rmForSync, pmForSync);
      }
    }

    // Planned batches are saved, but reserved stock is not auto-updated here.
    // Reserved updates only on explicit BMR/BPR reserve transitions.
    res.json(formatBatchRow(batch));
  } catch (err) {
    console.error('updateBatch error', err);
    res.status(500).json({ error: 'Failed to update batch' });
  }
}

/** Sum RM (kg) and PM (pcs) from one planning_batches row; uses PI packaging when batch has no pm_lines. */
function accumulatePlannedBatchIntoQtyMaps(batchPlain, planPlain, rmByCode, rmByName, pmByCode, pmByName, plannedRm, plannedPm) {
  const sizeKg = Number(batchPlain.size_kg) || 0;
  const orderQty = parseInt(String(planPlain.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
  const totalKg = parseFloat(String(planPlain.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
  const kgPerUnit = orderQty > 0 && totalKg > 0 ? totalKg / orderQty : 1;
  const unitsForBatch = kgPerUnit > 0 ? sizeKg / kgPerUnit : 0;

  const rmLines = Array.isArray(batchPlain.rm_lines) ? batchPlain.rm_lines : [];
  for (const line of rmLines) {
    const id = resolveRmIdFromPlanningLine(line, rmByCode, rmByName);
    if (id == null || Number.isNaN(id)) continue;
    const pct = line.pct_w_w ?? line.pct ?? 0;
    const qty = (sizeKg * pct) / 100;
    plannedRm.set(id, (plannedRm.get(id) || 0) + qty);
  }

  let pmLines = Array.isArray(batchPlain.pm_lines) ? batchPlain.pm_lines : [];
  if (pmLines.length === 0) {
    const pkg = Array.isArray(planPlain.packaging_materials) ? planPlain.packaging_materials : [];
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
  for (const line of pmLines) {
    const id = resolvePmIdFromPlanningLine(line, pmByCode, pmByName);
    if (id == null || Number.isNaN(id)) continue;
    const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
    const qty = unitsForBatch * qtyPerUnit;
    plannedPm.set(id, (plannedPm.get(id) || 0) + qty);
  }
}

function countPlanningBatchesTouchingRm(planBatchesPlain, rmId, rmByCode, rmByName) {
  let n = 0;
  for (const bp of planBatchesPlain) {
    const lines = Array.isArray(bp.rm_lines) ? bp.rm_lines : [];
    let touches = false;
    for (const line of lines) {
      const id = resolveRmIdFromPlanningLine(line, rmByCode, rmByName);
      if (id === rmId) {
        touches = true;
        break;
      }
    }
    if (touches) n += 1;
  }
  return n;
}

function countPlanningBatchesTouchingPm(planBatchesPlain, pmId, pmByCode, pmByName, planPlain) {
  let n = 0;
  const orderQty = parseInt(String(planPlain.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
  for (const bp of planBatchesPlain) {
    let pmLines = Array.isArray(bp.pm_lines) ? bp.pm_lines : [];
    if (pmLines.length === 0) {
      const pkg = Array.isArray(planPlain.packaging_materials) ? planPlain.packaging_materials : [];
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
    let touches = false;
    for (const line of pmLines) {
      const id = resolvePmIdFromPlanningLine(line, pmByCode, pmByName);
      if (id === pmId) {
        touches = true;
        break;
      }
    }
    if (touches) n += 1;
  }
  return n;
}

/**
 * GET /items-involved — aggregated RM/PM for confirmed PIs, consolidated by item.
 * - totalRequired: full BOM qty for the item across those PIs (gross demand vs warehouse / procurement).
 * - unallocatedToBatches: max(0, gross − qty in planning_batches that are **sent to production**) — draft batches excluded.
 * - surplusShortage / coverage use gross demand so stock checks stay correct after batches absorb the BOM.
 */
async function getItemsInvolved(req, res) {
  try {
    const includeZeroRequired =
      String(req.query.includeZeroRequired ?? '').toLowerCase() === '1' ||
      String(req.query.includeZeroRequired ?? '').toLowerCase() === 'true';
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[planningExtracted] getItemsInvolved syncWarehouseInTransitAll failed:', e && e.message ? e.message : e);
    }

    const rmAgg = new Map(); // key: raw_material_id -> { totalRequired (gross), unallocatedToBatches, plannedQty, ... }
    const pmAgg = new Map(); // key: pack_material_id -> { totalRequired (gross), unallocatedToBatches, plannedQty, ... }

    const confirmed = await PlanningExtracted.findAll({
      where: { bom_confirmed_at: { [Op.ne]: null } },
      include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] }],
      order: [['id', 'ASC']],
    });

    const batches = await PlanningBatch.findAll({
      include: [{
        model: PlanningExtracted,
        as: 'planningExtracted',
        required: true,
        attributes: ['id', 'order_qty_display', 'total_kg_display', 'product_id', 'packaging_materials', 'raw_materials'],
        include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] }],
      }],
      order: [['planning_extracted_id', 'ASC'], ['sequence', 'ASC']],
    });

    const batchesByPlanId = new Map();
    const rmCodes = new Set();
    const pmCodes = new Set();
    for (const row of confirmed) {
      const plain = row.get ? row.get({ plain: true }) : row;
      for (const r of Array.isArray(plain.raw_materials) ? plain.raw_materials : []) {
        if (r.code) rmCodes.add(r.code);
      }
      for (const p of Array.isArray(plain.packaging_materials) ? plain.packaging_materials : []) {
        if (p.code) pmCodes.add(p.code);
      }
    }
    for (const b of batches) {
      const plain = b.get ? b.get({ plain: true }) : b;
      const pid = plain.planning_extracted_id;
      if (!batchesByPlanId.has(pid)) batchesByPlanId.set(pid, []);
      batchesByPlanId.get(pid).push(b);
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
      const plan = plain.planningExtracted || {};
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

    const fallbackRmByCode = rmByCode;
    const fallbackRmByName = rmByName;
    const fallbackPmByCode = pmByCode;
    const fallbackPmByName = pmByName;

    for (const row of confirmed) {
      const plain = row.get ? row.get({ plain: true }) : row;
      const planId = plain.id;
      const productName = plain.product?.product_name || '';

      const fullRm = new Map();
      const fullPm = new Map();
      const rmUnitById = new Map();
      const pmUnitById = new Map();
      const rmNameById = new Map();
      const rmCodeById = new Map();
      const pmNameById = new Map();
      const pmCodeById = new Map();

      const { rawMaterials: rms, packagingMaterials: pms } = await getConfirmedPiMaterialSnapshot(plain);
      for (const r of rms) {
        const id = resolveRmIdFromMaterialSnapshotRow(r, fallbackRmByCode, fallbackRmByName);
        if (id == null || Number.isNaN(id)) continue;
        const qty = Number(r.quantity) || 0;
        const unit = r.unit || 'KG';
        fullRm.set(id, (fullRm.get(id) || 0) + qty);
        if (!rmUnitById.has(id)) rmUnitById.set(id, unit);
        if (r.name) rmNameById.set(id, r.name);
        if (r.code) rmCodeById.set(id, r.code);
      }
      for (const p of pms) {
        let pid = p.pack_material_id != null ? Number(p.pack_material_id) : null;
        if (pid == null && p.code) {
          const pm = fallbackPmByCode.get(p.code);
          if (pm) pid = pm.id;
        }
        if (pid == null && p.name) {
          const pm = fallbackPmByName.get(String(p.name).trim().toLowerCase());
          if (pm) pid = pm.id;
        }
        if (pid == null || Number.isNaN(pid)) continue;
        const qty = Number(p.quantity) || 0;
        const unit = p.unit || 'PCS';
        fullPm.set(pid, (fullPm.get(pid) || 0) + qty);
        if (!pmUnitById.has(pid)) pmUnitById.set(pid, unit);
        if (p.name) pmNameById.set(pid, p.name);
        if (p.code) pmCodeById.set(pid, p.code);
      }

      const planBatchesRaw = batchesByPlanId.get(planId) || [];
      const planBatchesPlain = planBatchesRaw.map((batchRow) => (batchRow.get ? batchRow.get({ plain: true }) : batchRow));
      const planBatchesSent = filterPlanningBatchesSentToProduction(plain, planBatchesPlain);

      const plannedRm = new Map();
      const plannedPm = new Map();
      // Only batches sent to production count toward planned qty / unallocated / "used in" batch count.
      // Draft rows (next batch auto-created in Plan Batches) stay in DB but are excluded until sent.
      for (const bp of planBatchesSent) {
        accumulatePlannedBatchIntoQtyMaps(bp, plain, rmByCode, rmByName, pmByCode, pmByName, plannedRm, plannedPm);
      }

      const allRmIdsForPlan = new Set([...fullRm.keys(), ...plannedRm.keys()]);
      for (const id of allRmIdsForPlan) {
        const gross = (fullRm.get(id) || 0);
        const rem = Math.max(0, gross - (plannedRm.get(id) || 0));
        if (!(gross > 0) && !includeZeroRequired) continue;
        const unit = rmUnitById.get(id) || 'KG';
        const name = rmNameById.get(id) || '';
        const code = rmCodeById.get(id) || '';
        if (!rmAgg.has(id)) {
          rmAgg.set(id, {
            totalRequired: 0,
            unallocatedToBatches: 0,
            plannedQty: 0,
            unit,
            productNames: [],
            planningExtractedIds: [],
            name,
            code,
            batchCount: 0,
          });
        }
        const agg = rmAgg.get(id);
        agg.totalRequired += gross;
        agg.unallocatedToBatches += rem;
        agg.plannedQty += (plannedRm.get(id) || 0);
        if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
        if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
        if (name) agg.name = name;
        if (code) agg.code = code;
        agg.batchCount += countPlanningBatchesTouchingRm(planBatchesSent, id, rmByCode, rmByName);
      }

      const allPmIdsForPlan = new Set([...fullPm.keys(), ...plannedPm.keys()]);
      for (const id of allPmIdsForPlan) {
        const gross = (fullPm.get(id) || 0);
        const rem = Math.max(0, gross - (plannedPm.get(id) || 0));
        if (!(gross > 0) && !includeZeroRequired) continue;
        const unit = pmUnitById.get(id) || 'PCS';
        const name = pmNameById.get(id) || '';
        const code = pmCodeById.get(id) || '';
        if (!pmAgg.has(id)) {
          pmAgg.set(id, {
            totalRequired: 0,
            unallocatedToBatches: 0,
            plannedQty: 0,
            unit,
            productNames: [],
            planningExtractedIds: [],
            name,
            code,
            batchCount: 0,
          });
        }
        const agg = pmAgg.get(id);
        agg.totalRequired += gross;
        agg.unallocatedToBatches += rem;
        agg.plannedQty += (plannedPm.get(id) || 0);
        if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
        if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
        if (name) agg.name = name;
        if (code) agg.code = code;
        agg.batchCount += countPlanningBatchesTouchingPm(planBatchesSent, id, pmByCode, pmByName, plain);
      }
    }

    const allRmIds = [...rmAgg.keys()];
    const allPmIds = [...pmAgg.keys()];
    const whWhere = [];
    if (allRmIds.length) whWhere.push({ item_type: 'RM', raw_material_id: { [Op.in]: allRmIds } });
    if (allPmIds.length) whWhere.push({ item_type: 'PM', pack_material_id: { [Op.in]: allPmIds } });
    const {
      getGrnInTransitQtyByKey,
      getPoPipelineInTransitQtyByKey,
      getCompletedGrnReceivedKgByKey,
    } = require('../warehouseInventory/inTransitSync');
    const {
      buildRmMetaMap,
      finalizeItemsInvolvedRmRow,
      warehouseNativeQtyToKg,
    } = require('../lib/itemsInvolvedRmDisplay');

    const [whRows, rmsList, pmsList, allPos, allPrs, grnInTransitKg, poInTransitKg, grnReceivedKg] = await Promise.all([
      whWhere.length ? WarehouseInventory.findAll({ where: { [Op.or]: whWhere } }) : Promise.resolve([]),
      allRmIds.length
        ? RawMaterial.findAll({
            where: { id: allRmIds },
            attributes: ['id', 'code', 'name', 'uom', 'specific_gravity'],
          })
        : Promise.resolve([]),
      allPmIds.length ? PackMaterial.findAll({ where: { id: allPmIds }, attributes: ['id', 'code', 'description'] }) : Promise.resolve([]),
      PurchaseOrder.findAll({ attributes: ['id', 'items', 'reference', 'form_data'] }),
      ProcurementRequest.findAll({ attributes: ['id', 'planning_extracted_id', 'status', 'items'] }),
      getGrnInTransitQtyByKey(),
      getPoPipelineInTransitQtyByKey(),
      getCompletedGrnReceivedKgByKey(),
    ]);
    const rmMetaById = buildRmMetaMap(rmsList);

    const { buildPrPlanningExtractedIdByRequestId, computeItemsInvolvedStageFlow } = require('../lib/itemsInvolvedStageFlow');
    const prPeByRequestId = buildPrPlanningExtractedIdByRequestId(allPrs);

    // Combined in-transit (open GRNs + PO pipeline) by key, kg-canonical for RM stage-flow.
    const inTransitByKey = new Map();
    for (const source of [grnInTransitKg, poInTransitKg]) {
      for (const [k, v] of source) {
        const n = Number(v) || 0;
        if (n <= 0) continue;
        inTransitByKey.set(k, (inTransitByKey.get(k) || 0) + n);
      }
    }
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
    const whUnitByRm = new Map();
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
        whUnitByRm.set(w.raw_material_id, w.wh_unit);
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

    // Stage-flow math (kg-canonical); API display via finalizeItemsInvolvedRmRow (planning→primary, WH→native):
    //   totalReleased  = Release to Planning only (PR + Planning PE-* draft PO), NOT planning_batches / BOM confirm
    //   plannedQty     = totalReleased - totalOnPO (not yet on any PO)
    //   totalOnPO      -> poQty stage balance (minus in-transit + received)
    //   totalInTransit -> inTransitQty (still shipped, not yet received)
    //   totalReceived  -> folded into WH stock
    // Qty "flows" forward; any stage edit auto-rebalances on next read because every displayed
    // number is derived from current source-of-truth tables.
    const flowEpsilon = 1e-6;
    const isDev = process.env.NODE_ENV !== 'production';
    const computeStageFlow = (key, totalReleased, stockInHand, planningExtractedIds) => {
      const flow = computeItemsInvolvedStageFlow(
        key,
        totalReleased,
        stockInHand,
        planningExtractedIds,
        allPos,
        prPeByRequestId,
        inTransitByKey,
        grnReceivedKg,
        rmMetaById
      );
      if (isDev) {
        const stageSum = flow.plannedQty + flow.poQty + flow.inTransitQty;
        if (stageSum > Number(totalReleased) + flowEpsilon && Number(totalReleased) > 0) {
          console.warn(
            `[items-involved] stage-flow drift for ${key}: planned+po+inTransit=${stageSum.toFixed(3)} > totalReleased=${Number(totalReleased).toFixed(3)} (totalOnPO=${flow.totalOnPO}, totalInTransit=${flow.totalInTransit}, totalReceived=${flow.totalReceived})`
          );
        }
      }
      return flow;
    };

    const out = [];
    for (const [id, agg] of rmAgg) {
      // "sih" in the items-involved API should represent *available/free* stock
      // (stock_in_hand minus already-reserved quantities). Otherwise the UI
      // can incorrectly think there is no shortage and disable "Release to Planning".
      const stockInHand = sihByRm.get(id) ?? 0;
      const reserved = reservedByRm.get(id) ?? 0;
      const sihNative = Math.max(0, stockInHand - reserved);
      const inTransitNative = inTransitByRm.get(id) ?? 0;
      const rmMeta = rmMetaById.get(id);
      const whUnit = whUnitByRm.get(id);
      const sihKg = warehouseNativeQtyToKg(sihNative, whUnit, rmMeta);
      const inTransitKg = warehouseNativeQtyToKg(inTransitNative, whUnit, rmMeta);
      const stockInHandKg = warehouseNativeQtyToKg(stockInHand, whUnit, rmMeta);
      const batchAllocatedQty = Number(agg.plannedQty) || 0;
      const totalReleased = totalReleaseToPlanningQtyForAgg('RM', id, agg, allPrs, allPos, rmMetaById);
      const flow = computeStageFlow(`rm-${id}`, totalReleased, stockInHandKg, agg.planningExtractedIds);
      const info = rmInfo.get(id) || {};
      const coverageDenom =
        agg.totalRequired > 0
          ? Math.min(100, Math.round(((sihKg + inTransitKg) / agg.totalRequired) * 100))
          : 100;
      const rowStatus = planningItemsInvolvedDisplayStatus(
        statusByRm.get(id) ?? 'In Stock',
        sihKg,
        inTransitKg,
        agg.totalRequired
      );
      const rmRowKg = {
        type: 'RM',
        raw_material_id: id,
        pack_material_id: null,
        code: info.code || agg.code || `RM-${id}`,
        name: info.name || agg.name || `RM ${id}`,
        category: 'RM',
        usedInProducts: agg.productNames,
        planningExtractedIds: agg.planningExtractedIds,
        totalRequired: agg.totalRequired,
        unallocatedToBatches: Number(agg.unallocatedToBatches) || 0,
        unit: agg.unit,
        batchCount: agg.batchCount ?? 0,
        sih: sihKg,
        surplusShortage: sihKg + inTransitKg - agg.totalRequired,
        coverage: coverageDenom,
        warehouseInventoryId: whIdByRm.get(id) ?? null,
        batchNumber: batchNumberByRm.get(id) ?? null,
        expiryDate: expiryByRm.get(id) ?? null,
        reserved,
        plannedQty: flow.plannedQty,
        poQty: flow.poQty,
        inTransitQty: flow.inTransitQty,
        whQty: flow.whQty,
        totalReleased,
        batchAllocatedQty,
        totalOnPO: flow.totalOnPO,
        totalReceived: flow.totalReceived,
        inTransit: inTransitKg,
        reorderPt: reorderPtByRm.get(id) ?? 0,
        avgMo: avgMoByRm.get(id) ?? 0,
        status: rowStatus,
      };
      out.push(
        finalizeItemsInvolvedRmRow(rmRowKg, rmMeta, {
          sih: sihNative,
          reserved,
          inTransit: inTransitNative,
          reorderPt: reorderPtByRm.get(id) ?? 0,
          avgMo: avgMoByRm.get(id) ?? 0,
          whUnit,
        })
      );
    }
    for (const [id, agg] of pmAgg) {
      const stockInHand = sihByPm.get(id) ?? 0;
      const reserved = reservedByPm.get(id) ?? 0;
      const sih = Math.max(0, stockInHand - reserved);
      const inTransit = inTransitByPm.get(id) ?? 0;
      const surplusShortage = sih + inTransit - agg.totalRequired;
      const batchAllocatedQty = Number(agg.plannedQty) || 0;
      const totalReleased = totalReleaseToPlanningQtyForAgg('PM', id, agg, allPrs, allPos);
      const flow = computeStageFlow(`pm-${id}`, totalReleased, stockInHand, agg.planningExtractedIds);
      const info = pmInfo.get(id) || {};
      const coverageDenomPm = agg.totalRequired > 0
        ? Math.min(100, Math.round(((sih + inTransit) / agg.totalRequired) * 100))
        : 100;
      const rowStatusPm = planningItemsInvolvedDisplayStatus(
        statusByPm.get(id) ?? 'In Stock',
        sih,
        inTransit,
        agg.totalRequired
      );
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
        unallocatedToBatches: Number(agg.unallocatedToBatches) || 0,
        unit: agg.unit,
        batchCount: agg.batchCount ?? 0,
        sih,
        surplusShortage,
        coverage: coverageDenomPm,
        warehouseInventoryId: whIdByPm.get(id) ?? null,
        batchNumber: batchNumberByPm.get(id) ?? null,
        expiryDate: expiryByPm.get(id) ?? null,
        reserved,
        plannedQty: flow.plannedQty,
        poQty: flow.poQty,
        inTransitQty: flow.inTransitQty,
        whQty: flow.whQty,
        totalReleased,
        batchAllocatedQty,
        totalOnPO: flow.totalOnPO,
        totalReceived: flow.totalReceived,
        inTransit,
        reorderPt: reorderPtByPm.get(id) ?? 0,
        avgMo: avgMoByPm.get(id) ?? 0,
        status: rowStatusPm,
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

    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[planningExtracted] getItemsInvolvedByPlanningId syncWarehouseInTransitAll failed:', e && e.message ? e.message : e);
    }

    const row = await PlanningExtracted.findByPk(id, {
      include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'lead_time_days'] }],
    });
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });

    const plain = row.get ? row.get({ plain: true }) : row;
    const rmIds = [];
    const pmIds = [];
    const rmReq = new Map(); // id -> { quantity, unit, name, code }
    const pmReq = new Map();

    let rms;
    let pms;
    if (plain.bom_confirmed_at) {
      const snap = await getConfirmedPiMaterialSnapshot(plain);
      rms = snap.rawMaterials;
      pms = snap.packagingMaterials;
    } else {
      rms = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
      pms = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];
    }

    const productId = plain.product_id ?? plain.product?.product_id;
    if (!plain.bom_confirmed_at && productId != null && (rms.length === 0 || pms.length === 0)) {
      const bomRows = await BOM.findAll({ where: { product_id: productId }, limit: 1 });
      const bom = bomRows[0];
      if (bom) {
        const bomPlain = bom.get ? bom.get({ plain: true }) : bom;
        if (rms.length === 0 && Array.isArray(bomPlain.rm_lines) && bomPlain.rm_lines.length > 0) {
          const batchSizeKg = Number(plain.batch_size_kg) || 500;
          const totalKgNum = parseFloat(String(plain.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
          for (const line of bomPlain.rm_lines) {
            let rid = line.raw_material_id != null ? Number(line.raw_material_id) : null;
            if (rid == null && line.rm_code) {
              const rm = await RawMaterial.findOne({ where: { code: line.rm_code }, attributes: ['id'] });
              if (rm) rid = rm.id;
            }
            if (rid == null || Number.isNaN(rid)) continue;
            const pct = line.pct_w_w ?? line.pct ?? 0;
            const quantity = totalKgNum > 0 ? (totalKgNum * pct) / 100 : (batchSizeKg * pct) / 100;
            rms.push({
              raw_material_id: rid,
              name: line.inci_name ?? line.name ?? line.rm_code ?? '',
              quantity: roundPlanningMaterialQty(quantity),
              unit: line.uom || 'KG',
              code: line.rm_code ?? line.code ?? '',
            });
          }
        }
        if (pms.length === 0 && Array.isArray(bomPlain.pm_lines) && bomPlain.pm_lines.length > 0) {
          const orderQtyNum = parseInt(String(plain.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
          for (const line of bomPlain.pm_lines) {
            let pid = line.pack_material_id != null ? Number(line.pack_material_id) : null;
            if (pid == null && line.pm_code) {
              const pm = await PackMaterial.findOne({ where: { code: line.pm_code }, attributes: ['id'] });
              if (pm) pid = pm.id;
            }
            if (pid == null || Number.isNaN(pid)) continue;
            const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
            const required = orderQtyNum * qtyPerUnit;
            pms.push({
              pack_material_id: pid,
              name: line.description ?? line.name ?? line.pm_code ?? '',
              quantity: roundPlanningMaterialQty(required),
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
      const rid = resolveRmIdFromMaterialSnapshotRow(r, rmByCode, rmByName);
      if (rid != null) r.raw_material_id = rid;
    }
    for (const p of pms) {
      if (p.pack_material_id != null && !Number.isNaN(Number(p.pack_material_id))) continue;
      const code = (p.code || '').trim();
      const nameKey = (p.name || '').trim().toLowerCase();
      if (code && pmByCode[code]) p.pack_material_id = pmByCode[code];
      else if (nameKey && pmByName[nameKey]) p.pack_material_id = pmByName[nameKey];
    }

    for (const r of rms) {
      const rid = resolveRmIdFromMaterialSnapshotRow(r, rmByCode, rmByName);
      if (rid == null || Number.isNaN(rid)) continue;
      const qty = Number(r.quantity) || 0;
      const prev = rmReq.get(rid);
      if (prev) {
        prev.quantity += qty;
        if (!prev.name && r.name) prev.name = r.name;
        if (!prev.code && r.code) prev.code = r.code;
      } else {
        rmReq.set(rid, { quantity: qty, unit: r.unit || 'KG', name: r.name || '', code: r.code || '' });
      }
    }
    rmIds.push(...rmReq.keys());
    for (const p of pms) {
      const pid = p.pack_material_id != null ? Number(p.pack_material_id) : null;
      if (pid == null || Number.isNaN(pid)) continue;
      const qty = Number(p.quantity) || 0;
      const prev = pmReq.get(pid);
      if (prev) {
        prev.quantity += qty;
        if (!prev.name && p.name) prev.name = p.name;
        if (!prev.code && p.code) prev.code = p.code;
      } else {
        pmReq.set(pid, { quantity: qty, unit: p.unit || 'PCS', name: p.name || '', code: p.code || '' });
      }
    }
    pmIds.push(...pmReq.keys());

    const planBatchesList = await PlanningBatch.findAll({ where: { planning_extracted_id: id }, order: [['sequence', 'ASC']] });
    const planBatchesPlain = planBatchesList.map((b) => (b.get ? b.get({ plain: true }) : b));
    const planBatchesSent = filterPlanningBatchesSentToProduction(plain, planBatchesPlain);
    const rmByCodeMap = new Map();
    const rmByNameMap = new Map();
    const pmByCodeMap = new Map();
    const pmByNameMap = new Map();
    if (rmIds.length > 0) {
      const rmRowsForBatch = await RawMaterial.findAll({ where: { id: { [Op.in]: rmIds } }, attributes: ['id', 'code', 'name'] });
      for (const r of rmRowsForBatch) {
        rmByCodeMap.set(r.code, r);
        if (r.name) rmByNameMap.set(String(r.name).trim().toLowerCase(), r);
      }
    }
    const extraRmCodes = new Set();
    const extraPmCodes = new Set();
    for (const bp of planBatchesPlain) {
      for (const line of bp.rm_lines || []) {
        const c = line.rm_code || line.code;
        if (c && !rmByCodeMap.has(c)) extraRmCodes.add(c);
      }
      for (const line of bp.pm_lines || []) {
        const c = line.pm_code || line.code;
        if (c && !pmByCodeMap.has(c)) extraPmCodes.add(c);
      }
    }
    if (extraRmCodes.size > 0) {
      const extra = await RawMaterial.findAll({ where: { code: { [Op.in]: [...extraRmCodes] } }, attributes: ['id', 'code', 'name'] });
      for (const r of extra) {
        rmByCodeMap.set(r.code, r);
        if (r.name) rmByNameMap.set(String(r.name).trim().toLowerCase(), r);
      }
    }
    if (pmIds.length > 0) {
      const pmRowsForBatch = await PackMaterial.findAll({ where: { id: { [Op.in]: pmIds } }, attributes: ['id', 'code', 'description'] });
      for (const p of pmRowsForBatch) {
        pmByCodeMap.set(p.code, p);
        if (p.description) pmByNameMap.set(String(p.description).trim().toLowerCase(), p);
      }
    }
    if (extraPmCodes.size > 0) {
      const extra = await PackMaterial.findAll({ where: { code: { [Op.in]: [...extraPmCodes] } }, attributes: ['id', 'code', 'description'] });
      for (const p of extra) {
        pmByCodeMap.set(p.code, p);
        if (p.description) pmByNameMap.set(String(p.description).trim().toLowerCase(), p);
      }
    }
    const plannedRmFromBatches = new Map();
    const plannedPmFromBatches = new Map();
    for (const bp of planBatchesSent) {
      accumulatePlannedBatchIntoQtyMaps(bp, plain, rmByCodeMap, rmByNameMap, pmByCodeMap, pmByNameMap, plannedRmFromBatches, plannedPmFromBatches);
    }

    // Match global items-involved: include materials on sent batches even when absent from BOM snapshot.
    for (const rid of plannedRmFromBatches.keys()) {
      const ridNum = Number(rid);
      if (!Number.isFinite(ridNum) || ridNum <= 0 || rmReq.has(ridNum)) continue;
      let name = '';
      let code = '';
      for (const r of rmByCodeMap.values()) {
        if (Number(r.id) === ridNum) {
          name = r.name || '';
          code = r.code || '';
          break;
        }
      }
      rmReq.set(ridNum, { quantity: 0, unit: 'KG', name, code });
    }
    for (const pid of plannedPmFromBatches.keys()) {
      const pidNum = Number(pid);
      if (!Number.isFinite(pidNum) || pidNum <= 0 || pmReq.has(pidNum)) continue;
      let name = '';
      let code = '';
      for (const p of pmByCodeMap.values()) {
        if (Number(p.id) === pidNum) {
          name = p.description || p.code || '';
          code = p.code || '';
          break;
        }
      }
      pmReq.set(pidNum, { quantity: 0, unit: 'PCS', name, code });
    }
    rmIds.length = 0;
    pmIds.length = 0;
    rmIds.push(...rmReq.keys());
    pmIds.push(...pmReq.keys());

    const whWhere = [];
    if (rmIds.length) whWhere.push({ item_type: 'RM', raw_material_id: { [Op.in]: rmIds } });
    if (pmIds.length) whWhere.push({ item_type: 'PM', pack_material_id: { [Op.in]: pmIds } });
    const {
      getGrnInTransitQtyByKey,
      getPoPipelineInTransitQtyByKey,
      getCompletedGrnReceivedKgByKey,
    } = require('../warehouseInventory/inTransitSync');
    const {
      buildRmMetaMap,
      finalizeItemsInvolvedRmRow,
      warehouseNativeQtyToKg,
      procurementOrPoLineQtyToKg,
      rmMetaForId,
    } = require('../lib/itemsInvolvedRmDisplay');
    const [whRows, rmsList, pmsList, allPos, grnInTransitKg, poInTransitKg, grnReceivedKg] = await Promise.all([
      whWhere.length ? WarehouseInventory.findAll({ where: { [Op.or]: whWhere } }) : Promise.resolve([]),
      rmIds.length
        ? RawMaterial.findAll({
            where: { id: rmIds },
            attributes: ['id', 'code', 'name', 'uom', 'specific_gravity'],
          })
        : Promise.resolve([]),
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : Promise.resolve([]),
      PurchaseOrder.findAll({ attributes: ['id', 'items'] }),
      getGrnInTransitQtyByKey(),
      getPoPipelineInTransitQtyByKey(),
      getCompletedGrnReceivedKgByKey(),
    ]);
    const rmMetaById = buildRmMetaMap(rmsList);

    const poQtyMapKg = new Map();
    for (const po of allPos) {
      const items = Array.isArray(po.items) ? po.items : [];
      for (const line of items) {
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        const n =
          key.startsWith('rm-') && rmMetaById
            ? procurementOrPoLineQtyToKg(line, rmMetaForId(rmMetaById, Number(String(key).slice(3))))
            : Number(line.quantity ?? line.qty ?? line.poQty ?? 0) || 0;
        if (!(n > 0)) continue;
        poQtyMapKg.set(key, (poQtyMapKg.get(key) || 0) + n);
      }
    }

    const inTransitByKeyKg = new Map();
    for (const source of [grnInTransitKg, poInTransitKg]) {
      for (const [k, v] of source) {
        const n = Number(v) || 0;
        if (n <= 0) continue;
        inTransitByKeyKg.set(k, (inTransitByKeyKg.get(k) || 0) + n);
      }
    }
    const netOpenPoQtyKg = (key) => {
      const totalOnPO = Number(poQtyMapKg.get(key) ?? 0) || 0;
      const totalInTransit = Number(inTransitByKeyKg.get(key) ?? 0) || 0;
      const totalReceived = Number(grnReceivedKg.get(key) ?? 0) || 0;
      return Math.max(0, totalOnPO - totalInTransit - totalReceived);
    };

    const sihByRm = new Map();
    const reservedByRm = new Map();
    const whIdByRm = new Map();
    const batchByRm = new Map();
    const expiryByRm = new Map();
    const inTransitByRm = new Map();
    const whUnitByRm = new Map();
    const sihByPm = new Map();
    const reservedByPm = new Map();
    const whIdByPm = new Map();
    const batchByPm = new Map();
    const expiryByPm = new Map();
    const inTransitByPm = new Map();
    for (const w of whRows) {
      const s = Number(w.stock_in_hand) || 0;
      const resv = Number(w.reserved) || 0;
      const inTr = Number(w.in_transit) || 0;
      if (w.item_type === 'RM' && w.raw_material_id) {
        whUnitByRm.set(w.raw_material_id, w.wh_unit);
        sihByRm.set(w.raw_material_id, s);
        reservedByRm.set(w.raw_material_id, resv);
        whIdByRm.set(w.raw_material_id, w.id);
        if (w.batch_number) batchByRm.set(w.raw_material_id, w.batch_number);
        if (w.expiry_date) expiryByRm.set(w.raw_material_id, w.expiry_date);
        inTransitByRm.set(w.raw_material_id, inTr);
      }
      if (w.item_type === 'PM' && w.pack_material_id) {
        sihByPm.set(w.pack_material_id, s);
        reservedByPm.set(w.pack_material_id, resv);
        whIdByPm.set(w.pack_material_id, w.id);
        if (w.batch_number) batchByPm.set(w.pack_material_id, w.batch_number);
        if (w.expiry_date) expiryByPm.set(w.pack_material_id, w.expiry_date);
        inTransitByPm.set(w.pack_material_id, inTr);
      }
    }

    const rmInfo = new Map(rmsList.map((r) => [r.id, { code: r.code, name: r.name }]));
    const pmInfo = new Map(pmsList.map((p) => [p.id, { code: p.code, name: p.description || p.code }]));

    const out = [];
    let idx = 0;
    for (const rid of rmIds) {
      const req = rmReq.get(rid) || {};
      const stockInHand = sihByRm.get(rid) ?? 0;
      const reserved = reservedByRm.get(rid) ?? 0;
      const sihNative = Math.max(0, stockInHand - reserved);
      const inTransitNative = inTransitByRm.get(rid) ?? 0;
      const rmMeta = rmMetaById.get(rid);
      const whUnit = whUnitByRm.get(rid);
      const sihKg = warehouseNativeQtyToKg(sihNative, whUnit, rmMeta);
      const inTransitKg = warehouseNativeQtyToKg(inTransitNative, whUnit, rmMeta);
      const fullOrderQty = req.quantity || 0;
      const plannedInBatches = plannedRmFromBatches.get(rid) || 0;
      const bomGrossRequiredKg = fullOrderQty;
      const unallocatedToBatches = Math.max(0, fullOrderQty - plannedInBatches);
      const plannedQty = plannedInBatches;
      const info = rmInfo.get(rid) || {};
      const name = req.name || info.name || `RM ${rid}`;
      const code = req.code || info.code || `RM-${rid}`;
      const rmRowKg = {
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
        totalRequired: bomGrossRequiredKg,
        unallocatedToBatches,
        unit: req.unit || 'KG',
        sih: sihKg,
        reserved,
        netStock: sihKg,
        surplusShortage: sihKg + inTransitKg - bomGrossRequiredKg,
        coverage:
          bomGrossRequiredKg > 0
            ? Math.min(100, Math.round(((sihKg + inTransitKg) / bomGrossRequiredKg) * 100))
            : 100,
        warehouseInventoryId: whIdByRm.get(rid) ?? null,
        batchNumber: batchByRm.get(rid) ?? null,
        expiryDate: expiryByRm.get(rid) ?? null,
        plannedQty,
        poQty: netOpenPoQtyKg(`rm-${rid}`),
        inTransit: inTransitKg,
        batchCount: countPlanningBatchesTouchingRm(planBatchesSent, rid, rmByCodeMap, rmByNameMap),
      };
      out.push(
        finalizeItemsInvolvedRmRow(rmRowKg, rmMeta, {
          sih: sihNative,
          reserved,
          inTransit: inTransitNative,
          whUnit,
        })
      );
    }
    for (const pid of pmIds) {
      const req = pmReq.get(pid) || {};
      const stockInHand = sihByPm.get(pid) ?? 0;
      const reserved = reservedByPm.get(pid) ?? 0;
      const sih = Math.max(0, stockInHand - reserved);
      const inTransit = inTransitByPm.get(pid) ?? 0;
      const fullOrderQtyPm = req.quantity || 0;
      const plannedInBatchesPm = plannedPmFromBatches.get(pid) || 0;
      const bomGrossRequiredPm = fullOrderQtyPm;
      const unallocatedToBatchesPm = Math.max(0, fullOrderQtyPm - plannedInBatchesPm);
      const plannedQty = plannedInBatchesPm;
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
        totalRequired: bomGrossRequiredPm,
        unallocatedToBatches: unallocatedToBatchesPm,
        unit: req.unit || 'PCS',
        sih,
        reserved,
        netStock: sih,
        surplusShortage: sih + inTransit - bomGrossRequiredPm,
        coverage: bomGrossRequiredPm > 0 ? Math.min(100, Math.round(((sih + inTransit) / bomGrossRequiredPm) * 100)) : 100,
        warehouseInventoryId: whIdByPm.get(pid) ?? null,
        batchNumber: batchByPm.get(pid) ?? null,
        expiryDate: expiryByPm.get(pid) ?? null,
        plannedQty,
        poQty: netOpenPoQtyNative(`pm-${pid}`),
        inTransit,
        batchCount: countPlanningBatchesTouchingPm(planBatchesSent, pid, pmByCodeMap, pmByNameMap, plain),
      });
    }

    console.log('[planningExtracted][items-involved-by-id]', {
      planningExtractedId: id,
      rows: out.map((r) => ({
        code: r.code,
        type: r.type,
        sih: r.sih,
        reserved: r.reserved,
        inTransit: r.inTransit,
        plannedQty: r.plannedQty,
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
  syncPlanningExtractedFromSalesOrders,
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
