/**
 * Ensures exactly one is_default zone per location_type (warehouse | production).
 * GRN inbound uses the warehouse default; MTR fallback uses the production default.
 */
const { WarehouseLocation } = require('../warehouseLocations/models');
const {
  setDefaultLocation,
  ensureDefaultRackForLocation,
} = require('./defaultLocationService');

/** Preferred zone when none is marked default (or when deduping multiple defaults). */
const PREFERRED_DEFAULT_CODE = {
  warehouse: 'LOC-RM',
  production: 'LOC-ML1',
};

function plainRow(row) {
  return row && row.get ? row.get({ plain: true }) : row;
}

function pickWinner(rows, locationType) {
  const preferred = PREFERRED_DEFAULT_CODE[locationType];
  if (preferred) {
    const hit = rows.find((r) => plainRow(r).code === preferred);
    if (hit) return hit;
  }
  return rows.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
}

/**
 * @param {'warehouse'|'production'} locationType
 * @returns {Promise<{ code: string, id: number, changed: boolean }|null>}
 */
async function ensureSingleDefaultLocationPerType(locationType) {
  const type = String(locationType || '').trim().toLowerCase();
  if (type !== 'warehouse' && type !== 'production') return null;

  const all = await WarehouseLocation.findAll({
    where: { location_type: type },
    order: [['id', 'ASC']],
  });
  if (all.length === 0) return null;

  const defaults = all.filter((z) => plainRow(z).is_default === true);

  if (defaults.length === 1) {
    await ensureDefaultRackForLocation(defaults[0].id);
    const p = plainRow(defaults[0]);
    return { id: p.id, code: p.code, changed: false };
  }

  const pool = defaults.length > 1 ? defaults : all;
  const winner = pickWinner(pool, type);
  await setDefaultLocation(winner.id);
  const p = plainRow(winner);
  return { id: p.id, code: p.code, changed: true };
}

async function ensureFacilityDefaultLocations() {
  const warehouse = await ensureSingleDefaultLocationPerType('warehouse');
  const production = await ensureSingleDefaultLocationPerType('production');
  return { warehouse, production };
}

module.exports = {
  ensureSingleDefaultLocationPerType,
  ensureFacilityDefaultLocations,
  PREFERRED_DEFAULT_CODE,
};
