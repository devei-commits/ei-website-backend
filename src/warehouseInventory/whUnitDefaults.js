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

module.exports = {
  defaultWhUnitForItemType,
  resolveWhUnit,
};
