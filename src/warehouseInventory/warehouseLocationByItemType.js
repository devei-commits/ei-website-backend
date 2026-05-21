/**
 * Map warehouse inventory item_type → allowed WH zone codes (LOC-RM / LOC-PM / LOC-FG).
 */

/** @param {'RM'|'PM'|'PR'|string|null|undefined} itemType */
function allowedWarehouseLocationCodes(itemType) {
  const t = String(itemType || '')
    .trim()
    .toUpperCase();
  if (t === 'RM') return ['LOC-RM'];
  if (t === 'PM') return ['LOC-PM'];
  if (t === 'PR') return ['LOC-FG'];
  return null;
}

function isWarehouseLocationAllowedForItemType(locationCode, itemType) {
  const allowed = allowedWarehouseLocationCodes(itemType);
  if (!allowed) return true;
  const code = String(locationCode || '')
    .trim()
    .toUpperCase();
  return allowed.some((a) => a === code);
}

/** Human label for UI hints. */
function warehouseStoreLabelForItemType(itemType) {
  const t = String(itemType || '')
    .trim()
    .toUpperCase();
  if (t === 'RM') return 'RM Store (LOC-RM)';
  if (t === 'PM') return 'Packaging / PM Store (LOC-PM)';
  if (t === 'PR') return 'Finished goods store (LOC-FG)';
  return 'Warehouse';
}

/**
 * @param {Array<{ locationCode?: string }>} warehouseZones
 * @param {'RM'|'PM'|'PR'|string} itemType
 */
function filterWarehouseZonesForItemType(warehouseZones, itemType) {
  const allowed = allowedWarehouseLocationCodes(itemType);
  if (!allowed) return warehouseZones;
  const set = new Set(allowed.map((c) => c.toUpperCase()));
  return (warehouseZones || []).filter((loc) =>
    set.has(
      String(loc.locationCode || '')
        .trim()
        .toUpperCase()
    )
  );
}

module.exports = {
  allowedWarehouseLocationCodes,
  isWarehouseLocationAllowedForItemType,
  warehouseStoreLabelForItemType,
  filterWarehouseZonesForItemType,
};
