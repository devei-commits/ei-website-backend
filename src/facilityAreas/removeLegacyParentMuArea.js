/**
 * Remove obsolete parent manufacturing area `AREA-MU` (0 zones / duplicate umbrella).
 * Canonical layout: AREA-MU-01 (ML1) and AREA-MU-02 (ML2) only.
 */

const FacilityArea = require('./models');
const { WarehouseLocation } = require('../warehouseLocations/models');

const LEGACY_PARENT_CODE = 'AREA-MU';
const MU1_CODE = 'AREA-MU-01';
const MU2_CODE = 'AREA-MU-02';

function zoneTargetsMu2(zone) {
  const code = String(zone.code || '').toUpperCase();
  const label = String(zone.zone_label || '').toUpperCase();
  const name = String(zone.name || '').toUpperCase();
  const blob = `${code} ${label} ${name}`;
  return blob.includes('ML2') || blob.includes('MU02') || blob.includes('MU-02');
}

/**
 * Reassign any zones still on AREA-MU, then delete the parent row when empty.
 * @param {Map<string, number>} [areaIdByCode] optional code → id from a fresh seed pass
 */
async function removeLegacyParentManufacturingArea(areaIdByCode) {
  const legacy = await FacilityArea.findOne({ where: { code: LEGACY_PARENT_CODE } });
  if (!legacy) return { removed: false, migratedZones: 0 };

  let mu1Id = areaIdByCode?.get(MU1_CODE);
  let mu2Id = areaIdByCode?.get(MU2_CODE);
  if (mu1Id == null) {
    const mu1 = await FacilityArea.findOne({ where: { code: MU1_CODE }, attributes: ['id'] });
    mu1Id = mu1?.id ?? null;
  }
  if (mu2Id == null) {
    const mu2 = await FacilityArea.findOne({ where: { code: MU2_CODE }, attributes: ['id'] });
    mu2Id = mu2?.id ?? null;
  }

  const zones = await WarehouseLocation.findAll({ where: { area_id: legacy.id } });
  let migratedZones = 0;
  const now = new Date();

  for (const row of zones) {
    const plain = row.get ? row.get({ plain: true }) : row;
    const targetId = zoneTargetsMu2(plain) ? mu2Id : mu1Id;
    if (targetId == null || Number(targetId) === Number(legacy.id)) continue;
    await row.update({ area_id: targetId, updated_at: now });
    migratedZones += 1;
    console.log(
      `[facility] migrated zone ${plain.code} from ${LEGACY_PARENT_CODE} → ${zoneTargetsMu2(plain) ? MU2_CODE : MU1_CODE}`
    );
  }

  const remaining = await WarehouseLocation.count({ where: { area_id: legacy.id } });
  if (remaining > 0) {
    console.warn(
      `[facility] ${LEGACY_PARENT_CODE} still has ${remaining} zone(s); parent area not deleted`
    );
    return { removed: false, migratedZones };
  }

  await legacy.destroy();
  console.log(`[facility] removed legacy parent manufacturing area ${LEGACY_PARENT_CODE}`);
  return { removed: true, migratedZones };
}

module.exports = {
  LEGACY_PARENT_CODE,
  removeLegacyParentManufacturingArea,
};
