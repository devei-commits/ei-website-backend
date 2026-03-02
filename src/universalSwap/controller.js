const UniversalSwapHistory = require('./models');
const RawMaterial = require('../rawMaterials/models');
const ItemMaster = require('../itemsMaster/models');

function toIntList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((x) => (typeof x === 'number' ? x : parseInt(x, 10))).filter((n) => !Number.isNaN(n));
  const n = typeof val === 'number' ? val : parseInt(val, 10);
  return Number.isNaN(n) ? [] : [n];
}

function formatSwapRow(row, fromRm = null, toRm = null, itemCodes = []) {
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
    affectedItemIds: Array.isArray(d.affected_item_ids) ? d.affected_item_ids : [],
    affectedItemCodes: itemCodes,
    createdAt: d.created_at,
  };
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
    const allItemIds = [...new Set(rows.flatMap((r) => toIntList(r.get?.({ plain: true })?.affected_item_ids)))];
    const [rms, items] = await Promise.all([
      allRmIds.length ? RawMaterial.findAll({ where: { id: allRmIds } }) : [],
      allItemIds.length ? ItemMaster.findAll({ where: { id: allItemIds } }) : [],
    ]);
    const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    const itemMap = new Map(items.map((i) => [i.id, (i.get ? i.get({ plain: true }) : i).code]));

    const list = rows.map((r) => {
      const plain = r.get ? r.get({ plain: true }) : r;
      const codes = (Array.isArray(plain.affected_item_ids) ? plain.affected_item_ids : []).map((id) => itemMap.get(id)).filter(Boolean);
      return formatSwapRow(r, rmMap.get(plain.from_raw_material_id), rmMap.get(plain.to_raw_material_id), codes);
    });

    res.json(list);
  } catch (err) {
    console.error('listHistory error', err);
    res.status(500).json({ error: 'Failed to list swap history' });
  }
}

/**
 * POST /api/v1/universal-swap/apply
 * Body: fromRawMaterialId, toRawMaterialId, swapRatio, reason, approvedBy, selectedItemIds (array of items_master id strings/numbers)
 * Creates a history record and updates each selected item's raw_material_ids (replace from with to).
 */
async function applySwap(req, res) {
  try {
    const body = req.body || {};
    const fromRawMaterialId = parseInt(body.fromRawMaterialId ?? body.from_raw_material_id, 10);
    const toRawMaterialId = parseInt(body.toRawMaterialId ?? body.to_raw_material_id, 10);
    const swapRatio = body.swapRatio ?? body.swap_ratio ?? 1;
    const reason = body.reason ?? '';
    const approvedBy = body.approvedBy ?? body.approved_by ?? '';
    const approvedByUserId = body.approvedByUserId != null ? parseInt(body.approvedByUserId, 10) : null;
    let selectedItemIds = body.selectedItemIds ?? body.affected_item_ids ?? [];
    if (!Array.isArray(selectedItemIds)) selectedItemIds = [];

    if (Number.isNaN(fromRawMaterialId) || Number.isNaN(toRawMaterialId)) {
      return res.status(400).json({ error: 'fromRawMaterialId and toRawMaterialId are required' });
    }

    const numericItemIds = selectedItemIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));

    const [fromRm, toRm] = await Promise.all([
      RawMaterial.findByPk(fromRawMaterialId),
      RawMaterial.findByPk(toRawMaterialId),
    ]);
    if (!fromRm) return res.status(400).json({ error: 'From raw material not found' });
    if (!toRm) return res.status(400).json({ error: 'To raw material not found' });

    const historyRow = await UniversalSwapHistory.create({
      from_raw_material_id: fromRawMaterialId,
      to_raw_material_id: toRawMaterialId,
      swap_ratio: swapRatio,
      reason: reason,
      approved_by: approvedBy,
      approved_by_user_id: Number.isNaN(approvedByUserId) ? null : approvedByUserId,
      affected_item_ids: numericItemIds,
    });

    let updatedCount = 0;
    for (const itemId of numericItemIds) {
      const item = await ItemMaster.findByPk(itemId);
      if (!item) continue;
      const plain = item.get ? item.get({ plain: true }) : item;
      const rmIds = toIntList(plain.raw_material_ids);
      if (!rmIds.includes(fromRawMaterialId)) continue;
      const newRmIds = rmIds.map((id) => (id === fromRawMaterialId ? toRawMaterialId : id));
      await item.update({ raw_material_ids: newRmIds });
      updatedCount++;
    }

    const fromPlain = fromRm.get ? fromRm.get({ plain: true }) : fromRm;
    const toPlain = toRm.get ? toRm.get({ plain: true }) : toRm;
    const formatted = formatSwapRow(historyRow, fromPlain, toPlain);
    res.status(201).json({
      ...formatted,
      updatedItemsCount: updatedCount,
    });
  } catch (err) {
    console.error('applySwap error', err);
    res.status(500).json({ error: err.message || 'Failed to apply swap' });
  }
}

module.exports = {
  listHistory,
  applySwap,
  formatSwapRow,
};
