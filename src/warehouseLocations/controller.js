/**
 * Warehouse Locations & Rack Management — list (with nested racks + stored items), CRUD for locations and racks.
 * Stored items are warehouse_inventory ids; resolved to code, name, type for display.
 */
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('./models');
const { Op } = require('sequelize');
const FacilityArea = require('../facilityAreas/models');
const WarehouseInventory = require('../warehouseInventory/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Build a map warehouse_inventory.id -> { code, name, type } from WarehouseInventory + RM/PM/PR.
 */
async function buildInventorySummaryMap() {
  const whRows = await WarehouseInventory.findAll({ order: [['id', 'ASC']] });
  const rmIds = [...new Set(whRows.map((r) => r.raw_material_id).filter(Boolean))];
  const pmIds = [...new Set(whRows.map((r) => r.pack_material_id).filter(Boolean))];
  const productIds = [...new Set(whRows.map((r) => r.product_id).filter(Boolean))];

  const [rms, pms, products] = await Promise.all([
    rmIds.length ? RawMaterial.findAll({ where: { id: rmIds } }) : [],
    pmIds.length ? PackMaterial.findAll({ where: { id: pmIds } }) : [],
    productIds.length ? Product.findAll({ where: { product_id: productIds } }) : [],
  ]);

  const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
  const pmMap = new Map(pms.map((p) => [p.id, p.get ? p.get({ plain: true }) : p]));
  const productMap = new Map(products.map((p) => [p.product_id, p.get ? p.get({ plain: true }) : p]));

  const out = new Map();
  for (const w of whRows) {
    const wh = w.get ? w.get({ plain: true }) : w;
    let code = '', name = '', type = 'RM';
    if (wh.item_type === 'RM' && wh.raw_material_id) {
      const m = rmMap.get(wh.raw_material_id);
      if (m) {
        code = m.code || '';
        name = m.name || m.code || '';
        type = 'RM';
      }
    } else if (wh.item_type === 'PM' && wh.pack_material_id) {
      const m = pmMap.get(wh.pack_material_id);
      if (m) {
        code = m.code || '';
        name = m.description || m.code || '';
        type = 'PM';
      }
    } else if (wh.item_type === 'PR' && wh.product_id) {
      const m = productMap.get(wh.product_id);
      if (m) {
        code = m.product_code || '';
        name = m.product_name || '';
        type = 'FG/PR';
      }
    }
    out.set(wh.id, { code, name, type });
  }
  return out;
}

/**
 * GET /api/v1/warehouse-locations
 * Returns locations with nested racks; each rack has storedItems: [{ warehouseInventoryId, code, name, type }].
 * Location utilisation = avg/weighted of rack utilisations; rack utilisation = (stored count / (levels * slots)) * 100.
 */
async function list(req, res) {
  try {
    const where = {};
    if (req.query.location_type) where.location_type = req.query.location_type;
    if (req.query.area_id) where.area_id = parseInt(req.query.area_id, 10);

    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    const normalizeInt = (v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? null : n;
    };

    let locations = [];
    let total = null;
    let limit = null;
    let offset = null;

    if (wantsPagination) {
      limit = limitQ != null ? normalizeInt(limitQ) : 20;
      offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }

      total = await WarehouseLocation.count({ where });

      // Pagination must apply to the base "locations" rows; includes can otherwise distort row counts.
      const idRows = await WarehouseLocation.findAll({
        where,
        attributes: ['id'],
        order: [['id', 'ASC']],
        limit,
        offset,
        raw: true,
      });
      const ids = idRows.map((r) => r.id);

      if (ids.length === 0) return res.json({ rows: [], total, limit, offset });

      locations = await WarehouseLocation.findAll({
        where: { id: { [Op.in]: ids } },
        order: [['id', 'ASC']],
        include: [
          { model: FacilityArea, as: 'area', required: false, attributes: ['id', 'name', 'area_type'] },
          {
            model: WarehouseRack,
            as: 'WarehouseRacks',
            required: false,
            include: [
              {
                model: WarehouseRackItem,
                as: 'WarehouseRackItems',
                required: false,
              },
            ],
          },
        ],
      });
    } else {
      locations = await WarehouseLocation.findAll({
        where,
        order: [['id', 'ASC']],
        include: [
          { model: FacilityArea, as: 'area', required: false, attributes: ['id', 'name', 'area_type'] },
          {
            model: WarehouseRack,
            as: 'WarehouseRacks',
            required: false,
            include: [
              {
                model: WarehouseRackItem,
                as: 'WarehouseRackItems',
                required: false,
              },
            ],
          },
        ],
      });
    }

    const invMap = await buildInventorySummaryMap();

    const result = locations.map((loc) => {
      const locPlain = loc.get ? loc.get({ plain: true }) : loc;
      const racks = (locPlain.WarehouseRacks || []).map((r) => {
        const rPlain = r.get ? r.get({ plain: true }) : r;
        const items = rPlain.WarehouseRackItems || [];
        const levels = toNum(rPlain.levels) || 4;
        const slots = toNum(rPlain.slots_total) || 16;
        const totalSlots = levels * slots;
        const storedCount = items.length;
        const utilisationPct = totalSlots > 0 ? Math.round((storedCount / totalSlots) * 100) : 0;
        const storedItems = items.map((it) => {
          const inv = invMap.get(it.warehouse_inventory_id) || {};
          return {
            warehouseInventoryId: it.warehouse_inventory_id,
            code: inv.code || String(it.warehouse_inventory_id),
            name: inv.name || '',
            type: inv.type || 'RM',
          };
        });
        return {
          id: rPlain.id,
          locationId: rPlain.location_id,
          code: rPlain.code,
          name: rPlain.name || rPlain.code,
          description: rPlain.description,
          levels,
          slotsTotal: slots,
          utilisationPct: rPlain.utilisation_pct != null ? toNum(rPlain.utilisation_pct) : utilisationPct,
          storedItems,
          itemsStoredCount: storedCount,
        };
      });

      const locUtil = racks.length
        ? Math.round(racks.reduce((sum, r) => sum + (r.utilisationPct || 0), 0) / racks.length)
        : 0;

      const areaData = locPlain.area || null;
      return {
        id: locPlain.id,
        code: locPlain.code,
        name: locPlain.name,
        locationType: locPlain.location_type || 'warehouse',
        areaId: locPlain.area_id || null,
        areaName: areaData ? areaData.name : null,
        zoneLabel: locPlain.zone_label,
        icon: locPlain.icon,
        areaSqm: locPlain.area_sqm,
        description: locPlain.description,
        utilisationPct: locPlain.utilisation_pct != null ? toNum(locPlain.utilisation_pct) : locUtil,
        racks,
      };
    });

    if (wantsPagination) {
      return res.json({ rows: result, total, limit, offset });
    }
    res.json(result);
  } catch (err) {
    console.error('[warehouse-locations] list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list warehouse locations' });
  }
}

/**
 * GET /api/v1/warehouse-locations/:id
 */
async function getLocationById(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid location id' });
    const loc = await WarehouseLocation.findByPk(id, {
      include: [
        {
          model: WarehouseRack,
          as: 'WarehouseRacks',
          include: [{ model: WarehouseRackItem, as: 'WarehouseRackItems' }],
        },
      ],
    });
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const invMap = await buildInventorySummaryMap();
    const locPlain = loc.get ? loc.get({ plain: true }) : loc;
    const racks = (locPlain.WarehouseRacks || []).map((r) => {
      const rPlain = r.get ? r.get({ plain: true }) : r;
      const items = rPlain.WarehouseRackItems || [];
      const levels = toNum(rPlain.levels) || 4;
      const slots = toNum(rPlain.slots_total) || 16;
      const totalSlots = levels * slots;
      const storedCount = items.length;
      const utilisationPct = totalSlots > 0 ? Math.round((storedCount / totalSlots) * 100) : 0;
      const storedItems = items.map((it) => {
        const inv = invMap.get(it.warehouse_inventory_id) || {};
        return {
          warehouseInventoryId: it.warehouse_inventory_id,
          code: inv.code || String(it.warehouse_inventory_id),
          name: inv.name || '',
          type: inv.type || 'RM',
        };
      });
      return {
        id: rPlain.id,
        locationId: rPlain.location_id,
        code: rPlain.code,
        name: rPlain.name || rPlain.code,
        description: rPlain.description,
        levels,
        slotsTotal: slots,
        utilisationPct: rPlain.utilisation_pct != null ? toNum(rPlain.utilisation_pct) : utilisationPct,
        storedItems,
        itemsStoredCount: storedCount,
      };
    });
    res.json({
      id: locPlain.id,
      code: locPlain.code,
      name: locPlain.name,
      zoneLabel: locPlain.zone_label,
      icon: locPlain.icon,
      areaSqm: locPlain.area_sqm,
      description: locPlain.description,
      utilisationPct: locPlain.utilisation_pct,
      racks,
    });
  } catch (err) {
    console.error('[warehouse-locations] getLocationById error:', err);
    res.status(500).json({ error: err.message || 'Failed to get location' });
  }
}

/**
 * POST /api/v1/warehouse-locations
 * Body: { code, name, area_id?, location_type?, zone_label?, icon?, area_sqm?, description? }
 */
async function createLocation(req, res) {
  try {
    const body = req.body || {};
    if (!body.code || !body.name) {
      return res.status(400).json({ error: 'code and name are required' });
    }
    const [loc] = await WarehouseLocation.findOrCreate({
      where: { code: String(body.code).trim() },
      defaults: {
        name: String(body.name).trim(),
        area_id: body.area_id != null ? parseInt(body.area_id, 10) : null,
        location_type: body.location_type || 'warehouse',
        zone_label: body.zone_label != null ? String(body.zone_label) : null,
        icon: body.icon != null ? String(body.icon) : null,
        area_sqm: body.area_sqm != null ? parseInt(body.area_sqm, 10) : null,
        description: body.description != null ? String(body.description) : null,
      },
    });
    const plain = loc.get ? loc.get({ plain: true }) : loc;
    res.status(201).json(plain);
  } catch (err) {
    console.error('[warehouse-locations] createLocation error:', err);
    res.status(500).json({ error: err.message || 'Failed to create location' });
  }
}

/**
 * PATCH /api/v1/warehouse-locations/:id
 */
async function updateLocation(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid location id' });
    const loc = await WarehouseLocation.findByPk(id);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const body = req.body || {};
    const updates = {};
    if (body.code != null) updates.code = String(body.code);
    if (body.name != null) updates.name = String(body.name);
    if (body.area_id !== undefined) updates.area_id = body.area_id != null ? parseInt(body.area_id, 10) : null;
    if (body.location_type != null) updates.location_type = String(body.location_type);
    if (body.zone_label != null) updates.zone_label = String(body.zone_label);
    if (body.icon != null) updates.icon = String(body.icon);
    if (body.area_sqm != null) updates.area_sqm = parseInt(body.area_sqm, 10);
    if (body.description != null) updates.description = String(body.description);
    if (body.utilisation_pct != null) updates.utilisation_pct = Number(body.utilisation_pct);
    await loc.update(updates);
    res.json(loc.get ? loc.get({ plain: true }) : loc);
  } catch (err) {
    console.error('[warehouse-locations] updateLocation error:', err);
    res.status(500).json({ error: err.message || 'Failed to update location' });
  }
}

/**
 * DELETE /api/v1/warehouse-locations/:id
 */
async function deleteLocation(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid location id' });
    const loc = await WarehouseLocation.findByPk(id);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    await loc.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('[warehouse-locations] deleteLocation error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete location' });
  }
}

/**
 * GET /api/v1/warehouse-locations/racks/:rackId
 */
async function getRackById(req, res) {
  try {
    const rackId = parseInt(String(req.params.rackId), 10);
    if (Number.isNaN(rackId)) return res.status(400).json({ error: 'Invalid rack id' });
    const rack = await WarehouseRack.findByPk(rackId, {
      include: [
        { model: WarehouseLocation, as: 'WarehouseLocation' },
        { model: WarehouseRackItem, as: 'WarehouseRackItems' },
      ],
    });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const invMap = await buildInventorySummaryMap();
    const rPlain = rack.get ? rack.get({ plain: true }) : rack;
    const items = rPlain.WarehouseRackItems || [];
    const levels = toNum(rPlain.levels) || 4;
    const slots = toNum(rPlain.slots_total) || 16;
    const totalSlots = levels * slots;
    const storedCount = items.length;
    const utilisationPct = totalSlots > 0 ? Math.round((storedCount / totalSlots) * 100) : 0;
    const storedItems = items.map((it) => {
      const inv = invMap.get(it.warehouse_inventory_id) || {};
      return {
        warehouseInventoryId: it.warehouse_inventory_id,
        code: inv.code || String(it.warehouse_inventory_id),
        name: inv.name || '',
        type: inv.type || 'RM',
      };
    });
    res.json({
      id: rPlain.id,
      locationId: rPlain.location_id,
      location: rPlain.WarehouseLocation ? (rPlain.WarehouseLocation.get ? rPlain.WarehouseLocation.get({ plain: true }) : rPlain.WarehouseLocation) : null,
      code: rPlain.code,
      name: rPlain.name || rPlain.code,
      description: rPlain.description,
      levels,
      slotsTotal: slots,
      utilisationPct: rPlain.utilisation_pct != null ? toNum(rPlain.utilisation_pct) : utilisationPct,
      storedItems,
      itemsStoredCount: storedCount,
    });
  } catch (err) {
    console.error('[warehouse-locations] getRackById error:', err);
    res.status(500).json({ error: err.message || 'Failed to get rack' });
  }
}

/**
 * POST /api/v1/warehouse-locations/racks
 * Body: { location_id, code, name?, description?, levels?, slots_total? }
 */
async function createRack(req, res) {
  try {
    const body = req.body || {};
    const locationId = body.location_id != null ? parseInt(String(body.location_id), 10) : NaN;
    if (Number.isNaN(locationId) || !body.code) {
      return res.status(400).json({ error: 'location_id and code are required' });
    }
    const loc = await WarehouseLocation.findByPk(locationId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const rack = await WarehouseRack.create({
      location_id: locationId,
      code: String(body.code).trim(),
      name: body.name != null ? String(body.name) : null,
      description: body.description != null ? String(body.description) : null,
      levels: body.levels != null ? parseInt(body.levels, 10) : 4,
      slots_total: body.slots_total != null ? parseInt(body.slots_total, 10) : 16,
    });
    res.status(201).json(rack.get ? rack.get({ plain: true }) : rack);
  } catch (err) {
    console.error('[warehouse-locations] createRack error:', err);
    res.status(500).json({ error: err.message || 'Failed to create rack' });
  }
}

/**
 * PATCH /api/v1/warehouse-locations/racks/:rackId
 */
async function updateRack(req, res) {
  try {
    const rackId = parseInt(String(req.params.rackId), 10);
    if (Number.isNaN(rackId)) return res.status(400).json({ error: 'Invalid rack id' });
    const rack = await WarehouseRack.findByPk(rackId);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const body = req.body || {};
    const updates = {};
    if (body.code != null) updates.code = String(body.code);
    if (body.name != null) updates.name = String(body.name);
    if (body.description != null) updates.description = String(body.description);
    if (body.levels != null) updates.levels = parseInt(body.levels, 10);
    if (body.slots_total != null) updates.slots_total = parseInt(body.slots_total, 10);
    if (body.utilisation_pct != null) updates.utilisation_pct = Number(body.utilisation_pct);
    await rack.update(updates);
    res.json(rack.get ? rack.get({ plain: true }) : rack);
  } catch (err) {
    console.error('[warehouse-locations] updateRack error:', err);
    res.status(500).json({ error: err.message || 'Failed to update rack' });
  }
}

/**
 * DELETE /api/v1/warehouse-locations/racks/:rackId
 */
async function deleteRack(req, res) {
  try {
    const rackId = parseInt(String(req.params.rackId), 10);
    if (Number.isNaN(rackId)) return res.status(400).json({ error: 'Invalid rack id' });
    const rack = await WarehouseRack.findByPk(rackId);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    await rack.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('[warehouse-locations] deleteRack error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete rack' });
  }
}

/**
 * POST /api/v1/warehouse-locations/racks/:rackId/items
 * Body: { warehouse_inventory_id }
 */
async function addRackItem(req, res) {
  try {
    const rackId = parseInt(String(req.params.rackId), 10);
    const invId = req.body && req.body.warehouse_inventory_id != null ? parseInt(String(req.body.warehouse_inventory_id), 10) : NaN;
    if (Number.isNaN(rackId)) return res.status(400).json({ error: 'Invalid rack id' });
    if (Number.isNaN(invId)) return res.status(400).json({ error: 'warehouse_inventory_id is required' });
    const rack = await WarehouseRack.findByPk(rackId);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const inv = await WarehouseInventory.findByPk(invId);
    if (!inv) return res.status(404).json({ error: 'Warehouse inventory item not found' });
    const item = await WarehouseRackItem.create({
      rack_id: rackId,
      warehouse_inventory_id: invId,
    });
    res.status(201).json(item.get ? item.get({ plain: true }) : item);
  } catch (err) {
    console.error('[warehouse-locations] addRackItem error:', err);
    res.status(500).json({ error: err.message || 'Failed to add item to rack' });
  }
}

/**
 * DELETE /api/v1/warehouse-locations/racks/:rackId/items/:warehouseInventoryId
 * Removes one stored item row (one slot). If multiple slots have same inventory, deletes one.
 */
async function removeRackItem(req, res) {
  try {
    const rackId = parseInt(String(req.params.rackId), 10);
    const warehouseInventoryId = parseInt(String(req.params.warehouseInventoryId), 10);
    if (Number.isNaN(rackId) || Number.isNaN(warehouseInventoryId)) {
      return res.status(400).json({ error: 'Invalid rack id or warehouse inventory id' });
    }
    const row = await WarehouseRackItem.findOne({
      where: { rack_id: rackId, warehouse_inventory_id: warehouseInventoryId },
    });
    if (!row) return res.status(404).json({ error: 'Rack item not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('[warehouse-locations] removeRackItem error:', err);
    res.status(500).json({ error: err.message || 'Failed to remove item from rack' });
  }
}

module.exports = {
  list,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
  getRackById,
  createRack,
  updateRack,
  deleteRack,
  addRackItem,
  removeRackItem,
};
