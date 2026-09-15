/**
 * Rack-level WH stock: list all warehouse racks per zone and set absolute qty_wh per rack.
 */
const { Op } = require('sequelize');
const WarehouseInventory = require('./models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { recalculateInventoryForItem } = require('./inventoryMath');
const { mergeLocationTokens } = require('./locationTokensMerge');
const { getManufacturingLocationLabels } = require('../facilityAreas/defaultLocationService');
const {
  filterWarehouseZonesForItemType,
  isWarehouseLocationAllowedForItemType,
} = require('./warehouseLocationByItemType');
const { resolveWhUnit } = require('./whUnitDefaults');
const { activeRowWhere } = require('../lib/softDelete');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

async function loadAllWarehouseZonesWithRacks() {
  return WarehouseLocation.findAll({
    where: { location_type: 'warehouse' },
    order: [['id', 'ASC']],
    include: [
      {
        model: WarehouseRack,
        as: 'WarehouseRacks',
        required: false,
      },
    ],
  });
}

/**
 * Build stock-by-location payload including every warehouse rack (qty 0 if empty).
 */
async function buildStockByLocationPayload(warehouseInventoryId) {
  const inv = await WarehouseInventory.findByPk(warehouseInventoryId);
  if (!inv) return null;
  const plain = inv.get ? inv.get({ plain: true }) : inv;

  const rackItems = await WarehouseRackItem.findAll({
    where: activeRowWhere({ warehouse_inventory_id: warehouseInventoryId }),
    include: [
      {
        model: WarehouseRack,
        as: 'WarehouseRack',
        required: true,
        include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: true }],
      },
    ],
  });

  const qtyByRackId = new Map();
  for (const it of rackItems) {
    const rPlain = it.WarehouseRack.get ? it.WarehouseRack.get({ plain: true }) : it.WarehouseRack;
    const itPlain = it.get ? it.get({ plain: true }) : it;
    if (rPlain && rPlain.id) qtyByRackId.set(rPlain.id, toNum(itPlain.qty_wh));
  }

  const itemType = String(plain.item_type || '').trim().toUpperCase() || null;
  const whUnitResolved = resolveWhUnit(plain.wh_unit, itemType);

  const whZones = await loadAllWarehouseZonesWithRacks();
  const warehouseAll = [];

  for (const loc of whZones) {
    const locPlain = loc.get ? loc.get({ plain: true }) : loc;
    const racksRaw = locPlain.WarehouseRacks || [];
    const racks = racksRaw
      .map((r) => {
        const rp = r.get ? r.get({ plain: true }) : r;
        const qtyWh = qtyByRackId.get(rp.id) || 0;
        return {
          rackId: rp.id,
          rackCode: rp.code,
          rackName: rp.name || rp.code,
          qtyWh,
        };
      })
      .sort((a, b) => String(a.rackCode).localeCompare(String(b.rackCode)));

    const totalQtyWh = racks.reduce((s, r) => s + r.qtyWh, 0);
    warehouseAll.push({
      locationId: locPlain.id,
      locationCode: locPlain.code,
      locationName: locPlain.name,
      locationType: 'warehouse',
      isDefault: locPlain.is_default === true,
      racks,
      totalQtyWh,
    });
  }

  const warehouse = filterWarehouseZonesForItemType(warehouseAll, itemType);

  const manufacturingZones = [];
  const prodZones = await WarehouseLocation.findAll({
    where: { location_type: 'production' },
    order: [['id', 'ASC']],
    include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
  });
  for (const loc of prodZones) {
    const locPlain = loc.get ? loc.get({ plain: true }) : loc;
    const racks = (locPlain.WarehouseRacks || [])
      .map((r) => {
        const rp = r.get ? r.get({ plain: true }) : r;
        const qtyWh = qtyByRackId.get(rp.id) || 0;
        return {
          rackId: rp.id,
          rackCode: rp.code,
          rackName: rp.name || rp.code,
          qtyWh,
        };
      })
      .sort((a, b) => String(a.rackCode).localeCompare(String(b.rackCode)));
    const totalQtyWh = racks.reduce((s, x) => s + x.qtyWh, 0);
    manufacturingZones.push({
      locationId: locPlain.id,
      locationCode: locPlain.code,
      locationName: locPlain.name,
      locationType: 'production',
      isDefault: locPlain.is_default === true,
      racks,
      totalQtyWh,
    });
  }

  const muLabels = await getManufacturingLocationLabels();
  const ml1Qty = toNum(plain.ml1_stock);
  const ml2Qty = toNum(plain.ml2_stock);
  const whTotal = toNum(plain.wh_stock);
  const rackWhSum = warehouse.reduce((s, l) => s + l.totalQtyWh, 0);

  const manufacturing = [
    {
      bucket: 'ML1',
      label: 'Manufacturing — ML1',
      qty: ml1Qty,
      unit: whUnitResolved,
      locationId: muLabels.ml1.locationId,
      locationCode: muLabels.ml1.locationCode,
      locationName: muLabels.ml1.locationName,
      isDefault: muLabels.ml1.isDefault,
    },
    {
      bucket: 'ML2',
      label: 'Manufacturing — ML2',
      qty: ml2Qty,
      unit: whUnitResolved,
      locationId: muLabels.ml2.locationId,
      locationCode: muLabels.ml2.locationCode,
      locationName: muLabels.ml2.locationName,
      isDefault: muLabels.ml2.isDefault,
    },
  ];

  const mlRackSum = manufacturingZones.reduce((s, l) => s + l.totalQtyWh, 0);

  return {
    warehouseInventoryId,
    itemType,
    code: plain.code,
    whStock: whTotal,
    whUnit: whUnitResolved,
    stockInHand: toNum(plain.stock_in_hand),
    warehouse,
    manufacturing,
    manufacturingZones,
    ml1Stock: ml1Qty,
    ml2Stock: ml2Qty,
    unallocatedWh: Math.max(0, whTotal - rackWhSum),
    unallocatedMl: Math.max(0, ml1Qty + ml2Qty - mlRackSum),
    defaultProduction: muLabels.defaultProduction,
  };
}

async function syncZoneRackTextFromRackItems(warehouseInventoryId, { transaction } = {}) {
  const inv = await WarehouseInventory.findByPk(warehouseInventoryId, transaction ? { transaction } : {});
  if (!inv) return null;

  const items = await WarehouseRackItem.findAll({
    where: activeRowWhere({ warehouse_inventory_id: warehouseInventoryId }),
    include: [
      {
        model: WarehouseRack,
        as: 'WarehouseRack',
        required: true,
        include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: true }],
      },
    ],
    ...(transaction ? { transaction } : {}),
  });

  let zone = null;
  let rack = null;
  for (const it of items) {
    const r = it.WarehouseRack;
    const loc = r && r.WarehouseLocation;
    const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
    const rPlain = r && r.get ? r.get({ plain: true }) : r;
    const itPlain = it.get ? it.get({ plain: true }) : it;
    if (!locPlain || locPlain.location_type !== 'warehouse') continue;
    if (toNum(itPlain.qty_wh) <= 0) continue;
    zone = mergeLocationTokens(zone, locPlain.name || locPlain.code);
    rack = mergeLocationTokens(rack, rPlain.code);
  }

  await inv.update(
    {
      zone: zone || null,
      rack: rack || null,
    },
    transaction ? { transaction } : {}
  );
  return inv;
}

/**
 * Set absolute qty_wh per warehouse rack for one inventory row.
 * @param {Array<{ rackId: number, qtyWh: number }>} entries
 */
async function clearDisallowedWarehouseRackQty(warehouseInventoryId, itemType, opts = {}) {
  const transaction = opts.transaction;
  const items = await WarehouseRackItem.findAll({
    where: activeRowWhere({ warehouse_inventory_id: warehouseInventoryId }),
    include: [
      {
        model: WarehouseRack,
        as: 'WarehouseRack',
        required: true,
        include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: true }],
      },
    ],
    ...(transaction ? { transaction } : {}),
  });

  for (const it of items) {
    const r = it.WarehouseRack;
    const loc = r && r.WarehouseLocation;
    const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
    if (!locPlain || String(locPlain.location_type || '').toLowerCase() !== 'warehouse') continue;
    if (isWarehouseLocationAllowedForItemType(locPlain.code, itemType)) continue;
    const itPlain = it.get ? it.get({ plain: true }) : it;
    if (toNum(itPlain.qty_wh) <= 0) continue;
    await it.update({ qty_wh: 0 }, transaction ? { transaction } : {});
  }
}

async function setWarehouseRackQuantities(warehouseInventoryId, entries, opts = {}) {
  const transaction = opts.transaction;
  const list = Array.isArray(entries) ? entries : [];

  const invRow = await WarehouseInventory.findByPk(warehouseInventoryId, transaction ? { transaction } : {});
  if (!invRow) return null;
  const invPlain = invRow.get ? invRow.get({ plain: true }) : invRow;
  const itemType = invPlain.item_type;

  for (const row of list) {
    const rackId = parseInt(String(row.rackId ?? row.rack_id), 10);
    const qty = Math.max(0, toNum(row.qtyWh ?? row.qty_wh));
    if (Number.isNaN(rackId)) continue;

    const rack = await WarehouseRack.findByPk(rackId, {
      include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: true }],
      ...(transaction ? { transaction } : {}),
    });
    if (!rack) continue;
    const rPlain = rack.get ? rack.get({ plain: true }) : rack;
    const loc = rPlain.WarehouseLocation;
    const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
    if (!locPlain || locPlain.location_type !== 'warehouse') continue;
    if (!isWarehouseLocationAllowedForItemType(locPlain.code, itemType)) {
      const err = new Error(
        `Rack ${rPlain.code} is not in an allowed warehouse zone for ${itemType} items`
      );
      err.status = 400;
      throw err;
    }

    let item = await WarehouseRackItem.findOne({
      where: activeRowWhere({ rack_id: rackId, warehouse_inventory_id: warehouseInventoryId }),
      ...(transaction ? { transaction } : {}),
    });

    if (qty === 0) {
      if (item) await item.destroy(transaction ? { transaction } : {});
    } else if (!item) {
      await WarehouseRackItem.create(
        { rack_id: rackId, warehouse_inventory_id: warehouseInventoryId, qty_wh: qty },
        transaction ? { transaction } : {}
      );
    } else {
      await item.update({ qty_wh: qty }, transaction ? { transaction } : {});
    }
  }

  await clearDisallowedWarehouseRackQty(warehouseInventoryId, itemType, { transaction });
  const inv = await recalculateInventoryForItem(warehouseInventoryId, { transaction });
  await syncZoneRackTextFromRackItems(warehouseInventoryId, { transaction });
  return inv;
}

module.exports = {
  buildStockByLocationPayload,
  setWarehouseRackQuantities,
  syncZoneRackTextFromRackItems,
};
