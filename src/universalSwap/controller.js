const { Op } = require('sequelize');
const UniversalSwapHistory = require('./models');
const RawMaterial = require('../rawMaterials/models');
const ItemGroup = require('../itemGroups/models');
const BOM = require('../bom/models');
const { Product } = require('../products/models');

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
    date: d.created_at ? new Date(d.created_at).toISOString().split('T')[0] : '',
    affectedGroupIds: Array.isArray(d.affected_group_ids) ? d.affected_group_ids : [],
    createdAt: d.created_at,
  };
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
    const products = productIds.length ? await Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_name', 'product_code'] }) : [];
    const productMap = new Map(products.map((p) => [p.product_id, p.get ? p.get({ plain: true }) : p]));

    res.json({
      itemGroups: itemGroups.map((g) => {
        const plain = g.get ? g.get({ plain: true }) : g;
        return { id: String(plain.id), code: plain.code, name: plain.name || plain.description || plain.code, type: plain.type, member_ids: toIntList(plain.member_ids) };
      }),
      boms: bomsContainingFrom.map((bom) => {
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
      }),
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
async function applySwap(req, res) {
  try {
    const body = req.body || {};
    const fromRawMaterialId = parseInt(body.fromRawMaterialId ?? body.from_raw_material_id, 10);
    const toRawMaterialId = parseInt(body.toRawMaterialId ?? body.to_raw_material_id, 10);
    const swapRatio = Math.max(0, Math.min(2, Number(body.swapRatio ?? body.swap_ratio ?? 1)));
    const reason = body.reason ?? '';
    const approvedBy = body.approvedBy ?? body.approved_by ?? '';
    const approvedByUserId = body.approvedByUserId != null ? parseInt(body.approvedByUserId, 10) : null;
    let selectedGroupIds = body.selectedGroupIds ?? body.affected_group_ids ?? [];
    let selectedBomIds = body.selectedBomIds ?? body.affected_bom_ids ?? [];
    if (!Array.isArray(selectedGroupIds)) selectedGroupIds = [];
    if (!Array.isArray(selectedBomIds)) selectedBomIds = [];

    if (Number.isNaN(fromRawMaterialId) || Number.isNaN(toRawMaterialId)) {
      return res.status(400).json({ error: 'fromRawMaterialId and toRawMaterialId are required' });
    }

    const numericGroupIds = selectedGroupIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));
    const numericBomIds = selectedBomIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));

    const [fromRm, toRm] = await Promise.all([
      RawMaterial.findByPk(fromRawMaterialId),
      RawMaterial.findByPk(toRawMaterialId),
    ]);
    if (!fromRm) return res.status(400).json({ error: 'From raw material not found' });
    if (!toRm) return res.status(400).json({ error: 'To raw material not found' });
    const fromPlain = fromRm.get ? fromRm.get({ plain: true }) : fromRm;
    const toPlain = toRm.get ? toRm.get({ plain: true }) : toRm;
    const fromCode = fromPlain.code || '';
    const toCode = toPlain.code || '';
    const toInci = toPlain.inci || toPlain.name || toCode;

    const historyRow = await UniversalSwapHistory.create({
      from_raw_material_id: fromRawMaterialId,
      to_raw_material_id: toRawMaterialId,
      swap_ratio: swapRatio,
      reason: reason,
      approved_by: approvedBy,
      approved_by_user_id: Number.isNaN(approvedByUserId) ? null : approvedByUserId,
      affected_group_ids: numericGroupIds.length > 0 ? numericGroupIds : null,
    });

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
          newRmLines.push(line);
          continue;
        }
        changed = true;
        const newPct = Math.round(pct * swapRatio * 100) / 100;
        const remainderPct = Math.round(pct * (1 - swapRatio) * 100) / 100;
        if (newPct > 0) {
          const newLine = {
            phase: line.phase,
            inci_name: toInci,
            rm_code: toCode,
            pct_w_w: newPct,
            uom: line.uom || 'kg',
          };
          if (toRawMaterialId != null) newLine.raw_material_id = toRawMaterialId;
          newRmLines.push(newLine);
        }
        if (remainderPct > 0) {
          const remainderLine = {
            phase: line.phase,
            inci_name: line.inci_name || line.inciName || fromPlain.inci || fromPlain.name,
            rm_code: fromCode,
            pct_w_w: remainderPct,
            uom: line.uom || 'kg',
          };
          if (fromRawMaterialId != null) remainderLine.raw_material_id = fromRawMaterialId;
          newRmLines.push(remainderLine);
        }
      }
      if (changed) {
        await bom.update({ rm_lines: newRmLines });
        updatedBomsCount++;
      }
    }

    const formatted = formatSwapRow(historyRow, fromPlain, toPlain);
    res.status(201).json({
      ...formatted,
      updatedGroupsCount: updatedGroupsCount,
      updatedBomsCount: updatedBomsCount,
    });
  } catch (err) {
    console.error('applySwap error', err);
    res.status(500).json({ error: err.message || 'Failed to apply swap' });
  }
}

module.exports = {
  getAffected,
  listHistory,
  applySwap,
  formatSwapRow,
};
