/**
 * Warehouse Inventory API — list (with RM/PM/PR + item groups) and PATCH for adjust stock.
 * stock_in_hand = wh_stock + ml1_stock + ml2_stock (computed).
 * In-transit breakdown and PO quantity derived from GRNs and Purchase Orders.
 */
const WarehouseInventory = require('./models');
const WarehouseInventoryLocationHistory = require('./locationHistoryModel');
const { recalculateInventoryForItem } = require('./inventoryMath');
const { logLocationMovement, logReservedChange } = require('./locationHistoryHelpers');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const ItemGroup = require('../itemGroups/models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { Op } = require('sequelize');
const GoodsReceivedNote = require('../grn/models');
const PurchaseOrder = require('../purchaseOrders/models');

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

/** In-transit = GRNs with status 'In Transit' (stuff coming to us, pending GRN). Returns Map<itemKey, [{ vendor, poId, poNo, expectedDate, quantity }]>. */
async function getInTransitBreakdown() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: { [Op.in]: ['In Transit', 'Under GRN', 'Pending', 'Delayed', 'On Hold'] } },
      attributes: ['id', 'vendor', 'purchase_order_id', 'po_no', 'expected_date', 'line_items'],
    });
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const vendor = d.vendor || '';
      const poId = d.purchase_order_id != null ? d.purchase_order_id : null;
      const poNo = d.po_no || '';
      const expectedDate = d.expected_date || null;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      for (const line of lines) {
        const qty = toNum(line.poQty ?? line.quantity ?? line.qty);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ vendor, poId, poNo, expectedDate, quantity: qty });
      }
    }
  } catch (err) {
    console.warn('[warehouse-inventory] getInTransitBreakdown error:', err.message);
  }
  return map;
}

/** PO quantity = sum of quantities from all purchase_orders.items by raw_material_id / pack_material_id. Returns Map<itemKey, number>. */
async function getPoQuantityByItem() {
  const map = new Map();
  try {
    const pos = await PurchaseOrder.findAll({ attributes: ['id', 'items'] });
    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      const items = Array.isArray(d.items) ? d.items : [];
      for (const line of items) {
        const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        map.set(key, (map.get(key) || 0) + qty);
      }
    }
  } catch (err) {
    console.warn('[warehouse-inventory] getPoQuantityByItem error:', err.message);
  }
  return map;
}

/**
 * GET /api/v1/warehouse-inventory
 * Returns { rows, itemGroups }. Each row has id (e.g. rm-1), code, name, subtitle, type, itemGroupNames, itemGroupCodes,
 * warehouseInventoryId, zone, rack, whStock, whUnit, ml1Stock, ml2Stock, stockInHand (computed), reserved, inTransit, inTransitBreakdown, poQuantity, reorderPt, avgMo, status.
 */
async function list(req, res) {
  try {
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
      const payload = await listPayload({ limit, offset });
      const total = await WarehouseInventory.count();
      console.log(
        '[warehouse-inventory] GET list (paginated): rows=%d, total=%d, itemGroups=%d',
        payload.rows.length,
        total,
        payload.itemGroups.length
      );
      return res.json({ rows: payload.rows, total, limit, offset, itemGroups: payload.itemGroups });
    }

    const payload = await listPayload();
    console.log(
      '[warehouse-inventory] GET list: rows=%d, itemGroups=%d',
      payload.rows.length,
      payload.itemGroups.length
    );
    res.json(payload);
  } catch (err) {
    console.error('[warehouse-inventory] GET list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list warehouse inventory' });
  }
}

/**
 * PATCH /api/v1/warehouse-inventory/:id
 * Body: { wh_stock?, ml1_stock?, ml2_stock?, reserved?, in_transit?, zone?, rack?, qc_status? }
 * Recomputes stock_in_hand = wh_stock + ml1_stock + ml2_stock.
 *
 * NOTE: Manual Adjust Stock is considered aggregate-level; per-rack quantities remain as-is for now.
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
    const wh = row.get ? row.get({ plain: true }) : row;
    const body = req.body || {};
    const updates = {};
    const prevZone = wh.zone || null;
    const prevRack = wh.rack || null;

    // For now, manual adjust can tweak aggregate quantities directly.
    let whStock = toNum(wh.wh_stock);
    let ml1Stock = toNum(wh.ml1_stock);
    let ml2Stock = toNum(wh.ml2_stock);

    if (body.wh_stock != null) {
      whStock = Number(body.wh_stock);
      updates.wh_stock = whStock;
    }
    if (body.ml1_stock != null) {
      ml1Stock = Number(body.ml1_stock);
      updates.ml1_stock = ml1Stock;
    }
    if (body.ml2_stock != null) {
      ml2Stock = Number(body.ml2_stock);
      updates.ml2_stock = ml2Stock;
    }
    if (body.reserved != null) updates.reserved = Number(body.reserved);
    if (body.in_transit != null) updates.in_transit = Number(body.in_transit);
    if (body.zone != null) updates.zone = String(body.zone);
    if (body.rack != null) updates.rack = String(body.rack);
    if (body.qc_status != null) updates.qc_status = String(body.qc_status);

    updates.stock_in_hand = whStock + ml1Stock + ml2Stock;

    // If storage location changed, record history for traceability
    const nextZone = updates.zone != null ? updates.zone : prevZone;
    const nextRack = updates.rack != null ? updates.rack : prevRack;
    const locationChanged =
      (prevZone || nextZone) && (prevZone !== nextZone || prevRack !== nextRack);

    if (locationChanged) {
      await logLocationMovement({
        warehouseInventoryId: wh.id,
        itemType: wh.item_type,
        rawMaterialId: wh.raw_material_id,
        packMaterialId: wh.pack_material_id,
        productId: wh.product_id,
        fromZone: prevZone,
        fromRack: prevRack,
        toZone: nextZone,
        toRack: nextRack,
        qtyDelta: null,
        actionType: 'MANUAL_ADJUST',
      });
    }

    await row.update(updates);
    const updatedRow = await WarehouseInventory.findByPk(id);
    const updated = updatedRow.get ? updatedRow.get({ plain: true }) : updatedRow;
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

/**
 * GET /api/v1/warehouse-inventory/:id/location-history
 * Returns chronological history of internal moves (zone/rack changes) for a given warehouse_inventory row.
 */
async function listLocationHistory(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }

    const rows = await WarehouseInventoryLocationHistory.findAll({
      where: { warehouse_inventory_id: id },
      order: [['moved_at', 'DESC']],
    });

    const history = rows.map((r) => {
      const h = r.get ? r.get({ plain: true }) : r;
      return {
        id: h.id,
        warehouseInventoryId: h.warehouse_inventory_id,
        itemType: h.item_type,
        rawMaterialId: h.raw_material_id,
        packMaterialId: h.pack_material_id,
        productId: h.product_id,
        fromZone: h.from_zone,
        fromRack: h.from_rack,
        toZone: h.to_zone,
        toRack: h.to_rack,
        movedAt: h.moved_at,
        reservedDelta: h.reserved_delta != null ? Number(h.reserved_delta) : null,
        reservedAfter: h.reserved_after != null ? Number(h.reserved_after) : null,
        productionBatchId: h.production_batch_id ?? null,
        batchNo: h.batch_no ?? null,
        actionType: h.action_type ?? null,
        qtyDelta: h.qty_delta != null ? Number(h.qty_delta) : null,
        dispensingBundleId: h.dispensing_bundle_id ?? null,
      };
    });

    return res.json({ history });
  } catch (err) {
    // If the history table doesn't exist yet, fail gracefully with empty history
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (
      code === '42P01' ||
      /warehouse_inventory_location_history/i.test(msg) ||
      /relation "warehouse_inventory_location_history" does not exist/i.test(msg)
    ) {
      console.warn('[warehouse-inventory] location-history table missing, returning empty history');
      return res.json({ history: [] });
    }

    console.error('[warehouse-inventory] GET location-history error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch location history' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/location-history
 * Returns consolidated history of internal moves for all items (RM/PM/PR), newest first.
 * Used by the Inventory History tab to show an itemised movement log.
 */
async function listAllLocationHistory(req, res) {
  try {
    const rows = await WarehouseInventoryLocationHistory.findAll({
      order: [['moved_at', 'DESC']],
    });

    const plain = rows.map((r) => (r.get ? r.get({ plain: true }) : r));

    const rmIds = [
      ...new Set(
        plain
          .filter((h) => h.item_type === 'RM' && h.raw_material_id != null)
          .map((h) => h.raw_material_id)
      ),
    ];
    const pmIds = [
      ...new Set(
        plain
          .filter((h) => h.item_type === 'PM' && h.pack_material_id != null)
          .map((h) => h.pack_material_id)
      ),
    ];
    const productIds = [
      ...new Set(
        plain
          .filter((h) => h.item_type === 'PR' && h.product_id != null)
          .map((h) => h.product_id)
      ),
    ];

    const [rms, pms, products] = await Promise.all([
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds } }) : [],
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds } }) : [],
      productIds.length ? Product.findAll({ where: { product_id: productIds } }) : [],
    ]);

    const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    const pmMap = new Map(pms.map((p) => [p.id, p.get ? p.get({ plain: true }) : p]));
    const productMap = new Map(
      products.map((p) => [p.product_id, p.get ? p.get({ plain: true }) : p])
    );

    const history = plain.map((h) => {
      let code = '';
      let name = '';
      let subtitle = '';

      if (h.item_type === 'RM' && h.raw_material_id) {
        const m = rmMap.get(h.raw_material_id);
        if (m) {
          code = m.code;
          name = m.name || m.code;
          subtitle = `${m.inci || m.name || ''} · ${m.uom || 'KG'}`;
        }
      } else if (h.item_type === 'PM' && h.pack_material_id) {
        const m = pmMap.get(h.pack_material_id);
        if (m) {
          code = m.code;
          name = m.description || m.code;
          subtitle = `${m.material || m.type || ''} · ${m.size_spec || '—'}`;
        }
      } else if (h.item_type === 'PR' && h.product_id) {
        const m = productMap.get(h.product_id);
        if (m) {
          code = m.product_code || '';
          name = m.product_name || '';
          subtitle = (m.category ? `${m.category} · ` : '') + 'PR';
        }
      }

      return {
        id: h.id,
        warehouseInventoryId: h.warehouse_inventory_id,
        itemType: h.item_type,
        rawMaterialId: h.raw_material_id,
        packMaterialId: h.pack_material_id,
        productId: h.product_id,
        fromZone: h.from_zone,
        fromRack: h.from_rack,
        toZone: h.to_zone,
        toRack: h.to_rack,
        qtyDelta: h.qty_delta,
        actionType: h.action_type,
        sourceGrnId: h.source_grn_id,
        sourceMrnId: h.source_mrn_id,
        movedAt: h.moved_at,
        reservedDelta: h.reserved_delta != null ? Number(h.reserved_delta) : null,
        reservedAfter: h.reserved_after != null ? Number(h.reserved_after) : null,
        productionBatchId: h.production_batch_id ?? null,
        batchNo: h.batch_no ?? null,
        code,
        name,
        subtitle,
        dispensingBundleId: h.dispensing_bundle_id ?? null,
      };
    });

    return res.json({ history });
  } catch (err) {
    // Same graceful behaviour as per-item endpoint if table is missing
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (
      code === '42P01' ||
      /warehouse_inventory_location_history/i.test(msg) ||
      /relation "warehouse_inventory_location_history" does not exist/i.test(msg)
    ) {
      console.warn(
        '[warehouse-inventory] all location-history table missing, returning empty history'
      );
      return res.json({ history: [] });
    }

    console.error('[warehouse-inventory] GET all location-history error:', err);
    res
      .status(500)
      .json({ error: err.message || 'Failed to fetch consolidated location history' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/:id/rack-locations
 * Returns list of { locationId, locationCode, locationName, rackId, rackCode } where this inventory item is stored.
 */
async function getRackLocations(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }
    const inv = await WarehouseInventory.findByPk(id);
    if (!inv) {
      return res.status(404).json({ error: 'Warehouse inventory row not found' });
    }
    const items = await WarehouseRackItem.findAll({
      where: { warehouse_inventory_id: id },
      include: [
        {
          model: WarehouseRack,
          as: 'WarehouseRack',
          required: true,
          include: [
            {
              model: WarehouseLocation,
              as: 'WarehouseLocation',
              required: true,
              attributes: ['id', 'code', 'name'],
            },
          ],
        },
      ],
    });
    const locations = items.map((it) => {
      const rack = it.WarehouseRack;
      const loc = rack && rack.WarehouseLocation ? rack.WarehouseLocation : null;
      const rPlain = rack && rack.get ? rack.get({ plain: true }) : rack;
      const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
      return {
        locationId: locPlain && locPlain.id,
        locationCode: locPlain && locPlain.code,
        locationName: locPlain && locPlain.name,
        rackId: rPlain && rPlain.id,
        rackCode: rPlain && rPlain.code,
      };
    });
    res.json({ locations });
  } catch (err) {
    console.error('[warehouse-inventory] GET rack-locations error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch rack locations' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/low-threshold-alerts
 * Returns inventory rows where stock_in_hand <= reorder_pt (and reorder_pt > 0). For planning team dashboard.
 */
async function listLowThresholdAlerts(req, res) {
  try {
    const payload = await listPayload();
    const rows = (payload.rows || []).filter(
      (r) => r.reorderPt > 0 && r.stockInHand <= r.reorderPt
    );
    res.json({ rows });
  } catch (err) {
    console.error('[warehouse-inventory] listLowThresholdAlerts error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch low threshold alerts' });
  }
}

/** Call list logic and return the payload without sending response (for internal use). */
async function listPayload() {
  const pagination = arguments.length > 0 && arguments[0] ? arguments[0] : null;
  const paginationOpts = pagination && typeof pagination === 'object' ? pagination : null;

  try {
    const { syncWarehouseInTransitAll } = require('./inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[warehouse-inventory] syncWarehouseInTransitAll failed:', e && e.message ? e.message : e);
  }

  const whRows = await WarehouseInventory.findAll({
    order: [
      ['item_type', 'ASC'],
      ['raw_material_id', 'ASC'],
      ['pack_material_id', 'ASC'],
      ['product_id', 'ASC'],
    ],
    ...(paginationOpts && paginationOpts.limit != null ? { limit: paginationOpts.limit } : {}),
    ...(paginationOpts && paginationOpts.offset != null ? { offset: paginationOpts.offset } : {}),
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
  const [inTransitByItem, poQtyByItem] = await Promise.all([getInTransitBreakdown(), getPoQuantityByItem()]);
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
      const itemKey = `rm-${wh.raw_material_id}`;
      const breakdown = inTransitByItem.get(itemKey) || [];
      rows.push({
        id: itemKey,
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
        inTransitBreakdown: breakdown,
        poQuantity: poQtyByItem.get(itemKey) || 0,
        reorderPt,
        avgMo: toNum(wh.avg_mo),
        status,
      });
    } else if (wh.item_type === 'PM' && wh.pack_material_id) {
      const m = pmMap.get(wh.pack_material_id);
      if (!m) continue;
      const groupList = pmGroupMap.get(wh.pack_material_id) || [];
      const itemKey = `pm-${wh.pack_material_id}`;
      const breakdown = inTransitByItem.get(itemKey) || [];
      rows.push({
        id: itemKey,
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
        inTransitBreakdown: breakdown,
        poQuantity: poQtyByItem.get(itemKey) || 0,
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
        inTransitBreakdown: [],
        poQuantity: 0,
        reorderPt,
        avgMo: toNum(wh.avg_mo),
        status,
      });
    }
  }
  const itemGroups = groups.map((g) => {
    const d = g.get ? g.get({ plain: true }) : g;
    return { id: String(d.id), code: d.code, name: d.name, type: d.type, member_ids: Array.isArray(d.member_ids) ? d.member_ids : [] };
  });
  return { rows, itemGroups };
}

/**
 * GET /api/v1/warehouse-inventory/usage-stats
 * Returns usage (consumption) per item: avg per day, week, month, quarter, year, and all-time total.
 * Derived from warehouse_inventory_location_history where qty_delta < 0 (outbound/consumption).
 */
async function listUsageStats(req, res) {
  try {
    const rows = await WarehouseInventoryLocationHistory.findAll({
      where: { qty_delta: { [Op.lt]: 0 } },
      attributes: ['item_type', 'raw_material_id', 'pack_material_id', 'product_id', 'qty_delta', 'moved_at'],
      order: [['moved_at', 'ASC']],
    });
    const key = (r) => {
      const h = r.get ? r.get({ plain: true }) : r;
      return `${h.item_type}|${h.raw_material_id ?? ''}|${h.pack_material_id ?? ''}|${h.product_id ?? ''}`;
    };
    const byItem = new Map();
    for (const r of rows) {
      const h = r.get ? r.get({ plain: true }) : r;
      const k = key(r);
      const qty = -toNum(h.qty_delta);
      const at = h.moved_at ? new Date(h.moved_at).getTime() : null;
      if (!byItem.has(k)) byItem.set(k, { itemType: h.item_type, rawMaterialId: h.raw_material_id, packMaterialId: h.pack_material_id, productId: h.product_id, total: 0, firstAt: at, lastAt: at });
      const rec = byItem.get(k);
      rec.total += qty;
      if (at != null) {
        if (rec.firstAt == null || at < rec.firstAt) rec.firstAt = at;
        if (rec.lastAt == null || at > rec.lastAt) rec.lastAt = at;
      }
    }
    const rmIds = [...new Set([...byItem.values()].filter((x) => x.rawMaterialId).map((x) => x.rawMaterialId))];
    const pmIds = [...new Set([...byItem.values()].filter((x) => x.packMaterialId).map((x) => x.packMaterialId))];
    const productIds = [...new Set([...byItem.values()].filter((x) => x.productId).map((x) => x.productId))];
    const [rms, pms, products] = await Promise.all([
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'] }) : [],
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : [],
      productIds.length ? Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_code', 'product_name'] }) : [],
    ]);
    const rmMap = new Map(rms.map((r) => { const d = r.get ? r.get({ plain: true }) : r; return [d.id, d]; }));
    const pmMap = new Map(pms.map((p) => { const d = p.get ? p.get({ plain: true }) : p; return [d.id, d]; }));
    const productMap = new Map(products.map((p) => { const d = p.get ? p.get({ plain: true }) : p; return [d.product_id, d]; }));
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const out = [];
    for (const [k, rec] of byItem) {
      const total = rec.total;
      const firstAt = rec.firstAt != null ? rec.firstAt : now;
      const lastAt = rec.lastAt != null ? rec.lastAt : now;
      const spanMs = Math.max(lastAt - firstAt, 0);
      const days = Math.max(spanMs / msPerDay, 1);
      const weeks = Math.max(days / 7, 1 / 7);
      const months = Math.max(days / 30, 1 / 30);
      const quarters = Math.max(days / 90, 1 / 90);
      const years = Math.max(days / 365, 1 / 365);
      let id = '';
      let code = '';
      let name = '';
      if (rec.itemType === 'RM' && rec.rawMaterialId != null) {
        const m = rmMap.get(rec.rawMaterialId);
        id = `rm-${rec.rawMaterialId}`;
        code = m ? m.code : '';
        name = m ? (m.name || m.code) : '';
      } else if (rec.itemType === 'PM' && rec.packMaterialId != null) {
        const m = pmMap.get(rec.packMaterialId);
        id = `pm-${rec.packMaterialId}`;
        code = m ? m.code : '';
        name = m ? (m.description || m.code) : '';
      } else if (rec.itemType === 'PR' && rec.productId != null) {
        const m = productMap.get(rec.productId);
        id = `pr-${rec.productId}`;
        code = m ? m.product_code : '';
        name = m ? m.product_name : '';
      } else {
        id = k;
      }
      out.push({
        id,
        code,
        name,
        type: rec.itemType || 'RM',
        avgDay: Math.round((total / days) * 10000) / 10000,
        avgWeek: Math.round((total / weeks) * 10000) / 10000,
        avgMonth: Math.round((total / months) * 10000) / 10000,
        avgQuarter: Math.round((total / quarters) * 10000) / 10000,
        avgYear: Math.round((total / years) * 10000) / 10000,
        totalAllTime: Math.round(total * 10000) / 10000,
      });
    }
    out.sort((a, b) => (a.code || a.id).localeCompare(b.code || b.id));
    res.json({ rows: out });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (code === '42P01' || /warehouse_inventory_location_history/i.test(msg)) {
      return res.json({ rows: [] });
    }
    console.error('[warehouse-inventory] listUsageStats error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch usage stats' });
  }
}

module.exports = { list, listPayload, updateStock, listLocationHistory, listAllLocationHistory, getRackLocations, listLowThresholdAlerts, listUsageStats };
