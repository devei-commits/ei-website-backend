/**
 * Warehouse Inventory API — list (with RM/PM/PR + item groups) and PATCH for adjust stock.
 * stock_in_hand = wh_stock + ml1_stock + ml2_stock (computed).
 */
const WarehouseInventory = require('./models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const ItemGroup = require('../itemGroups/models');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function buildMemberToGroupsMap(groups) {
  const map = new Map();
  for (const g of groups) {
    const ids = Array.isArray(g.member_ids) ? g.member_ids : [];
    for (const id of ids) {
      const n = typeof id === 'number' ? id : parseInt(String(id), 10);
      if (Number.isNaN(n)) continue;
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(g);
    }
  }
  return map;
}

/**
 * GET /api/v1/warehouse-inventory
 * Returns { rows, itemGroups }. Each row has id (e.g. rm-1), code, name, subtitle, type, itemGroupNames, itemGroupCodes,
 * warehouseInventoryId, zone, rack, whStock, whUnit, ml1Stock, ml2Stock, stockInHand (computed), reserved, inTransit, reorderPt, avgMo, status.
 */
async function list(req, res) {
  try {
    const whRows = await WarehouseInventory.findAll({
      order: [
        ['item_type', 'ASC'],
        ['raw_material_id', 'ASC'],
        ['pack_material_id', 'ASC'],
        ['product_id', 'ASC'],
      ],
    });
    const rmIds = [...new Set(whRows.map((r) => r.raw_material_id).filter(Boolean))];
    const pmIds = [...new Set(whRows.map((r) => r.pack_material_id).filter(Boolean))];
    const productIds = [...new Set(whRows.map((r) => r.product_id).filter(Boolean))];

    const [rms, pms, products, groups] = await Promise.all([
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds } }) : [],
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds } }) : [],
      productIds.length ? Product.findAll({ where: { product_id: productIds } }) : [],
      ItemGroup.findAll(),
    ]);

    const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    const pmMap = new Map(pms.map((p) => [p.id, p.get ? p.get({ plain: true }) : p]));
    const productMap = new Map(products.map((p) => [p.product_id, p.get ? p.get({ plain: true }) : p]));
    const rmGroupMap = buildMemberToGroupsMap(groups.filter((g) => g.type === 'RM'));
    const pmGroupMap = buildMemberToGroupsMap(groups.filter((g) => g.type === 'PM'));

    const rows = [];
    for (const w of whRows) {
      const wh = w.get ? w.get({ plain: true }) : w;
      const whStock = toNum(wh.wh_stock);
      const ml1Stock = toNum(wh.ml1_stock);
      const ml2Stock = toNum(wh.ml2_stock);
      const stockInHand = whStock + ml1Stock + ml2Stock;
      const reorderPt = toNum(wh.reorder_pt);
      let status = (wh.qc_status || 'In Stock').trim();
      if (status === 'In Stock' && reorderPt > 0) {
        if (stockInHand < reorderPt * 0.5) status = 'Critical';
        else if (stockInHand < reorderPt) status = 'Low Stock';
      }

      if (wh.item_type === 'RM' && wh.raw_material_id) {
        const m = rmMap.get(wh.raw_material_id);
        if (!m) continue;
        const groupList = rmGroupMap.get(wh.raw_material_id) || [];
        rows.push({
          id: `rm-${wh.raw_material_id}`,
          warehouseInventoryId: wh.id,
          code: m.code,
          name: m.name || m.code,
          subtitle: `${m.inci || m.name || ''} · ${m.uom || 'KG'}`,
          type: 'RM',
          sourceId: wh.raw_material_id,
          itemGroupNames: groupList.map((g) => g.name || g.code),
          itemGroupCodes: groupList.map((g) => g.code),
          zone: wh.zone || '—',
          rack: wh.rack || '—',
          whStock,
          whUnit: wh.wh_unit || 'KG',
          ml1Stock,
          ml2Stock,
          stockInHand,
          reserved: toNum(wh.reserved),
          inTransit: toNum(wh.in_transit),
          reorderPt,
          avgMo: toNum(wh.avg_mo),
          status,
        });
      } else if (wh.item_type === 'PM' && wh.pack_material_id) {
        const m = pmMap.get(wh.pack_material_id);
        if (!m) continue;
        const groupList = pmGroupMap.get(wh.pack_material_id) || [];
        rows.push({
          id: `pm-${wh.pack_material_id}`,
          warehouseInventoryId: wh.id,
          code: m.code,
          name: m.description || m.code,
          subtitle: `${m.material || m.type || ''} · ${m.size_spec || '—'}`,
          type: 'PM',
          sourceId: wh.pack_material_id,
          itemGroupNames: groupList.map((g) => g.name || g.code),
          itemGroupCodes: groupList.map((g) => g.code),
          zone: wh.zone || '—',
          rack: wh.rack || '—',
          whStock,
          whUnit: wh.wh_unit || 'PCS',
          ml1Stock,
          ml2Stock,
          stockInHand,
          reserved: toNum(wh.reserved),
          inTransit: toNum(wh.in_transit),
          reorderPt,
          avgMo: toNum(wh.avg_mo),
          status,
        });
      } else if (wh.item_type === 'PR' && wh.product_id) {
        const m = productMap.get(wh.product_id);
        if (!m) continue;
        rows.push({
          id: `pr-${wh.product_id}`,
          warehouseInventoryId: wh.id,
          code: m.product_code || '',
          name: m.product_name || '',
          subtitle: (m.category ? `${m.category} · ` : '') + 'PR',
          type: 'FG/PR',
          sourceId: wh.product_id,
          itemGroupNames: [],
          itemGroupCodes: [],
          zone: wh.zone || '—',
          rack: wh.rack || '—',
          whStock,
          whUnit: wh.wh_unit || 'PCS',
          ml1Stock,
          ml2Stock,
          stockInHand,
          reserved: toNum(wh.reserved),
          inTransit: toNum(wh.in_transit),
          reorderPt,
          avgMo: toNum(wh.avg_mo),
          status,
        });
      }
    }

    const itemGroups = groups.map((g) => {
      const d = g.get ? g.get({ plain: true }) : g;
      return {
        id: String(d.id),
        code: d.code,
        name: d.name,
        type: d.type,
        member_ids: Array.isArray(d.member_ids) ? d.member_ids : [],
      };
    });

    console.log('[warehouse-inventory] GET list: rows=%d, itemGroups=%d', rows.length, itemGroups.length);
    res.json({ rows, itemGroups });
  } catch (err) {
    console.error('[warehouse-inventory] GET list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list warehouse inventory' });
  }
}

/**
 * PATCH /api/v1/warehouse-inventory/:id
 * Body: { wh_stock?, ml1_stock?, ml2_stock?, reserved?, in_transit?, zone?, rack?, qc_status? }
 * Recomputes stock_in_hand = wh_stock + ml1_stock + ml2_stock.
 */
async function updateStock(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }
    const row = await WarehouseInventory.findByPk(id);
    if (!row) {
      return res.status(404).json({ error: 'Warehouse inventory row not found' });
    }
    const body = req.body || {};
    const updates = {};
    if (body.wh_stock != null) updates.wh_stock = Number(body.wh_stock);
    if (body.ml1_stock != null) updates.ml1_stock = Number(body.ml1_stock);
    if (body.ml2_stock != null) updates.ml2_stock = Number(body.ml2_stock);
    if (body.reserved != null) updates.reserved = Number(body.reserved);
    if (body.in_transit != null) updates.in_transit = Number(body.in_transit);
    if (body.zone != null) updates.zone = String(body.zone);
    if (body.rack != null) updates.rack = String(body.rack);
    if (body.qc_status != null) updates.qc_status = String(body.qc_status);

    const wh = row.get ? row.get({ plain: true }) : row;
    const whStock = updates.wh_stock != null ? updates.wh_stock : toNum(wh.wh_stock);
    const ml1Stock = updates.ml1_stock != null ? updates.ml1_stock : toNum(wh.ml1_stock);
    const ml2Stock = updates.ml2_stock != null ? updates.ml2_stock : toNum(wh.ml2_stock);
    updates.stock_in_hand = whStock + ml1Stock + ml2Stock;

    await row.update(updates);
    const updated = row.get ? row.get({ plain: true }) : row;
    console.log('[warehouse-inventory] PATCH id=%d: wh_stock=%s ml1=%s ml2=%s stock_in_hand=%s', id, updated.wh_stock, updated.ml1_stock, updated.ml2_stock, updated.stock_in_hand);
    res.json({
      id: updated.id,
      wh_stock: toNum(updated.wh_stock),
      ml1_stock: toNum(updated.ml1_stock),
      ml2_stock: toNum(updated.ml2_stock),
      stock_in_hand: toNum(updated.stock_in_hand),
      reserved: toNum(updated.reserved),
      in_transit: toNum(updated.in_transit),
      zone: updated.zone,
      rack: updated.rack,
      qc_status: updated.qc_status,
    });
  } catch (err) {
    console.error('[warehouse-inventory] PATCH error:', err);
    res.status(500).json({ error: err.message || 'Failed to update warehouse inventory' });
  }
}

module.exports = { list, updateStock };
