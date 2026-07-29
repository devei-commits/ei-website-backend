const { Op } = require('sequelize');
const { ProductionEquipment, ProductionBatch } = require('./models');
const { Order } = require('../orders/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { FulfillmentBatchSplit, ReservedBatchItem } = require('../fulfillment/models');
const MaterialRequestNote = require('../mrn/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const BOM = require('../bom/models');
const { assertPrLicenceClearForBatchPatch } = require('../products/prFacilityLicenceGate');
const { syncWarehouseReserved } = require('../planningExtracted/controller');
const { logReservedChange, logLocationMovement } = require('../warehouseInventory/locationHistoryHelpers');
const PlanningExtracted = require('../planningExtracted/models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const { createRworkPlanningBatch, createSplitPlanningBatch } = require('../planningExtracted/controller');
const SalesOrder = require('../salesOrders/models');
const ProcurementRequest = require('../procurementRequests/models');
const { hasGranularAccess } = require('../middleware/security');
const { roundPlanningMaterialQty, parseFillSizeToKgPerUnit } = require('../planningExtracted/orderKgMath');
const {
  assertBatchEligibleForVesselSplit,
  hasDispensingProgress,
  scaleDispensingJsonLines,
  MIN_REMAINDER_KG,
} = require('./vesselSplitMath');
const {
  muZoneCodeToMlBucket,
  muBucketLabelForZone,
  muStockQtyFromPlain,
  getStockQtyAtMuZone,
  getStockQtyStrAtMuZone,
} = require('../facilityAreas/defaultLocationService');
const { buildSchedulePatchFromPlanning, scheduleFieldsInBody, validateEquipmentSchedulePatch } = require('./scheduleFromPlanning');
const {
  flattenPrQualitySpecRowsForDisplay,
  hydratePrQualitySpecRowsBySectionFromBom,
  hydratePrQualityBulkSubSpecRowsByPathFromBom,
  hydratePrQualityFinalSubSpecRowsByPathFromBom,
  hydratePrQualityDispatchSubSpecRowsByPathFromBom,
} = require('../products/prQualitySpecStorage');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const { listProductionTeamMembers } = require('./productionTeamAssignees');
const {
  materialQtyGte,
  materialQtyGt,
  materialQtyLte,
  materialQtyLteForDispensing,
  materialQtyGteForDispensing,
  capPmDispenseConsumption,
  materialQtyFromDb,
  materialQtyToNum,
  materialQtySub,
} = require('../utils/materialQtyCompare');

/* ════════════════════════════════════════════════════════════
   EQUIPMENT
   ════════════════════════════════════════════════════════════ */

function formatEquipment(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  const base = {
    id: d.equipment_id,
    name: d.name,
    status: d.status,
    _pk: d.id,
  };
  if (d.category === 'manufacturing') {
    return { ...base, cap: d.capacity, type: d.type, homogenizer: d.homogenizer, processType: d.process_types || [] };
  }
  if (d.category === 'filling') {
    return { ...base, speed: d.speed, type: d.type, compatible: d.compatible || [] };
  }
  return { ...base, speed: d.speed, type: d.type, supports: d.supports || [] };
}

async function listEquipment(req, res) {
  try {
    const rows = await ProductionEquipment.findAll({
      where: activeRowWhere(),
      order: [['category', 'ASC'], ['equipment_id', 'ASC']],
    });
    const grouped = { manufacturing: [], filling: [], packaging: [] };
    for (const r of rows) {
      const cat = r.category;
      if (grouped[cat]) grouped[cat].push(formatEquipment(r));
    }
    res.json(grouped);
  } catch (err) {
    console.error('listEquipment error:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
}

async function getEquipmentById(req, res) {
  try {
    const row = await ProductionEquipment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    res.json(formatEquipment(row));
  } catch (err) {
    console.error('getEquipmentById error:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
}

async function createEquipment(req, res) {
  try {
    const row = await ProductionEquipment.create(req.body);
    res.status(201).json(formatEquipment(row));
  } catch (err) {
    console.error('createEquipment error:', err);
    res.status(500).json({ error: 'Failed to create equipment' });
  }
}

async function updateEquipment(req, res) {
  try {
    const row = await ProductionEquipment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    const allowed = ['equipment_id', 'name', 'category', 'capacity', 'speed', 'type', 'homogenizer', 'process_types', 'compatible', 'supports', 'status'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) row.set(k, req.body[k]);
    }
    await row.save();
    res.json(formatEquipment(row));
  } catch (err) {
    console.error('updateEquipment error:', err);
    res.status(500).json({ error: 'Failed to update equipment' });
  }
}

async function deleteEquipment(req, res) {
  try {
    const row = await ProductionEquipment.findOne({ where: activeRowWhere({ id: req.params.id }) });
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    await softDeleteInstance(row);
    res.json({ message: 'Equipment deleted' });
  } catch (err) {
    console.error('deleteEquipment error:', err);
    res.status(500).json({ error: 'Failed to delete equipment' });
  }
}

/* ════════════════════════════════════════════════════════════
   TEAM MEMBERS
   ════════════════════════════════════════════════════════════ */

async function listTeam(req, res) {
  try {
    const team = await listProductionTeamMembers();
    res.json(team);
  } catch (err) {
    console.error('listTeam error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
}

/* ════════════════════════════════════════════════════════════
   BATCHES (BMR / BPR)
   ════════════════════════════════════════════════════════════ */

function formatBatch(row, visibility = { canViewBmr: true, canViewBpr: true, canViewYield: true }) {
  const d = row.get ? row.get({ plain: true }) : row;
  const payload = {
    _pk: d.id,
    bmrNo: d.bmr_no,
    bprNo: d.bpr_no,
    productName: d.product_name,
    sku: d.sku,
    soNo: d.so_no || '',
    orderQty: d.order_qty ?? 0,
    batchSize: d.batch_size ?? 0,
    batchNo: d.batch_no || '',
    batchIndex: d.batch_index ?? 0,
    totalBatches: d.total_batches ?? 0,
    bmrStatus: d.bmr_status,
    bprStatus: d.bpr_status,
    color: d.color || '',
    processType: d.process_type || 'cold',
    homogenizer: !!d.homogenizer,
    mainVessel: d.main_vessel || '',
    supportingTanks: d.supporting_tanks || [],
    fillingLine: d.filling_line || '',
    fillingType: d.filling_type || 'bottle',
    packagingLine: d.packaging_line || '',
    monocarton: !!d.monocarton,
    shrink: !!d.shrink,
    teamBMR: d.team_bmr || [],
    teamBPR: d.team_bpr || [],
    shiftLeadBMR: d.shift_lead_bmr || '',
    shiftLeadBPR: d.shift_lead_bpr || '',
    qcOfficerBMR: d.qc_officer_bmr || '',
    qcOfficerBPR: d.qc_officer_bpr || '',
    scheduledMuZone: d.scheduled_mu_zone || '',
    scheduleRemarks: d.schedule_remarks || '',
    mfgDate: d.mfg_date || '',
    fillDate: d.fill_date || '',
    packDate: d.pack_date || '',
    fgDate: d.fg_date || '',
    rmConnectDate: d.rm_connect_date || '',
    pmConnectDate: d.pm_connect_date || '',
    rmReserved: !!d.rm_reserved,
    pmReserved: !!d.pm_reserved,
    rmConnected: !!d.rm_connected,
    pmConnected: !!d.pm_connected,
    dispensingRM: d.dispensing_rm || [],
    dispensingPM: d.dispensing_pm || [],
    bulkYield: d.bulk_yield != null ? Number(d.bulk_yield) : null,
    fillYield: d.fill_yield != null ? Number(d.fill_yield) : null,
    fgYield: d.fg_yield != null ? Number(d.fg_yield) : null,
    bulkBatchAccepted: d.bulk_batch_accepted,
    fillBatchAccepted: d.fill_batch_accepted,
    fgBatchAccepted: d.fg_batch_accepted,
    qcSpecs: d.qc_specs || [],
    remarks: d.remarks || '',
    dueDate: d.due_date || '',
    priority: d.priority || 'MEDIUM',
    needByNote: d.need_by_note || '',
    compatibleVessels: d.compatible_vessels || undefined,
    compatibleFillLines: d.compatible_fill_lines || undefined,
    compatiblePackLines: d.compatible_pack_lines || undefined,
    requiredVolumeLiters: d.required_volume_liters != null ? Number(d.required_volume_liters) : null,
    planningBatchId: d.planning_batch_id ?? undefined,
    muDispensingBundleId: d.mu_dispensing_bundle_id || null,
    muDispensingBundles: Array.isArray(d.mu_dispensing_bundles) ? d.mu_dispensing_bundles : [],
  };
  if (!visibility.canViewBmr) {
    payload.bmrNo = null;
    payload.bmrStatus = null;
    payload.teamBMR = [];
    payload.shiftLeadBMR = '';
    payload.qcOfficerBMR = '';
    payload.rmReserved = false;
    payload.rmConnected = false;
    payload.dispensingRM = [];
    payload.rmConnectDate = '';
  }
  if (!visibility.canViewBpr) {
    payload.bprNo = null;
    payload.bprStatus = null;
    payload.teamBPR = [];
    payload.shiftLeadBPR = '';
    payload.qcOfficerBPR = '';
    payload.pmReserved = false;
    payload.pmConnected = false;
    payload.dispensingPM = [];
    payload.pmConnectDate = '';
    payload.fillDate = '';
    payload.packDate = '';
    payload.fgDate = '';
  }
  if (!visibility.canViewYield) {
    payload.bulkYield = null;
    payload.fillYield = null;
    payload.fgYield = null;
    payload.bulkBatchAccepted = null;
    payload.fillBatchAccepted = null;
    payload.fgBatchAccepted = null;
  }
  return payload;
}

async function getBatchVisibility(req) {
  const [canViewBmr, canViewBpr, canViewYield] = await Promise.all([
    hasGranularAccess(req, 'order-management.production-bmr', 'view'),
    hasGranularAccess(req, 'order-management.production-bpr', 'view'),
    hasGranularAccess(req, 'order-management.production-transfer-yield', 'view'),
  ]);
  return { canViewBmr, canViewBpr, canViewYield };
}

/**
 * Compute required batch volume in liters from BOM rm_lines.
 * Volume per RM = (batch_size_kg * pct_w_w/100) / (specific_gravity || 1).
 * Assumes specific_gravity is relative to water (1 = 1 kg/L).
 */
function computeRequiredVolumeLiters(batchSizeKg, rmLines) {
  if (!batchSizeKg || !Array.isArray(rmLines) || rmLines.length === 0) return null;
  let totalL = 0;
  for (const line of rmLines) {
    const pct = Number(line.pct_w_w ?? line.pct ?? 0) || 0;
    const sg = Number(line.specific_gravity) || 1;
    if (sg <= 0) continue;
    const qtyKg = (batchSizeKg * pct) / 100;
    totalL += qtyKg / sg;
  }
  return Math.round(totalL * 100) / 100;
}

const BATCH_ALLOWED_FIELDS = [
  'bmr_no', 'bpr_no', 'product_name', 'sku', 'so_no', 'order_qty', 'batch_size',
  'batch_no', 'batch_index', 'total_batches', 'bmr_status', 'bpr_status', 'color',
  'process_type', 'homogenizer', 'main_vessel', 'supporting_tanks',
  'filling_line', 'filling_type', 'packaging_line', 'monocarton', 'shrink',
  'team_bmr', 'team_bpr', 'shift_lead_bmr', 'shift_lead_bpr', 'qc_officer_bmr', 'qc_officer_bpr',
  'scheduled_mu_zone', 'schedule_remarks',
  'mfg_date', 'fill_date', 'pack_date', 'fg_date', 'rm_connect_date', 'pm_connect_date',
  'rm_reserved', 'pm_reserved', 'rm_connected', 'pm_connected',
  'dispensing_rm', 'dispensing_pm',
  'bulk_yield', 'fill_yield', 'fg_yield',
  'bulk_batch_accepted', 'fill_batch_accepted', 'fg_batch_accepted',
  'qc_specs', 'remarks', 'due_date', 'priority', 'need_by_note',
  'compatible_vessels', 'compatible_fill_lines', 'compatible_pack_lines',
  'required_volume_liters',
];

const BATCH_CAMEL_TO_SNAKE = {
  bmrNo: 'bmr_no', bprNo: 'bpr_no', productName: 'product_name', soNo: 'so_no',
  orderQty: 'order_qty', batchSize: 'batch_size', batchNo: 'batch_no',
  batchIndex: 'batch_index', totalBatches: 'total_batches',
  bmrStatus: 'bmr_status', bprStatus: 'bpr_status',
  processType: 'process_type', mainVessel: 'main_vessel',
  supportingTanks: 'supporting_tanks', fillingLine: 'filling_line',
  fillingType: 'filling_type', packagingLine: 'packaging_line',
  teamBMR: 'team_bmr', teamBPR: 'team_bpr',
  shiftLeadBMR: 'shift_lead_bmr', shiftLeadBPR: 'shift_lead_bpr',
  qcOfficerBMR: 'qc_officer_bmr', qcOfficerBPR: 'qc_officer_bpr',
  scheduledMuZone: 'scheduled_mu_zone', scheduleRemarks: 'schedule_remarks',
  mfgDate: 'mfg_date', fillDate: 'fill_date', packDate: 'pack_date', fgDate: 'fg_date',
  rmConnectDate: 'rm_connect_date', pmConnectDate: 'pm_connect_date',
  rmReserved: 'rm_reserved', pmReserved: 'pm_reserved',
  rmConnected: 'rm_connected', pmConnected: 'pm_connected',
  dispensingRM: 'dispensing_rm', dispensingPM: 'dispensing_pm',
  bulkYield: 'bulk_yield', fillYield: 'fill_yield', fgYield: 'fg_yield',
  bulkBatchAccepted: 'bulk_batch_accepted', fillBatchAccepted: 'fill_batch_accepted',
  fgBatchAccepted: 'fg_batch_accepted', qcSpecs: 'qc_specs', dueDate: 'due_date',
  priority: 'priority', needByNote: 'need_by_note',
  compatibleVessels: 'compatible_vessels', compatibleFillLines: 'compatible_fill_lines',
  compatiblePackLines: 'compatible_pack_lines',
  requiredVolumeLiters: 'required_volume_liters',
};

function applyBatchBody(row, body) {
  for (const k of BATCH_ALLOWED_FIELDS) {
    if (body[k] !== undefined) row.set(k, body[k]);
  }
  for (const [camel, snake] of Object.entries(BATCH_CAMEL_TO_SNAKE)) {
    if (body[camel] !== undefined) row.set(snake, body[camel]);
  }
}

/**
 * Resolve product_id for a batch (from sku or product_name) and compute required_volume_liters from BOM rm_lines.
 * Sets required_volume_liters on the row if BOM and batch_size are available.
 */
async function recomputeBatchVolume(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  const batchSizeKg = Number(d.batch_size) || Number(d.order_qty) || 0;
  if (batchSizeKg <= 0) return;
  let product = null;
  if (d.sku) product = await Product.findOne({ where: { zoho_sku_code: d.sku }, attributes: ['product_id'] });
  if (!product && d.product_name) product = await Product.findOne({ where: { product_name: d.product_name }, attributes: ['product_id'] });
  if (!product) return;
  const productId = product.product_id;
  const bom = await BOM.findOne({ where: { product_id: productId }, attributes: ['rm_lines'] });
  if (!bom || !Array.isArray(bom.rm_lines) || bom.rm_lines.length === 0) return;
  const vol = computeRequiredVolumeLiters(batchSizeKg, bom.rm_lines);
  if (vol != null) row.set('required_volume_liters', vol);
}

/** Get next BMR/BPR numbers for the year (e.g. BMR-2026-001). */
async function getNextBMRBPRSequence(year) {
  const prefix = `BMR-${year}-`;
  const batches = await ProductionBatch.findAll({
    where: { bmr_no: { [Op.like]: `${prefix}%` } },
    attributes: ['bmr_no'],
  });
  let maxNum = 0;
  for (const b of batches) {
    const num = parseInt(b.bmr_no.replace(prefix, ''), 10);
    if (!Number.isNaN(num) && num > maxNum) maxNum = num;
  }
  const next = maxNum + 1;
  const suffix = String(next).padStart(3, '0');
  return { bmrNo: `BMR-${year}-${suffix}`, bprNo: `BPR-${year}-${suffix}` };
}

/**
 * Get next rework suffix for a base BMR (e.g. base BMR-2026-001 -> rw-01, rw-02).
 * baseBmrNo should not include -rw-XX (strip it if present).
 */
async function getNextRworkSuffix(baseBmrNo) {
  if (!baseBmrNo || typeof baseBmrNo !== 'string') return 1;
  const base = baseBmrNo.replace(/-rw-\d+$/, '').trim();
  if (!base) return 1;
  const pattern = `${base}-rw-%`;
  const rows = await ProductionBatch.findAll({
    where: { bmr_no: { [Op.like]: pattern } },
    attributes: ['bmr_no'],
  });
  let maxNum = 0;
  for (const r of rows) {
    const m = (r.bmr_no || '').match(/-rw-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return maxNum + 1;
}

/** Next split suffix for a base BMR (e.g. BMR-2026-001 -> sp-01, sp-02). */
async function getNextSplitSuffix(baseBmrNo) {
  if (!baseBmrNo || typeof baseBmrNo !== 'string') return 1;
  const base = baseBmrNo.replace(/-(?:rw|sp)-\d+$/, '').trim();
  if (!base) return 1;
  const pattern = `${base}-sp-%`;
  const rows = await ProductionBatch.findAll({
    where: { bmr_no: { [Op.like]: pattern } },
    attributes: ['bmr_no'],
  });
  let maxNum = 0;
  for (const r of rows) {
    const m = (r.bmr_no || '').match(/-sp-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return maxNum + 1;
}

async function listBatches(req, res) {
  try {
    const rows = await ProductionBatch.findAll({
      where: activeRowWhere(),
      order: [['bmr_no', 'ASC']],
    });
    const visibility = await getBatchVisibility(req);
    res.json(rows.map((r) => formatBatch(r, visibility)));
  } catch (err) {
    console.error('listBatches error:', err);
    res.status(500).json({ error: 'Failed to fetch batches' });
  }
}

async function loadEquipmentGrouped() {
  const rows = await ProductionEquipment.findAll({
    where: activeRowWhere(),
    order: [['category', 'ASC'], ['equipment_id', 'ASC']],
  });
  const grouped = { manufacturing: [], filling: [], packaging: [] };
  for (const r of rows) {
    const cat = r.category;
    if (grouped[cat]) grouped[cat].push(formatEquipment(r));
  }
  return grouped;
}

/** Seed MFG/Fill/Pack/FG stage dates from planning planned_start_date when batch has no mfg_date yet. */
async function applyPlanningScheduleIfNeeded(batchRow, planPlain, sequence, allBatches, equipmentGrouped) {
  const patch = buildSchedulePatchFromPlanning(planPlain, sequence, batchRow, allBatches, equipmentGrouped);
  if (!patch) return false;
  await batchRow.update(patch);
  return true;
}

/**
 * POST /batches/sync-from-planning — ensure a production batch exists for each sent planning batch.
 * For every PlanningExtracted with sent_batch_indices, and each index i, finds PlanningBatch (sequence i+1).
 * If no ProductionBatch exists for that SO + product + batch_index, creates one with next BMR/BPR.
 */
async function syncBatchesFromPlanning(req, res) {
  try {
    const equipmentGrouped = await loadEquipmentGrouped();
    const allBatches = await ProductionBatch.findAll({ where: activeRowWhere() });
    let scheduleSeeded = 0;

    const planRows = await PlanningExtracted.findAll({
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id'], required: true },
        { model: Product, as: 'product', attributes: ['product_id', 'zoho_sku_code', 'product_name'], required: true },
      ],
    });
    const plansWithSent = planRows.filter((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const sent = Array.isArray(d.sent_batch_indices) ? d.sent_batch_indices : [];
      return sent.length > 0;
    });
    const year = new Date().getFullYear();
    let created = 0;
    for (const planRow of plansWithSent) {
      const plan = planRow.get ? planRow.get({ plain: true }) : planRow;
      const sentIndices = Array.isArray(plan.sent_batch_indices) ? plan.sent_batch_indices : [];
      const soOrderId = plan.salesOrder?.order_id || '';
      const product = plan.product || {};
      const productSku = product.zoho_sku_code || '';
      const productName = product.product_name || '';

      for (const sentIndex of sentIndices) {
        const sequence = Number(sentIndex) + 1;
        const planningBatch = await PlanningBatch.findOne({
          where: { planning_extracted_id: plan.id, sequence },
        });
        if (!planningBatch) continue;

        const pbPlain = planningBatch.get ? planningBatch.get({ plain: true }) : planningBatch;
        const sizeKg = pbPlain.size_kg != null ? Number(pbPlain.size_kg) : null;
        const orderQty = parseInt(String(plan.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
        const batchCount = Number(plan.batch_count) || Number(plan.batches_required) || 1;

        const existing = await ProductionBatch.findAll({
          where: {
            [Op.or]: [
              { so_no: soOrderId },
              { so_no: soOrderId.replace(/^EI-SO-?/i, 'SO-') },
              { so_no: soOrderId.replace(/^SO-?/i, 'EI-SO-') },
            ],
            batch_index: sequence,
          },
        });
        const match = existing.find((b) => {
          const d = b.get ? b.get({ plain: true }) : b;
          return (productSku && d.sku === productSku) || (productName && d.product_name === productName);
        });
        if (match) {
          const matchPlain = match.get ? match.get({ plain: true }) : match;
          if (!matchPlain.planning_batch_id) {
            await match.update({ planning_batch_id: planningBatch.id });
          }
          if (await applyPlanningScheduleIfNeeded(match, plan, sequence, allBatches, equipmentGrouped)) {
            scheduleSeeded += 1;
          }
          continue;
        }

        const { bmrNo, bprNo } = await getNextBMRBPRSequence(year);
        const skuValue = productSku || productName || String(product.product_id ?? 'sync');
        const createdRow = await ProductionBatch.create({
          bmr_no: bmrNo,
          bpr_no: bprNo,
          product_name: productName || 'Unknown',
          sku: skuValue,
          so_no: soOrderId,
          order_qty: orderQty,
          batch_size: sizeKg != null ? Math.round(sizeKg) : null,
          batch_no: `B-${String(sequence).padStart(2, '0')}`,
          batch_index: sequence,
          total_batches: batchCount,
          planning_batch_id: planningBatch.id,
          bmr_status: 'draft',
          bpr_status: 'draft',
        });
        created++;
        allBatches.push(createdRow);
        if (await applyPlanningScheduleIfNeeded(createdRow, plan, sequence, allBatches, equipmentGrouped)) {
          scheduleSeeded += 1;
        }
      }
    }

    // Repair: link production batches that have no planning_batch_id but match a sent planning batch (SO + product + batch_index).
    // Handles batches sent from Planning that didn't match in the main loop (e.g. product name/sku mismatch) or created before linking existed.
    const unlinked = await ProductionBatch.findAll({
      where: { planning_batch_id: null },
      attributes: ['id', 'so_no', 'sku', 'product_name', 'batch_index'],
    });
    let repaired = 0;
    for (const row of unlinked) {
      const d = row.get ? row.get({ plain: true }) : row;
      const soNo = (d.so_no || '').trim();
      if (!soNo) continue;
      const plans = await PlanningExtracted.findAll({
        include: [
          { model: SalesOrder, as: 'salesOrder', attributes: ['order_id'], required: true },
          { model: Product, as: 'product', attributes: ['product_id', 'zoho_sku_code', 'product_name'], required: true },
        ],
      });
      const planMatch = plans.find((p) => {
        const plain = p.get ? p.get({ plain: true }) : p;
        const orderId = (plain.salesOrder?.order_id || '').trim();
        const soMatch = orderId === soNo
          || orderId.replace(/^EI-SO-?/i, 'SO-') === soNo.replace(/^EI-SO-?/i, 'SO-')
          || orderId.replace(/^SO-?/i, 'EI-SO-') === soNo.replace(/^SO-?/i, 'EI-SO-');
        if (!soMatch) return false;
        const sku = (plain.product?.zoho_sku_code || '').trim().toLowerCase();
        const pname = (plain.product?.product_name || '').trim().toLowerCase();
        const bSku = (d.sku || '').trim().toLowerCase();
        const bName = (d.product_name || '').trim().toLowerCase();
        const productMatch = (sku && bSku && (sku === bSku || bSku.includes(sku) || sku.includes(bSku)))
          || (pname && bName && (pname === bName || bName.includes(pname) || pname.includes(bName)));
        return !!productMatch;
      });
      if (!planMatch) continue;
      const plan = planMatch.get ? planMatch.get({ plain: true }) : planMatch;
      const sent = Array.isArray(plan.sent_batch_indices) ? plan.sent_batch_indices : [];
      const seq = d.batch_index != null ? Number(d.batch_index) : null;
      if (seq == null || !sent.includes(seq - 1)) continue;
      const pb = await PlanningBatch.findOne({
        where: { planning_extracted_id: plan.id, sequence: seq },
      });
      if (!pb) continue;
      await row.update({ planning_batch_id: pb.id });
      repaired++;
      const seqForSchedule = d.batch_index != null ? Number(d.batch_index) : 1;
      if (await applyPlanningScheduleIfNeeded(row, plan, seqForSchedule, allBatches, equipmentGrouped)) {
        scheduleSeeded += 1;
      }
    }

    res.json({ success: true, created, repaired, scheduleSeeded });
  } catch (err) {
    console.error('syncBatchesFromPlanning error', err);
    res.status(500).json({ success: false, error: 'Failed to sync batches from planning' });
  }
}

async function getBatchById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProductionBatch.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Batch not found' });
    const visibility = await getBatchVisibility(req);
    res.json(formatBatch(row, visibility));
  } catch (err) {
    console.error('getBatchById error:', err);
    res.status(500).json({ error: 'Failed to fetch batch' });
  }
}

async function createBatch(req, res) {
  try {
    const data = {};
    for (const k of BATCH_ALLOWED_FIELDS) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }
    for (const [camel, snake] of Object.entries(BATCH_CAMEL_TO_SNAKE)) {
      if (req.body[camel] !== undefined) data[snake] = req.body[camel];
    }
    const row = await ProductionBatch.create(data);
    await recomputeBatchVolume(row);
    await row.save();
    const visibility = await getBatchVisibility(req);
    res.status(201).json(formatBatch(row, visibility));
  } catch (err) {
    console.error('createBatch error:', err);
    res.status(500).json({ error: 'Failed to create batch' });
  }
}

/**
 * POST /batches/create-rework — create a new rework batch (BMR-YYYY-NNN-rw-01, rw-02, ...).
 * Body: {
 *   baseBatchId: number,
 *   reason?: string,
 *   targetOrderQty?: number,        // optional override for rework qty (units)
 *   targetBatchSizeKg?: number,     // optional override for planning batch size_kg
 *   rmLines?: any[],                // optional edited RM lines for new rework planning batch
 *   pmLines?: any[],                // optional edited PM lines for new rework planning batch
 * }
 * — production batch to rework from (same SO/product)
 * Creates a new planning_batch (PE-{id}-rw-NN) in the planning table and a new production batch linked to it (same SO).
 */
async function createRworkBatch(req, res) {
  try {
    const baseBatchId = req.body.baseBatchId != null ? parseInt(req.body.baseBatchId, 10) : null;
    if (baseBatchId == null || Number.isNaN(baseBatchId)) {
      return res.status(400).json({ error: 'baseBatchId is required' });
    }
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const targetOrderQtyRaw = req.body.targetOrderQty;
    const targetBatchSizeKgRaw = req.body.targetBatchSizeKg;
    const targetOrderQty = targetOrderQtyRaw != null ? Number(targetOrderQtyRaw) : null;
    const targetBatchSizeKg = targetBatchSizeKgRaw != null ? Number(targetBatchSizeKgRaw) : null;
    const editedRmLines = Array.isArray(req.body.rmLines) ? req.body.rmLines : null;
    const editedPmLines = Array.isArray(req.body.pmLines) ? req.body.pmLines : null;
    const base = await ProductionBatch.findByPk(baseBatchId);
    if (!base) return res.status(404).json({ error: 'Base batch not found' });
    const basePlain = base.get ? base.get({ plain: true }) : base;
    if (!basePlain.planning_batch_id) {
      return res.status(400).json({ error: 'Base batch must be linked to planning (has no planning_batch_id)' });
    }
    const pb = await PlanningBatch.findByPk(basePlain.planning_batch_id);
    if (!pb) return res.status(404).json({ error: 'Planning batch not found' });
    const planId = pb.planning_extracted_id;

    // Rework must inherit the *base planning batch BOM copy* (not just SO override / product master),
    // so per-batch swap/BOM editor changes persist into the new batch pipeline.
    const newPb = await createRworkPlanningBatch(planId, pb.id);
    if (!newPb) return res.status(404).json({ error: 'Planning extracted not found' });
    if (targetBatchSizeKg != null && Number.isFinite(targetBatchSizeKg) && targetBatchSizeKg > 0) {
      newPb.size_kg = targetBatchSizeKg;
    }
    if (editedRmLines) newPb.rm_lines = editedRmLines;
    if (editedPmLines) newPb.pm_lines = editedPmLines;
    await newPb.save();
    const newPbPlain = newPb.get ? newPb.get({ plain: true }) : newPb;

    const baseBmr = (basePlain.bmr_no || '').replace(/-rw-\d+$/, '').trim();
    const baseBpr = (basePlain.bpr_no || '').replace(/-rw-\d+$/, '').trim();
    const nextRw = await getNextRworkSuffix(basePlain.bmr_no);
    const rwSuffix = String(nextRw).padStart(2, '0');
    const bmrNo = `${baseBmr}-rw-${rwSuffix}`;
    const bprNo = `${baseBpr}-rw-${rwSuffix}`;

    const orderQty =
      targetOrderQty != null && Number.isFinite(targetOrderQty) && targetOrderQty > 0
        ? Math.round(targetOrderQty)
        : (basePlain.order_qty ?? 0);
    const batchSize = newPbPlain.size_kg != null ? Math.round(Number(newPbPlain.size_kg)) : (basePlain.batch_size ?? null);
    const remarksValue = reason ? `Rework: ${reason}` : null;
    const row = await ProductionBatch.create({
      bmr_no: bmrNo,
      bpr_no: bprNo,
      product_name: basePlain.product_name || 'Unknown',
      sku: basePlain.sku || '',
      so_no: basePlain.so_no || '',
      order_qty: orderQty,
      batch_size: batchSize,
      batch_no: `rw-${rwSuffix}`,
      batch_index: newPbPlain.sequence ?? 1,
      total_batches: basePlain.total_batches ?? 1,
      planning_batch_id: newPb.id,
      bmr_status: 'draft',
      bpr_status: 'draft',
      remarks: remarksValue,
    });
    await recomputeBatchVolume(row);
    await row.save();
    res.status(201).json(formatBatch(row));
  } catch (err) {
    console.error('createRworkBatch error:', err);
    res.status(500).json({ error: 'Failed to create rework batch' });
  }
}

/**
 * POST /batches/split-for-vessel — shrink batch to vessel-sized first run; create sp-NN sibling for remainder.
 * Body: { baseBatchId, firstRunSizeKg, reason?, vesselCapacityLiters? }
 */
async function splitBatchForVessel(req, res) {
  try {
    const baseBatchId = req.body.baseBatchId != null ? parseInt(req.body.baseBatchId, 10) : null;
    const firstRunSizeKg = req.body.firstRunSizeKg != null ? Number(req.body.firstRunSizeKg) : null;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (baseBatchId == null || Number.isNaN(baseBatchId)) {
      return res.status(400).json({ error: 'baseBatchId is required' });
    }
    if (!Number.isFinite(firstRunSizeKg) || firstRunSizeKg <= 0) {
      return res.status(400).json({ error: 'firstRunSizeKg must be a positive number' });
    }

    const base = await ProductionBatch.findByPk(baseBatchId);
    if (!base) return res.status(404).json({ error: 'Base batch not found' });
    const basePlain = base.get ? base.get({ plain: true }) : base;

    const eligibilityErr = assertBatchEligibleForVesselSplit(basePlain);
    if (eligibilityErr) return res.status(400).json({ error: eligibilityErr });
    if (!basePlain.planning_batch_id) {
      return res.status(400).json({ error: 'Base batch must be linked to planning (has no planning_batch_id)' });
    }
    if (hasDispensingProgress(basePlain.dispensing_rm, basePlain.dispensing_pm)) {
      return res.status(400).json({ error: 'Cannot split after dispensing has started on this batch.' });
    }

    const oldSize = Number(basePlain.batch_size) || 0;
    if (oldSize <= 0) return res.status(400).json({ error: 'Batch has no batch_size to split' });
    const firstRun = Math.round(firstRunSizeKg);
    const remainder = Math.round((oldSize - firstRun) * 1000) / 1000;
    if (firstRun >= oldSize) {
      return res.status(400).json({ error: 'firstRunSizeKg must be less than current batch size' });
    }
    if (remainder < MIN_REMAINDER_KG) {
      return res.status(400).json({ error: `Remainder must be at least ${MIN_REMAINDER_KG} KG` });
    }

    const pb = await PlanningBatch.findByPk(basePlain.planning_batch_id);
    if (!pb) return res.status(404).json({ error: 'Planning batch not found' });
    const planId = pb.planning_extracted_id;

    const firstScale = firstRun / oldSize;
    const remainderScale = remainder / oldSize;
    const oldOrderQty = Number(basePlain.order_qty) || 0;
    const splitOrderQty = oldOrderQty > 0 ? Math.max(0, Math.round(oldOrderQty * remainderScale)) : 0;
    const firstOrderQty = oldOrderQty > 0 ? Math.max(0, oldOrderQty - splitOrderQty) : oldOrderQty;
    const nextTotalBatches = (Number(basePlain.total_batches) || 1) + 1;

    const remarksNote = reason
      ? `Vessel split: ${reason}`
      : `Vessel split: ${firstRun} KG first run + ${remainder} KG split batch`;

    base.batch_size = firstRun;
    if (oldOrderQty > 0) base.order_qty = firstOrderQty;
    base.total_batches = nextTotalBatches;
    if (Array.isArray(basePlain.dispensing_rm)) {
      base.dispensing_rm = scaleDispensingJsonLines(basePlain.dispensing_rm, firstScale);
    }
    if (Array.isArray(basePlain.dispensing_pm)) {
      base.dispensing_pm = scaleDispensingJsonLines(basePlain.dispensing_pm, firstScale);
    }
    const existingRemarks = String(basePlain.remarks || '').trim();
    base.remarks = existingRemarks ? `${existingRemarks} · ${remarksNote}` : remarksNote;
    await recomputeBatchVolume(base);
    await base.save();
    await syncPlanningBatchFromProductionBatchSize(base.get({ plain: true }));

    const newPb = await createSplitPlanningBatch(planId, basePlain.planning_batch_id, remainder);
    if (!newPb) {
      return res.status(500).json({ error: 'Failed to create split planning batch' });
    }
    const newPbPlain = newPb.get ? newPb.get({ plain: true }) : newPb;

    const baseBmr = (basePlain.bmr_no || '').replace(/-(?:rw|sp)-\d+$/, '').trim();
    const baseBpr = (basePlain.bpr_no || '').replace(/-(?:rw|sp)-\d+$/, '').trim();
    const nextSp = await getNextSplitSuffix(basePlain.bmr_no);
    const spSuffix = String(nextSp).padStart(2, '0');
    const bmrNo = `${baseBmr}-sp-${spSuffix}`;
    const bprNo = `${baseBpr}-sp-${spSuffix}`;

    const splitRow = await ProductionBatch.create({
      bmr_no: bmrNo,
      bpr_no: bprNo,
      product_name: basePlain.product_name || 'Unknown',
      sku: basePlain.sku || '',
      so_no: basePlain.so_no || '',
      order_qty: splitOrderQty || basePlain.order_qty || 0,
      batch_size: remainder,
      batch_no: `sp-${spSuffix}`,
      batch_index: newPbPlain.sequence ?? nextTotalBatches,
      total_batches: nextTotalBatches,
      planning_batch_id: newPb.id,
      bmr_status: 'draft',
      bpr_status: 'draft',
      color: basePlain.color || null,
      process_type: basePlain.process_type || null,
      homogenizer: basePlain.homogenizer ?? false,
      filling_type: basePlain.filling_type || null,
      compatible_vessels: basePlain.compatible_vessels || null,
      compatible_fill_lines: basePlain.compatible_fill_lines || null,
      compatible_pack_lines: basePlain.compatible_pack_lines || null,
      remarks: remarksNote,
    });
    await recomputeBatchVolume(splitRow);
    await splitRow.save();

    const visibility = await getBatchVisibility(req);
    return res.status(201).json({
      original: formatBatch(base, visibility),
      split: formatBatch(splitRow, visibility),
    });
  } catch (err) {
    console.error('splitBatchForVessel error:', err);
    res.status(500).json({ error: err.message || 'Failed to split batch for vessel capacity' });
  }
}

/**
 * After BPR QC: reduce RM/PM (consumed), add FG to warehouse, set fulfillment split fg_qty for invoicing.
 * Called when BPR status transitions to fg_ready.
 */
/** Keep fulfillment_batch_splits.fg_qty aligned with QC yields (no warehouse side effects). */
async function syncFulfillmentFgQtyFromBatch(batchRow) {
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;
  if (String(d.bpr_status || '').toLowerCase() !== 'fg_ready') return;
  const fgYieldQty = Number(d.fg_yield);
  const fillYieldQty = Number(d.fill_yield);
  const plannedQty = Number(d.batch_size || d.order_qty || 0);
  const producedQtyRaw = Number.isFinite(fgYieldQty) && fgYieldQty >= 0
    ? fgYieldQty
    : (Number.isFinite(fillYieldQty) && fillYieldQty > 0 ? fillYieldQty : plannedQty);
  const producedQty = Math.max(0, Math.round(producedQtyRaw) || 0);
  if (producedQty <= 0) return;
  const { FulfillmentBatchSplit } = require('../fulfillment/models');
  const splits = await FulfillmentBatchSplit.findAll({
    where: { production_batch_id: d.id },
    order: [['id', 'ASC']],
  });
  let remaining = producedQty;
  for (const split of splits) {
    const planned = Number(split.planned_qty) || 0;
    const qty = Math.min(planned > 0 ? planned : remaining, remaining);
    if (qty >= 0) await split.update({ fg_qty: qty, ff_status: 'fg_ready' });
    remaining -= qty;
    if (remaining <= 0) break;
  }
}

async function applyBprFgReadyToInventory(batchRow) {
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;

  // Dispensing consumption should already have happened during rm_dispensing/pm_dispensing stage
  // (before reaching fg_ready). To prevent double-counting, only reduce RM/PM here if there is
  // no recorded dispensed quantity yet.
  // If dispensed quantities are present, we only add FG below.
  const dispensingRm = Array.isArray(d.dispensing_rm) ? d.dispensing_rm : [];
  const dispensingPm = Array.isArray(d.dispensing_pm) ? d.dispensing_pm : [];
  const totalDispensedRm = dispensingRm.reduce((sum, l) => sum + (Number(l.dispensed) || 0), 0);
  const totalDispensedPm = dispensingPm.reduce((sum, l) => sum + (Number(l.dispensed) || 0), 0);

  const shouldConsumeRmPmNow = totalDispensedRm <= 0 && totalDispensedPm <= 0;

  if (shouldConsumeRmPmNow) {
    // 1. Reduce RM (consumption from dispensing_rm)
    const newRmLines = [];
    let rmDispensingPersist = false;
    for (const line of dispensingRm) {
      const qty = Number(line.dispensed ?? line.required ?? 0) || 0;
      if (qty <= 0) {
        newRmLines.push(line);
        continue;
      }
      const code = (line.code || '').trim();
      if (!code) {
        newRmLines.push(line);
        continue;
      }
      const rm = await RawMaterial.findOne({ where: { code } });
      if (!rm) {
        newRmLines.push(line);
        continue;
      }
      const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
      if (!wh) {
        newRmLines.push(line);
        continue;
      }
      const plain = wh.get ? wh.get({ plain: true }) : wh;
      const whStock = Number(plain.wh_stock) || 0;
      const ml1 = Number(plain.ml1_stock) || 0;
      const ml2 = Number(plain.ml2_stock) || 0;

      // Consume from manufacturing tank stock (ML1+ML2) at fg_ready fallback.
      let newMl1 = ml1;
      let newMl2 = ml2;
      let remaining = qty;
      const fromMl1 = Math.min(newMl1, remaining);
      newMl1 = newMl1 - fromMl1;
      remaining = remaining - fromMl1;
      if (remaining > 0) {
        const fromMl2 = Math.min(newMl2, remaining);
        newMl2 = newMl2 - fromMl2;
      }

      const newStockInHand = whStock + newMl1 + newMl2;
      await wh.update({ ml1_stock: newMl1, ml2_stock: newMl2, stock_in_hand: newStockInHand });
      console.log('[production] BPR fg_ready: reduced RM id=%s qty=%s -> mu_stock=%s', rm.id, qty, newMl1 + newMl2);
      const prevD = Number(line.dispensed) || 0;
      if (prevD !== qty) rmDispensingPersist = true;
      newRmLines.push(prevD === qty ? line : { ...line, dispensed: qty });
    }

    // 2. Reduce PM (consumption from dispensing_pm)
    const newPmLines = [];
    let pmDispensingPersist = false;
    for (const line of dispensingPm) {
      const qty = Number(line.dispensed ?? line.required ?? 0) || 0;
      if (qty <= 0) {
        newPmLines.push(line);
        continue;
      }
      const code = (line.code || '').trim();
      if (!code) {
        newPmLines.push(line);
        continue;
      }
      const pm = await PackMaterial.findOne({ where: { code } });
      if (!pm) {
        newPmLines.push(line);
        continue;
      }
      const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
      if (!wh) {
        newPmLines.push(line);
        continue;
      }
      const plain = wh.get ? wh.get({ plain: true }) : wh;
      const whStock = Number(plain.wh_stock) || 0;
      const ml1 = Number(plain.ml1_stock) || 0;
      const ml2 = Number(plain.ml2_stock) || 0;

      // Consume from manufacturing tank stock (ML1+ML2) at fg_ready fallback.
      let newMl1 = ml1;
      let newMl2 = ml2;
      let remaining = qty;
      const fromMl1 = Math.min(newMl1, remaining);
      newMl1 = newMl1 - fromMl1;
      remaining = remaining - fromMl1;
      if (remaining > 0) {
        const fromMl2 = Math.min(newMl2, remaining);
        newMl2 = newMl2 - fromMl2;
      }

      const newStockInHand = whStock + newMl1 + newMl2;
      await wh.update({ ml1_stock: newMl1, ml2_stock: newMl2, stock_in_hand: newStockInHand });
      console.log('[production] BPR fg_ready: reduced PM id=%s qty=%s -> mu_stock=%s', pm.id, qty, newMl1 + newMl2);
      const prevD = Number(line.dispensed) || 0;
      if (prevD !== qty) pmDispensingPersist = true;
      newPmLines.push(prevD === qty ? line : { ...line, dispensed: qty });
    }

    // Persist dispensed baselines when we consumed using `required` (dispensed was 0). Otherwise a
    // later PATCH that only fills dispensing UI would run consumeDelta and double-reduce inventory.
    if (rmDispensingPersist || pmDispensingPersist) {
      batchRow.set('dispensing_rm', newRmLines);
      batchRow.set('dispensing_pm', newPmLines);
      await batchRow.save({ fields: ['dispensing_rm', 'dispensing_pm'] });
    }
  } else if (DISPENSING_DEBUG) {
    console.log('[production] BPR fg_ready: skipping RM/PM reduction (dispensed already recorded)', {
      totalDispensedRm,
      totalDispensedPm,
      bmr_no: d.bmr_no,
      bpr_no: d.bpr_no,
    });
  }

  // 3. Add FG (product) to warehouse_inventory
  let product = null;
  if (d.sku) product = await Product.findOne({ where: { zoho_sku_code: d.sku } });
  if (!product && d.product_name) product = await Product.findOne({ where: { product_name: d.product_name } });
  if (!product) {
    console.warn('[production] BPR fg_ready: no product found for sku=%s product_name=%s', d.sku, d.product_name);
  } else {
    const productId = product.get ? product.get({ plain: true }).product_id : product.product_id;
    // FG ready quantity must reflect yield report first; planned batch/order qty is only a fallback.
    const fgYieldQty = Number(d.fg_yield);
    const fillYieldQty = Number(d.fill_yield);
    const plannedQty = Number(d.batch_size || d.order_qty || 0);
    const producedQtyRaw = Number.isFinite(fgYieldQty) && fgYieldQty > 0
      ? fgYieldQty
      : (Number.isFinite(fillYieldQty) && fillYieldQty > 0 ? fillYieldQty : plannedQty);
    const producedQty = Math.max(0, Math.round(producedQtyRaw) || 0);
    if (producedQty > 0) {
      let whRow = await WarehouseInventory.findOne({ where: { item_type: 'PR', product_id: productId } });
      if (whRow) {
        const wh = whRow.get ? whRow.get({ plain: true }) : whRow;
        const whStock = (Number(wh.wh_stock) || 0) + producedQty;
        const ml1 = Number(wh.ml1_stock) || 0;
        const ml2 = Number(wh.ml2_stock) || 0;
        await whRow.update({ wh_stock: whStock, stock_in_hand: whStock + ml1 + ml2 });
        console.log('[production] BPR fg_ready: added FG product_id=%d qty=%s -> wh_stock=%s', productId, producedQty, whStock);
      } else {
        await WarehouseInventory.create({
          item_type: 'PR',
          raw_material_id: null,
          pack_material_id: null,
          product_id: productId,
          wh_stock: producedQty,
          wh_unit: 'PCS',
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: producedQty,
          reserved: 0,
          in_transit: 0,
          reorder_pt: 0,
          avg_mo: 0,
          qc_status: 'In Stock',
        });
        console.log('[production] BPR fg_ready: created PR warehouse_inventory product_id=%d wh_stock=%s', productId, producedQty);
      }

      await syncFulfillmentFgQtyFromBatch(batchRow);
    }
  }
}

const DISPENSING_DEBUG = process.env.DISPENSING_DEBUG === '1';
const DISPENSING_TRACE = process.env.DISPENSING_TRACE === '1';
/** Filter server logs with this string to trace BMR dispensing → MU / warehouse_inventory. */
const DISPENDING_MU_ERR_TAG = '[dispending-mu-error]';

/**
 * When BMR status transitions to rm_reserved: create reserved_batch_items for RM from BOM,
 * sync warehouse_inventory.reserved, and log reserved change in history with batch id.
 * Idempotent: removes any existing RM reservations for this batch first so repeat runs don't double-count.
 * Inventory: available = SIH - reserved; after reserve X, reserved_new = R + X, available_new = SIH - reserved_new.
 */
/** Sum reserved_batch_items for the same material held by other production batches (exclusive pool). */
async function sumReservedQtyOtherBatches(productionBatchId, kind, materialId) {
  const bid = Number(productionBatchId);
  const mid = Number(materialId);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(mid) || mid <= 0) return 0;
  const where = {
    production_batch_id: { [Op.ne]: bid },
    ...(kind === 'rm'
      ? { raw_material_id: mid, pack_material_id: null }
      : { pack_material_id: mid, raw_material_id: null }),
  };
  const sum = await ReservedBatchItem.sum('quantity_reserved', { where });
  return sum != null ? Number(sum) : 0;
}

function warehouseSihFromPlain(plainWh) {
  if (!plainWh) return 0;
  const direct = Number(plainWh.stock_in_hand);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return (
    (Number(plainWh.wh_stock) || 0)
    + (Number(plainWh.ml1_stock) || 0)
    + (Number(plainWh.ml2_stock) || 0)
  );
}

/**
 * Block reserve when other batches already hold RBI — free stock = SIH − other batches' reserved.
 * This batch's own prior RBI rows are rebuilt on force/idempotent paths before this runs.
 */
async function assertExclusiveBatchReserveAvailability(batchId, rmQuantities, pmQuantities) {
  const shortages = [];

  for (const [rmId, { quantity, code, unit }] of rmQuantities) {
    const need = Number(quantity) || 0;
    if (need <= 0) continue;
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    const plain = wh?.get ? wh.get({ plain: true }) : wh;
    const sih = warehouseSihFromPlain(plain);
    const otherReserved = await sumReservedQtyOtherBatches(batchId, 'rm', rmId);
    const free = Math.max(0, sih - otherReserved);
    if (need > free + 1e-6) {
      shortages.push({
        type: 'RM',
        code: code || `RM#${rmId}`,
        unit: unit || 'KG',
        need,
        free,
        otherBatchesReserved: otherReserved,
        sih,
      });
    }
  }

  for (const [pmId, { quantity, code, unit }] of pmQuantities) {
    const need = Number(quantity) || 0;
    if (need <= 0) continue;
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    const plain = wh?.get ? wh.get({ plain: true }) : wh;
    const sih = warehouseSihFromPlain(plain);
    const otherReserved = await sumReservedQtyOtherBatches(batchId, 'pm', pmId);
    const free = Math.max(0, sih - otherReserved);
    if (need > free + 1e-6) {
      shortages.push({
        type: 'PM',
        code: code || `PM#${pmId}`,
        unit: unit || 'PCS',
        need,
        free,
        otherBatchesReserved: otherReserved,
        sih,
      });
    }
  }

  if (shortages.length === 0) return;

  const summary = shortages
    .slice(0, 4)
    .map(
      (s) =>
        `${s.code} (need ${s.need} ${s.unit}, free ${s.free} ${s.unit} after ${s.otherBatchesReserved} ${s.unit} reserved by other batches)`,
    )
    .join('; ');
  const more = shortages.length > 4 ? ` (+${shortages.length - 4} more)` : '';
  const err = new Error(
    `Cannot reserve — stock is already allocated to other production batches. ${summary}${more}`,
  );
  err.statusCode = 409;
  err.reserveShortages = shortages;
  throw err;
}

/** Completed outbound MTR (WH→MU) qty for this BMR — caps batch-exclusive dispensing at MU. */
async function sumCompletedOutboundMtrQtyForBatch(bmrNo, kind, materialId) {
  const bmr = String(bmrNo || '').trim();
  const mid = Number(materialId);
  if (!bmr || !Number.isFinite(mid) || mid <= 0) return 0;
  const rows = await MaterialRequestNote.findAll({
    where: {
      bmr_no: bmr,
      source: 'MTR',
      is_inbound_from_mu: { [Op.not]: true },
      status: 'Completed',
    },
    attributes: ['line_items'],
  });
  let total = 0;
  for (const row of rows) {
    const plain = row.get ? row.get({ plain: true }) : row;
    const lines = Array.isArray(plain.line_items) ? plain.line_items : [];
    for (const li of lines) {
      const qty = Number(li.quantity) || 0;
      if (qty <= 0) continue;
      if (kind === 'RM' && Number(li.raw_material_id) === mid) total += qty;
      if (kind === 'PM' && Number(li.pack_material_id) === mid) total += qty;
    }
  }
  return total;
}

function formatBatchExclusiveDispenseShortageMessage(type, code, nextDispensed, muTransferred, unit) {
  return (
    `Dispensing blocked — ${type} ${code} exceeds qty transferred to MU for this batch `
    + `(dispensed ${nextDispensed} ${unit}, MTR to MU ${muTransferred} ${unit}). `
    + 'Other batches cannot use this batch\'s reserved allocation.'
  );
}

/** Re-sync warehouse_inventory.reserved when RBI rows already exist (idempotent reserve re-run). */
async function syncWarehouseReservedForExistingBatchRbi(batchId, kind) {
  const where =
    kind === 'rm'
      ? { production_batch_id: batchId, pack_material_id: null, raw_material_id: { [Op.ne]: null } }
      : { production_batch_id: batchId, raw_material_id: null, pack_material_id: { [Op.ne]: null } };
  const rows = await ReservedBatchItem.findAll({
    where,
    attributes: ['raw_material_id', 'pack_material_id'],
  });
  const rmIds = [...new Set(rows.map((r) => Number(r.raw_material_id)).filter((id) => Number.isFinite(id) && id > 0))];
  const pmIds = [...new Set(rows.map((r) => Number(r.pack_material_id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (rmIds.length || pmIds.length) {
    await syncWarehouseReserved(rmIds, pmIds);
  }
}

async function applyRmReservedToInventory(batchRow, options = {}) {
  const { force = false } = options;
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;
  const existingRmCount = await countRmReservedBatchItems(d.id);
  if (existingRmCount > 0 && !force) {
    await syncWarehouseReservedForExistingBatchRbi(d.id, 'rm');
    return;
  }
  if (existingRmCount > 0) {
    await ReservedBatchItem.destroy({
      where: { production_batch_id: d.id, pack_material_id: null },
    });
  }

  const { rmLines: bomRmLines, source: bomSource, batchSizeKg: planningBatchSizeKg } = await getBomLinesForBatch(d);
  if (!Array.isArray(bomRmLines) || bomRmLines.length === 0) {
    console.warn('[production] rm_reserved: no BOM rm_lines for batch', d.bmr_no);
    return;
  }
  const batchSizeKg = (bomSource === 'planning_batch' && planningBatchSizeKg != null && planningBatchSizeKg > 0)
    ? planningBatchSizeKg
    : (Number(d.batch_size) || Number(d.order_qty) || 0);
  if (batchSizeKg <= 0) return;

  // Aggregate by raw_material_id so same RM in multiple BOM lines is one reserved row (SIH - reserved = available)
  const rmQuantities = new Map(); // rmId -> { quantity, unit, code }
  for (const line of bomRmLines) {
    const code = line.rm_code || line.rmCode || line.code;
    if (!code) continue;
    const rm = await RawMaterial.findOne({ where: { code } });
    if (!rm) continue;
    const rmId = rm.id;
    const pct = Number(line.pct_w_w ?? line.pct ?? 0);
    const quantity = (batchSizeKg * pct) / 100;
    if (quantity <= 0) continue;
    const unit = line.uom || 'KG';
    const existing = rmQuantities.get(rmId);
    if (existing) {
      existing.quantity = roundPlanningMaterialQty(existing.quantity + quantity);
    } else {
      rmQuantities.set(rmId, { quantity: roundPlanningMaterialQty(quantity), unit, code });
    }
  }
  const affectedRmIds = new Set(rmQuantities.keys());
  if (affectedRmIds.size === 0) return;
  await assertExclusiveBatchReserveAvailability(d.id, rmQuantities, new Map());
  for (const [rmId, { quantity, unit }] of rmQuantities) {
    await ReservedBatchItem.create({
      production_batch_id: d.id,
      raw_material_id: rmId,
      pack_material_id: null,
      quantity_reserved: roundPlanningMaterialQty(quantity),
      unit,
    });
  }
  await syncWarehouseReserved([...affectedRmIds], []);
  try {
    const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[production] syncWarehouseInTransitAll after RM reserve failed:', e && e.message ? e.message : e);
  }

  const bmrNo = d.bmr_no || '';
  for (const rid of affectedRmIds) {
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rid } });
    if (!wh) continue;
    const whPlain = wh.get ? wh.get({ plain: true }) : wh;
    const sih = Number(whPlain.stock_in_hand ?? whPlain.wh_stock + (whPlain.ml1_stock || 0) + (whPlain.ml2_stock || 0)) || 0;
    const reservedAfter = Number(whPlain.reserved) || 0;
    const sum = await ReservedBatchItem.sum('quantity_reserved', {
      where: { production_batch_id: d.id, raw_material_id: rid },
    });
    const reservedDelta = sum != null ? Number(sum) : 0;
    await logReservedChange({
      warehouseInventoryId: whPlain.id,
      itemType: 'RM',
      rawMaterialId: rid,
      packMaterialId: null,
      productId: null,
      reservedDelta,
      reservedAfter,
      productionBatchId: d.id,
      batchNo: bmrNo,
      actionType: 'BMR_RESERVED',
    });
  }
}

function batchMarkedPmReserved(plain) {
  return !!plain.pm_reserved || plain.bpr_status === 'pm_reserved';
}

async function countPmReservedBatchItems(batchId) {
  return ReservedBatchItem.count({
    where: { production_batch_id: batchId, raw_material_id: null },
  });
}

/** PM shows reserved in UI but RBI rows missing — safe to rebuild only before PM connect/MTR consumed reserve. */
async function needsPmReserveRepair(batchId, plain) {
  if (!batchMarkedPmReserved(plain)) return false;
  if (plain.pm_connected) return false;
  const n = await countPmReservedBatchItems(batchId);
  return n === 0;
}

function batchMarkedRmReserved(plain) {
  return !!plain.rm_reserved || plain.bmr_status === 'rm_reserved';
}

async function countRmReservedBatchItems(batchId) {
  return ReservedBatchItem.count({
    where: { production_batch_id: batchId, pack_material_id: null },
  });
}

async function needsRmReserveRepair(batchId, plain) {
  if (!batchMarkedRmReserved(plain)) return false;
  if (plain.rm_connected) return false;
  const n = await countRmReservedBatchItems(batchId);
  return n === 0;
}

/**
 * When BPR status transitions to pm_reserved: create reserved_batch_items for PM from BOM,
 * sync warehouse_inventory.reserved, and log reserved change in history with batch id.
 * Idempotent: skips when PM RBI rows already exist unless options.force (repair missing reserve).
 * Inventory: available = SIH - reserved; after reserve X, reserved_new = R + X, available_new = SIH - reserved_new.
 */
async function applyPmReservedToInventory(batchRow, options = {}) {
  const { force = false } = options;
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;
  const existingPmCount = await countPmReservedBatchItems(d.id);
  if (existingPmCount > 0 && !force) {
    await syncWarehouseReservedForExistingBatchRbi(d.id, 'pm');
    return;
  }
  if (existingPmCount > 0) {
    await ReservedBatchItem.destroy({
      where: { production_batch_id: d.id, raw_material_id: null },
    });
  }

  const { pmLines: bomPmLines, source: bomSource, batchSizeKg: planningBatchSizeKg } = await getBomLinesForBatch(d);
  if (!Array.isArray(bomPmLines) || bomPmLines.length === 0) {
    console.warn('[production] pm_reserved: no BOM pm_lines for batch', d.bpr_no, d.bmr_no);
    return;
  }
  // When using planning batch BOM, use its size_kg for units; else match frontend formula
  const totalBatches = Number(d.total_batches) || 0;
  const orderQty = Number(d.order_qty) || 0;
  const batchSizeUnits = (bomSource === 'planning_batch' && planningBatchSizeKg != null && planningBatchSizeKg > 0)
    ? Math.round(planningBatchSizeKg)
    : (totalBatches > 0 ? Math.ceil(orderQty / totalBatches) : (Number(d.batch_size) || orderQty || 1));

  // Aggregate by pack_material_id so same PM in multiple BOM lines is one reserved row (SIH - reserved = available)
  const pmQuantities = new Map(); // pmId -> { quantity, unit, code }
  const missingPmCodes = [];
  for (const line of bomPmLines) {
    const code = String(line.pm_code || line.pmCode || line.code || '').trim();
    if (!code) continue;
    const pm = await PackMaterial.findOne({ where: { code } });
    if (!pm) {
      missingPmCodes.push(code);
      continue;
    }
    const pmId = pm.id;
    const qtyPerUnit = line.qty_per_unit != null ? Number(line.qty_per_unit) : (line.quantity != null ? Number(line.quantity) : 1);
    const quantity = qtyPerUnit * batchSizeUnits;
    if (quantity <= 0) continue;
    const unit = line.uom || 'PCS';
    const existing = pmQuantities.get(pmId);
    if (existing) {
      existing.quantity = roundPlanningMaterialQty(existing.quantity + quantity);
    } else {
      pmQuantities.set(pmId, { quantity: roundPlanningMaterialQty(quantity), unit, code });
    }
  }
  const affectedPmIds = new Set(pmQuantities.keys());
  if (affectedPmIds.size === 0) {
    if (missingPmCodes.length > 0) {
      console.warn('[production] pm_reserved: no pack_materials rows for BOM codes', {
        bpr_no: d.bpr_no,
        bmr_no: d.bmr_no,
        missingPmCodes,
      });
    }
    return;
  }
  if (missingPmCodes.length > 0) {
    console.warn('[production] pm_reserved: skipped BOM lines (pack_materials not found)', {
      bpr_no: d.bpr_no,
      missingPmCodes,
    });
  }
  await assertExclusiveBatchReserveAvailability(d.id, new Map(), pmQuantities);
  for (const [pmId, { quantity, unit }] of pmQuantities) {
    await ReservedBatchItem.create({
      production_batch_id: d.id,
      raw_material_id: null,
      pack_material_id: pmId,
      quantity_reserved: roundPlanningMaterialQty(quantity),
      unit,
    });
  }
  await syncWarehouseReserved([], [...affectedPmIds]);
  try {
    const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[production] syncWarehouseInTransitAll after PM reserve failed:', e && e.message ? e.message : e);
  }

  const bprNo = d.bpr_no || '';
  for (const pid of affectedPmIds) {
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pid } });
    if (!wh) continue;
    const whPlain = wh.get ? wh.get({ plain: true }) : wh;
    const sih = Number(whPlain.stock_in_hand ?? whPlain.wh_stock + (whPlain.ml1_stock || 0) + (whPlain.ml2_stock || 0)) || 0;
    const reservedAfter = Number(whPlain.reserved) || 0;
    const sum = await ReservedBatchItem.sum('quantity_reserved', {
      where: { production_batch_id: d.id, pack_material_id: pid },
    });
    const reservedDelta = sum != null ? Number(sum) : 0;
    await logReservedChange({
      warehouseInventoryId: whPlain.id,
      itemType: 'PM',
      rawMaterialId: null,
      packMaterialId: pid,
      productId: null,
      reservedDelta,
      reservedAfter,
      productionBatchId: d.id,
      batchNo: bprNo,
      actionType: 'BPR_RESERVED',
    });
  }
}

const MTR_CANCELLED_STATUSES = new Set(['cancelled', 'rejected', 'canceled']);

async function hasOutboundMtrForBatch(bmrNo, kind) {
  const bmr = String(bmrNo || '').trim();
  if (!bmr) return false;
  const rows = await MaterialRequestNote.findAll({
    where: {
      bmr_no: bmr,
      source: 'MTR',
      [Op.or]: [{ is_inbound_from_mu: false }, { is_inbound_from_mu: null }],
    },
    attributes: ['status', 'line_items'],
  });
  for (const row of rows) {
    const plain = row.get ? row.get({ plain: true }) : row;
    const status = String(plain.status || '').trim().toLowerCase();
    if (MTR_CANCELLED_STATUSES.has(status)) continue;
    const lines = Array.isArray(plain.line_items) ? plain.line_items : [];
    for (const li of lines) {
      if (kind === 'rm' && li.raw_material_id != null) return true;
      if (kind === 'pm' && li.pack_material_id != null) return true;
    }
  }
  return false;
}

function dispensingHasPositiveQty(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.some((l) => (Number(l?.dispensed) || 0) > 1e-9);
}

async function assertCanReleaseBatchReserve(batchPlain, kind) {
  const label = kind === 'rm' ? 'RM' : 'PM';
  const bmrNo = String(batchPlain.bmr_no || '').trim();
  if (kind === 'rm' && batchPlain.rm_connected) {
    const err = new Error(`Cannot remove ${label} reservation — material is already connected or transferred for this batch.`);
    err.statusCode = 409;
    throw err;
  }
  if (kind === 'pm' && batchPlain.pm_connected) {
    const err = new Error(`Cannot remove ${label} reservation — packaging is already connected or transferred for this batch.`);
    err.statusCode = 409;
    throw err;
  }
  const dispensing = kind === 'rm' ? batchPlain.dispensing_rm : batchPlain.dispensing_pm;
  if (dispensingHasPositiveQty(dispensing)) {
    const err = new Error(`Cannot remove ${label} reservation — dispensing has already been recorded for this batch.`);
    err.statusCode = 409;
    throw err;
  }
  if (await hasOutboundMtrForBatch(bmrNo, kind)) {
    const err = new Error(
      `Cannot remove ${label} reservation — an outbound MTR exists for ${bmrNo}. Cancel or complete the transfer first.`,
    );
    err.statusCode = 409;
    throw err;
  }
}

async function releaseBatchReservedFromInventory(batchRow, kind) {
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;
  await assertCanReleaseBatchReserve(d, kind);
  const where =
    kind === 'rm'
      ? { production_batch_id: d.id, pack_material_id: null, raw_material_id: { [Op.ne]: null } }
      : { production_batch_id: d.id, raw_material_id: null, pack_material_id: { [Op.ne]: null } };
  const rows = await ReservedBatchItem.findAll({ where });
  if (rows.length === 0) return;

  const affectedRmIds = new Set();
  const affectedPmIds = new Set();
  const batchNo = kind === 'rm' ? (d.bmr_no || '') : (d.bpr_no || d.bmr_no || '');
  const actionType = kind === 'rm' ? 'BMR_UNRESERVED' : 'BPR_UNRESERVED';
  const itemType = kind === 'rm' ? 'RM' : 'PM';

  for (const rbi of rows) {
    const plain = rbi.get ? rbi.get({ plain: true }) : rbi;
    const qty = Number(plain.quantity_reserved) || 0;
    const rmId = plain.raw_material_id != null ? Number(plain.raw_material_id) : null;
    const pmId = plain.pack_material_id != null ? Number(plain.pack_material_id) : null;
    const materialId = kind === 'rm' ? rmId : pmId;
    if (!materialId || qty <= 0) {
      await rbi.destroy();
      continue;
    }
    if (kind === 'rm') affectedRmIds.add(materialId);
    else affectedPmIds.add(materialId);

    const wh = await WarehouseInventory.findOne({
      where: kind === 'rm'
        ? { item_type: 'RM', raw_material_id: materialId }
        : { item_type: 'PM', pack_material_id: materialId },
    });
    if (wh) {
      const whPlain = wh.get ? wh.get({ plain: true }) : wh;
      const reservedBefore = Number(whPlain.reserved) || 0;
      const reservedAfter = Math.max(0, reservedBefore - qty);
      await logReservedChange({
        warehouseInventoryId: whPlain.id,
        itemType,
        rawMaterialId: kind === 'rm' ? materialId : null,
        packMaterialId: kind === 'pm' ? materialId : null,
        productId: null,
        reservedDelta: -qty,
        reservedAfter,
        productionBatchId: d.id,
        batchNo,
        actionType,
      });
    }
    await rbi.destroy();
  }

  if (affectedRmIds.size > 0 || affectedPmIds.size > 0) {
    await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
  }
}

async function releaseRmReservedFromInventory(batchRow) {
  return releaseBatchReservedFromInventory(batchRow, 'rm');
}

async function releasePmReservedFromInventory(batchRow) {
  return releaseBatchReservedFromInventory(batchRow, 'pm');
}

/** Master codes seeded as EI-… on dispensing line text (e.g. inci "Niacinamide (EI-RM-ACT-002)"). */
function extractEiCodeFromDispensingText(text) {
  if (!text) return '';
  const m = String(text).match(/EI-[A-Z0-9-]+/i);
  return m && m[0] ? m[0] : '';
}

function pickDispensingLine(nextArr, prevArr, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const fromNext = (nextArr || []).find((l) => dispensingLineCode(l) === c);
  if (fromNext) return fromNext;
  return (prevArr || []).find((l) => dispensingLineCode(l) === c) || null;
}

function dispensingLineCode(line) {
  return String(
    line?.code ?? line?.pm_code ?? line?.pmCode ?? line?.rm_code ?? line?.rmCode ?? ''
  ).trim();
}

function sumDispensedByCodeForDispensing(arr) {
  const m = new Map();
  for (const line of arr || []) {
    const code = dispensingLineCode(line);
    if (!code) continue;
    const dispensed = Number(line.dispensed ?? 0) || 0;
    m.set(code, (m.get(code) || 0) + dispensed);
  }
  return m;
}

/**
 * Dispensing may only consume from the batch scheduled manufacturing zone (scheduled_mu_zone).
 * Returns shortage rows for positive deltas that exceed on-hand qty at that MU.
 */
async function collectDispensingMuZoneShortages(type, prevArr, nextArr, scheduledMuZone) {
  const muZone = String(scheduledMuZone || '').trim();
  if (!muZone) {
    return [{ reason: 'no_scheduled_mu', type, code: '', delta: 0, atMu: 0, shortage: 0 }];
  }

  const prevMap = sumDispensedByCodeForDispensing(prevArr);
  const nextMap = sumDispensedByCodeForDispensing(nextArr);
  const codes = new Set([...prevMap.keys(), ...nextMap.keys()]);
  const shortages = [];
  const muLabel = muBucketLabelForZone(muZone);

  for (const code of codes) {
    let delta = (nextMap.get(code) || 0) - (prevMap.get(code) || 0);
    if (!Number.isFinite(delta) || delta <= 1e-9) continue;

    const sampleLine = pickDispensingLine(nextArr, prevArr, code);
    const rmOrPmRow = type === 'RM'
      ? await resolveRawMaterialForDispensingLine(sampleLine || { code })
      : await resolvePackMaterialForDispensingLine(sampleLine || { code });
    if (!rmOrPmRow) {
      shortages.push({
        type,
        code,
        delta,
        atMu: 0,
        shortage: delta,
        muZone,
        muLabel,
        reason: 'master_not_found',
      });
      continue;
    }

    const wh = await WarehouseInventory.findOne({
      where: type === 'RM'
        ? { item_type: 'RM', raw_material_id: rmOrPmRow.id }
        : { item_type: 'PM', pack_material_id: rmOrPmRow.id },
    });
    if (!wh) {
      shortages.push({
        type,
        code,
        delta,
        atMu: 0,
        shortage: delta,
        muZone,
        muLabel,
        reason: 'no_inventory_row',
      });
      continue;
    }

    const plainWh = wh.get ? wh.get({ plain: true }) : wh;
    let atMu = 0;
    try {
      atMu = await getStockQtyAtMuZone(plainWh.id, muZone);
      if (type === 'PM' && delta > 0) {
        delta = capPmDispenseConsumption(delta, atMu);
      }
    } catch (e) {
      console.warn(DISPENSING_MU_ERR_TAG, 'collectDispensingMuZoneShortages: stock lookup failed', {
        type,
        code,
        muZone,
        err: e?.message || e,
      });
      shortages.push({
        type,
        code,
        delta,
        atMu: 0,
        shortage: delta,
        muZone,
        muLabel,
        reason: 'inventory_lookup_failed',
      });
      continue;
    }

    if (!materialQtyLteForDispensing(delta, atMu, type)) {
      const deltaN = materialQtyToNum(delta);
      const atMuN = materialQtyToNum(atMu);
      shortages.push({
        type,
        code,
        masterCode: rmOrPmRow.code || code,
        delta: deltaN,
        atMu: atMuN,
        shortage: Math.max(0, deltaN - atMuN),
        muZone,
        muLabel,
        whStock: toNum(plainWh.wh_stock),
        ml1Stock: toNum(plainWh.ml1_stock),
        ml2Stock: toNum(plainWh.ml2_stock),
      });
    }
  }

  return shortages;
}

/** Lines marked done must have dispensed >= required. */
function collectDispensingRequiredShortages(arr) {
  const shortages = [];
  for (const line of arr || []) {
    if (!line?.done) continue;
    const required = line.required;
    if (!materialQtyGt(required, 0)) continue;
    const dispensed = line.dispensed;
    const isPcs = String(line.unit || '').toUpperCase() === 'PCS' || String(line.uom || '').toUpperCase() === 'PCS';
    const meets = isPcs
      ? materialQtyGteForDispensing(dispensed, required, 'pcs')
      : materialQtyGte(dispensed, required);
    if (!meets) {
      shortages.push({
        code: String(line.code || '').trim(),
        required: Number(required) || 0,
        dispensed: Number(dispensed) || 0,
        shortage: (Number(required) || 0) - (Number(dispensed) || 0),
      });
    }
  }
  return shortages;
}

function formatDispensingMuZoneShortageMessage(shortages, scheduledMuZone) {
  const muZone = String(scheduledMuZone || '').trim();
  const noMu = shortages.find((s) => s.reason === 'no_scheduled_mu');
  if (noMu) {
    return 'Dispensing blocked — schedule the batch and select a manufacturing site (MTR receive zone) before dispensing.';
  }
  const lines = shortages.slice(0, 8).map((s) => {
    const label = s.masterCode || s.code;
    const at = Number(s.atMu) || 0;
    const need = Number(s.delta) || 0;
    const zone = s.muZone || muZone;
    const bucket = s.muLabel || muBucketLabelForZone(zone);
    if (s.reason === 'master_not_found') {
      return `${label}: material master not found`;
    }
    if (s.reason === 'no_inventory_row') {
      return `${label}: no warehouse inventory row`;
    }
    return `${label}: need ${need} at ${zone} (${bucket}), only ${at} available — complete MTR to this site first`;
  });
  const more = shortages.length > 8 ? ` (+${shortages.length - 8} more)` : '';
  return `Dispensing blocked — stock must be at the batch manufacturing site.${lines.length ? ` ${lines.join('; ')}` : ''}${more}`;
}

function formatDispensingRequiredShortageMessage(shortages) {
  const lines = shortages.slice(0, 8).map((s) => {
    const code = s.code || 'item';
    return `${code}: dispensed ${s.dispensed} < required ${s.required}`;
  });
  const more = shortages.length > 8 ? ` (+${shortages.length - 8} more)` : '';
  return `Dispensing blocked — each completed line must meet the required quantity.${lines.length ? ` ${lines.join('; ')}` : ''}${more}`;
}

async function resolveRawMaterialForDispensingLine(line) {
  if (!line) return null;
  const rid = line.raw_material_id != null ? Number(line.raw_material_id) : null;
  if (rid != null && !Number.isNaN(rid)) {
    const rm = await RawMaterial.findByPk(rid);
    if (rm) return rm;
  }
  const code = String(line.code || '').trim();
  if (code) {
    const byCode = await RawMaterial.findOne({ where: { code } });
    if (byCode) return byCode;
  }
  const ei = extractEiCodeFromDispensingText(line.inci || line.name || line.item || '');
  if (ei) {
    const byEi = await RawMaterial.findOne({ where: { code: ei } });
    if (byEi) return byEi;
  }
  const nameBase = String(line.inci || line.name || '').split('(')[0].trim();
  if (nameBase) {
    const byName = await RawMaterial.findOne({ where: { name: nameBase } });
    if (byName) return byName;
    const byLike = await RawMaterial.findOne({
      where: { name: { [Op.iLike]: `%${nameBase}%` } },
    });
    if (byLike) return byLike;
  }
  return null;
}

async function resolvePackMaterialForDispensingLine(line) {
  if (!line) return null;
  const pid = line.pack_material_id != null ? Number(line.pack_material_id) : null;
  if (pid != null && !Number.isNaN(pid)) {
    const pm = await PackMaterial.findByPk(pid);
    if (pm) return pm;
  }
  const code = dispensingLineCode(line);
  if (code) {
    const byCode = await PackMaterial.findOne({ where: { code } });
    if (byCode) return byCode;
  }
  const ei = extractEiCodeFromDispensingText(line.name || line.description || line.item || '');
  if (ei) {
    const byEi = await PackMaterial.findOne({ where: { code: ei } });
    if (byEi) return byEi;
  }
  const nameBase = String(line.name || line.description || '').split('(')[0].trim();
  if (nameBase) {
    const byDesc = await PackMaterial.findOne({ where: { description: nameBase } });
    if (byDesc) return byDesc;
    const byLike = await PackMaterial.findOne({
      where: { description: { [Op.iLike]: `%${nameBase}%` } },
    });
    if (byLike) return byLike;
  }
  return null;
}

/**
 * When dispensed qty increases, reduce this batch's reserved_batch_items so SIH − reserved matches reality.
 * When dispensed qty decreases (correction), add back reserve up to prior level.
 * warehouse_inventory.reserved is recomputed via syncWarehouseReserved from sums of these rows.
 */
async function adjustProductionReservedAfterDispenseDelta({
  productionBatchId,
  type,
  materialId,
  dispenseDelta,
}) {
  if (!productionBatchId || !materialId || !Number.isFinite(dispenseDelta) || Math.abs(dispenseDelta) <= 1e-9) {
    return;
  }
  const where =
    type === 'RM'
      ? { production_batch_id: productionBatchId, raw_material_id: materialId, pack_material_id: null }
      : { production_batch_id: productionBatchId, pack_material_id: materialId, raw_material_id: null };
  const rbi = await ReservedBatchItem.findOne({ where });
  if (!rbi) return;
  const cur = Number(rbi.quantity_reserved) || 0;
  let next;
  if (dispenseDelta > 0) {
    next = Math.max(0, cur - dispenseDelta);
  } else {
    next = cur + Math.abs(dispenseDelta);
  }
  if (Math.abs(next - cur) < 1e-9) return;
  await rbi.update({ quantity_reserved: next });
  await syncWarehouseReserved(type === 'RM' ? [materialId] : [], type === 'PM' ? [materialId] : []);
}

/**
 * Apply dispensing delta from the batch scheduled manufacturing zone only (ML1 or ML2 bucket).
 * WH stock and the other MU cannot be used without MTR to the batch site first.
 * qty_delta in history: negative when material leaves inventory (dispense), positive when restored.
 * @returns {boolean} true if warehouse row was updated and history logged
 */
async function applyDispensingDeltaToWarehouseInventory({
  type,
  code,
  delta,
  sampleLine,
  batchPlain,
  dispensingBundleId,
}) {
  if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-9) {
    console.log(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: skip zero/invalid delta', { type, code, delta, batchId: batchPlain?.id, bmr_no: batchPlain?.bmr_no });
    return false;
  }

  console.log(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: start', {
    type,
    code,
    delta,
    batchId: batchPlain?.id,
    bmr_no: batchPlain?.bmr_no,
    sampleLine: sampleLine ? { code: sampleLine.code, dispensed: sampleLine.dispensed, raw_material_id: sampleLine.raw_material_id } : null,
  });

  const rmOrPmRow = type === 'RM'
    ? await resolveRawMaterialForDispensingLine(sampleLine || { code })
    : await resolvePackMaterialForDispensingLine(sampleLine || { code });
  if (!rmOrPmRow) {
    console.warn(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: cannot resolve RM/PM master', { type, code, sampleLine });
    if (DISPENSING_TRACE || DISPENSING_DEBUG) {
      console.warn('[production][DISPENSING_TRACE] could not resolve master for line', { type, code, sampleLine });
    }
    return false;
  }

  const wh = await WarehouseInventory.findOne({
    where: type === 'RM'
      ? { item_type: 'RM', raw_material_id: rmOrPmRow.id }
      : { item_type: 'PM', pack_material_id: rmOrPmRow.id },
  });
  if (!wh) {
    console.warn(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: no warehouse_inventory row for master', {
      type,
      masterId: rmOrPmRow.id,
      masterCode: rmOrPmRow.code,
      code,
    });
    if (DISPENSING_TRACE || DISPENSING_DEBUG) {
      console.warn('[production][DISPENSING_TRACE] no warehouse_inventory row', { type, id: rmOrPmRow.id, code });
    }
    return false;
  }

  // Fresh read so MU (ML1/ML2) reflects the latest DB state after MTR/GRN/reserve, avoiding stale totals.
  try {
    await wh.reload();
  } catch (e) {
    console.warn(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: warehouse_inventory reload failed', e?.message || e);
    return false;
  }

  const plainWh = wh.get ? wh.get({ plain: true }) : wh;
  let whStock = Number(plainWh.wh_stock) || 0;
  let newMl1 = Number(plainWh.ml1_stock) || 0;
  let newMl2 = Number(plainWh.ml2_stock) || 0;
  const beforeSih = whStock + newMl1 + newMl2;

  console.log(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: stock before (after reload)', {
    whInventoryId: plainWh.id,
    type,
    code,
    masterCode: rmOrPmRow.code,
    delta,
    wh_stock: whStock,
    ml1_stock: newMl1,
    ml2_stock: newMl2,
    stock_in_hand: beforeSih,
  });

  if (DISPENSING_TRACE || DISPENSING_DEBUG) {
    console.log('[production][DISPENSING_TRACE] applying delta', {
      type,
      code,
      delta,
      batch: { bmr_no: batchPlain?.bmr_no, bpr_no: batchPlain?.bpr_no, id: batchPlain?.id },
      resolved: { masterId: rmOrPmRow.id, masterCode: rmOrPmRow.code },
      whInventoryId: plainWh.id,
      whBefore: { wh_stock: whStock, ml1_stock: newMl1, ml2_stock: newMl2, sih: beforeSih },
      sampleLine: sampleLine ? { ...sampleLine, dispensed: sampleLine.dispensed } : null,
    });
  }

  const muZone = String(batchPlain?.scheduled_mu_zone || '').trim();
  const muBucket = muZoneCodeToMlBucket(muZone);
  const muLabel = muBucketLabelForZone(muZone);

  let fromMl1Used = 0;
  let fromMl2Used = 0;
  if (delta > 0) {
    if (!muZone) {
      const err = new Error(formatDispensingMuZoneShortageMessage([{ reason: 'no_scheduled_mu' }], ''));
      err.statusCode = 400;
      throw err;
    }

    const nextDispensed = Number(sampleLine?.dispensed) || 0;
    const muTransferred = await sumCompletedOutboundMtrQtyForBatch(
      batchPlain?.bmr_no,
      type,
      rmOrPmRow.id,
    );
    const unitLabel = type === 'RM' ? 'KG' : 'PCS';
    if (muTransferred > 0 && nextDispensed > muTransferred + 1e-6) {
      const err = new Error(
        formatBatchExclusiveDispenseShortageMessage(
          type,
          rmOrPmRow.code || code,
          nextDispensed,
          muTransferred,
          unitLabel,
        ),
      );
      err.statusCode = 400;
      err.dispensingFacilityShortages = [{
        type,
        code: rmOrPmRow.code || code,
        delta,
        nextDispensed,
        muTransferred,
        muZone,
        reason: 'batch_exclusive_mtr_cap',
      }];
      throw err;
    }

    let atMuBefore = await getStockQtyAtMuZone(plainWh.id, muZone);
    if (type === 'PM' && delta > 0) {
      delta = capPmDispenseConsumption(delta, atMuBefore);
    }
    if (!materialQtyLteForDispensing(delta, atMuBefore, type)) {
      const err = new Error(
        formatDispensingMuZoneShortageMessage(
          [{
            type,
            code,
            masterCode: rmOrPmRow.code || code,
            delta,
            atMu: atMuBefore,
            shortage: Math.max(0, Number(delta) - Number(atMuBefore)),
            muZone,
            muLabel,
          }],
          muZone
        )
      );
      err.statusCode = 400;
      err.dispensingFacilityShortages = [{
        type,
        code,
        masterCode: rmOrPmRow.code || code,
        delta,
        atMu: atMuBefore,
        shortage: delta - atMuBefore,
        muZone,
        muLabel,
      }];
      throw err;
    }

    if (muBucket === 'ml2') {
      fromMl2Used = Math.min(newMl2, delta);
      newMl2 -= fromMl2Used;
      const ml2Remainder = materialQtyToNum(materialQtySub(delta, fromMl2Used));
      if (materialQtyGt(ml2Remainder, 0)) {
        const err = new Error(formatDispensingMuZoneShortageMessage([{
          type,
          code,
          masterCode: rmOrPmRow.code || code,
          delta,
          atMu: atMuBefore,
          shortage: ml2Remainder,
          muZone,
          muLabel,
        }], muZone));
        err.statusCode = 400;
        throw err;
      }
    } else {
      fromMl1Used = Math.min(newMl1, delta);
      newMl1 -= fromMl1Used;
      const ml1Remainder = materialQtyToNum(materialQtySub(delta, fromMl1Used));
      if (materialQtyGt(ml1Remainder, 0)) {
        const err = new Error(formatDispensingMuZoneShortageMessage([{
          type,
          code,
          masterCode: rmOrPmRow.code || code,
          delta,
          atMu: atMuBefore,
          shortage: ml1Remainder,
          muZone,
          muLabel,
        }], muZone));
        err.statusCode = 400;
        throw err;
      }
    }
  } else {
    const restore = Math.abs(delta);
    if (muBucket === 'ml2') newMl2 += restore;
    else newMl1 += restore;
  }

  const newStockInHand = whStock + newMl1 + newMl2;
  console.log(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: computed consumption → will UPDATE', {
    whInventoryId: plainWh.id,
    code,
    delta,
    tookFrom: { ml1: fromMl1Used, ml2: fromMl2Used },
    after: { wh_stock: whStock, ml1_stock: newMl1, ml2_stock: newMl2, stock_in_hand: newStockInHand },
  });

  await wh.update({
    wh_stock: whStock,
    ml1_stock: newMl1,
    ml2_stock: newMl2,
    stock_in_hand: newStockInHand,
  });

  // Reserved qty for this production batch (reserved_batch_items) must drop as material is dispensed
  // so warehouse_inventory.reserved stays aligned with stock actually still held for the batch.
  const prodBatchId = batchPlain?.id != null ? Number(batchPlain.id) : null;
  if (prodBatchId && !Number.isNaN(prodBatchId)) {
    await adjustProductionReservedAfterDispenseDelta({
      productionBatchId: prodBatchId,
      type,
      materialId: rmOrPmRow.id,
      dispenseDelta: delta,
    });
  }

  console.log(DISPENDING_MU_ERR_TAG, 'applyDispensingDelta: warehouse_inventory UPDATE committed', {
    whInventoryId: plainWh.id,
    code,
    delta,
    tookFrom: { ml1: fromMl1Used, ml2: fromMl2Used },
    sih_before: beforeSih,
    sih_after: newStockInHand,
  });

  await logLocationMovement({
    warehouseInventoryId: plainWh.id,
    itemType: type,
    rawMaterialId: type === 'RM' ? rmOrPmRow.id : null,
    packMaterialId: type === 'PM' ? rmOrPmRow.id : null,
    productId: null,
    fromZone: plainWh.zone || null,
    fromRack: plainWh.rack || null,
    toZone: plainWh.zone || null,
    toRack: plainWh.rack || null,
    qtyDelta: -delta,
    actionType: 'BMR_DISPENSING',
    productionBatchId: batchPlain?.id ?? null,
    batchNo: batchPlain?.bmr_no || null,
    dispensingBundleId: dispensingBundleId || null,
  });

  if (DISPENSING_TRACE || DISPENSING_DEBUG) {
    console.log('[production] DISPENSING applied', {
      batch_id: batchPlain?.id,
      bmr_no: batchPlain?.bmr_no,
      type,
      code,
      masterResolved: rmOrPmRow.code || rmOrPmRow.id,
      delta,
      wh_ml_after: { wh: whStock, ml1: newMl1, ml2: newMl2, sih: newStockInHand },
    });
  }
  return true;
}

function dispensingMapsHaveAnyDelta(prevMap, nextMap) {
  const keys = new Set([...prevMap.keys(), ...nextMap.keys()]);
  for (const k of keys) {
    const prevQty = prevMap.get(k) || 0;
    const nextQty = nextMap.get(k) || 0;
    if (Math.abs(nextQty - prevQty) > 1e-9) return true;
  }
  return false;
}

function makeMuDispensingBundleId(bmrNo) {
  const safe = String(bmrNo || 'BATCH').replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  return `MU-${safe}-${Date.now()}`;
}

async function resolvePlanningExtractedIdForBatch(batchPlain) {
  const pbid = batchPlain?.planning_batch_id != null ? Number(batchPlain.planning_batch_id) : null;
  if (pbid && !Number.isNaN(pbid)) {
    const pb = await PlanningBatch.findByPk(pbid, { attributes: ['planning_extracted_id'] });
    if (pb) {
      const p = pb.get ? pb.get({ plain: true }) : pb;
      return p.planning_extracted_id != null ? Number(p.planning_extracted_id) : null;
    }
  }
  return null;
}

async function persistMuDispensingBundleSnapshot(batchId, bundleId, consumed, planningExtractedId) {
  const prRows = planningExtractedId
    ? await ProcurementRequest.findAll({
      where: { planning_extracted_id: planningExtractedId },
      attributes: ['id', 'planning_batch_id', 'status'],
      order: [['id', 'ASC']],
    })
    : [];
  const procurementRequests = prRows.map((r) => {
    const p = r.get ? r.get({ plain: true }) : r;
    return { id: p.id, planningBatchId: p.planning_batch_id, status: p.status || null };
  });
  const rm = consumed.filter((c) => c.type === 'RM').map(({ code, qty }) => ({ code, qty: roundPlanningMaterialQty(qty) }));
  const pm = consumed.filter((c) => c.type === 'PM').map(({ code, qty }) => ({ code, qty: roundPlanningMaterialQty(qty) }));
  const entry = {
    bundleId,
    at: new Date().toISOString(),
    procurementRequests,
    rm,
    pm,
  };
  const fresh = await ProductionBatch.findByPk(batchId);
  if (!fresh) return;
  let prevBundles = fresh.get('mu_dispensing_bundles');
  if (typeof prevBundles === 'string') {
    try {
      prevBundles = JSON.parse(prevBundles);
    } catch {
      prevBundles = [];
    }
  }
  if (!Array.isArray(prevBundles)) prevBundles = [];
  const capped = [...prevBundles, entry].slice(-80);
  await fresh.update({
    mu_dispensing_bundles: capped,
    mu_dispensing_bundle_id: bundleId,
  });
}

/** Deep-clone JSON array columns — Sequelize plain objects often hold JSON by reference; row.set/save can mutate in place so "prev" dispensing would wrongly equal "next" and inventory deltas stay 0. */
function cloneJsonArray(val) {
  if (!Array.isArray(val) || val.length === 0) return [];
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return val.map((line) => (line && typeof line === 'object' ? { ...line } : line));
  }
}

/** True when leaving bulk / fill / pack QC with an outcome (pass path or qc_failed). */
function qcTransitionRequiresNonEmptyResults(prevPlain, nextPreview) {
  if (
    prevPlain.bmr_status === 'bulk_qc' &&
    (nextPreview.bmr_status === 'cleared' || nextPreview.bmr_status === 'qc_failed')
  ) {
    return true;
  }
  if (
    prevPlain.bpr_status === 'fill_qc' &&
    (nextPreview.bpr_status === 'packaging' || nextPreview.bpr_status === 'qc_failed')
  ) {
    return true;
  }
  if (
    prevPlain.bpr_status === 'pack_qc' &&
    (nextPreview.bpr_status === 'fg_ready' || nextPreview.bpr_status === 'qc_failed')
  ) {
    return true;
  }
  return false;
}

function qcSpecsEveryResultNonEmpty(qcSpecs) {
  const arr = Array.isArray(qcSpecs) ? qcSpecs : [];
  if (arr.length === 0) return true;
  return arr.every((row) => {
    const r = row && row.result != null ? String(row.result) : '';
    return r.trim().length > 0;
  });
}

/** qc_specs may be legacy array (BMR only) or { bmr, fill, pack } — validate the slice for the transition. */
function getQcSpecsArrayForScope(qcSpecs, scope) {
  if (!qcSpecs) return [];
  if (Array.isArray(qcSpecs)) {
    if (scope === 'bmr') return qcSpecs;
    return [];
  }
  if (typeof qcSpecs === 'object' && qcSpecs !== null) {
    const arr = qcSpecs[scope];
    return Array.isArray(arr) ? arr : [];
  }
  return [];
}

function qcTransitionSpecsValid(prevPlain, nextPreview) {
  if (
    prevPlain.bmr_status === 'bulk_qc' &&
    (nextPreview.bmr_status === 'cleared' || nextPreview.bmr_status === 'qc_failed')
  ) {
    return qcSpecsEveryResultNonEmpty(getQcSpecsArrayForScope(nextPreview.qc_specs, 'bmr'));
  }
  if (
    prevPlain.bpr_status === 'fill_qc' &&
    (nextPreview.bpr_status === 'packaging' || nextPreview.bpr_status === 'qc_failed')
  ) {
    return qcSpecsEveryResultNonEmpty(getQcSpecsArrayForScope(nextPreview.qc_specs, 'fill'));
  }
  if (
    prevPlain.bpr_status === 'pack_qc' &&
    (nextPreview.bpr_status === 'fg_ready' || nextPreview.bpr_status === 'qc_failed')
  ) {
    return qcSpecsEveryResultNonEmpty(getQcSpecsArrayForScope(nextPreview.qc_specs, 'pack'));
  }
  return true;
}

/** Scale numeric qty fields on planning_batches BOM JSON when batch size changes from Production. */
function scalePlanningJsonLines(lines, scale) {
  if (!Array.isArray(lines) || !(scale > 0) || Math.abs(scale - 1) < 1e-9) return lines;
  return lines.map((line) => {
    if (!line || typeof line !== 'object') return line;
    const copy = { ...line };
    for (const k of ['qty', 'qty_kg', 'required_kg', 'required', 'amount', 'qty_per_batch']) {
      if (typeof copy[k] === 'number' && Number.isFinite(copy[k])) {
        copy[k] = roundPlanningMaterialQty(copy[k] * scale);
      }
    }
    return copy;
  });
}

/**
 * Keep linked planning_batches row aligned with production batch_size (and scaled BOM copy lines).
 */
async function syncPlanningBatchFromProductionBatchSize(finalPlain) {
  const pbId = finalPlain.planning_batch_id != null ? Number(finalPlain.planning_batch_id) : null;
  if (!pbId || Number.isNaN(pbId)) return;
  const pb = await PlanningBatch.findByPk(pbId);
  if (!pb) return;
  const newSize = Number(finalPlain.batch_size);
  if (!Number.isFinite(newSize) || newSize <= 0) return;
  const plain = pb.get({ plain: true });
  const oldSize = Number(plain.size_kg) || newSize;
  const scale = oldSize > 0 ? newSize / oldSize : 1;
  const updates = { size_kg: newSize };
  if (Math.abs(scale - 1) > 1e-9) {
    if (Array.isArray(plain.rm_lines)) updates.rm_lines = scalePlanningJsonLines(plain.rm_lines, scale);
    if (Array.isArray(plain.pm_lines)) updates.pm_lines = scalePlanningJsonLines(plain.pm_lines, scale);
  }
  await pb.update(updates);
}

/** Monotonic BMR lifecycle rank (higher = further along). Used to reject stale-client downgrades. */
const BMR_STATUS_RANK = {
  draft: 0,
  batch_confirmed: 1,
  rm_reserved: 2,
  scheduled: 3,
  rm_connected: 4,
  dispensing: 5,
  in_production: 6,
  qc_failed: 6.5,
  bulk_qc: 7,
  cleared: 8,
};

const PACKAGING_GATE_MESSAGE = 'Packaging cannot start until BMR bulk QC is cleared';

function isBmrBulkCleared(plain) {
  return String(plain?.bmr_status || '').toLowerCase() === 'cleared';
}

/** Block PM reserve / BPR advances until BMR bulk QC is cleared. */
function assertPackagingRequiresBmrCleared(prevPlain, nextPlain) {
  if (isBmrBulkCleared(nextPlain)) return null;
  if (!prevPlain.pm_reserved && nextPlain.pm_reserved) return PACKAGING_GATE_MESSAGE;
  const prevBpr = String(prevPlain.bpr_status || 'draft').toLowerCase();
  const nextBpr = String(nextPlain.bpr_status || 'draft').toLowerCase();
  if (nextBpr !== prevBpr && nextBpr !== 'draft') return PACKAGING_GATE_MESSAGE;
  return null;
}

function bmrStatusRank(status) {
  if (status == null || status === '') return -1;
  const k = String(status).trim();
  return Object.prototype.hasOwnProperty.call(BMR_STATUS_RANK, k) ? BMR_STATUS_RANK[k] : -1;
}

/**
 * Schedule / reschedule PATCHes often resend bmr_status from a stale UI (e.g. "scheduled" while DB is
 * already "cleared"). Never persist an earlier lifecycle stage except QC fail / retry side paths.
 */
function reconcileBmrStatusPreventRewind(row, prevPlain) {
  const prev = prevPlain.bmr_status;
  const cur = row.get ? row.get('bmr_status') : row.bmr_status;
  if (cur === undefined || cur === null) return;
  const pr = bmrStatusRank(prev);
  const nr = bmrStatusRank(cur);
  if (pr < 0 || nr < 0) return;
  if (nr >= pr) return;
  const qcFailSidePath =
    (prev === 'bulk_qc' && cur === 'qc_failed') ||
    (prev === 'qc_failed' && (cur === 'bulk_qc' || cur === 'in_production'));
  if (qcFailSidePath) return;
  row.set('bmr_status', prev);
}

async function updateBatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProductionBatch.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Batch not found' });
    const prevPlain = row.get ? row.get({ plain: true }) : row;
    const prevDispensingRmSnapshot = cloneJsonArray(prevPlain?.dispensing_rm);
    const prevDispensingPmSnapshot = cloneJsonArray(prevPlain?.dispensing_pm);
    const prevBmrStatus = prevPlain.bmr_status;
    const prevBprStatus = prevPlain.bpr_status;
    const incomingHasDispensing =
      req.body?.dispensing_rm != null ||
      req.body?.dispensing_pm != null ||
      req.body?.dispensingRM != null ||
      req.body?.dispensingPM != null;
    if (incomingHasDispensing) {
      const bdrm = req.body.dispensingRM || req.body.dispensing_rm;
      const bdpm = req.body.dispensingPM || req.body.dispensing_pm;
      console.log(DISPENDING_MU_ERR_TAG, 'updateBatch: incoming PATCH (before save)', {
        batchPk: id,
        bmr_no: prevPlain.bmr_no,
        prev_bpr_status: prevBprStatus,
        prev_bmr_status: prevBmrStatus,
        bodyKeys: Object.keys(req.body || {}),
        dispensingRMLines: Array.isArray(bdrm) ? bdrm.map((l) => ({ code: l?.code, dispensed: l?.dispensed, required: l?.required })) : null,
        dispensingPMLines: Array.isArray(bdpm) ? bdpm.map((l) => ({ code: l?.code, dispensed: l?.dispensed, required: l?.required })) : null,
      });
    }
    applyBatchBody(row, req.body);
    await recomputeBatchVolume(row);
    reconcileBmrStatusPreventRewind(row, prevPlain);
    const nextPreview = row.get ? row.get({ plain: true }) : row;

    if (
      qcTransitionRequiresNonEmptyResults(prevPlain, nextPreview) &&
      !qcTransitionSpecsValid(prevPlain, nextPreview)
    ) {
      return res.status(400).json({
        error:
          'Every QC parameter must have a non-empty Result before submitting bulk, fill, or pack QC.',
      });
    }

    if (prevBmrStatus !== 'cleared' && nextPreview.bmr_status === 'cleared') {
      const by = Number(nextPreview.bulk_yield);
      if (!(Number.isFinite(by) && by > 0)) {
        return res.status(400).json({
          error: 'Bulk yield quantity (KG) is required before BMR can be cleared from bulk QC.',
        });
      }
    }
    if (prevBprStatus !== 'packaging' && nextPreview.bpr_status === 'packaging' && nextPreview.fill_batch_accepted) {
      const fy = Number(nextPreview.fill_yield);
      if (!(Number.isFinite(fy) && fy > 0)) {
        return res.status(400).json({
          error: 'Fill yield (units) is required to approve fill QC and move to packaging.',
        });
      }
    }
    if (prevBprStatus !== 'fg_ready' && nextPreview.bpr_status === 'fg_ready' && nextPreview.fg_batch_accepted) {
      const fgy = Number(nextPreview.fg_yield);
      if (!(Number.isFinite(fgy) && fgy > 0)) {
        return res.status(400).json({
          error: 'Packaging / FG yield (units) is required to complete packaging QC and mark FG ready.',
        });
      }
    }

    const packagingGateErr = assertPackagingRequiresBmrCleared(prevPlain, nextPreview);
    if (packagingGateErr) {
      return res.status(400).json({ error: packagingGateErr });
    }

    const licenceGateErr = await assertPrLicenceClearForBatchPatch(prevPlain, nextPreview, req.body || {});
    if (licenceGateErr) {
      return res.status(400).json({ error: licenceGateErr, code: 'PR_LICENCE_BLOCKED' });
    }

    if (scheduleFieldsInBody(req.body || {})) {
      const allBatches = await ProductionBatch.findAll({
        attributes: [
          'bmr_no', 'mfg_date', 'fill_date', 'pack_date',
          'main_vessel', 'filling_line', 'packaging_line', 'supporting_tanks',
        ],
      });
      const equipErrors = validateEquipmentSchedulePatch(
        nextPreview,
        allBatches,
        prevPlain?.bmr_no || nextPreview?.bmr_no || '',
      );
      if (equipErrors.length > 0) {
        return res.status(400).json({ error: equipErrors.join(' ') });
      }
    }

    if (incomingHasDispensing) {
      const scheduledMuZone = String(nextPreview?.scheduled_mu_zone || prevPlain?.scheduled_mu_zone || '').trim();
      const nextDispensingRmPreview = Array.isArray(nextPreview?.dispensing_rm) ? nextPreview.dispensing_rm : [];
      const nextDispensingPmPreview = Array.isArray(nextPreview?.dispensing_pm) ? nextPreview.dispensing_pm : [];
      const requiredShortages = [
        ...collectDispensingRequiredShortages(nextDispensingRmPreview),
        ...collectDispensingRequiredShortages(nextDispensingPmPreview),
      ];
      if (requiredShortages.length > 0) {
        return res.status(400).json({
          error: formatDispensingRequiredShortageMessage(requiredShortages),
          shortages: requiredShortages,
        });
      }
      const [rmShortages, pmShortages] = await Promise.all([
        collectDispensingMuZoneShortages('RM', prevDispensingRmSnapshot, nextDispensingRmPreview, scheduledMuZone),
        collectDispensingMuZoneShortages('PM', prevDispensingPmSnapshot, nextDispensingPmPreview, scheduledMuZone),
      ]);
      const allShortages = [...rmShortages, ...pmShortages];
      if (allShortages.length > 0) {
        return res.status(400).json({
          error: formatDispensingMuZoneShortageMessage(allShortages, scheduledMuZone),
          shortages: allShortages,
        });
      }
    }

    await row.save();
    const nextPlain = row.get ? row.get({ plain: true }) : row;

    // --- Dispensing consumption (delta on dispensed qty) ---
    // When dispensing_rm/dispensing_pm values change (even via Save Progress),
    // consume the delta from RM/PM at the batch scheduled_mu_zone only (not WH or other MU).
    //
    // IMPORTANT: This must run even when bpr_status is already fg_ready. Previously we skipped
    // the whole block for fg_ready, which meant: (1) saving dispensing on a completed BPR never
    // moved stock, and (2) a single PATCH that set fg_ready together with first dispensing
    // amounts skipped consumption entirely (fg_ready path also skips RM/PM when dispensed > 0).
    // Double consumption is avoided: applyBprFgReadyToInventory only reduces RM/PM when
    // totalDispensedRm/totalDispensedPm are both <= 0 (dispensing never recorded incrementally).
    const prevDispensingRm = prevDispensingRmSnapshot;
    const nextDispensingRm = Array.isArray(nextPlain?.dispensing_rm) ? nextPlain.dispensing_rm : [];
    const prevDispensingPm = prevDispensingPmSnapshot;
    const nextDispensingPm = Array.isArray(nextPlain?.dispensing_pm) ? nextPlain.dispensing_pm : [];

    const consumedForBundle = [];
    const consumeDelta = async (type, prevMap, nextMap, nextLines, prevLines, bundleTagId) => {
      const codes = new Set([...prevMap.keys(), ...nextMap.keys()]);
      for (const code of codes) {
        const prevQty = prevMap.get(code) || 0;
        const nextQty = nextMap.get(code) || 0;
        const delta = nextQty - prevQty;
        const willApply = Number.isFinite(delta) && Math.abs(delta) > 1e-9;
        console.log(DISPENDING_MU_ERR_TAG, 'consumeDelta: per code', {
          batchPk: id,
          type,
          code,
          prevQty,
          nextQty,
          delta,
          willApply,
        });
        if (!willApply) continue;
        const sampleLine = pickDispensingLine(nextLines, prevLines, code);
        if (DISPENSING_TRACE) {
          console.log('[production][DISPENSING_TRACE] consumeDelta', {
            type,
            code,
            prevQty,
            nextQty,
            delta,
            prevLine: prevLines?.find((l) => String(l?.code || '').trim() === code) ?? null,
            nextLine: nextLines?.find((l) => String(l?.code || '').trim() === code) ?? null,
          });
        }
        try {
          const applied = await applyDispensingDeltaToWarehouseInventory({
            type,
            code,
            delta,
            sampleLine,
            batchPlain: nextPlain,
            dispensingBundleId: bundleTagId || null,
          });
          if (applied && delta > 0) {
            consumedForBundle.push({ type, code, qty: delta });
          }
        } catch (consumeErr) {
          if (consumeErr && consumeErr.statusCode === 400) throw consumeErr;
          throw consumeErr;
        }
      }
    };

    const prevRmMap = sumDispensedByCodeForDispensing(prevDispensingRm);
    const nextRmMap = sumDispensedByCodeForDispensing(nextDispensingRm);
    const prevPmMap = sumDispensedByCodeForDispensing(prevDispensingPm);
    const nextPmMap = sumDispensedByCodeForDispensing(nextDispensingPm);

    const dispensingDeltaThisPatch =
      dispensingMapsHaveAnyDelta(prevRmMap, nextRmMap) || dispensingMapsHaveAnyDelta(prevPmMap, nextPmMap);
    const muDispensingBundleTagId = dispensingDeltaThisPatch ? makeMuDispensingBundleId(nextPlain.bmr_no) : null;

    console.log(DISPENDING_MU_ERR_TAG, 'updateBatch: DB state after save — dispensed totals by code', {
      batchPk: id,
      bmr_no: nextPlain.bmr_no,
      bpr_status: nextPlain.bpr_status,
      bmr_status: nextPlain.bmr_status,
      prevRm: Object.fromEntries(prevRmMap),
      nextRm: Object.fromEntries(nextRmMap),
      prevPm: Object.fromEntries(prevPmMap),
      nextPm: Object.fromEntries(nextPmMap),
    });

    if (DISPENSING_TRACE) {
      const sumArr = (arr) => (arr || []).map((l) => ({ code: l?.code, dispensed: l?.dispensed, required: l?.required, done: l?.done }));
      console.log('[production][DISPENSING_TRACE] updateBatch dispensing snapshot', {
        batchId: id,
        prevBmrStatus: prevPlain?.bmr_status,
        nextBmrStatus: nextPlain?.bmr_status,
        prevBprStatus: prevBprStatus,
        nextBprStatus: nextPlain?.bpr_status,
        prevDispensingRm: sumArr(prevDispensingRm),
        nextDispensingRm: sumArr(nextDispensingRm),
        prevDispensingPm: sumArr(prevDispensingPm),
        nextDispensingPm: sumArr(nextDispensingPm),
      });
    }

    await consumeDelta('RM', prevRmMap, nextRmMap, nextDispensingRm, prevDispensingRm, muDispensingBundleTagId);
    await consumeDelta('PM', prevPmMap, nextPmMap, nextDispensingPm, prevDispensingPm, muDispensingBundleTagId);
    console.log(DISPENDING_MU_ERR_TAG, 'updateBatch: dispensing consumeDelta pass finished', {
      batchPk: id,
      bmr_no: nextPlain.bmr_no,
      muDispensingBundleTagId,
      consumedLines: consumedForBundle.length,
    });

    if (consumedForBundle.length > 0 && muDispensingBundleTagId) {
      const peId = await resolvePlanningExtractedIdForBatch(nextPlain);
      await persistMuDispensingBundleSnapshot(id, muDispensingBundleTagId, consumedForBundle, peId);
      await row.reload();
    }
    const rmUnreserveTriggered = !!prevPlain.rm_reserved && !nextPlain.rm_reserved;
    const rmReserveTriggered =
      !rmUnreserveTriggered &&
      ((prevBmrStatus !== 'rm_reserved' && nextPlain.bmr_status === 'rm_reserved') ||
        (!prevPlain.rm_reserved && !!nextPlain.rm_reserved));
    if (rmUnreserveTriggered) {
      await releaseRmReservedFromInventory(row);
    } else if (rmReserveTriggered) {
      await applyRmReservedToInventory(row);
    } else if (await needsRmReserveRepair(id, nextPlain)) {
      await applyRmReservedToInventory(row, { force: true });
    }
    const pmUnreserveTriggered = !!prevPlain.pm_reserved && !nextPlain.pm_reserved;
    const pmReserveTriggered =
      !pmUnreserveTriggered &&
      ((prevBprStatus !== 'pm_reserved' && nextPlain.bpr_status === 'pm_reserved') ||
        (!prevPlain.pm_reserved && !!nextPlain.pm_reserved));
    if (pmUnreserveTriggered) {
      await releasePmReservedFromInventory(row);
    } else if (pmReserveTriggered) {
      if (!isBmrBulkCleared(nextPlain)) {
        return res.status(400).json({ error: PACKAGING_GATE_MESSAGE });
      }
      await applyPmReservedToInventory(row);
    } else if (await needsPmReserveRepair(id, nextPlain)) {
      if (!isBmrBulkCleared(nextPlain)) {
        return res.status(400).json({ error: PACKAGING_GATE_MESSAGE });
      }
      await applyPmReservedToInventory(row, { force: true });
    }
    if (prevBprStatus !== 'fg_ready' && nextPlain.bpr_status === 'fg_ready') {
      await applyBprFgReadyToInventory(row);
    } else if (nextPlain.bpr_status === 'fg_ready') {
      const yieldChanged =
        Number(prevPlain.fg_yield) !== Number(nextPlain.fg_yield)
        || Number(prevPlain.fill_yield) !== Number(nextPlain.fill_yield);
      if (yieldChanged) await syncFulfillmentFgQtyFromBatch(row);
    }

    // Update website order pipeline stage when Production/BPR changes.
    // Linked by shared so_no (EI-SO-YYYY-XXX) which is stored on Order.so_no and ProductionBatch.so_no.
    const soNo = nextPlain.so_no;
    if (soNo) {
      let stage = null;
      if (nextPlain.bpr_status === 'fg_ready') stage = 'completed_production';
      else if (['packaging', 'pack_qc'].includes(nextPlain.bpr_status)) stage = 'packaged';
      else if (nextPlain.bmr_status === 'rm_reserved' || nextPlain.bpr_status === 'pm_reserved') stage = 'in_production';
      else if (['wip', 'bulk_qc'].includes(nextPlain.bmr_status)) stage = 'in_production';
      if (stage) {
        await Order.update({ fulfillment_stage: stage }, { where: { so_no: soNo } });
      }
    }
    await row.reload();
    const finalPlain = row.get({ plain: true });
    await syncPlanningBatchFromProductionBatchSize(finalPlain);
    res.json(formatBatch(row));
  } catch (err) {
    console.error('updateBatch error:', err);
    if (err && err.statusCode === 400) {
      return res.status(400).json({
        error: err.message || 'Dispensing blocked — insufficient stock at production facility',
        shortages: err.dispensingFacilityShortages || undefined,
      });
    }
    if (err && err.statusCode === 409) {
      return res.status(409).json({
        error: err.message || 'Cannot reserve — insufficient free stock for this batch',
        shortages: err.reserveShortages || undefined,
      });
    }
    res.status(500).json({ error: 'Failed to update batch' });
  }
}

async function deleteBatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProductionBatch.findOne({ where: activeRowWhere({ id }) });
    if (!row) return res.status(404).json({ error: 'Batch not found' });
    await softDeleteInstance(row);
    res.json({ message: 'Batch deleted' });
  } catch (err) {
    console.error('deleteBatch error:', err);
    res.status(500).json({ error: 'Failed to delete batch' });
  }
}

/** Normalize SO identifier for matching (e.g. "EI-SO-2026-001" and "SO-2026-001" -> same). */
function normalizeSoId(id) {
  if (!id || typeof id !== 'string') return '';
  const stripped = id.replace(/^(EI-)?(SO-)?/i, '').trim() || id;
  return stripped;
}

/** True if two SO identifiers refer to the same order (normalized match or numeric suffix match). */
function soIdsMatch(a, b) {
  const na = normalizeSoId(a);
  const nb = normalizeSoId(b);
  if (na === nb) return true;
  const numA = na.split('-').pop();
  const numB = nb.split('-').pop();
  return numA !== undefined && numB !== undefined && String(parseInt(numA, 10)) === String(parseInt(numB, 10));
}

// BOM resolution debug logs (backend). Set BOM_DEBUG=0 to disable. Table: copy BOM = planning_batches, master = bom.
const BOM_DEBUG = process.env.BOM_DEBUG !== '0';

/**
 * Resolve product_id for filling an empty planning-batch BOM copy from master `boms`.
 */
async function resolveProductIdForBomFallback(d) {
  if (d.sku) {
    const prod = await Product.findOne({ where: { zoho_sku_code: d.sku }, attributes: ['product_id'] });
    if (prod) return prod.product_id;
  }
  if (d.product_name) {
    const prod = await Product.findOne({
      where: { product_name: { [Op.iLike]: String(d.product_name).trim() } },
      attributes: ['product_id'],
    });
    if (prod) return prod.product_id;
  }
  const pbId = d.planning_batch_id != null ? Number(d.planning_batch_id) : null;
  if (pbId && !Number.isNaN(pbId)) {
    const pb = await PlanningBatch.findByPk(pbId, { attributes: ['planning_extracted_id'] });
    if (pb) {
      const pe = await PlanningExtracted.findByPk(pb.planning_extracted_id, { attributes: ['product_id'] });
      if (pe) return pe.product_id;
    }
  }
  return null;
}

/**
 * Resolve BOM lines for a production batch.
 * Always prefer the batch-specific BOM copy: when production_batch.planning_batch_id is set, load
 * rm_lines/pm_lines from that planning_batches row (the BOM copy created for this batch). Otherwise
 * try to match by SO + product + sequence, then fall back to product master BOM.
 * Returns { rmLines, pmLines, source: 'planning_batch' | 'product_bom' }.
 */
async function getBomLinesForBatch(d) {
  let rmLines = [];
  let pmLines = [];
  let source = 'product_bom';
  /** When set, we already read planning_batches via planning_batch_id but rm_lines/pm_lines were empty — skip inferring the same row again. */
  let skipInference = false;
  /** Batch size from planning_batches when we use that row (even if BOM lines are filled from master below). */
  let batchSizeKgOut = null;

  if (BOM_DEBUG) {
    console.log('[BOM-DEBUG] getBomLinesForBatch INPUT (production_batches row):', {
      production_batch_id: d.id,
      bmr_no: d.bmr_no,
      so_no: d.so_no,
      sku: d.sku,
      product_name: d.product_name,
      batch_index: d.batch_index,
      batch_no: d.batch_no,
      planning_batch_id: d.planning_batch_id,
      table: 'production_batches',
    });
  }

  // 1) Direct link: this production batch is tied to a specific planning_batches row (batch BOM copy).
  const planningBatchId = d.planning_batch_id != null ? Number(d.planning_batch_id) : null;
  if (planningBatchId && !Number.isNaN(planningBatchId)) {
    const pb = await PlanningBatch.findByPk(planningBatchId, { attributes: ['id', 'rm_lines', 'pm_lines', 'size_kg', 'batch_code', 'planning_extracted_id', 'sequence'] });
    if (pb) {
      const plain = pb.get ? pb.get({ plain: true }) : pb;
      rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
      pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
      source = 'planning_batch';
      if (BOM_DEBUG) {
        console.log('[BOM-DEBUG] USING COPY BOM (direct link):', {
          table: 'planning_batches',
          planning_batch_id: plain.id,
          planning_extracted_id: plain.planning_extracted_id,
          batch_code: plain.batch_code,
          sequence: plain.sequence,
          rm_lines_count: rmLines.length,
          pm_lines_count: pmLines.length,
        });
      }
      batchSizeKgOut = plain.size_kg != null ? Number(plain.size_kg) : null;
      if (rmLines.length > 0 || pmLines.length > 0) {
        return { rmLines, pmLines, source, batchSizeKg: batchSizeKgOut };
      }
      skipInference = true;
      if (BOM_DEBUG) {
        console.log('[BOM-DEBUG] planning batch copy empty — will try product master BOM merge');
      }
    }
    if (BOM_DEBUG) console.log('[BOM-DEBUG] planning_batch_id', planningBatchId, 'set but PlanningBatch.findByPk returned null');
  } else if (BOM_DEBUG) {
    console.log('[BOM-DEBUG] No direct planning_batch_id — will try inference by SO + product + sequence');
  }

  // 2) No direct link: infer planning batch by SO + product + batch sequence (for older batches).
  const soNorm = normalizeSoId(d.so_no || '');
  const rawBatchIndex = (d.batch_index != null && !Number.isNaN(Number(d.batch_index)))
    ? Number(d.batch_index)
    : (d.batch_no ? parseInt(String(d.batch_no).replace(/^B-?/i, ''), 10) : null);
  const seq = (rawBatchIndex != null && !Number.isNaN(rawBatchIndex) && rawBatchIndex >= 1) ? rawBatchIndex : 1;

  if (!skipInference && soNorm && (d.sku || d.product_name)) {
    let productId = null;
    if (d.sku) {
      const prod = await Product.findOne({ where: { zoho_sku_code: d.sku }, attributes: ['product_id'] });
      if (prod) productId = prod.product_id;
    }
    if (productId == null && d.product_name) {
      let prod = await Product.findOne({ where: { product_name: d.product_name }, attributes: ['product_id'] });
      if (!prod) {
        prod = await Product.findOne({
          where: { product_name: { [Op.iLike]: String(d.product_name).trim() } },
          attributes: ['product_id'],
        });
      }
      if (prod) productId = prod.product_id;
    }
    if (BOM_DEBUG) console.log('[BOM-DEBUG] Inference: soNorm=', soNorm, 'seq=', seq, 'productId=', productId, 'sku=', d.sku, 'product_name=', d.product_name);
    if (productId != null) {
      const soList = await SalesOrder.findAll({ attributes: ['id', 'order_id'] });
      const soMatch = soList.find((s) => soIdsMatch(s.order_id, d.so_no || ''));
      if (BOM_DEBUG) console.log('[BOM-DEBUG] Inference: soMatch=', soMatch ? { id: soMatch.id, order_id: soMatch.order_id } : null);
      if (soMatch) {
        const plan = await PlanningExtracted.findOne({
          where: { sales_order_id: soMatch.id, product_id: productId },
        });
        if (BOM_DEBUG) console.log('[BOM-DEBUG] Inference: plan (planning_extracted)=', plan ? { id: plan.id, sales_order_id: plan.sales_order_id, product_id: plan.product_id } : null);
        if (plan) {
          const pb = await PlanningBatch.findOne({
            where: {
              planning_extracted_id: plan.id,
              [Op.or]: [{ sequence: seq }, { sequence: String(seq) }],
            },
            attributes: ['id', 'rm_lines', 'pm_lines', 'size_kg', 'batch_code', 'planning_extracted_id', 'sequence'],
          });
          if (pb) {
            const plain = pb.get ? pb.get({ plain: true }) : pb;
            rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
            pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
            source = 'planning_batch';
            if (BOM_DEBUG) {
              console.log('[BOM-DEBUG] USING COPY BOM (inferred):', {
                table: 'planning_batches',
                planning_batch_id: plain.id,
                planning_extracted_id: plain.planning_extracted_id,
                batch_code: plain.batch_code,
                sequence: plain.sequence,
                rm_lines_count: rmLines.length,
                pm_lines_count: pmLines.length,
              });
            }
            batchSizeKgOut = plain.size_kg != null ? Number(plain.size_kg) : null;
            if (rmLines.length > 0 || pmLines.length > 0) {
              return { rmLines, pmLines, source, batchSizeKg: batchSizeKgOut };
            }
            if (BOM_DEBUG) {
              console.log('[BOM-DEBUG] inferred planning batch copy empty — will try product master BOM merge');
            }
          }
          if (BOM_DEBUG) console.log('[BOM-DEBUG] Inference: no PlanningBatch row for plan.id=', plan.id, 'sequence=', seq);
        }
      }
    }
  }

  // 3) Fallback: product master BOM (items master list).
  if (source === 'product_bom') {
    let product = null;
    if (d.sku) product = await Product.findOne({ where: { zoho_sku_code: d.sku } });
    if (!product && d.product_name) product = await Product.findOne({ where: { product_name: d.product_name } });
    if (product) {
      const productId = product.get ? product.get({ plain: true }).product_id : product.product_id;
      const bom = await BOM.findOne({ where: { product_id: productId }, attributes: ['rm_lines', 'pm_lines'] });
      if (bom) {
        const plain = bom.get ? bom.get({ plain: true }) : bom;
        rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
        if (BOM_DEBUG) {
          console.log('[BOM-DEBUG] FALLBACK: using product master BOM:', { table: 'bom', product_id: productId, rm_lines_count: rmLines.length, pm_lines_count: pmLines.length });
        }
      }
    }
  }

  // 4) planning_batches snapshot empty but product master `boms` may have RM/PM (or only master was maintained).
  if (rmLines.length === 0 || pmLines.length === 0) {
    const pid = await resolveProductIdForBomFallback(d);
    if (pid != null) {
      const bom = await BOM.findOne({ where: { product_id: pid }, attributes: ['rm_lines', 'pm_lines'] });
      if (bom) {
        const plain = bom.get ? bom.get({ plain: true }) : bom;
        const masterRm = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        const masterPm = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
        if (rmLines.length === 0 && masterRm.length > 0) {
          rmLines = masterRm;
          if (BOM_DEBUG) console.log('[BOM-DEBUG] Filled empty batch RM from product master BOM product_id=', pid);
        }
        if (pmLines.length === 0 && masterPm.length > 0) {
          pmLines = masterPm;
          if (BOM_DEBUG) console.log('[BOM-DEBUG] Filled empty batch PM from product master BOM product_id=', pid);
        }
      }
    }
  }

  if (BOM_DEBUG) console.log('[BOM-DEBUG] RESULT: source=', source, 'rmLines=', rmLines.length, 'pmLines=', pmLines.length);
  return { rmLines, pmLines, source, batchSizeKg: batchSizeKgOut };
}

/** Master RM/PM "Quality specifications" keys stored in form_data (RawMaterialForm / PackagingForm). */
const BULK_QUALITY_FORM_KEYS = [
  ['assayPurity', 'Assay / Purity %'],
  ['appearanceSpec', 'Appearance spec'],
  ['phSpec', 'pH range'],
  ['moistureLod', 'Moisture / LOD %'],
  ['heavyMetalsSpec', 'Heavy metals'],
  ['microbialSpec', 'Microbial'],
  ['odorColorSpec', 'Odor & color'],
  ['otherSpecs', 'Other specifications'],
];

function extractBulkQualityFromFormData(fd) {
  if (!fd || typeof fd !== 'object') return {};
  const out = {};
  for (const [key, label] of BULK_QUALITY_FORM_KEYS) {
    const v = fd[key];
    if (v != null && String(v).trim()) out[label] = String(v).trim();
  }
  return out;
}

function flattenBomLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const item of lines) {
    if (item && Array.isArray(item.ingredients)) {
      for (const ing of item.ingredients) out.push(ing);
    } else if (item) out.push(item);
  }
  return out;
}

async function normalizeBatchBomLines(rmLinesInput, pmLinesInput) {
  const rmLines = Array.isArray(rmLinesInput) ? rmLinesInput : [];
  const pmLines = Array.isArray(pmLinesInput) ? pmLinesInput : [];

  const rmIds = new Set();
  const rmCodes = new Set();
  for (const line of rmLines) {
    const id = line.raw_material_id ?? line.rawMaterialId;
    if (id != null && !Number.isNaN(Number(id))) rmIds.add(Number(id));
    const code = line.rm_code ?? line.rmCode ?? line.code;
    if (code != null && String(code).trim()) rmCodes.add(String(code).trim());
  }
  const pmIds = new Set();
  const pmCodes = new Set();
  for (const line of pmLines) {
    const id = line.pack_material_id ?? line.packMaterialId;
    if (id != null && !Number.isNaN(Number(id))) pmIds.add(Number(id));
    const code = line.pm_code ?? line.pmCode ?? line.code;
    if (code != null && String(code).trim()) pmCodes.add(String(code).trim());
  }

  const [rmRows, pmRows] = await Promise.all([
    (rmIds.size || rmCodes.size)
      ? RawMaterial.findAll({
        where: {
          [Op.or]: [
            ...(rmIds.size ? [{ id: { [Op.in]: [...rmIds] } }] : []),
            ...(rmCodes.size ? [{ code: { [Op.in]: [...rmCodes] } }] : []),
          ],
        },
        attributes: ['id', 'code', 'name', 'inci'],
      })
      : Promise.resolve([]),
    (pmIds.size || pmCodes.size)
      ? PackMaterial.findAll({
        where: {
          [Op.or]: [
            ...(pmIds.size ? [{ id: { [Op.in]: [...pmIds] } }] : []),
            ...(pmCodes.size ? [{ code: { [Op.in]: [...pmCodes] } }] : []),
          ],
        },
        attributes: ['id', 'code', 'description'],
      })
      : Promise.resolve([]),
  ]);

  const rmById = new Map();
  const rmByCode = new Map();
  for (const r of rmRows) {
    const p = r.get ? r.get({ plain: true }) : r;
    rmById.set(Number(p.id), p);
    if (p.code) rmByCode.set(String(p.code).trim(), p);
  }
  const pmById = new Map();
  const pmByCode = new Map();
  for (const p0 of pmRows) {
    const p = p0.get ? p0.get({ plain: true }) : p0;
    pmById.set(Number(p.id), p);
    if (p.code) pmByCode.set(String(p.code).trim(), p);
  }

  const normalizedRmLines = rmLines.map((line) => {
    const id = line.raw_material_id ?? line.rawMaterialId;
    const code = (line.rm_code ?? line.rmCode ?? line.code ?? '').toString().trim();
    const row = (id != null && !Number.isNaN(Number(id)) ? rmById.get(Number(id)) : null) || (code ? rmByCode.get(code) : null);
    if (!row) return line;
    return {
      ...line,
      raw_material_id: row.id,
      rawMaterialId: row.id,
      rm_code: row.code,
      rmCode: row.code,
      code: row.code,
      inci_name: line.inci_name || line.inciName || line.name || row.name || row.inci || '',
      name: line.name || line.inci_name || row.name || row.inci || '',
    };
  });

  const normalizedPmLines = pmLines.map((line) => {
    const id = line.pack_material_id ?? line.packMaterialId;
    const code = (line.pm_code ?? line.pmCode ?? line.code ?? '').toString().trim();
    const row = (id != null && !Number.isNaN(Number(id)) ? pmById.get(Number(id)) : null) || (code ? pmByCode.get(code) : null);
    if (!row) return line;
    return {
      ...line,
      pack_material_id: row.id,
      packMaterialId: row.id,
      pm_code: row.code,
      pmCode: row.code,
      code: row.code,
      description: line.description || line.name || row.description || '',
      name: line.name || line.description || row.description || '',
    };
  });

  return { rmLines: normalizedRmLines, pmLines: normalizedPmLines };
}

async function buildIngredientBulkSpecsForBom(rmLines, pmLines) {
  const flatRm = flattenBomLines(rmLines);
  const flatPm = flattenBomLines(pmLines);
  const rmIds = new Set();
  const rmCodes = new Set();
  for (const line of flatRm) {
    const id = line.raw_material_id ?? line.rawMaterialId;
    if (id != null && !Number.isNaN(Number(id))) rmIds.add(Number(id));
    const code = line.rm_code ?? line.rmCode ?? line.code;
    if (code != null && String(code).trim()) rmCodes.add(String(code).trim());
  }
  const pmIds = new Set();
  const pmCodes = new Set();
  for (const line of flatPm) {
    const id = line.pack_material_id ?? line.packMaterialId;
    if (id != null && !Number.isNaN(Number(id))) pmIds.add(Number(id));
    const code = line.pm_code ?? line.pmCode ?? line.code;
    if (code != null && String(code).trim()) pmCodes.add(String(code).trim());
  }

  const byRmId = new Map();
  if (rmIds.size > 0) {
    const rows = await RawMaterial.findAll({
      where: { id: { [Op.in]: [...rmIds] } },
      attributes: ['id', 'code', 'inci', 'name', 'form_data'],
    });
    for (const r of rows) {
      const p = r.get ? r.get({ plain: true }) : r;
      byRmId.set(p.id, p);
    }
  }
  const rmByCode = new Map();
  if (rmCodes.size > 0) {
    const rows = await RawMaterial.findAll({
      where: { code: { [Op.in]: [...rmCodes] } },
      attributes: ['id', 'code', 'inci', 'name', 'form_data'],
    });
    for (const r of rows) {
      const p = r.get ? r.get({ plain: true }) : r;
      rmByCode.set(p.code, p);
    }
  }

  const byPmId = new Map();
  if (pmIds.size > 0) {
    const rows = await PackMaterial.findAll({
      where: { id: { [Op.in]: [...pmIds] } },
      attributes: ['id', 'code', 'description', 'form_data'],
    });
    for (const r of rows) {
      const p = r.get ? r.get({ plain: true }) : r;
      byPmId.set(p.id, p);
    }
  }
  const pmByCode = new Map();
  if (pmCodes.size > 0) {
    const rows = await PackMaterial.findAll({
      where: { code: { [Op.in]: [...pmCodes] } },
      attributes: ['id', 'code', 'description', 'form_data'],
    });
    for (const r of rows) {
      const p = r.get ? r.get({ plain: true }) : r;
      pmByCode.set(p.code, p);
    }
  }

  const seenRm = new Set();
  const seenPm = new Set();
  const ingredientBulkSpecs = [];

  for (const line of flatRm) {
    let row = null;
    const id = line.raw_material_id ?? line.rawMaterialId;
    if (id != null) row = byRmId.get(Number(id));
    if (!row) {
      const c = line.rm_code ?? line.rmCode ?? line.code;
      if (c) row = rmByCode.get(String(c).trim());
    }
    if (!row) continue;
    const key = `rm:${row.id}`;
    if (seenRm.has(key)) continue;
    seenRm.add(key);
    const fd = row.form_data && typeof row.form_data === 'object' ? row.form_data : {};
    ingredientBulkSpecs.push({
      type: 'RM',
      id: row.id,
      code: row.code,
      name: row.name || row.inci || '',
      inci: row.inci || '',
      specs: extractBulkQualityFromFormData(fd),
    });
  }

  for (const line of flatPm) {
    let row = null;
    const id = line.pack_material_id ?? line.packMaterialId;
    if (id != null) row = byPmId.get(Number(id));
    if (!row) {
      const c = line.pm_code ?? line.pmCode ?? line.code;
      if (c) row = pmByCode.get(String(c).trim());
    }
    if (!row) continue;
    const key = `pm:${row.id}`;
    if (seenPm.has(key)) continue;
    seenPm.add(key);
    const fd = row.form_data && typeof row.form_data === 'object' ? row.form_data : {};
    ingredientBulkSpecs.push({
      type: 'PM',
      id: row.id,
      code: row.code,
      name: row.description || '',
      inci: '',
      specs: extractBulkQualityFromFormData(fd),
    });
  }

  return ingredientBulkSpecs;
}

async function buildFgProductSpecsForBatch(batchPlain) {
  let product = null;
  if (batchPlain.sku) product = await Product.findOne({ where: { zoho_sku_code: batchPlain.sku } });
  if (!product && batchPlain.product_name) {
    product = await Product.findOne({ where: { product_name: batchPlain.product_name } });
  }
  if (!product) return {};
  const p = product.get ? product.get({ plain: true }) : product;
  const bom = await BOM.findOne({ where: { product_id: p.product_id } });
  const bomPlain = bom ? (bom.get ? bom.get({ plain: true }) : bom) : null;
  const bySection = hydratePrQualitySpecRowsBySectionFromBom(bomPlain);
  const bulkSubByPath = hydratePrQualityBulkSubSpecRowsByPathFromBom(bomPlain);
  const finalSubByPath = hydratePrQualityFinalSubSpecRowsByPathFromBom(bomPlain);
  const dispatchSubByPath = hydratePrQualityDispatchSubSpecRowsByPathFromBom(bomPlain);
  const tabular = flattenPrQualitySpecRowsForDisplay(
    bySection,
    bulkSubByPath,
    finalSubByPath,
    dispatchSubByPath
  );
  if (Object.keys(tabular).length > 0) return tabular;

  const pairs = [
    ['pH range', p.ph_range],
    ['Viscosity (cPs)', p.viscosity_range],
    ['SPF / PA', p.spf_pa_rating],
    ['Appearance', p.appearance],
    ['Odour', p.odour],
    ['Fill weight', p.fill_weight_spec],
    ['Stability', p.stability_summary],
  ];
  const out = {};
  for (const [label, v] of pairs) {
    if (v != null && String(v).trim()) out[label] = String(v).trim();
  }
  return out;
}

/**
 * GET /batches/:id/bom — BOM for this production batch.
 * Prefer batch-specific BOM from planning_batches (when batch was sent from Planning with edited BOM).
 * Fallback: product master BOM from boms table.
 * Includes qcReference: master bulk specs per RM/PM line + product Specs & Stability for the batch SKU.
 */
/**
 * Per-batch kg-per-unit + client, for the Edit Batch modal's units<->kg conversion and read-only header.
 * kgPerUnit prefers the linked planning row (total_kg / order_qty = bulk kg incl. overage), then the
 * product's net fill size, else 0 (caller falls back to editing kg directly).
 */
async function computeBatchUnitBasis(d) {
  let kgPerUnit = 0;
  let client = '';
  try {
    const peId = await resolvePlanningExtractedIdForBatch(d);
    if (peId != null) {
      const pe = await PlanningExtracted.findByPk(peId, {
        attributes: ['total_kg_display', 'order_qty_display', 'product_id'],
      });
      if (pe) {
        const totalKg = parseFloat(String(pe.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
        const orderQty = parseInt(String(pe.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
        if (totalKg > 0 && orderQty > 0) kgPerUnit = totalKg / orderQty;
        if (!(kgPerUnit > 0) && pe.product_id != null) {
          const prod = await Product.findByPk(pe.product_id, { attributes: ['fill_size'] });
          const fromFill = prod ? parseFillSizeToKgPerUnit(prod.fill_size, 1) : 0;
          if (fromFill > 0) kgPerUnit = fromFill;
        }
      }
    }
  } catch (e) {
    console.warn('[production] computeBatchUnitBasis kgPerUnit:', e && e.message ? e.message : e);
  }
  try {
    if (d.so_no) {
      const so = await SalesOrder.findOne({
        where: { order_id: d.so_no },
        attributes: ['customer_name'],
      });
      if (so) client = so.customer_name || '';
    }
  } catch (e) {
    console.warn('[production] computeBatchUnitBasis client:', e && e.message ? e.message : e);
  }
  return { kgPerUnit: kgPerUnit > 0 ? kgPerUnit : null, client };
}

async function getBatchBom(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const d = batch.get ? batch.get({ plain: true }) : batch;
    if (BOM_DEBUG) console.log('[BOM-DEBUG] GET /batches/:id/bom called with production_batch id=', id, 'bmr_no=', d.bmr_no, 'so_no=', d.so_no);
    const { rmLines, pmLines, source, batchSizeKg } = await getBomLinesForBatch(d);
    const normalized = await normalizeBatchBomLines(rmLines, pmLines);
    if (BOM_DEBUG) console.log('[BOM-DEBUG] GET /batches/:id/bom response: source=', source, 'rmLines=', rmLines.length, 'pmLines=', pmLines.length);
    const [ingredientBulkSpecs, fgProductSpecs, unitBasis] = await Promise.all([
      buildIngredientBulkSpecsForBom(normalized.rmLines, normalized.pmLines),
      buildFgProductSpecsForBatch(d),
      computeBatchUnitBasis(d),
    ]);
    const effectiveKg = (batchSizeKg != null && batchSizeKg > 0)
      ? batchSizeKg
      : (Number(d.batch_size) || 0);
    const batchUnits =
      unitBasis.kgPerUnit && unitBasis.kgPerUnit > 0 && effectiveKg > 0
        ? Math.round(effectiveKg / unitBasis.kgPerUnit)
        : null;
    res.json({
      success: true,
      data: {
        rmLines: normalized.rmLines,
        pmLines: normalized.pmLines,
        source,
        batchSizeKg: batchSizeKg ?? undefined,
        kgPerUnit: unitBasis.kgPerUnit ?? undefined,
        batchUnits: batchUnits ?? undefined,
        client: unitBasis.client || undefined,
        qcReference: { ingredientBulkSpecs, fgProductSpecs },
      },
    });
  } catch (err) {
    console.error('getBatchBom error', err);
    res.status(500).json({ success: false, error: 'Failed to fetch batch BOM' });
  }
}

/**
 * GET /batches/:id/mtr-reserved — per-code reserved qty for this batch (reserved_batch_items).
 * Re-syncs warehouse_inventory.reserved from RBI sums so MTR modal matches DB.
 */
async function getBatchMtrReserved(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const plain = batch.get ? batch.get({ plain: true }) : batch;
    if (await needsPmReserveRepair(id, plain)) {
      await applyPmReservedToInventory(batch, { force: true });
    } else if (await needsRmReserveRepair(id, plain)) {
      await applyRmReservedToInventory(batch, { force: true });
    }

    const rows = await ReservedBatchItem.findAll({
      where: { production_batch_id: id },
      attributes: ['raw_material_id', 'pack_material_id', 'quantity_reserved'],
    });
    const otherRows = await ReservedBatchItem.findAll({
      where: { production_batch_id: { [Op.ne]: id } },
      attributes: ['raw_material_id', 'pack_material_id', 'quantity_reserved'],
    });
    const syncRmIds = new Set();
    const syncPmIds = new Set();
    const byCode = {};
    const otherBatchesByCode = {};

    const accumulateByCode = async (target, plain, trackSync) => {
      const qty = Number(plain.quantity_reserved) || 0;
      if (qty <= 0) return;
      if (plain.raw_material_id != null) {
        if (trackSync) syncRmIds.add(plain.raw_material_id);
        const rm = await RawMaterial.findByPk(plain.raw_material_id, { attributes: ['code'] });
        const code = String(rm?.code || '').trim();
        if (code) target[code] = (target[code] ?? 0) + qty;
      } else if (plain.pack_material_id != null) {
        if (trackSync) syncPmIds.add(plain.pack_material_id);
        const pm = await PackMaterial.findByPk(plain.pack_material_id, { attributes: ['code'] });
        const code = String(pm?.code || '').trim();
        if (code) target[code] = (target[code] ?? 0) + qty;
      }
    };

    for (const row of rows) {
      const plain = row.get ? row.get({ plain: true }) : row;
      await accumulateByCode(byCode, plain, true);
    }
    for (const row of otherRows) {
      const plain = row.get ? row.get({ plain: true }) : row;
      await accumulateByCode(otherBatchesByCode, plain, false);
    }
    if (syncRmIds.size > 0 || syncPmIds.size > 0) {
      await syncWarehouseReserved([...syncRmIds], [...syncPmIds]);
    }
    res.json({ success: true, byCode, otherBatchesByCode });
  } catch (err) {
    console.error('getBatchMtrReserved error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch batch reserved qty' });
  }
}

/**
 * GET /batches/:id/dispensing-mu-stock — qty at batch scheduled_mu_zone per RM/PM code (rack sum at zone, else ML bucket).
 * Matches backend dispensing validation (not warehouse list ml1/ml2 columns alone).
 */
async function getBatchDispensingMuStock(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const d = batch.get ? batch.get({ plain: true }) : batch;
    const scheduledMuZone = String(d.scheduled_mu_zone || '').trim();

    const rmCodes = new Set();
    const pmCodes = new Set();
    for (const line of Array.isArray(d.dispensing_rm) ? d.dispensing_rm : []) {
      const c = String(line?.code || '').trim();
      if (c) rmCodes.add(c);
    }
    for (const line of Array.isArray(d.dispensing_pm) ? d.dispensing_pm : []) {
      const c = String(line?.code || '').trim();
      if (c) pmCodes.add(c);
    }
    if (rmCodes.size === 0 && pmCodes.size === 0) {
      const { rmLines, pmLines } = await getBomLinesForBatch(d);
      for (const line of rmLines || []) {
        const c = String(line.rm_code || line.code || '').trim();
        if (c) rmCodes.add(c);
      }
      for (const line of pmLines || []) {
        const c = String(line.pm_code || line.code || '').trim();
        if (c) pmCodes.add(c);
      }
    }

    const rmByCode = {};
    const pmByCode = {};

    for (const code of rmCodes) {
      const rmOrPmRow = await resolveRawMaterialForDispensingLine({ code });
      if (!rmOrPmRow) {
        rmByCode[code] = 0;
        continue;
      }
      const wh = await WarehouseInventory.findOne({
        where: { item_type: 'RM', raw_material_id: rmOrPmRow.id },
      });
      if (!wh) {
        rmByCode[code] = 0;
        continue;
      }
      const plainWh = wh.get ? wh.get({ plain: true }) : wh;
      rmByCode[code] = scheduledMuZone
        ? materialQtyFromDb(await getStockQtyStrAtMuZone(plainWh.id, scheduledMuZone))
        : '0';
    }

    for (const code of pmCodes) {
      const rmOrPmRow = await resolvePackMaterialForDispensingLine({ code });
      if (!rmOrPmRow) {
        pmByCode[code] = 0;
        continue;
      }
      const wh = await WarehouseInventory.findOne({
        where: { item_type: 'PM', pack_material_id: rmOrPmRow.id },
      });
      if (!wh) {
        pmByCode[code] = 0;
        continue;
      }
      const plainWh = wh.get ? wh.get({ plain: true }) : wh;
      pmByCode[code] = scheduledMuZone
        ? materialQtyFromDb(await getStockQtyStrAtMuZone(plainWh.id, scheduledMuZone))
        : '0';
    }

    res.json({
      success: true,
      scheduledMuZone,
      rmByCode,
      pmByCode,
    });
  } catch (err) {
    console.error('getBatchDispensingMuStock error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch dispensing MU stock' });
  }
}

const {
  reserveProductionBatchLines,
  unreserveProductionBatchLines,
  listProductionReservedItems,
  computeBatchMaterialCoverage,
} = require('./batchLineReserve');

async function listReservedItems(req, res) {
  try {
    const items = await listProductionReservedItems();
    res.json({ success: true, data: items });
  } catch (err) {
    console.error('listReservedItems error:', err);
    res.status(500).json({ success: false, error: 'Failed to list reserved items' });
  }
}

async function reserveBatchLines(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const kind = String(req.body?.kind || '').toLowerCase() === 'pm' ? 'pm' : 'rm';
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : null;
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const batchPlainRow = batch.get ? batch.get({ plain: true }) : batch;
    if (kind === 'pm' && !isBmrBulkCleared(batchPlainRow)) {
      return res.status(400).json({ error: PACKAGING_GATE_MESSAGE });
    }
    const bomMeta = await getBomLinesForBatch(batchPlainRow);
    await reserveProductionBatchLines(batch, kind, codes, bomMeta);
    await batch.reload();
    res.json({ success: true, data: formatBatch(batch), coverage: await computeBatchMaterialCoverage(batch.get({ plain: true }), kind, bomMeta) });
  } catch (err) {
    console.error('reserveBatchLines error:', err);
    if (err?.statusCode === 409) {
      return res.status(409).json({ error: err.message, shortages: err.reserveShortages });
    }
    if (err?.statusCode === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to reserve batch lines' });
  }
}

async function unreserveBatchLines(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const kind = String(req.body?.kind || '').toLowerCase() === 'pm' ? 'pm' : 'rm';
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const bomMeta = await getBomLinesForBatch(batch.get ? batch.get({ plain: true }) : batch);
    await unreserveProductionBatchLines(batch, kind, codes, bomMeta);
    await batch.reload();
    res.json({ success: true, data: formatBatch(batch), coverage: await computeBatchMaterialCoverage(batch.get({ plain: true }), kind, bomMeta) });
  } catch (err) {
    console.error('unreserveBatchLines error:', err);
    if (err?.statusCode === 409) return res.status(409).json({ error: err.message });
    if (err?.statusCode === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to unreserve batch lines' });
  }
}

async function getBatchReservationCoverage(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const d = batch.get({ plain: true });
    const bomMeta = await getBomLinesForBatch(d);
    const [rm, pm] = await Promise.all([
      computeBatchMaterialCoverage(d, 'rm', bomMeta),
      computeBatchMaterialCoverage(d, 'pm', bomMeta),
    ]);
    res.json({ success: true, data: { rm, pm } });
  } catch (err) {
    console.error('getBatchReservationCoverage error:', err);
    res.status(500).json({ error: 'Failed to fetch reservation coverage' });
  }
}

module.exports = {
  listEquipment, getEquipmentById, createEquipment, updateEquipment, deleteEquipment,
  listTeam,
  listBatches, getBatchById, createBatch, createRworkBatch, splitBatchForVessel, updateBatch, deleteBatch, getBatchBom, getBatchMtrReserved, getBatchDispensingMuStock, syncBatchesFromPlanning,
  listReservedItems, reserveBatchLines, unreserveBatchLines, getBatchReservationCoverage,
  computeRequiredVolumeLiters,
  applyRmReservedToInventory,
  applyPmReservedToInventory,
  applyBprFgReadyToInventory,
  /** @internal exported for integration tests */
  applyDispensingDeltaToWarehouseInventory,
};
