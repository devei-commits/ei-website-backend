/**
 * Warehouse zone visibility and rack edits for inventory (RM / PM / PR).
 * All warehouse zones are shown for every item type; inbound GRN uses the facility
 * default warehouse zone (warehouse_locations.is_default for location_type = warehouse).
 */

/** @returns {null} null = no zone-code restriction */
function allowedWarehouseLocationCodes(_itemType) {
  return null;
}

function isWarehouseLocationAllowedForItemType(_locationCode, _itemType) {
  return true;
}

/** Human label for UI hints. */
function warehouseStoreLabelForItemType(_itemType) {
  return 'Warehouse zones';
}

/**
 * @param {Array<{ locationCode?: string }>} warehouseZones
 * @param {'RM'|'PM'|'PR'|string} [_itemType]
 */
function filterWarehouseZonesForItemType(warehouseZones, _itemType) {
  return warehouseZones || [];
}

module.exports = {
  allowedWarehouseLocationCodes,
  isWarehouseLocationAllowedForItemType,
  warehouseStoreLabelForItemType,
  filterWarehouseZonesForItemType,
};
