const { Op } = require('sequelize');
const { ProductionEquipment, ProductionTeamMember, ProductionBatch } = require('./models');
const { Order } = require('../orders/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { FulfillmentBatchSplit, ReservedBatchItem } = require('../fulfillment/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const BOM = require('../bom/models');
const { syncWarehouseReserved } = require('../planningExtracted/controller');
const { logReservedChange } = require('../warehouseInventory/locationHistoryHelpers');
const PlanningExtracted = require('../planningExtracted/models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const { createRworkPlanningBatch } = require('../planningExtracted/controller');
const SalesOrder = require('../salesOrders/models');

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
    const rows = await ProductionEquipment.findAll({ order: [['category', 'ASC'], ['equipment_id', 'ASC']] });
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
    const row = await ProductionEquipment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    await row.destroy();
    res.json({ message: 'Equipment deleted' });
  } catch (err) {
    console.error('deleteEquipment error:', err);
    res.status(500).json({ error: 'Failed to delete equipment' });
  }
}

/* ════════════════════════════════════════════════════════════
   TEAM MEMBERS
   ════════════════════════════════════════════════════════════ */

function formatTeamMember(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return { id: d.member_id, userId: d.user_id || null, name: d.name, role: d.role, dept: d.department, avail: d.available, _pk: d.id };
}

async function listTeam(req, res) {
  try {
    const rows = await ProductionTeamMember.findAll({ order: [['member_id', 'ASC']] });
    res.json(rows.map(formatTeamMember));
  } catch (err) {
    console.error('listTeam error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
}

async function getTeamMemberById(req, res) {
  try {
    const row = await ProductionTeamMember.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Team member not found' });
    res.json(formatTeamMember(row));
  } catch (err) {
    console.error('getTeamMemberById error:', err);
    res.status(500).json({ error: 'Failed to fetch team member' });
  }
}

async function createTeamMember(req, res) {
  try {
    if (req.body.user_id) {
      const existing = await ProductionTeamMember.findOne({ where: { user_id: req.body.user_id } });
      if (existing) return res.status(409).json({ error: 'This user is already on the production team' });
    }
    const row = await ProductionTeamMember.create(req.body);
    res.status(201).json(formatTeamMember(row));
  } catch (err) {
    console.error('createTeamMember error:', err);
    res.status(500).json({ error: 'Failed to create team member' });
  }
}

async function updateTeamMember(req, res) {
  try {
    const row = await ProductionTeamMember.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Team member not found' });
    const allowed = ['member_id', 'user_id', 'name', 'role', 'department', 'available'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) row.set(k, req.body[k]);
    }
    await row.save();
    res.json(formatTeamMember(row));
  } catch (err) {
    console.error('updateTeamMember error:', err);
    res.status(500).json({ error: 'Failed to update team member' });
  }
}

async function deleteTeamMember(req, res) {
  try {
    const row = await ProductionTeamMember.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Team member not found' });
    await row.destroy();
    res.json({ message: 'Team member deleted' });
  } catch (err) {
    console.error('deleteTeamMember error:', err);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
}

/* ════════════════════════════════════════════════════════════
   BATCHES (BMR / BPR)
   ════════════════════════════════════════════════════════════ */

function formatBatch(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return {
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
    qcOfficerBMR: d.qc_officer_bmr || '',
    qcOfficerBPR: d.qc_officer_bpr || '',
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
    compatibleVessels: d.compatible_vessels || undefined,
    compatibleFillLines: d.compatible_fill_lines || undefined,
    compatiblePackLines: d.compatible_pack_lines || undefined,
    requiredVolumeLiters: d.required_volume_liters != null ? Number(d.required_volume_liters) : null,
    planningBatchId: d.planning_batch_id ?? undefined,
  };
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
  'team_bmr', 'team_bpr', 'qc_officer_bmr', 'qc_officer_bpr',
  'mfg_date', 'fill_date', 'pack_date', 'fg_date', 'rm_connect_date', 'pm_connect_date',
  'rm_reserved', 'pm_reserved', 'rm_connected', 'pm_connected',
  'dispensing_rm', 'dispensing_pm',
  'bulk_yield', 'fill_yield', 'fg_yield',
  'bulk_batch_accepted', 'fill_batch_accepted', 'fg_batch_accepted',
  'qc_specs', 'remarks', 'due_date',
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
  qcOfficerBMR: 'qc_officer_bmr', qcOfficerBPR: 'qc_officer_bpr',
  mfgDate: 'mfg_date', fillDate: 'fill_date', packDate: 'pack_date', fgDate: 'fg_date',
  rmConnectDate: 'rm_connect_date', pmConnectDate: 'pm_connect_date',
  rmReserved: 'rm_reserved', pmReserved: 'pm_reserved',
  rmConnected: 'rm_connected', pmConnected: 'pm_connected',
  dispensingRM: 'dispensing_rm', dispensingPM: 'dispensing_pm',
  bulkYield: 'bulk_yield', fillYield: 'fill_yield', fgYield: 'fg_yield',
  bulkBatchAccepted: 'bulk_batch_accepted', fillBatchAccepted: 'fill_batch_accepted',
  fgBatchAccepted: 'fg_batch_accepted', qcSpecs: 'qc_specs', dueDate: 'due_date',
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
  if (d.sku) product = await Product.findOne({ where: { product_sku: d.sku }, attributes: ['product_id'] });
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

async function listBatches(req, res) {
  try {
    const rows = await ProductionBatch.findAll({ order: [['bmr_no', 'ASC']] });
    res.json(rows.map(formatBatch));
  } catch (err) {
    console.error('listBatches error:', err);
    res.status(500).json({ error: 'Failed to fetch batches' });
  }
}

/**
 * POST /batches/sync-from-planning — ensure a production batch exists for each sent planning batch.
 * For every PlanningExtracted with sent_batch_indices, and each index i, finds PlanningBatch (sequence i+1).
 * If no ProductionBatch exists for that SO + product + batch_index, creates one with next BMR/BPR.
 */
async function syncBatchesFromPlanning(req, res) {
  try {
    const planRows = await PlanningExtracted.findAll({
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id'], required: true },
        { model: Product, as: 'product', attributes: ['product_id', 'product_sku', 'product_name'], required: true },
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
      const productSku = product.product_sku || '';
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
          continue;
        }

        const { bmrNo, bprNo } = await getNextBMRBPRSequence(year);
        const skuValue = productSku || productName || String(product.product_id ?? 'sync');
        await ProductionBatch.create({
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
          { model: Product, as: 'product', attributes: ['product_id', 'product_sku', 'product_name'], required: true },
        ],
      });
      const planMatch = plans.find((p) => {
        const plain = p.get ? p.get({ plain: true }) : p;
        const orderId = (plain.salesOrder?.order_id || '').trim();
        const soMatch = orderId === soNo
          || orderId.replace(/^EI-SO-?/i, 'SO-') === soNo.replace(/^EI-SO-?/i, 'SO-')
          || orderId.replace(/^SO-?/i, 'EI-SO-') === soNo.replace(/^SO-?/i, 'EI-SO-');
        if (!soMatch) return false;
        const sku = (plain.product?.product_sku || '').trim().toLowerCase();
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
    }

    res.json({ success: true, created, repaired });
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
    res.json(formatBatch(row));
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
    res.status(201).json(formatBatch(row));
  } catch (err) {
    console.error('createBatch error:', err);
    res.status(500).json({ error: 'Failed to create batch' });
  }
}

/**
 * POST /batches/create-rework — create a new rework batch (BMR-YYYY-NNN-rw-01, rw-02, ...).
 * Body: { baseBatchId: number, reason?: string } — production batch to rework from (same SO/product); optional reason stored in remarks.
 * Creates a new planning_batch (PE-{id}-rw-NN) in the planning table and a new production batch linked to it (same SO).
 */
async function createRworkBatch(req, res) {
  try {
    const baseBatchId = req.body.baseBatchId != null ? parseInt(req.body.baseBatchId, 10) : null;
    if (baseBatchId == null || Number.isNaN(baseBatchId)) {
      return res.status(400).json({ error: 'baseBatchId is required' });
    }
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const base = await ProductionBatch.findByPk(baseBatchId);
    if (!base) return res.status(404).json({ error: 'Base batch not found' });
    const basePlain = base.get ? base.get({ plain: true }) : base;
    if (!basePlain.planning_batch_id) {
      return res.status(400).json({ error: 'Base batch must be linked to planning (has no planning_batch_id)' });
    }
    const pb = await PlanningBatch.findByPk(basePlain.planning_batch_id);
    if (!pb) return res.status(404).json({ error: 'Planning batch not found' });
    const planId = pb.planning_extracted_id;

    const newPb = await createRworkPlanningBatch(planId);
    if (!newPb) return res.status(404).json({ error: 'Planning extracted not found' });
    const newPbPlain = newPb.get ? newPb.get({ plain: true }) : newPb;

    const baseBmr = (basePlain.bmr_no || '').replace(/-rw-\d+$/, '').trim();
    const baseBpr = (basePlain.bpr_no || '').replace(/-rw-\d+$/, '').trim();
    const nextRw = await getNextRworkSuffix(basePlain.bmr_no);
    const rwSuffix = String(nextRw).padStart(2, '0');
    const bmrNo = `${baseBmr}-rw-${rwSuffix}`;
    const bprNo = `${baseBpr}-rw-${rwSuffix}`;

    const orderQty = basePlain.order_qty ?? 0;
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
 * After BPR QC: reduce RM/PM (consumed), add FG to warehouse, set fulfillment split fg_qty for invoicing.
 * Called when BPR status transitions to fg_ready.
 */
async function applyBprFgReadyToInventory(batchRow) {
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;

  // 1. Reduce RM (consumption from dispensing_rm)
  const dispensingRm = Array.isArray(d.dispensing_rm) ? d.dispensing_rm : [];
  for (const line of dispensingRm) {
    const qty = Number(line.dispensed ?? line.required ?? 0) || 0;
    if (qty <= 0) continue;
    const code = (line.code || '').trim();
    if (!code) continue;
    const rm = await RawMaterial.findOne({ where: { code } });
    if (!rm) continue;
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    if (!wh) continue;
    const plain = wh.get ? wh.get({ plain: true }) : wh;
    const whStock = Number(plain.wh_stock) || 0;
    const ml1 = Number(plain.ml1_stock) || 0;
    const ml2 = Number(plain.ml2_stock) || 0;
    const newWhStock = Math.max(0, whStock - qty);
    await wh.update({ wh_stock: newWhStock, stock_in_hand: newWhStock + ml1 + ml2 });
    console.log('[production] BPR fg_ready: reduced RM id=%s qty=%s -> wh_stock=%s', rm.id, qty, newWhStock);
  }

  // 2. Reduce PM (consumption from dispensing_pm)
  const dispensingPm = Array.isArray(d.dispensing_pm) ? d.dispensing_pm : [];
  for (const line of dispensingPm) {
    const qty = Number(line.dispensed ?? line.required ?? 0) || 0;
    if (qty <= 0) continue;
    const code = (line.code || '').trim();
    if (!code) continue;
    const pm = await PackMaterial.findOne({ where: { code } });
    if (!pm) continue;
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    if (!wh) continue;
    const plain = wh.get ? wh.get({ plain: true }) : wh;
    const whStock = Number(plain.wh_stock) || 0;
    const ml1 = Number(plain.ml1_stock) || 0;
    const ml2 = Number(plain.ml2_stock) || 0;
    const newWhStock = Math.max(0, whStock - qty);
    await wh.update({ wh_stock: newWhStock, stock_in_hand: newWhStock + ml1 + ml2 });
    console.log('[production] BPR fg_ready: reduced PM id=%s qty=%s -> wh_stock=%s', pm.id, qty, newWhStock);
  }

  // 3. Add FG (product) to warehouse_inventory
  let product = null;
  if (d.sku) product = await Product.findOne({ where: { product_sku: d.sku } });
  if (!product && d.product_name) product = await Product.findOne({ where: { product_name: d.product_name } });
  if (!product) {
    console.warn('[production] BPR fg_ready: no product found for sku=%s product_name=%s', d.sku, d.product_name);
  } else {
    const productId = product.get ? product.get({ plain: true }).product_id : product.product_id;
    const producedQty = Math.max(0, parseInt(d.batch_size || d.order_qty || 0, 10) || 0);
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

      // 4. Set fulfillment split fg_qty (final FG quantity = what is invoiced)
      const splits = await FulfillmentBatchSplit.findAll({
        where: { production_batch_id: d.id },
        order: [['id', 'ASC']],
      });
      let remaining = producedQty;
      for (const split of splits) {
        const planned = Number(split.planned_qty) || 0;
        const qty = Math.min(planned, remaining);
        if (qty > 0) await split.update({ fg_qty: qty });
        remaining -= qty;
        if (remaining <= 0) break;
      }
    }
  }
}

const RESERVE_DEBUG = process.env.RESERVE_DEBUG !== '0';

/**
 * When BMR status transitions to rm_reserved: create reserved_batch_items for RM from BOM,
 * sync warehouse_inventory.reserved, and log reserved change in history with batch id.
 * Idempotent: removes any existing RM reservations for this batch first so repeat runs don't double-count.
 * Inventory: available = SIH - reserved; after reserve X, reserved_new = R + X, available_new = SIH - reserved_new.
 */
async function applyRmReservedToInventory(batchRow) {
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;
  if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] applyRmReservedToInventory START', { production_batch_id: d.id, bmr_no: d.bmr_no });
  // Idempotent: if this batch already has RM reserved_batch_items (e.g. double PATCH), skip to avoid double-counting
  const existingRmCount = await ReservedBatchItem.count({
    where: { production_batch_id: d.id, pack_material_id: null },
  });
  if (existingRmCount > 0) {
    if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] applyRmReservedToInventory SKIP (already has', existingRmCount, 'RM reserved_batch_items)');
    return;
  }
  // Remove existing RM reserved_batch_items for this batch so we don't double-count on repeat transition
  await ReservedBatchItem.destroy({
    where: { production_batch_id: d.id, pack_material_id: null },
  });

  const { rmLines: bomRmLines, source: bomSource, batchSizeKg: planningBatchSizeKg } = await getBomLinesForBatch(d);
  if (!Array.isArray(bomRmLines) || bomRmLines.length === 0) {
    console.warn('[production] rm_reserved: no BOM rm_lines for batch', d.bmr_no);
    return;
  }
  const batchSizeKg = (bomSource === 'planning_batch' && planningBatchSizeKg != null && planningBatchSizeKg > 0)
    ? planningBatchSizeKg
    : (Number(d.batch_size) || Number(d.order_qty) || 0);
  if (batchSizeKg <= 0) return;
  if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] RM reserve batchSizeKg=', batchSizeKg, 'bomSource=', bomSource);

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
      existing.quantity += quantity;
    } else {
      rmQuantities.set(rmId, { quantity, unit, code });
    }
  }
  const affectedRmIds = new Set(rmQuantities.keys());
  if (affectedRmIds.size === 0) return;
  if (RESERVE_DEBUG) {
    const perCode = [];
    for (const [rmId, o] of rmQuantities) perCode.push({ rmId, code: o.code, quantity_reserved_X: o.quantity, unit: o.unit });
    console.log('[RESERVE-DEBUG] RM quantities to reserve (X per item):', perCode);
  }
  for (const [rmId, { quantity, unit }] of rmQuantities) {
    await ReservedBatchItem.create({
      production_batch_id: d.id,
      raw_material_id: rmId,
      pack_material_id: null,
      quantity_reserved: quantity,
      unit,
    });
  }
  await syncWarehouseReserved([...affectedRmIds], []);

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
    if (RESERVE_DEBUG) {
      const rmCode = (rmQuantities.get(rid) || {}).code;
      console.log('[RESERVE-DEBUG] RM after reserve', {
        code: rmCode,
        raw_material_id: rid,
        SIH: sih,
        reserved_after_R_plus_X: reservedAfter,
        reserved_delta_this_batch_X: reservedDelta,
        available_Y_minus_X: Math.max(0, sih - reservedAfter),
      });
    }
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
  if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] applyRmReservedToInventory DONE');
}

/**
 * When BPR status transitions to pm_reserved: create reserved_batch_items for PM from BOM,
 * sync warehouse_inventory.reserved, and log reserved change in history with batch id.
 * Idempotent: removes any existing PM reservations for this batch first so repeat runs don't double-count.
 * Inventory: available = SIH - reserved; after reserve X, reserved_new = R + X, available_new = SIH - reserved_new.
 */
async function applyPmReservedToInventory(batchRow) {
  const d = batchRow.get ? batchRow.get({ plain: true }) : batchRow;
  if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] applyPmReservedToInventory START', { production_batch_id: d.id, bpr_no: d.bpr_no });
  // Idempotent: if this batch already has PM reserved_batch_items (e.g. double PATCH), skip to avoid double-counting
  const existingPmCount = await ReservedBatchItem.count({
    where: { production_batch_id: d.id, raw_material_id: null },
  });
  if (existingPmCount > 0) {
    if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] applyPmReservedToInventory SKIP (already has', existingPmCount, 'PM reserved_batch_items)');
    return;
  }
  // Remove existing PM reserved_batch_items for this batch so we don't double-count on repeat transition
  await ReservedBatchItem.destroy({
    where: { production_batch_id: d.id, raw_material_id: null },
  });

  const { pmLines: bomPmLines, source: bomSource, batchSizeKg: planningBatchSizeKg } = await getBomLinesForBatch(d);
  if (!Array.isArray(bomPmLines) || bomPmLines.length === 0) {
    console.warn('[production] pm_reserved: no BOM pm_lines for batch', d.bpr_no);
    return;
  }
  // When using planning batch BOM, use its size_kg for units; else match frontend formula
  const totalBatches = Number(d.total_batches) || 0;
  const orderQty = Number(d.order_qty) || 0;
  const batchSizeUnits = (bomSource === 'planning_batch' && planningBatchSizeKg != null && planningBatchSizeKg > 0)
    ? Math.round(planningBatchSizeKg)
    : (totalBatches > 0 ? Math.ceil(orderQty / totalBatches) : (Number(d.batch_size) || orderQty || 1));
  if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] PM reserve batchSizeUnits=', batchSizeUnits, 'bomSource=', bomSource);

  // Aggregate by pack_material_id so same PM in multiple BOM lines is one reserved row (SIH - reserved = available)
  const pmQuantities = new Map(); // pmId -> { quantity, unit, code }
  for (const line of bomPmLines) {
    const code = line.pm_code || line.pmCode || line.code;
    if (!code) continue;
    const pm = await PackMaterial.findOne({ where: { code } });
    if (!pm) continue;
    const pmId = pm.id;
    const qtyPerUnit = line.qty_per_unit != null ? Number(line.qty_per_unit) : (line.quantity != null ? Number(line.quantity) : 1);
    const quantity = qtyPerUnit * batchSizeUnits;
    if (quantity <= 0) continue;
    const unit = line.uom || 'PCS';
    const existing = pmQuantities.get(pmId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      pmQuantities.set(pmId, { quantity, unit, code });
    }
  }
  const affectedPmIds = new Set(pmQuantities.keys());
  if (affectedPmIds.size === 0) return;
  if (RESERVE_DEBUG) {
    const perCode = [];
    for (const [pmId, o] of pmQuantities) perCode.push({ pmId, code: o.code, quantity_reserved_X: o.quantity, unit: o.unit });
    console.log('[RESERVE-DEBUG] PM quantities to reserve (X per item):', perCode);
  }
  for (const [pmId, { quantity, unit }] of pmQuantities) {
    await ReservedBatchItem.create({
      production_batch_id: d.id,
      raw_material_id: null,
      pack_material_id: pmId,
      quantity_reserved: quantity,
      unit,
    });
  }
  await syncWarehouseReserved([], [...affectedPmIds]);

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
    if (RESERVE_DEBUG) {
      const pmCode = (pmQuantities.get(pid) || {}).code;
      console.log('[RESERVE-DEBUG] PM after reserve', {
        code: pmCode,
        pack_material_id: pid,
        SIH: sih,
        reserved_after_R_plus_X: reservedAfter,
        reserved_delta_this_batch_X: reservedDelta,
        available_Y_minus_X: Math.max(0, sih - reservedAfter),
      });
    }
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
  if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] applyPmReservedToInventory DONE');
}

async function updateBatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProductionBatch.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Batch not found' });
    const prevPlain = row.get ? row.get({ plain: true }) : row;
    const prevBmrStatus = prevPlain.bmr_status;
    const prevBprStatus = prevPlain.bpr_status;
    if (RESERVE_DEBUG && (req.body.bmr_status === 'rm_reserved' || req.body.bpr_status === 'pm_reserved')) {
      console.log('[RESERVE-DEBUG] updateBatch PATCH body (reserve):', {
        production_batch_id: id,
        bmr_status: req.body.bmr_status,
        bpr_status: req.body.bpr_status,
        rmReserved: req.body.rmReserved,
        pmReserved: req.body.pmReserved,
      });
    }
    applyBatchBody(row, req.body);
    await recomputeBatchVolume(row);
    await row.save();
    const nextPlain = row.get ? row.get({ plain: true }) : row;
    if (prevBmrStatus !== 'rm_reserved' && nextPlain.bmr_status === 'rm_reserved') {
      if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] updateBatch: transition to rm_reserved -> applyRmReservedToInventory');
      await applyRmReservedToInventory(row);
    }
    if (prevBprStatus !== 'pm_reserved' && nextPlain.bpr_status === 'pm_reserved') {
      if (RESERVE_DEBUG) console.log('[RESERVE-DEBUG] updateBatch: transition to pm_reserved -> applyPmReservedToInventory');
      await applyPmReservedToInventory(row);
    }
    if (prevBprStatus !== 'fg_ready' && nextPlain.bpr_status === 'fg_ready') {
      await applyBprFgReadyToInventory(row);
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
    res.json(formatBatch(row));
  } catch (err) {
    console.error('updateBatch error:', err);
    res.status(500).json({ error: 'Failed to update batch' });
  }
}

async function deleteBatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProductionBatch.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Batch not found' });
    await row.destroy();
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
      return { rmLines, pmLines, source, batchSizeKg: plain.size_kg != null ? Number(plain.size_kg) : null };
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

  if (soNorm && (d.sku || d.product_name)) {
    let productId = null;
    if (d.sku) {
      const prod = await Product.findOne({ where: { product_sku: d.sku }, attributes: ['product_id'] });
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
            return { rmLines, pmLines, source, batchSizeKg: plain.size_kg != null ? Number(plain.size_kg) : null };
          }
          if (BOM_DEBUG) console.log('[BOM-DEBUG] Inference: no PlanningBatch row for plan.id=', plan.id, 'sequence=', seq);
        }
      }
    }
  }

  // 3) Fallback: product master BOM (items master list).
  if (source === 'product_bom') {
    let product = null;
    if (d.sku) product = await Product.findOne({ where: { product_sku: d.sku } });
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

  if (BOM_DEBUG) console.log('[BOM-DEBUG] RESULT: source=', source, 'rmLines=', rmLines.length, 'pmLines=', pmLines.length);
  return { rmLines, pmLines, source, batchSizeKg: null };
}

/**
 * GET /batches/:id/bom — BOM for this production batch.
 * Prefer batch-specific BOM from planning_batches (when batch was sent from Planning with edited BOM).
 * Fallback: product master BOM from boms table.
 */
async function getBatchBom(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const batch = await ProductionBatch.findByPk(id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const d = batch.get ? batch.get({ plain: true }) : batch;
    if (BOM_DEBUG) console.log('[BOM-DEBUG] GET /batches/:id/bom called with production_batch id=', id, 'bmr_no=', d.bmr_no, 'so_no=', d.so_no);
    const { rmLines, pmLines, source, batchSizeKg } = await getBomLinesForBatch(d);
    if (BOM_DEBUG) console.log('[BOM-DEBUG] GET /batches/:id/bom response: source=', source, 'rmLines=', rmLines.length, 'pmLines=', pmLines.length);
    res.json({
      success: true,
      data: { rmLines, pmLines, source, batchSizeKg: batchSizeKg ?? undefined },
    });
  } catch (err) {
    console.error('getBatchBom error', err);
    res.status(500).json({ success: false, error: 'Failed to fetch batch BOM' });
  }
}

module.exports = {
  listEquipment, getEquipmentById, createEquipment, updateEquipment, deleteEquipment,
  listTeam, getTeamMemberById, createTeamMember, updateTeamMember, deleteTeamMember,
  listBatches, getBatchById, createBatch, createRworkBatch, updateBatch, deleteBatch, getBatchBom, syncBatchesFromPlanning,
  computeRequiredVolumeLiters,
  applyRmReservedToInventory,
  applyPmReservedToInventory,
  applyBprFgReadyToInventory,
};
