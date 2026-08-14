const { Op } = require('sequelize');
const UniversalSwapHistory = require('./models');
const RawMaterial = require('../rawMaterials/models');
const ItemGroup = require('../itemGroups/models');
const BOM = require('../bom/models');
const { Product } = require('../products/models');
const { applySwapRatioToPct } = require('../lib/swapRatio');
const { applySwapToPlanning } = require('./applySwapToPlanning');

function toIntList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((x) => (typeof x === 'number' ? x : parseInt(x, 10))).filter((n) => !Number.isNaN(n));
  const n = typeof val === 'number' ? val : parseInt(val, 10);
  return Number.isNaN(n) ? [] : [n];
}

/** Returns true if this BOM line refers to the from-ingredient (by rm_code, code, or raw_material_id). */
function lineIsFromIngredient(line, fromCode, fromRawMaterialId) {
  const code = String(line.rm_code ?? line.rmCode ?? line.code ?? '').trim();
  if (code && code === String(fromCode || '').trim()) return true;
  const rmId = line.raw_material_id != null ? parseInt(line.raw_material_id, 10) : NaN;
  if (!Number.isNaN(rmId) && rmId === fromRawMaterialId) return true;
  return false;
}

function formatSwapRow(row, fromRm = null, toRm = null) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    fromRawMaterialId: d.from_raw_material_id,
    toRawMaterialId: d.to_raw_material_id,
    fromIngredient: fromRm ? (fromRm.name || fromRm.code) : '',
    toIngredient: toRm ? (toRm.name || toRm.code) : '',
    swapRatio: d.swap_ratio != null ? Number(d.swap_ratio) : 1,
    reason: d.reason || '',
    approvedBy: d.approved_by || '',
    status: d.status || 'applied',
    date: d.created_at ? new Date(d.created_at).toISOString().split('T')[0] : '',
    affectedGroupIds: Array.isArray(d.affected_group_ids) ? d.affected_group_ids : [],
    affectedBomIds: Array.isArray(d.affected_bom_ids) ? d.affected_bom_ids : [],
    createdAt: d.created_at,
  };
}

/**
 * Helper for mapping BOM rows + products to a compact PR BOM descriptor.
 */
function mapBomsWithProducts(boms, products) {
  const productMap = new Map(
    products.map((p) => {
      const plain = p.get ? p.get({ plain: true }) : p;
      return [plain.product_id, plain];
    })
  );

  return boms.map((bom) => {
    const plain = bom.get ? bom.get({ plain: true }) : bom;
    const product = productMap.get(plain.product_id);
    const productName = product ? (product.product_name || product.product_code || '') : '';
    return {
      id: String(plain.id),
      bom_code: plain.bom_code,
      name: plain.name || plain.bom_code,
      product_id: plain.product_id,
      product_name: productName,
    };
  });
}

/**
 * GET /api/v1/universal-swap/affected?fromRawMaterialId=1
 * Returns item_groups and PR BOMs (formulas) that contain the from raw material (for "Apply to" list).
 */
async function getAffected(req, res) {
  try {
    const fromRawMaterialId = parseInt(req.query.fromRawMaterialId ?? req.query.from_raw_material_id, 10);
    if (Number.isNaN(fromRawMaterialId) || fromRawMaterialId < 1) {
      return res.status(400).json({ error: 'fromRawMaterialId is required' });
    }
    const fromRm = await RawMaterial.findByPk(fromRawMaterialId);
    const fromCode = fromRm ? (fromRm.get ? fromRm.get({ plain: true }) : fromRm).code || '' : '';

    const [allGroups, prBoms] = await Promise.all([
      ItemGroup.findAll({ where: { type: 'RM' }, order: [['code', 'ASC']] }),
      BOM.findAll({ where: { product_id: { [Op.ne]: null } }, order: [['bom_code', 'ASC']] }),
    ]);

    const itemGroups = allGroups.filter((g) => {
      const plain = g.get ? g.get({ plain: true }) : g;
      return toIntList(plain.member_ids).includes(fromRawMaterialId);
    });

    const bomsContainingFrom = prBoms.filter((bom) => {
      const rmLines = Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
      return rmLines.some((line) => lineIsFromIngredient(line, fromCode, fromRawMaterialId));
    });

    const productIds = [...new Set(bomsContainingFrom.map((b) => (b.get ? b.get({ plain: true }) : b).product_id).filter(Boolean))];
    const products = productIds.length
      ? await Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_name', 'product_code'] })
      : [];

    res.json({
      itemGroups: itemGroups.map((g) => {
        const plain = g.get ? g.get({ plain: true }) : g;
        return { id: String(plain.id), code: plain.code, name: plain.name || plain.description || plain.code, type: plain.type, member_ids: toIntList(plain.member_ids) };
      }),
      boms: mapBomsWithProducts(bomsContainingFrom, products),
    });
  } catch (err) {
    console.error('getAffected error', err);
    res.status(500).json({ error: 'Failed to get affected item groups and PR BOMs' });
  }
}

/**
 * GET /api/v1/universal-swap/history — list swap history with from/to RM names.
 */
async function listHistory(req, res) {
  try {
    const rows = await UniversalSwapHistory.findAll({
      order: [['created_at', 'DESC']],
    });
    const fromIds = [...new Set(rows.map((r) => r.get?.({ plain: true })?.from_raw_material_id).filter(Boolean))];
    const toIds = [...new Set(rows.map((r) => r.get?.({ plain: true })?.to_raw_material_id).filter(Boolean))];
    const allRmIds = [...new Set([...fromIds, ...toIds])];
    const rms = allRmIds.length ? await RawMaterial.findAll({ where: { id: allRmIds } }) : [];
    const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));

    const list = rows.map((r) => {
      const plain = r.get ? r.get({ plain: true }) : r;
      return formatSwapRow(r, rmMap.get(plain.from_raw_material_id), rmMap.get(plain.to_raw_material_id));
    });

    res.json(list);
  } catch (err) {
    console.error('listHistory error', err);
    res.status(500).json({ error: 'Failed to list swap history' });
  }
}

/**
 * POST /api/v1/universal-swap/apply
 * Body: fromRawMaterialId, toRawMaterialId, swapRatio, reason, approvedBy, selectedGroupIds, selectedBomIds
 * - swapRatio: e.g. 0.9 = 90% of original usage becomes replacement; in BOM, new_pct = pct_w_w * swapRatio, remainder = pct_w_w * (1 - swapRatio).
 * - Updates: item_groups (member_ids), BOM rm_lines (by rm_code with ratio).
 */
/** Parse + normalize the swap inputs from a request body (shared by draft / apply / finalize). */
function parseSwapBody(body = {}) {
  const fromRawMaterialId = parseInt(body.fromRawMaterialId ?? body.from_raw_material_id, 10);
  const toRawMaterialId = parseInt(body.toRawMaterialId ?? body.to_raw_material_id, 10);
  const swapRatio = Math.max(0, Math.min(2, Number(body.swapRatio ?? body.swap_ratio ?? 1)));
  const approvedByUserId = body.approvedByUserId != null ? parseInt(body.approvedByUserId, 10) : null;
  let selectedGroupIds = body.selectedGroupIds ?? body.affected_group_ids ?? [];
  let selectedBomIds = body.selectedBomIds ?? body.affected_bom_ids ?? [];
  if (!Array.isArray(selectedGroupIds)) selectedGroupIds = [];
  if (!Array.isArray(selectedBomIds)) selectedBomIds = [];
  return {
    fromRawMaterialId,
    toRawMaterialId,
    swapRatio,
    reason: body.reason ?? '',
    approvedBy: body.approvedBy ?? body.approved_by ?? '',
    approvedByUserId: Number.isNaN(approvedByUserId) ? null : approvedByUserId,
    numericGroupIds: selectedGroupIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n)),
    numericBomIds: selectedBomIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n)),
  };
}

/**
 * Execute the swap against item_groups (member_ids) + PR BOM rm_lines (ratio). Pure DB effects — no
 * history row. Returns { updatedGroupsCount, updatedBomsCount }.
 */
async function applySwapEffects({ fromRawMaterialId, toRawMaterialId, swapRatio, numericGroupIds, numericBomIds, fromPlain, toPlain }, { transaction } = {}) {
  const fromCode = fromPlain.code || '';
  const toCode = toPlain.code || '';
  const toInci = toPlain.inci || toPlain.name || toCode;

  let updatedGroupsCount = 0;
  for (const groupId of numericGroupIds) {
    const group = await ItemGroup.findByPk(groupId);
    if (!group || group.type !== 'RM') continue;
    const plain = group.get ? group.get({ plain: true }) : group;
    const memberIds = toIntList(plain.member_ids);
    if (!memberIds.includes(fromRawMaterialId)) continue;
    const newMemberIds = memberIds.map((id) => (id === fromRawMaterialId ? toRawMaterialId : id));
    await group.update({ member_ids: newMemberIds });
    updatedGroupsCount++;
  }

  // Apply ratio swap only to selected PR BOMs that contain the from-ingredient.
  let updatedBomsCount = 0;
  const touchedProductIds = new Set();
  const prBoms = numericBomIds.length > 0
    ? await BOM.findAll({ where: { id: numericBomIds, product_id: { [Op.ne]: null } } })
    : [];
  for (const bom of prBoms) {
    const rmLines = Array.isArray(bom.rm_lines) ? [...bom.rm_lines] : [];
    let changed = false;
    const newRmLines = [];
    for (const line of rmLines) {
      if (!lineIsFromIngredient(line, fromCode, fromRawMaterialId)) {
        newRmLines.push(line);
        continue;
      }
      const pct = Number(line.pct_w_w ?? line.pctWw ?? line.pct ?? 0);
      if (pct <= 0) {
        // A 0% line still names a material. Skipping it left the OLD ingredient sitting in the BOM
        // after an approved swap (visible in the BOM editor as "WATER … 0% w/w"), and any later
        // percentage typed against it would have re-introduced the swapped-out material.
        // There is nothing to split, so carry the identity across and keep the percentage at 0.
        changed = true;
        const zeroLine = { ...line, inci_name: toInci, rm_code: toCode, pct_w_w: 0 };
        if (toRawMaterialId != null) zeroLine.raw_material_id = toRawMaterialId;
        if ('zoho_sku_code' in zeroLine) zeroLine.zoho_sku_code = toPlain.zoho_sku_code || toCode;
        if ('code' in zeroLine) zeroLine.code = toCode;
        newRmLines.push(zeroLine);
        continue;
      }
      changed = true;
      const { newPct, remainderPct } = applySwapRatioToPct(pct, swapRatio);
      if (newPct > 0) {
        const newLine = { phase: line.phase, inci_name: toInci, rm_code: toCode, pct_w_w: newPct, uom: line.uom || 'kg' };
        if (toRawMaterialId != null) newLine.raw_material_id = toRawMaterialId;
        newRmLines.push(newLine);
      }
      if (remainderPct > 0) {
        const remainderLine = { phase: line.phase, inci_name: line.inci_name || line.inciName || fromPlain.inci || fromPlain.name, rm_code: fromCode, pct_w_w: remainderPct, uom: line.uom || 'kg' };
        if (fromRawMaterialId != null) remainderLine.raw_material_id = fromRawMaterialId;
        newRmLines.push(remainderLine);
      }
    }
    if (changed) {
      await bom.update({ rm_lines: newRmLines });
      updatedBomsCount++;
      if (bom.product_id != null) touchedProductIds.add(Number(bom.product_id));
    }
  }

  // Planning keeps its own copies of the formula (planning_extracted.raw_materials and each
  // planning_batches.rm_lines). Updating only the master BOM left every existing plan and batch
  // still naming the swapped-out material, which is what the Plan Batches BOM editor reads.
  const planning = await applySwapToPlanning({
    productIds: [...touchedProductIds],
    fromRawMaterialId,
    toRawMaterialId,
    swapRatio,
    fromPlain,
    toPlain,
  }, { transaction });

  return {
    updatedGroupsCount,
    updatedBomsCount,
    updatedPlanningRows: planning.planningRows,
    updatedPlanningBatches: planning.batches,
    skippedSentBatches: planning.skippedSentBatches,
  };
}

/**
 * POST /api/v1/universal-swap/draft — save a swap as a DRAFT (no changes applied).
 * Stores the from/to/ratio/reason/approver + selected groups & BOMs; finalize later to execute.
 */
async function saveDraft(req, res) {
  try {
    const p = parseSwapBody(req.body);
    if (Number.isNaN(p.fromRawMaterialId) || Number.isNaN(p.toRawMaterialId)) {
      return res.status(400).json({ error: 'fromRawMaterialId and toRawMaterialId are required' });
    }
    const [fromRm, toRm] = await Promise.all([
      RawMaterial.findByPk(p.fromRawMaterialId),
      RawMaterial.findByPk(p.toRawMaterialId),
    ]);
    if (!fromRm) return res.status(400).json({ error: 'From raw material not found' });
    if (!toRm) return res.status(400).json({ error: 'To raw material not found' });
    const row = await UniversalSwapHistory.create({
      from_raw_material_id: p.fromRawMaterialId,
      to_raw_material_id: p.toRawMaterialId,
      swap_ratio: p.swapRatio,
      reason: p.reason,
      approved_by: p.approvedBy,
      approved_by_user_id: p.approvedByUserId,
      affected_group_ids: p.numericGroupIds.length > 0 ? p.numericGroupIds : null,
      affected_bom_ids: p.numericBomIds.length > 0 ? p.numericBomIds : null,
      status: 'draft',
    });
    return res.status(201).json(formatSwapRow(row, fromRm.get ? fromRm.get({ plain: true }) : fromRm, toRm.get ? toRm.get({ plain: true }) : toRm));
  } catch (err) {
    console.error('saveDraft error', err);
    return res.status(500).json({ error: err.message || 'Failed to save draft' });
  }
}

/**
 * POST /api/v1/universal-swap/:id/finalize — execute a saved DRAFT swap (applies BOM/group changes)
 * and mark it applied. Optional body may override the selected groups/BOMs before applying.
 */
async function finalizeSwap(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await UniversalSwapHistory.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Draft not found' });
    const rec = row.get ? row.get({ plain: true }) : row;
    if (rec.status === 'applied') return res.status(409).json({ error: 'This swap is already applied.' });

    const body = req.body || {};
    const swapRatio = body.swapRatio != null || body.swap_ratio != null
      ? Math.max(0, Math.min(2, Number(body.swapRatio ?? body.swap_ratio)))
      : (rec.swap_ratio != null ? Number(rec.swap_ratio) : 1);
    const numericGroupIds = Array.isArray(body.selectedGroupIds ?? body.affected_group_ids)
      ? (body.selectedGroupIds ?? body.affected_group_ids).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n))
      : toIntList(rec.affected_group_ids);
    const numericBomIds = Array.isArray(body.selectedBomIds ?? body.affected_bom_ids)
      ? (body.selectedBomIds ?? body.affected_bom_ids).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n))
      : toIntList(rec.affected_bom_ids);

    const [fromRm, toRm] = await Promise.all([
      RawMaterial.findByPk(rec.from_raw_material_id),
      RawMaterial.findByPk(rec.to_raw_material_id),
    ]);
    if (!fromRm) return res.status(400).json({ error: 'From raw material not found' });
    if (!toRm) return res.status(400).json({ error: 'To raw material not found' });
    const fromPlain = fromRm.get ? fromRm.get({ plain: true }) : fromRm;
    const toPlain = toRm.get ? toRm.get({ plain: true }) : toRm;

    const { updatedGroupsCount, updatedBomsCount } = await applySwapEffects({
      fromRawMaterialId: rec.from_raw_material_id,
      toRawMaterialId: rec.to_raw_material_id,
      swapRatio,
      numericGroupIds,
      numericBomIds,
      fromPlain,
      toPlain,
    });

    await row.update({
      status: 'applied',
      swap_ratio: swapRatio,
      affected_group_ids: numericGroupIds.length > 0 ? numericGroupIds : null,
      affected_bom_ids: numericBomIds.length > 0 ? numericBomIds : null,
    });

    return res.json({ ...formatSwapRow(row, fromPlain, toPlain), updatedGroupsCount, updatedBomsCount });
  } catch (err) {
    console.error('finalizeSwap error', err);
    return res.status(500).json({ error: err.message || 'Failed to finalize swap' });
  }
}

/**
 * POST /api/v1/universal-swap/apply — save + apply in one shot (status='applied'). Kept for direct apply.
 */
async function applySwap(req, res) {
  try {
    const p = parseSwapBody(req.body);
    if (Number.isNaN(p.fromRawMaterialId) || Number.isNaN(p.toRawMaterialId)) {
      return res.status(400).json({ error: 'fromRawMaterialId and toRawMaterialId are required' });
    }
    const [fromRm, toRm] = await Promise.all([
      RawMaterial.findByPk(p.fromRawMaterialId),
      RawMaterial.findByPk(p.toRawMaterialId),
    ]);
    if (!fromRm) return res.status(400).json({ error: 'From raw material not found' });
    if (!toRm) return res.status(400).json({ error: 'To raw material not found' });
    const fromPlain = fromRm.get ? fromRm.get({ plain: true }) : fromRm;
    const toPlain = toRm.get ? toRm.get({ plain: true }) : toRm;

    const historyRow = await UniversalSwapHistory.create({
      from_raw_material_id: p.fromRawMaterialId,
      to_raw_material_id: p.toRawMaterialId,
      swap_ratio: p.swapRatio,
      reason: p.reason,
      approved_by: p.approvedBy,
      approved_by_user_id: p.approvedByUserId,
      affected_group_ids: p.numericGroupIds.length > 0 ? p.numericGroupIds : null,
      affected_bom_ids: p.numericBomIds.length > 0 ? p.numericBomIds : null,
      status: 'applied',
    });

    const { updatedGroupsCount, updatedBomsCount } = await applySwapEffects({
      fromRawMaterialId: p.fromRawMaterialId,
      toRawMaterialId: p.toRawMaterialId,
      swapRatio: p.swapRatio,
      numericGroupIds: p.numericGroupIds,
      numericBomIds: p.numericBomIds,
      fromPlain,
      toPlain,
    });

    return res.status(201).json({ ...formatSwapRow(historyRow, fromPlain, toPlain), updatedGroupsCount, updatedBomsCount });
  } catch (err) {
    console.error('applySwap error', err);
    return res.status(500).json({ error: err.message || 'Failed to apply swap' });
  }
}

/**
 * GET /api/v1/universal-swap/history/:id/affected
 * Returns PR BOMs (with product names) that were affected for a given history row.
 */
async function getHistoryAffected(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid history id' });
    }

    const row = await UniversalSwapHistory.findByPk(id);
    if (!row) {
      return res.status(404).json({ error: 'Swap history entry not found' });
    }

    const plain = row.get ? row.get({ plain: true }) : row;
    const bomIds = toIntList(plain.affected_bom_ids);
    if (!bomIds.length) {
      return res.json({ boms: [] });
    }

    const boms = await BOM.findAll({
      where: { id: bomIds, product_id: { [Op.ne]: null } },
      order: [['bom_code', 'ASC']],
    });
    if (!boms.length) {
      return res.json({ boms: [] });
    }

    const productIds = [...new Set(boms.map((b) => (b.get ? b.get({ plain: true }) : b).product_id).filter(Boolean))];
    const products = productIds.length
      ? await Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_name', 'product_code'] })
      : [];

    const mapped = mapBomsWithProducts(boms, products);
    res.json({ boms: mapped });
  } catch (err) {
    console.error('getHistoryAffected error', err);
    res.status(500).json({ error: 'Failed to load affected PR BOMs for this swap' });
  }
}

module.exports = {
  getAffected,
  listHistory,
  applySwap,
  saveDraft,
  finalizeSwap,
  getHistoryAffected,
  formatSwapRow,
};
