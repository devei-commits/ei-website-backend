/**
 * Custom GRN warehouse put-away: find or create zone under main warehouse, then rack in that zone.
 */
const { Op } = require('sequelize');
const FacilityArea = require('./models');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');

const WH_CUSTOM_AREA_CODE = 'WH-CUSTOM';
const MAIN_WAREHOUSE_AREA_CODES = ['AREA-WH', 'WH-MAIN'];

function slugifyZoneCode(text) {
  const s = String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'ZONE';
}

/**
 * @returns {Promise<import('sequelize').Model|null>}
 */
async function findMainWarehouseArea(opts = {}) {
  const transaction = opts.transaction;
  for (const code of MAIN_WAREHOUSE_AREA_CODES) {
    // eslint-disable-next-line no-await-in-loop
    const area = await FacilityArea.findOne({
      where: { code, area_type: 'warehouse' },
      ...(transaction ? { transaction } : {}),
    });
    if (area) return area;
  }

  const whCustom = await FacilityArea.findOne({
    where: { code: WH_CUSTOM_AREA_CODE },
    ...(transaction ? { transaction } : {}),
  });
  const excludeId = whCustom ? Number(whCustom.id) : null;

  return FacilityArea.findOne({
    where: {
      area_type: 'warehouse',
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    order: [['id', 'ASC']],
    ...(transaction ? { transaction } : {}),
  });
}

/**
 * @param {string} zoneText
 * @param {string} rackText
 * @param {{ transaction?: import('sequelize').Transaction }} [opts]
 * @returns {Promise<{
 *   areaId: number,
 *   zoneId: number,
 *   rackId: number,
 *   zoneCode: string,
 *   zoneName: string,
 *   rackCode: string,
 *   locationPrefix: string,
 *   locationZone: string,
 *   createdZone: boolean,
 *   createdRack: boolean,
 * }|null>}
 */
async function ensureWarehouseZoneAndRack(zoneText, rackText, opts = {}) {
  const zoneTxt = String(zoneText || '').trim();
  const rackTxt = String(rackText || '').trim();
  if (!zoneTxt || !rackTxt) return null;

  const area = await findMainWarehouseArea(opts);
  if (!area) {
    const err = new Error(
      'No main warehouse area found. Create a warehouse facility area in Facility Management first.'
    );
    err.status = 400;
    throw err;
  }

  const zoneSlug = slugifyZoneCode(zoneTxt);
  const zoneSlugLower = zoneSlug.toLowerCase();
  const zoneNameLower = zoneTxt.toLowerCase();

  const zonesInWh = await WarehouseLocation.findAll({
    where: { area_id: area.id, location_type: 'warehouse' },
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  });

  let zone =
    zonesInWh.find((l) => {
      const codeLower = String(l.code || '').toLowerCase();
      const nameLower = String(l.name || '').toLowerCase();
      const labelLower = String(l.zone_label || '').toLowerCase();
      return codeLower === zoneSlugLower || nameLower === zoneNameLower || labelLower === zoneNameLower;
    }) || null;

  const createdZone = !zone;
  if (!zone) {
    let candidate = zoneSlug;
    let n = 1;
    while (n <= 50) {
      // eslint-disable-next-line no-await-in-loop
      const clash = await WarehouseLocation.findOne({
        where: { code: candidate },
        ...(opts.transaction ? { transaction: opts.transaction } : {}),
      });
      if (!clash) break;
      n += 1;
      candidate = `${zoneSlug}-${n}`;
    }
    zone = await WarehouseLocation.create(
      {
        code: candidate,
        name: zoneTxt,
        zone_label: zoneTxt,
        area_id: area.id,
        location_type: 'warehouse',
        description: 'Created from custom GRN put-away zone entry.',
        is_default: false,
        is_active: true,
      },
      opts.transaction ? { transaction: opts.transaction } : {}
    );
  }

  const racks = await WarehouseRack.findAll({
    where: { location_id: zone.id },
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  });
  const rackLower = rackTxt.toLowerCase();
  let rack = racks.find((r) => String(r.code || '').toLowerCase() === rackLower) || null;
  const createdRack = !rack;
  if (!rack) {
    rack = await WarehouseRack.create(
      {
        location_id: zone.id,
        code: rackTxt,
        name: null,
        description: 'Created from custom GRN put-away rack entry.',
        levels: 4,
        slots_total: 16,
      },
      opts.transaction ? { transaction: opts.transaction } : {}
    );
  }

  const zonePlain = zone.get ? zone.get({ plain: true }) : zone;
  const rackPlain = rack.get ? rack.get({ plain: true }) : rack;
  const zoneName = String(zonePlain.zone_label || zonePlain.name || zonePlain.code || '').trim();
  const rackCode = String(rackPlain.code || '').trim();

  return {
    areaId: Number(area.id),
    zoneId: Number(zonePlain.id),
    rackId: Number(rackPlain.id),
    zoneCode: String(zonePlain.code || '').trim(),
    zoneName,
    rackCode,
    locationPrefix: rackCode,
    locationZone: zoneName,
    createdZone,
    createdRack,
  };
}

module.exports = {
  ensureWarehouseZoneAndRack,
  findMainWarehouseArea,
  slugifyZoneCode,
};
