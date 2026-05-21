/**
 * Map Zoho Inventory → Facility Management:
 *   GET /locations  → facility_areas + nested warehouse_locations
 *   GET /warehouses → enrich/create warehouse_locations (branch_id, is_primary, full address)
 */

const FacilityArea = require('../../src/facilityAreas/models');
const { WarehouseLocation } = require('../../src/warehouseLocations/models');
const { normalizeZohoId } = require('../../src/services/zohoBooks');

function slugifyCode(text, maxLen = 40) {
  const s = String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return s || 'LOC';
}

function zohoAreaCode(locationId) {
  const id = normalizeZohoId(locationId);
  return id ? `ZL-${id}` : null;
}

function zohoWarehouseCode(warehouseId) {
  const id = normalizeZohoId(warehouseId);
  return id ? `ZW-${id}` : null;
}

/** Parent Zoho location id: /warehouses uses branch_id; nested uses parent arg. */
function resolveWarehouseParentLocationId(wh, fallbackParentLocationId) {
  return (
    normalizeZohoId(wh.branch_id) ||
    normalizeZohoId(wh.location_id) ||
    normalizeZohoId(fallbackParentLocationId)
  );
}

function formatAddressLines(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [
    addr.street_address1,
    addr.street_address2,
    addr.city,
    addr.state,
    addr.postal_code,
    addr.country,
  ]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  return parts.join(', ');
}

function buildLocationMeta(loc) {
  return {
    location_id: normalizeZohoId(loc.location_id),
    location_name: loc.location_name || null,
    type: loc.type || null,
    address: loc.address || null,
    is_filing_address: loc.is_filing_address === true,
    is_primary_location: loc.is_primary_location === true,
    is_location_active: loc.is_location_active !== false,
    phone: loc.phone || null,
    email: loc.email || null,
    tax_reg_no: loc.tax_reg_no || null,
    vendor_id: normalizeZohoId(loc.vendor_id),
    vendor_name: loc.vendor_name || null,
    is_storage_location_enabled: loc.is_storage_location_enabled === true,
    total_zones: loc.total_zones || null,
    synced_at: new Date().toISOString(),
    source: 'zoho_inventory_locations',
  };
}

function buildWarehouseMeta(wh, parentLocationId) {
  const branchId = normalizeZohoId(wh.branch_id);
  const parentId = resolveWarehouseParentLocationId(wh, parentLocationId);
  return {
    warehouse_id: normalizeZohoId(wh.warehouse_id),
    warehouse_name: wh.warehouse_name || null,
    zoho_location_id: parentId,
    branch_id: branchId,
    branch_name: wh.branch_name || null,
    is_primary: wh.is_primary === true,
    attention: wh.attention || null,
    address: wh.address || wh.address1 || null,
    address1: wh.address1 || null,
    address2: wh.address2 || null,
    city: wh.city || null,
    state: wh.state || null,
    state_code: wh.state_code || null,
    country: wh.country || null,
    zip: wh.zip || null,
    phone: wh.phone || null,
    email: wh.email || null,
    status: wh.status || null,
    synced_at: new Date().toISOString(),
    source: branchId != null ? 'zoho_inventory_warehouses' : 'zoho_inventory_locations',
  };
}

function buildWarehouseDescription(wh) {
  const lines = [];
  const addr = [wh.address1 || wh.address, wh.address2, wh.city, wh.state, wh.zip, wh.country]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (addr.length) lines.push(addr.join(', '));
  if (wh.branch_name) lines.push(`Branch: ${wh.branch_name}`);
  if (wh.attention) lines.push(`Attention: ${wh.attention}`);
  if (wh.phone) lines.push(`Phone: ${wh.phone}`);
  if (wh.email) lines.push(`Email: ${wh.email}`);
  if (wh.status) lines.push(`Zoho status: ${wh.status}`);
  if (wh.is_primary === true) lines.push('Primary Zoho warehouse');
  return lines.join('\n').slice(0, 500) || null;
}

function mapLocationToAreaFields(loc) {
  const zohoId = normalizeZohoId(loc.location_id);
  const code = zohoAreaCode(zohoId) || slugifyCode(loc.location_name);
  const addrText = formatAddressLines(loc.address);
  const descParts = [];
  if (addrText) descParts.push(addrText);
  if (loc.tax_reg_no) descParts.push(`GSTIN: ${loc.tax_reg_no}`);
  if (loc.email) descParts.push(`Email: ${loc.email}`);
  if (loc.is_primary_location) descParts.push('Primary Zoho location');

  return {
    code,
    name: String(loc.location_name || code).trim().slice(0, 200),
    area_type: 'warehouse',
    description: descParts.join(' | ').slice(0, 500) || 'Synced from Zoho Inventory location',
    zoho_location_id: zohoId,
    zoho_meta: buildLocationMeta(loc),
  };
}

function mapWarehouseToZoneFields(wh, areaId, parentLocationId) {
  const zohoWhId = normalizeZohoId(wh.warehouse_id);
  const zohoLocId = resolveWarehouseParentLocationId(wh, parentLocationId);
  const code = zohoWarehouseCode(zohoWhId) || slugifyCode(wh.warehouse_name);
  const status = String(wh.status || 'active').toLowerCase();
  const isActive = status === 'active';
  const branchName = String(wh.branch_name || '').trim();

  return {
    area_id: areaId,
    code,
    name: String(wh.warehouse_name || code).trim().slice(0, 200),
    location_type: 'warehouse',
    zone_label: branchName ? branchName.slice(0, 50) : null,
    description: buildWarehouseDescription(wh),
    zoho_warehouse_id: zohoWhId,
    zoho_location_id: zohoLocId,
    is_active: isActive,
    is_zoho_primary: wh.is_primary === true,
    zoho_meta: buildWarehouseMeta(wh, parentLocationId),
  };
}

function emptyStats() {
  return {
    locationsFetched: 0,
    warehousesFetched: 0,
    areasCreated: 0,
    areasUpdated: 0,
    warehousesCreated: 0,
    warehousesUpdated: 0,
    warehousesSkipped: 0,
    errors: [],
  };
}

function mergeStats(target, source) {
  for (const key of Object.keys(target)) {
    if (key === 'errors') {
      target.errors.push(...(source.errors || []));
    } else if (typeof target[key] === 'number' && typeof source[key] === 'number') {
      target[key] += source[key];
    }
  }
  return target;
}

async function findFacilityAreaForZohoLocation(zohoLocId) {
  if (!zohoLocId) return null;
  let area = await FacilityArea.findOne({ where: { zoho_location_id: zohoLocId } });
  if (!area) {
    area = await FacilityArea.findOne({ where: { code: zohoAreaCode(zohoLocId) } });
  }
  return area;
}

/**
 * Upsert one warehouse_locations row.
 * @returns {'created'|'updated'|'skipped'|'dry_created'|'dry_updated'}
 */
async function upsertWarehouseZone(wh, area, parentLocationId, dryRun) {
  const zohoWhId = normalizeZohoId(wh.warehouse_id);
  if (!zohoWhId) return 'skipped';

  const areaIdForMap = area ? area.id : 0;
  const zoneFields = mapWarehouseToZoneFields(wh, areaIdForMap, parentLocationId);
  let zone = await WarehouseLocation.findOne({ where: { zoho_warehouse_id: zohoWhId } });
  if (!zone) {
    zone = await WarehouseLocation.findOne({ where: { code: zoneFields.code } });
  }

  if (dryRun) {
    return zone ? 'dry_updated' : 'dry_created';
  }

  if (zone) {
    await zone.update({
      area_id: zoneFields.area_id,
      name: zoneFields.name,
      zone_label: zoneFields.zone_label,
      description: zoneFields.description,
      location_type: zoneFields.location_type,
      zoho_warehouse_id: zoneFields.zoho_warehouse_id,
      zoho_location_id: zoneFields.zoho_location_id,
      is_active: zoneFields.is_active,
      is_zoho_primary: zoneFields.is_zoho_primary,
      zoho_meta: zoneFields.zoho_meta,
    });
    return 'updated';
  }

  await WarehouseLocation.create(zoneFields);
  return 'created';
}

/**
 * @param {Record<string, unknown>[]} zohoLocations
 * @param {{ dryRun?: boolean }} options
 */
async function syncFacilityLocationsFromZoho(zohoLocations, options = {}) {
  const dryRun = !!options.dryRun;
  const stats = emptyStats();
  stats.locationsFetched = zohoLocations.length;

  for (const loc of zohoLocations) {
    const zohoLocId = normalizeZohoId(loc.location_id);
    if (!zohoLocId) {
      stats.errors.push({ scope: 'location', reason: 'missing location_id' });
      continue;
    }

    const areaFields = mapLocationToAreaFields(loc);
    let area = await findFacilityAreaForZohoLocation(zohoLocId);
    if (!area && !dryRun) {
      area = await FacilityArea.findOne({ where: { code: areaFields.code } });
    }

    if (dryRun) {
      if (area) stats.areasUpdated += 1;
      else stats.areasCreated += 1;
    } else if (area) {
      await area.update({
        name: areaFields.name,
        description: areaFields.description,
        zoho_location_id: areaFields.zoho_location_id,
        zoho_meta: areaFields.zoho_meta,
        area_type: areaFields.area_type,
      });
      stats.areasUpdated += 1;
    } else {
      area = await FacilityArea.create(areaFields);
      stats.areasCreated += 1;
    }

    const warehouses = Array.isArray(loc.warehouses) ? loc.warehouses : [];
    for (const wh of warehouses) {
      try {
        const result = await upsertWarehouseZone(wh, area, zohoLocId, dryRun);
        if (result === 'created' || result === 'dry_created') stats.warehousesCreated += 1;
        else if (result === 'updated' || result === 'dry_updated') stats.warehousesUpdated += 1;
        else stats.warehousesSkipped += 1;
      } catch (err) {
        stats.errors.push({
          scope: 'warehouse',
          source: 'locations',
          zoho_warehouse_id: normalizeZohoId(wh.warehouse_id),
          message: err && err.message ? err.message : String(err),
        });
      }
    }
  }

  return stats;
}

/**
 * Second pass: GET /warehouses — authoritative warehouse + branch fields.
 * Links each warehouse to facility_areas via branch_id (= Zoho location id).
 *
 * @param {Record<string, unknown>[]} zohoWarehouses
 * @param {{ dryRun?: boolean }} options
 */
async function syncWarehousesFromZoho(zohoWarehouses, options = {}) {
  const dryRun = !!options.dryRun;
  const stats = emptyStats();
  stats.warehousesFetched = zohoWarehouses.length;

  for (const wh of zohoWarehouses) {
    const zohoWhId = normalizeZohoId(wh.warehouse_id);
    if (!zohoWhId) {
      stats.warehousesSkipped += 1;
      continue;
    }

    const parentLocId = resolveWarehouseParentLocationId(wh, null);
    if (!parentLocId) {
      stats.warehousesSkipped += 1;
      stats.errors.push({
        scope: 'warehouse',
        source: 'warehouses',
        zoho_warehouse_id: zohoWhId,
        reason: 'missing branch_id / parent location',
      });
      continue;
    }

    const area = await findFacilityAreaForZohoLocation(parentLocId);
    if (!area && !dryRun) {
      stats.warehousesSkipped += 1;
      stats.errors.push({
        scope: 'warehouse',
        source: 'warehouses',
        zoho_warehouse_id: zohoWhId,
        zoho_location_id: parentLocId,
        reason: 'facility area not found — run locations sync first',
      });
      continue;
    }

    try {
      const result = await upsertWarehouseZone(wh, area, parentLocId, dryRun);
      if (result === 'created' || result === 'dry_created') stats.warehousesCreated += 1;
      else if (result === 'updated' || result === 'dry_updated') stats.warehousesUpdated += 1;
      else stats.warehousesSkipped += 1;
    } catch (err) {
      stats.errors.push({
        scope: 'warehouse',
        source: 'warehouses',
        zoho_warehouse_id: zohoWhId,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  return stats;
}

/**
 * Full sync: locations first, then warehouses list (patch/enrich).
 */
async function syncFacilityFromZoho({ locations = [], warehouses = [] }, options = {}) {
  const stats = emptyStats();
  const locStats = await syncFacilityLocationsFromZoho(locations, options);
  mergeStats(stats, locStats);
  const whStats = await syncWarehousesFromZoho(warehouses, options);
  mergeStats(stats, whStats);
  return stats;
}

module.exports = {
  slugifyCode,
  zohoAreaCode,
  zohoWarehouseCode,
  resolveWarehouseParentLocationId,
  mapLocationToAreaFields,
  mapWarehouseToZoneFields,
  syncFacilityLocationsFromZoho,
  syncWarehousesFromZoho,
  syncFacilityFromZoho,
};
