/**
 * Default warehouse display UOM when warehouse_inventory.wh_unit is empty.
 */
function defaultWhUnitForItemType(itemType) {
  const t = String(itemType || '').trim().toUpperCase();
  if (t === 'PM') return 'PCS';
  return 'KG';
}

function resolveWhUnit(whUnit, itemType) {
  const u = whUnit != null ? String(whUnit).trim() : '';
  return u || defaultWhUnitForItemType(itemType);
}

/** Canonical count UOM for all packaging materials (master, warehouse, production). */
const PM_CANONICAL_UNIT = 'PCS';

/**
 * PM warehouse display UOM — always PCS (see scripts/syncPmUnitsToPcs.js).
 */
function resolvePmWhUnit(_warehouseWhUnit, _packMaterialUnit) {
  return PM_CANONICAL_UNIT;
}

module.exports = {
  PM_CANONICAL_UNIT,
  defaultWhUnitForItemType,
  resolveWhUnit,
  resolvePmWhUnit,
};
