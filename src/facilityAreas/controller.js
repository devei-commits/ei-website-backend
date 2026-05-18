const FacilityArea = require('./models');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');

/**
 * Slugify a free-text zone label into a compact, URL-safe zone code.
 * Kept short (<=40 chars) because WarehouseLocation.code is STRING(50) and globally unique.
 */
function slugifyZoneCode(text) {
  const s = String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'ZONE';
}

function formatRack(r) {
  const plain = r.get ? r.get({ plain: true }) : r;
  return {
    id: plain.id,
    locationId: plain.location_id,
    code: plain.code,
    name: plain.name || null,
    description: plain.description || null,
    levels: plain.levels != null ? Number(plain.levels) : 4,
    slotsTotal: plain.slots_total != null ? Number(plain.slots_total) : 16,
  };
}

function formatArea(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  const zones = (d.zones || []).map((z) => {
    const racks = (z.WarehouseRacks || []).map(formatRack);
    return {
      id: z.id,
      code: z.code,
      name: z.name,
      locationType: z.location_type || d.area_type,
      zoneLabel: z.zone_label,
      icon: z.icon,
      areaSqm: z.area_sqm,
      description: z.description,
      utilisationPct: z.utilisation_pct != null ? Number(z.utilisation_pct) : 0,
      zohoWarehouseId: z.zoho_warehouse_id || null,
      zohoLocationId: z.zoho_location_id || null,
      isActive: z.is_active !== false,
      isZohoPrimary: z.is_zoho_primary === true,
      zohoMeta: z.zoho_meta || null,
      racks,
    };
  });
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    areaType: d.area_type,
    icon: d.icon,
    description: d.description,
    zohoLocationId: d.zoho_location_id || null,
    zohoMeta: d.zoho_meta || null,
    zones,
  };
}

async function listAreas(req, res) {
  try {
    const where = {};
    if (req.query.area_type) where.area_type = req.query.area_type;
    const rows = await FacilityArea.findAll({
      where,
      order: [['id', 'ASC']],
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        order: [['id', 'ASC']],
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false, attributes: ['id', 'location_id', 'code', 'name', 'description', 'levels', 'slots_total'] }],
      }],
    });
    res.json(rows.map(formatArea));
  } catch (err) {
    console.error('listAreas error:', err);
    res.status(500).json({ error: 'Failed to fetch facility areas' });
  }
}

async function getAreaById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FacilityArea.findByPk(id, {
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
      }],
    });
    if (!row) return res.status(404).json({ error: 'Facility area not found' });
    res.json(formatArea(row));
  } catch (err) {
    console.error('getAreaById error:', err);
    res.status(500).json({ error: 'Failed to fetch facility area' });
  }
}

async function createArea(req, res) {
  try {
    const { code, name, area_type, icon, description } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const row = await FacilityArea.create({
      code: String(code).trim(),
      name: String(name).trim(),
      area_type: area_type || 'warehouse',
      icon: icon || null,
      description: description || null,
    });
    const full = await FacilityArea.findByPk(row.id, {
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
      }],
    });
    res.status(201).json(formatArea(full));
  } catch (err) {
    console.error('createArea error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Area code already exists' });
    }
    res.status(500).json({ error: 'Failed to create facility area' });
  }
}

async function updateArea(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FacilityArea.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Facility area not found' });
    const allowed = ['code', 'name', 'area_type', 'icon', 'description'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) row.set(k, req.body[k]);
    }
    await row.save();
    const full = await FacilityArea.findByPk(id, {
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
      }],
    });
    res.json(formatArea(full));
  } catch (err) {
    console.error('updateArea error:', err);
    res.status(500).json({ error: 'Failed to update facility area' });
  }
}

async function deleteArea(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FacilityArea.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Facility area not found' });
    await WarehouseLocation.destroy({ where: { area_id: id } });
    await row.destroy();
    res.json({ message: 'Facility area deleted' });
  } catch (err) {
    console.error('deleteArea error:', err);
    res.status(500).json({ error: 'Failed to delete facility area' });
  }
}

/**
 * POST /api/v1/facility-areas/ensure-custom
 * Body: { areaType: 'warehouse' | 'production', zoneText: string, rackText: string }
 *
 * Find-or-create flow (idempotent) for custom zones/racks entered on GRN / Production MU:
 *   1. Ensure a catch-all "CUSTOM" FacilityArea exists for the given area type
 *      (code: WH-CUSTOM or PROD-CUSTOM).
 *   2. Ensure a WarehouseLocation (zone) exists with that text. Match case-insensitively
 *      by slug-code or by display name, scoped to the same location_type, so a zone that
 *      was originally created by a Facility Management admin is reused rather than
 *      duplicated. If truly new, create it under the CUSTOM area.
 *   3. Ensure a WarehouseRack with that text exists under the zone (case-insensitive code
 *      match, scoped to the zone's location_id — rack codes are only unique per zone).
 * Returns { areaId, zoneId, rackId }.
 */
async function ensureCustomLocation(req, res) {
  try {
    const rawType = String((req.body && req.body.areaType) || '').toLowerCase().trim();
    const type = rawType === 'production' ? 'production' : rawType === 'warehouse' ? 'warehouse' : '';
    if (!type) return res.status(400).json({ error: 'areaType must be "warehouse" or "production"' });

    const zoneText = String((req.body && req.body.zoneText) || '').trim();
    const rackText = String((req.body && req.body.rackText) || '').trim();
    if (!zoneText || !rackText) {
      return res.status(400).json({ error: 'zoneText and rackText are required' });
    }

    // 1) CUSTOM parent area (one per area type; reused across all custom entries).
    const customAreaCode = type === 'warehouse' ? 'WH-CUSTOM' : 'PROD-CUSTOM';
    const customAreaName = type === 'warehouse' ? 'Custom Warehouse Locations' : 'Custom Production Locations';
    const [area] = await FacilityArea.findOrCreate({
      where: { code: customAreaCode },
      defaults: {
        code: customAreaCode,
        name: customAreaName,
        area_type: type,
        description: 'Auto-created from custom zone/rack entries on GRN and Production MU.',
      },
    });
    // Defensive: ensure area_type stays consistent if a pre-existing row had a different type.
    if (area.area_type !== type) {
      area.set('area_type', type);
      await area.save();
    }

    // 2) Zone — dedupe by case-insensitive code OR name within same location_type.
    const zoneSlug = slugifyZoneCode(zoneText);
    const zoneSlugLower = zoneSlug.toLowerCase();
    const zoneNameLower = zoneText.toLowerCase();

    const sameTypeLocations = await WarehouseLocation.findAll({
      where: { location_type: type },
    });
    let zone = sameTypeLocations.find((l) => {
      const codeLower = String(l.code || '').toLowerCase();
      const nameLower = String(l.name || '').toLowerCase();
      return codeLower === zoneSlugLower || nameLower === zoneNameLower;
    }) || null;

    if (!zone) {
      // WarehouseLocation.code is globally unique; disambiguate with numeric suffix on collision.
      let candidate = zoneSlug;
      let n = 1;
      // Small safety cap; practical collisions should resolve in <5 attempts.
      while (n <= 50) {
        // eslint-disable-next-line no-await-in-loop
        const clash = await WarehouseLocation.findOne({ where: { code: candidate } });
        if (!clash) break;
        n += 1;
        candidate = `${zoneSlug}-${n}`;
      }
      zone = await WarehouseLocation.create({
        code: candidate,
        name: zoneText,
        area_id: area.id,
        location_type: type,
        description: 'Auto-created from custom entry on GRN / Production MU.',
      });
    }

    // 3) Rack — case-insensitive match by code within this zone.
    const rackList = await WarehouseRack.findAll({ where: { location_id: zone.id } });
    const rackLower = rackText.toLowerCase();
    let rack = rackList.find((r) => String(r.code || '').toLowerCase() === rackLower) || null;
    if (!rack) {
      rack = await WarehouseRack.create({
        location_id: zone.id,
        code: rackText,
        name: null,
        description: 'Auto-created from custom entry on GRN / Production MU.',
      });
    }

    return res.status(200).json({
      areaId: area.id,
      zoneId: zone.id,
      rackId: rack.id,
      zoneCode: zone.code,
      zoneName: zone.name,
      rackCode: rack.code,
      areaType: type,
    });
  } catch (err) {
    console.error('ensureCustomLocation error:', err);
    return res.status(500).json({ error: err.message || 'Failed to register custom location' });
  }
}

module.exports = { listAreas, getAreaById, createArea, updateArea, deleteArea, ensureCustomLocation };
