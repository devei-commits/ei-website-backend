/**
 * Default warehouse / manufacturing zones and inbound stock routing.
 */
const db = require('../../db');
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('../warehouseLocations/models');
const WarehouseInventory = require('../warehouseInventory/models');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

const DEFAULT_RACK_CODE = 'DEFAULT';

/** ML1 vs ML2 bucket from a production zone (code / name / label). */
function inferMlBucketFromProductionZone(locPlain) {
  if (!locPlain) return 'ml1';
  const blob = `${locPlain.code || ''} ${locPlain.name || ''} ${locPlain.zone_label || ''}`.toUpperCase();
  if (blob.includes('ML2') || blob.includes('MU02')) return 'ml2';
  return 'ml1';
}

/** Map MRN MU receive zone code to ml1_stock vs ml2_stock column. */
function muZoneCodeToMlBucket(zoneCode) {
  if (!zoneCode || typeof zoneCode !== 'string') return 'ml1';
  const z = String(zoneCode).trim().toUpperCase();
  if (z.includes('ML2') || z === 'LOC-ML2' || z.includes('MU02')) return 'ml2';
  return 'ml1';
}

/** Human label for batch scheduled_mu_zone bucket. */
function muBucketLabelForZone(zoneCode) {
  return muZoneCodeToMlBucket(zoneCode) === 'ml2' ? 'ML2' : 'ML1';
}

/** ML1 or ML2 aggregate column for a zone code (fast path when rack rows are not used). */
function muStockQtyFromPlain(plainWh, muZoneCode) {
  const bucket = muZoneCodeToMlBucket(muZoneCode);
  return bucket === 'ml2' ? toNum(plainWh?.ml2_stock) : toNum(plainWh?.ml1_stock);
}

/**
 * Qty at batch manufacturing site = ML1 or ML2 bucket column (warehouse_inventory aggregate).
 * Matches physical ML1/ML2 stock in DB — no rounding; rack rows roll up into these columns.
 */
async function getStockQtyAtMuZone(warehouseInventoryId, muZoneCode, opts = {}) {
  const str = await getStockQtyStrAtMuZone(warehouseInventoryId, muZoneCode, opts);
  return toNum(str);
}

/** Same as getStockQtyAtMuZone but preserves DECIMAL string from Postgres. */
async function getStockQtyStrAtMuZone(warehouseInventoryId, muZoneCode, opts = {}) {
  const zoneCode = String(muZoneCode || '').trim();
  if (!zoneCode || !warehouseInventoryId) return '0';
  const transaction = opts.transaction;
  const bucket = muZoneCodeToMlBucket(zoneCode);
  const inv = await WarehouseInventory.findByPk(
    warehouseInventoryId,
    transaction ? { transaction } : {}
  );
  if (!inv) return '0';
  const plain = inv.get ? inv.get({ plain: true }) : inv;
  const raw = bucket === 'ml2' ? plain?.ml2_stock : plain?.ml1_stock;
  if (raw == null) return '0';
  return typeof raw === 'string' ? raw.trim() || '0' : String(raw);
}

async function ensureDefaultRackForLocation(locationId, opts = {}) {
  const transaction = opts.transaction;
  let rack = await WarehouseRack.findOne({
    where: { location_id: locationId, code: DEFAULT_RACK_CODE },
    ...(transaction ? { transaction } : {}),
  });
  if (!rack) {
    rack = await WarehouseRack.create(
      {
        location_id: locationId,
        code: DEFAULT_RACK_CODE,
        name: 'Default storage',
        description: 'Auto-created for default location inbound stock',
        levels: 4,
        slots_total: 16,
      },
      transaction ? { transaction } : {}
    );
  }
  return rack;
}

/**
 * @returns {Promise<{ location: object, rack: object }|null>}
 */
async function getDefaultLocationForType(locationType, opts = {}) {
  const transaction = opts.transaction;
  const type = String(locationType || '').trim().toLowerCase();
  if (type !== 'warehouse' && type !== 'production') return null;

  const location = await WarehouseLocation.findOne({
    where: { location_type: type, is_default: true },
    ...(transaction ? { transaction } : {}),
  });
  if (!location) return null;

  const rack = await ensureDefaultRackForLocation(location.id, { transaction });
  const locPlain = location.get ? location.get({ plain: true }) : location;
  const rackPlain = rack.get ? rack.get({ plain: true }) : rack;
  return { location: locPlain, rack: rackPlain };
}

/**
 * Clear other defaults for the same location_type and mark this zone as default.
 */
async function setDefaultLocation(locationId, opts = {}) {
  const run = async (transaction) => {
    const loc = await WarehouseLocation.findByPk(locationId, { transaction });
    if (!loc) {
      const err = new Error('Location not found');
      err.status = 404;
      throw err;
    }
    const plain = loc.get ? loc.get({ plain: true }) : loc;
    const type = plain.location_type;

    await WarehouseLocation.update(
      { is_default: false },
      {
        where: { location_type: type, is_default: true },
        transaction,
      }
    );
    await loc.update({ is_default: true }, { transaction });
    const rack = await ensureDefaultRackForLocation(loc.id, { transaction });
    return {
      location: loc.get ? loc.get({ plain: true }) : loc,
      rack: rack.get ? rack.get({ plain: true }) : rack,
    };
  };

  if (opts.transaction) return run(opts.transaction);
  return db.transaction(run);
}

/**
 * Resolve rack for GRN / inbound WH stock using the facility default warehouse zone.
 */
async function resolveInboundWarehouseRack(_itemIds, opts = {}) {
  const def = await getDefaultLocationForType('warehouse', opts);
  if (!def) return null;

  return {
    locationId: def.location.id,
    locationCode: def.location.code,
    locationName: def.location.name,
    locationType: 'warehouse',
    rackId: def.rack.id,
    rackCode: def.rack.code,
    source: 'facility_default',
  };
}

/**
 * Labels for ML1 / ML2 manufacturing buckets (uses default production zone when set).
 */
async function getManufacturingLocationLabels(opts = {}) {
  const defProd = await getDefaultLocationForType('production', opts);
  const prodZones = await WarehouseLocation.findAll({
    where: { location_type: 'production' },
    attributes: ['id', 'code', 'name', 'zone_label', 'is_default'],
    order: [['id', 'ASC']],
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  });

  const pickForMu = (muKey) => {
    const key = String(muKey || '').toUpperCase();
    for (const z of prodZones) {
      const p = z.get ? z.get({ plain: true }) : z;
      if (inferMlBucketFromProductionZone(p) === key.toLowerCase()) {
        return {
          locationId: p.id,
          locationCode: p.code,
          locationName: p.name,
          isDefault: p.is_default === true,
        };
      }
      const blob = `${p.code || ''} ${p.name || ''} ${p.zone_label || ''}`.toUpperCase();
      if (blob.includes(key)) {
        return {
          locationId: p.id,
          locationCode: p.code,
          locationName: p.name,
          isDefault: p.is_default === true,
        };
      }
    }
    if (defProd) {
      return {
        locationId: defProd.location.id,
        locationCode: defProd.location.code,
        locationName: defProd.location.name,
        isDefault: true,
      };
    }
    return { locationId: null, locationCode: null, locationName: key, isDefault: false };
  };

  return {
    ml1: pickForMu('ML1'),
    ml2: pickForMu('ML2'),
    defaultProduction: defProd
      ? {
          locationId: defProd.location.id,
          locationCode: defProd.location.code,
          locationName: defProd.location.name,
        }
      : null,
  };
}

/**
 * Resolve production zone + rack for MTR receive (WH → MU) or reverse.
 * Priority: explicit zone/rack codes → DEFAULT rack on zone → facility default production zone.
 */
async function resolveProductionRackForTransfer({ zoneCode, rackCode }, opts = {}) {
  const transaction = opts.transaction;
  const zCode = String(zoneCode || '').trim();
  let zone = null;

  if (zCode) {
    zone = await WarehouseLocation.findOne({
      where: { code: zCode, location_type: 'production' },
      ...(transaction ? { transaction } : {}),
    });
  }
  if (!zone) {
    const def = await getDefaultLocationForType('production', opts);
    if (def) {
      zone = await WarehouseLocation.findByPk(def.location.id, transaction ? { transaction } : {});
    }
  }
  if (!zone) return null;

  const zPlain = zone.get ? zone.get({ plain: true }) : zone;

  if (rackCode) {
    const rc = String(rackCode).trim();
    const rack = await WarehouseRack.findOne({
      where: { location_id: zPlain.id, code: rc },
      ...(transaction ? { transaction } : {}),
    });
    if (rack) {
      const rPlain = rack.get ? rack.get({ plain: true }) : rack;
      return {
        locationId: zPlain.id,
        locationCode: zPlain.code,
        locationName: zPlain.name,
        locationType: 'production',
        rackId: rPlain.id,
        rackCode: rPlain.code,
        mlBucket: inferMlBucketFromProductionZone(zPlain),
        source: 'explicit_rack',
      };
    }
  }

  const rack = await ensureDefaultRackForLocation(zPlain.id, { transaction });
  const rPlain = rack.get ? rack.get({ plain: true }) : rack;
  return {
    locationId: zPlain.id,
    locationCode: zPlain.code,
    locationName: zPlain.name,
    locationType: 'production',
    rackId: rPlain.id,
    rackCode: rPlain.code,
    mlBucket: inferMlBucketFromProductionZone(zPlain),
    source: 'zone_default_rack',
  };
}

module.exports = {
  DEFAULT_RACK_CODE,
  ensureDefaultRackForLocation,
  getDefaultLocationForType,
  setDefaultLocation,
  resolveInboundWarehouseRack,
  resolveProductionRackForTransfer,
  getManufacturingLocationLabels,
  inferMlBucketFromProductionZone,
  muZoneCodeToMlBucket,
  muBucketLabelForZone,
  muStockQtyFromPlain,
  getStockQtyAtMuZone,
  getStockQtyStrAtMuZone,
};
