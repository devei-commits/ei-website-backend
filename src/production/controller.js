const { ProductionEquipment, ProductionTeamMember, ProductionBatch } = require('./models');
const WarehouseInventory = require('../warehouseInventory/models');
const { FulfillmentBatchSplit } = require('../fulfillment/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

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
  };
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
};

function applyBatchBody(row, body) {
  for (const k of BATCH_ALLOWED_FIELDS) {
    if (body[k] !== undefined) row.set(k, body[k]);
  }
  for (const [camel, snake] of Object.entries(BATCH_CAMEL_TO_SNAKE)) {
    if (body[camel] !== undefined) row.set(snake, body[camel]);
  }
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
    res.status(201).json(formatBatch(row));
  } catch (err) {
    console.error('createBatch error:', err);
    res.status(500).json({ error: 'Failed to create batch' });
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

async function updateBatch(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProductionBatch.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Batch not found' });
    const prevPlain = row.get ? row.get({ plain: true }) : row;
    const prevBprStatus = prevPlain.bpr_status;
    applyBatchBody(row, req.body);
    await row.save();
    const nextPlain = row.get ? row.get({ plain: true }) : row;
    if (prevBprStatus !== 'fg_ready' && nextPlain.bpr_status === 'fg_ready') {
      await applyBprFgReadyToInventory(row);
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

module.exports = {
  listEquipment, getEquipmentById, createEquipment, updateEquipment, deleteEquipment,
  listTeam, getTeamMemberById, createTeamMember, updateTeamMember, deleteTeamMember,
  listBatches, getBatchById, createBatch, updateBatch, deleteBatch,
};
