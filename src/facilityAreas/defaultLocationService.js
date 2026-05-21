/**
 * Default warehouse / manufacturing zones and inbound stock routing.
 */
const { Op } = require('sequelize');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');
const ItemDedicatedFacilityLocation = require('../itemDedicatedFacilityLocations/models');
const { resolveDedicatedProductionCodes } = require('../itemDedicatedFacilityLocations/service');

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
  const transaction = opts.transaction;
  const loc = await WarehouseLocation.findByPk(locationId, transaction ? { transaction } : {});
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
      ...(transaction ? { transaction } : {}),
    }
  );
  await loc.update({ is_default: true }, transaction ? { transaction } : {});
  const rack = await ensureDefaultRackForLocation(loc.id, { transaction });
  return {
    location: loc.get ? loc.get({ plain: true }) : loc,
    rack: rack.get ? rack.get({ plain: true }) : rack,
  };
}

async function findDedicatedWhRack({ rawMaterialId, packMaterialId, productId }, opts = {}) {
  const transaction = opts.transaction;
  const or = [];
  if (rawMaterialId != null) or.push({ raw_material_id: Number(rawMaterialId) });
  if (packMaterialId != null) or.push({ pack_material_id: Number(packMaterialId) });
  if (productId != null) or.push({ product_id: Number(productId) });
  if (or.length === 0) return null;

  const row = await ItemDedicatedFacilityLocation.findOne({
    where: { [Op.or]: or },
    ...(transaction ? { transaction } : {}),
  });
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  if (!d.wh_location_id) return null;

  const zone = await WarehouseLocation.findByPk(d.wh_location_id, transaction ? { transaction } : {});
  if (!zone) return null;
  const zPlain = zone.get ? zone.get({ plain: true }) : zone;
  if (String(zPlain.location_type || '').toLowerCase() !== 'warehouse') return null;

  let rack = null;
  if (d.wh_rack_id) {
    rack = await WarehouseRack.findByPk(d.wh_rack_id, transaction ? { transaction } : {});
    const rPlain = rack && rack.get ? rack.get({ plain: true }) : rack;
    if (rPlain && Number(rPlain.location_id) !== Number(zPlain.id)) rack = null;
  }
  if (!rack) {
    rack = await ensureDefaultRackForLocation(zPlain.id, { transaction });
  }
  const rPlain = rack.get ? rack.get({ plain: true }) : rack;
  return {
    locationId: zPlain.id,
    locationCode: zPlain.code,
    locationName: zPlain.name,
    locationType: 'warehouse',
    rackId: rPlain.id,
    rackCode: rPlain.code,
    source: 'item_dedicated',
  };
}

/**
 * Resolve rack for GRN / inbound WH stock: item dedicated WH rack, else facility default warehouse zone.
 */
async function resolveInboundWarehouseRack(itemIds, opts = {}) {
  const dedicated = await findDedicatedWhRack(itemIds, opts);
  if (dedicated) return dedicated;

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
 * Priority: explicit zone/rack codes → item dedicated prod rack (zone must match) → DEFAULT rack on zone → facility default production zone.
 */
async function resolveProductionRackForTransfer({ zoneCode, rackCode, lineItems }, opts = {}) {
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
  const items = Array.isArray(lineItems) ? lineItems : [];

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

  if (items.length > 0) {
    const { prodZoneCode, prodRackCode, ok } = await resolveDedicatedProductionCodes(items);
    if (ok && prodZoneCode && prodZoneCode === zPlain.code && prodRackCode) {
      const rack = await WarehouseRack.findOne({
        where: { location_id: zPlain.id, code: prodRackCode },
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
          source: 'item_dedicated',
        };
      }
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
  findDedicatedWhRack,
  resolveInboundWarehouseRack,
  resolveProductionRackForTransfer,
  getManufacturingLocationLabels,
  inferMlBucketFromProductionZone,
  muZoneCodeToMlBucket,
};
