const { ItemsList, ItemListVendorRate, ItemListTier } = require('./models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const VendorClient = require('../vendorClient/models');

function toNum(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

/**
 * Resolve item row to display shape from RM or PM master.
 */
async function resolveItemMaster(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  if (d.type === 'RM' && d.raw_material_id) {
    const rm = await RawMaterial.findByPk(d.raw_material_id);
    if (!rm) return null;
    const r = rm.get ? rm.get({ plain: true }) : rm;
    const price = toNum(r.price_per_kg);
    return {
      id: String(d.id),
      code: r.code,
      name: r.name || r.code,
      type: 'RM',
      category: r.category || '',
      pricePerUnit: price ?? 0,
      uom: r.uom || 'KG',
      gst: toNum(r.gst) ?? 0,
      status: d.status || r.status || 'Active',
      raw_material_id: d.raw_material_id ?? null,
      pack_material_id: null,
    };
  }
  if (d.type === 'PM' && d.pack_material_id) {
    const pm = await PackMaterial.findByPk(d.pack_material_id);
    if (!pm) return null;
    const p = pm.get ? pm.get({ plain: true }) : pm;
    const price = toNum(p.price_per_pc);
    return {
      id: String(d.id),
      code: p.code,
      name: p.description || p.code,
      type: 'PM',
      category: p.type || '',
      pricePerUnit: price ?? 0,
      uom: 'PCS',
      gst: 18,
      status: d.status || 'Active',
      raw_material_id: null,
      pack_material_id: d.pack_material_id ?? null,
    };
  }
  return null;
}

/**
 * GET /page?type=RM|PM — all RM or PM from masters with optional price list data (vendorRates + tiers).
 * Used by Price Lists UI: each item shows either list-price-only or full vendor/tier table.
 */
async function pageItemsList(req, res) {
  try {
    const type = req.query.type;
    if (type !== 'RM' && type !== 'PM') {
      return res.status(400).json({ error: 'Query type must be RM or PM' });
    }
    const items = [];
    if (type === 'RM') {
      const rms = await RawMaterial.findAll({ order: [['code', 'ASC']] });
      const listRows = await ItemsList.findAll({ where: { type: 'RM' }, order: [['id']] });
      const byRmId = new Map(listRows.map((r) => [r.raw_material_id, r]));
      const vendorIds = [...new Set((await ItemListVendorRate.findAll({ attributes: ['vendor_id'] })).map((r) => r.vendor_id))];
      const vendors = vendorIds.length ? await VendorClient.findAll({ where: { id: vendorIds } }) : [];
      const vendorById = new Map(vendors.map((v) => [v.id, v.get ? v.get({ plain: true }) : v]));

      for (const rm of rms) {
        const r = rm.get ? rm.get({ plain: true }) : rm;
        const base = {
          code: r.code,
          name: r.name || r.code,
          type: 'RM',
          uom: r.uom || 'KG',
          gst: toNum(r.gst) ?? 0,
          pricePerUnit: toNum(r.price_per_kg) ?? 0,
          raw_material_id: rm.id,
          pack_material_id: null,
        };
        const listRow = byRmId.get(rm.id);
        if (!listRow) {
          items.push({ ...base, itemsListId: null, vendorRates: [] });
          continue;
        }
        const rates = await ItemListVendorRate.findAll({ where: { items_list_id: listRow.id }, order: [['id']] });
        const ratesWithTiers = [];
        for (const rate of rates) {
          const tiers = await ItemListTier.findAll({ where: { item_list_vendor_rate_id: rate.id }, order: [['moq_min', 'ASC']] });
          const v = vendorById.get(rate.vendor_id);
          ratesWithTiers.push({
            id: rate.id,
            vendor_id: rate.vendor_id,
            vendor_name: v ? v.name : null,
            vendor_code: v ? v.entity_code : null,
            currency: rate.currency || 'INR',
            tiers: tiers.map((t) => ({
              id: t.id,
              moq_min: t.moq_min,
              moq_max: t.moq_max,
              price_per_unit: toNum(t.price_per_unit),
              valid_till: t.valid_till || null,
              note: t.note || null,
            })),
          });
        }
        items.push({ ...base, itemsListId: listRow.id, vendorRates: ratesWithTiers });
      }
    } else {
      const pms = await PackMaterial.findAll({ order: [['code', 'ASC']] });
      const listRows = await ItemsList.findAll({ where: { type: 'PM' }, order: [['id']] });
      const byPmId = new Map(listRows.map((r) => [r.pack_material_id, r]));
      const vendorIds = [...new Set((await ItemListVendorRate.findAll({ attributes: ['vendor_id'] })).map((r) => r.vendor_id))];
      const vendors = vendorIds.length ? await VendorClient.findAll({ where: { id: vendorIds } }) : [];
      const vendorById = new Map(vendors.map((v) => [v.id, v.get ? v.get({ plain: true }) : v]));

      for (const pm of pms) {
        const p = pm.get ? pm.get({ plain: true }) : pm;
        const base = {
          code: p.code,
          name: p.description || p.code,
          type: 'PM',
          pack_type: p.type || '',
          level: p.level || '',
          pricePerUnit: toNum(p.price_per_pc) ?? 0,
          moq: toNum(p.moq) ?? 0,
          raw_material_id: null,
          pack_material_id: pm.id,
        };
        const listRow = byPmId.get(pm.id);
        if (!listRow) {
          items.push({ ...base, itemsListId: null, vendorRates: [] });
          continue;
        }
        const rates = await ItemListVendorRate.findAll({ where: { items_list_id: listRow.id }, order: [['id']] });
        const ratesWithTiers = [];
        for (const rate of rates) {
          const tiers = await ItemListTier.findAll({ where: { item_list_vendor_rate_id: rate.id }, order: [['moq_min', 'ASC']] });
          const v = vendorById.get(rate.vendor_id);
          ratesWithTiers.push({
            id: rate.id,
            vendor_id: rate.vendor_id,
            vendor_name: v ? v.name : null,
            vendor_code: v ? v.entity_code : null,
            currency: rate.currency || 'INR',
            tiers: tiers.map((t) => ({
              id: t.id,
              moq_min: t.moq_min,
              moq_max: t.moq_max,
              price_per_unit: toNum(t.price_per_unit),
              valid_till: t.valid_till || null,
              note: t.note || null,
            })),
          });
        }
        items.push({ ...base, itemsListId: listRow.id, vendorRates: ratesWithTiers });
      }
    }
    res.json(items);
  } catch (err) {
    console.error('pageItemsList error', err);
    res.status(500).json({ error: 'Failed to load price list page' });
  }
}

/**
 * GET / — list items with vendor count, tier count, lastUpdated from rates.
 */
async function listItemsList(req, res) {
  try {
    const typeFilter = req.query.type; // 'RM' | 'PM' | omit = all
    const where = {};
    if (typeFilter === 'RM' || typeFilter === 'PM') where.type = typeFilter;

    const rows = await ItemsList.findAll({ where, order: [['id', 'ASC']] });
    const list = [];
    for (const row of rows) {
      const base = await resolveItemMaster(row);
      if (!base) continue;
      const rates = await ItemListVendorRate.findAll({ where: { items_list_id: row.id } });
      const rateIds = rates.map((r) => r.id);
      const tierCount = rateIds.length
        ? await ItemListTier.count({ where: { item_list_vendor_rate_id: rateIds } })
        : 0;
      let lastUpdated = row.updated_at;
      for (const r of rates) {
        if (r.updated_at && (!lastUpdated || r.updated_at > lastUpdated)) lastUpdated = r.updated_at;
      }
      list.push({
        ...base,
        vendors: rates.length,
        tiers: tierCount,
        lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString().slice(0, 10) : '',
      });
    }
    res.json(list);
  } catch (err) {
    console.error('listItemsList error', err);
    res.status(500).json({ error: 'Failed to list items' });
  }
}

/**
 * GET /:id — one item with full vendor rates and tiers.
 */
async function getItemsListById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemsList.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    const base = await resolveItemMaster(row);
    if (!base) return res.status(404).json({ error: 'Master not found' });

    const rates = await ItemListVendorRate.findAll({
      where: { items_list_id: id },
      order: [['id', 'ASC']],
    });
    const vendorIds = [...new Set(rates.map((r) => r.vendor_id))];
    const vendors = await VendorClient.findAll({ where: { id: vendorIds } });
    const vendorById = new Map(vendors.map((v) => [v.id, v.get ? v.get({ plain: true }) : v]));

    const ratesWithTiers = [];
    for (const r of rates) {
      const tiers = await ItemListTier.findAll({
        where: { item_list_vendor_rate_id: r.id },
        order: [['moq_min', 'ASC']],
      });
      const v = vendorById.get(r.vendor_id);
      ratesWithTiers.push({
        id: r.id,
        vendor_id: r.vendor_id,
        vendor_name: v ? v.name : null,
        vendor_code: v ? v.entity_code : null,
        default_rate: toNum(r.default_rate),
        default_moq: toNum(r.default_moq),
        currency: r.currency || 'INR',
        status: r.status,
      tiers: tiers.map((t) => ({
        id: t.id,
        moq_min: t.moq_min,
        moq_max: t.moq_max,
        price_per_unit: toNum(t.price_per_unit),
        valid_till: t.valid_till || null,
        note: t.note || null,
      })),
      });
    }

    res.json({
      ...base,
      vendors: rates.length,
      tiers: ratesWithTiers.reduce((sum, r) => sum + r.tiers.length, 0),
      lastUpdated: row.updated_at ? new Date(row.updated_at).toISOString().slice(0, 10) : '',
      vendorRates: ratesWithTiers,
    });
  } catch (err) {
    console.error('getItemsListById error', err);
    res.status(500).json({ error: 'Failed to get item' });
  }
}

/**
 * POST / — add item (type + raw_material_id or pack_material_id).
 */
async function createItemsList(req, res) {
  try {
    const { type, raw_material_id, pack_material_id, status } = req.body;
    if (type !== 'RM' && type !== 'PM') {
      return res.status(400).json({ error: 'type must be RM or PM' });
    }
    const rmId = raw_material_id != null ? parseInt(raw_material_id, 10) : null;
    const pmId = pack_material_id != null ? parseInt(pack_material_id, 10) : null;
    if (type === 'RM') {
      if (rmId == null || Number.isNaN(rmId)) return res.status(400).json({ error: 'raw_material_id required for RM' });
      const existing = await ItemsList.findOne({ where: { type: 'RM', raw_material_id: rmId } });
      if (existing) return res.status(409).json({ error: 'This raw material is already in the items list' });
    } else {
      if (pmId == null || Number.isNaN(pmId)) return res.status(400).json({ error: 'pack_material_id required for PM' });
      const existing = await ItemsList.findOne({ where: { type: 'PM', pack_material_id: pmId } });
      if (existing) return res.status(409).json({ error: 'This pack material is already in the items list' });
    }
    const row = await ItemsList.create({
      type,
      raw_material_id: type === 'RM' ? rmId : null,
      pack_material_id: type === 'PM' ? pmId : null,
      status: status || 'Active',
    });
    const base = await resolveItemMaster(row);
    res.status(201).json({ ...base, vendors: 0, tiers: 0, lastUpdated: '' });
  } catch (err) {
    console.error('createItemsList error', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
}

/**
 * PUT /:id — update item (status only; master is RM/PM).
 */
async function updateItemsList(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemsList.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    const { status } = req.body;
    if (status !== undefined) row.status = status;
    await row.save();
    const base = await resolveItemMaster(row);
    if (!base) return res.status(500).json({ error: 'Master resolve failed' });
    const rates = await ItemListVendorRate.findAll({ where: { items_list_id: id } });
    const rateIds = rates.map((r) => r.id);
    const tierCount = rateIds.length ? await ItemListTier.count({ where: { item_list_vendor_rate_id: rateIds } }) : 0;
    res.json({
      ...base,
      vendors: rates.length,
      tiers: tierCount,
      lastUpdated: row.updated_at ? new Date(row.updated_at).toISOString().slice(0, 10) : '',
    });
  } catch (err) {
    console.error('updateItemsList error', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
}

/**
 * DELETE /:id — remove from items list (and cascade rates/tiers if we add FK onDelete).
 */
async function deleteItemsList(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemsList.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    const rates = await ItemListVendorRate.findAll({ where: { items_list_id: id } });
    for (const r of rates) {
      await ItemListTier.destroy({ where: { item_list_vendor_rate_id: r.id } });
    }
    await ItemListVendorRate.destroy({ where: { items_list_id: id } });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteItemsList error', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
}

// ——— Vendor rates (nested under item) ———

async function listRates(req, res) {
  try {
    const itemsListId = parseInt(req.params.id, 10);
    if (Number.isNaN(itemsListId)) return res.status(400).json({ error: 'Invalid id' });
    const rates = await ItemListVendorRate.findAll({
      where: { items_list_id: itemsListId },
      order: [['id', 'ASC']],
    });
    const vendorIds = [...new Set(rates.map((r) => r.vendor_id))];
    const vendors = await VendorClient.findAll({ where: { id: vendorIds } });
    const vendorById = new Map(vendors.map((v) => [v.id, v.get ? v.get({ plain: true }) : v]));
    const result = [];
    for (const r of rates) {
      const tiers = await ItemListTier.findAll({ where: { item_list_vendor_rate_id: r.id }, order: [['moq_min', 'ASC']] });
      const v = vendorById.get(r.vendor_id);
      result.push({
        id: r.id,
        vendor_id: r.vendor_id,
        vendor_name: v ? v.name : null,
        vendor_code: v ? v.entity_code : null,
        default_rate: toNum(r.default_rate),
        default_moq: toNum(r.default_moq),
        currency: r.currency || 'INR',
        status: r.status,
        tiers: tiers.map((t) => ({ id: t.id, moq_min: t.moq_min, moq_max: t.moq_max, price_per_unit: toNum(t.price_per_unit), valid_till: t.valid_till || null, note: t.note || null })),
      });
    }
    res.json(result);
  } catch (err) {
    console.error('listRates error', err);
    res.status(500).json({ error: 'Failed to list rates' });
  }
}

async function createRate(req, res) {
  try {
    const itemsListId = parseInt(req.params.id, 10);
    if (Number.isNaN(itemsListId)) return res.status(400).json({ error: 'Invalid id' });
    const item = await ItemsList.findByPk(itemsListId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { vendor_id, default_rate, default_moq, currency } = req.body;
    const vendorId = vendor_id != null ? parseInt(vendor_id, 10) : null;
    if (vendorId == null || Number.isNaN(vendorId)) return res.status(400).json({ error: 'vendor_id required' });
    const existing = await ItemListVendorRate.findOne({ where: { items_list_id: itemsListId, vendor_id: vendorId } });
    if (existing) return res.status(409).json({ error: 'Vendor rate already exists for this item' });
    const row = await ItemListVendorRate.create({
      items_list_id: itemsListId,
      vendor_id: vendorId,
      default_rate: default_rate != null ? parseFloat(default_rate) : null,
      default_moq: default_moq != null ? parseInt(default_moq, 10) : null,
      currency: currency || 'INR',
      status: 'active',
    });
    const v = await VendorClient.findByPk(vendorId);
    const plain = v ? v.get({ plain: true }) : {};
    res.status(201).json({
      id: row.id,
      vendor_id: row.vendor_id,
      vendor_name: plain.name || null,
      vendor_code: plain.entity_code || null,
      default_rate: toNum(row.default_rate),
      default_moq: toNum(row.default_moq),
      currency: row.currency || 'INR',
      status: row.status,
      tiers: [],
    });
  } catch (err) {
    console.error('createRate error', err);
    res.status(500).json({ error: 'Failed to create rate' });
  }
}

async function updateRate(req, res) {
  try {
    const rateId = parseInt(req.params.rateId, 10);
    if (Number.isNaN(rateId)) return res.status(400).json({ error: 'Invalid rateId' });
    const row = await ItemListVendorRate.findByPk(rateId);
    if (!row) return res.status(404).json({ error: 'Rate not found' });
    const { default_rate, default_moq, currency, status } = req.body;
    if (default_rate !== undefined) row.default_rate = default_rate;
    if (default_moq !== undefined) row.default_moq = default_moq;
    if (currency !== undefined) row.currency = currency;
    if (status !== undefined) row.status = status;
    await row.save();
    const v = await VendorClient.findByPk(row.vendor_id);
    const plain = v ? v.get({ plain: true }) : {};
    const tiers = await ItemListTier.findAll({ where: { item_list_vendor_rate_id: rateId }, order: [['moq_min', 'ASC']] });
    res.json({
      id: row.id,
      vendor_id: row.vendor_id,
      vendor_name: plain.name || null,
      vendor_code: plain.entity_code || null,
      default_rate: toNum(row.default_rate),
      default_moq: toNum(row.default_moq),
      currency: row.currency || 'INR',
      status: row.status,
      tiers: tiers.map((t) => ({ id: t.id, moq_min: t.moq_min, moq_max: t.moq_max, price_per_unit: toNum(t.price_per_unit), valid_till: t.valid_till || null, note: t.note || null })),
    });
  } catch (err) {
    console.error('updateRate error', err);
    res.status(500).json({ error: 'Failed to update rate' });
  }
}

async function deleteRate(req, res) {
  try {
    const rateId = parseInt(req.params.rateId, 10);
    if (Number.isNaN(rateId)) return res.status(400).json({ error: 'Invalid rateId' });
    const row = await ItemListVendorRate.findByPk(rateId);
    if (!row) return res.status(404).json({ error: 'Rate not found' });
    await ItemListTier.destroy({ where: { item_list_vendor_rate_id: rateId } });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteRate error', err);
    res.status(500).json({ error: 'Failed to delete rate' });
  }
}

// ——— Tiers (nested under rate) ———

async function createTier(req, res) {
  try {
    const rateId = parseInt(req.params.rateId, 10);
    if (Number.isNaN(rateId)) return res.status(400).json({ error: 'Invalid rateId' });
    const rate = await ItemListVendorRate.findByPk(rateId);
    if (!rate) return res.status(404).json({ error: 'Rate not found' });
    const { moq_min, moq_max, price_per_unit, valid_till, note } = req.body;
    const moqMin = moq_min != null ? parseInt(moq_min, 10) : null;
    if (moqMin == null || Number.isNaN(moqMin)) return res.status(400).json({ error: 'moq_min required' });
    const price = price_per_unit != null ? parseFloat(price_per_unit) : null;
    if (price == null || Number.isNaN(price)) return res.status(400).json({ error: 'price_per_unit required' });
    const row = await ItemListTier.create({
      item_list_vendor_rate_id: rateId,
      moq_min: moqMin,
      moq_max: moq_max != null ? parseInt(moq_max, 10) : null,
      price_per_unit: price,
      valid_till: valid_till || null,
      note: note || null,
    });
    res.status(201).json({ id: row.id, moq_min: row.moq_min, moq_max: row.moq_max, price_per_unit: toNum(row.price_per_unit), valid_till: row.valid_till, note: row.note });
  } catch (err) {
    console.error('createTier error', err);
    res.status(500).json({ error: 'Failed to create tier' });
  }
}

async function updateTier(req, res) {
  try {
    const tierId = parseInt(req.params.tierId, 10);
    if (Number.isNaN(tierId)) return res.status(400).json({ error: 'Invalid tierId' });
    const row = await ItemListTier.findByPk(tierId);
    if (!row) return res.status(404).json({ error: 'Tier not found' });
    const { moq_min, moq_max, price_per_unit, valid_till, note } = req.body;
    if (moq_min !== undefined) row.moq_min = parseInt(moq_min, 10);
    if (moq_max !== undefined) row.moq_max = moq_max == null ? null : parseInt(moq_max, 10);
    if (price_per_unit !== undefined) row.price_per_unit = parseFloat(price_per_unit);
    if (valid_till !== undefined) row.valid_till = valid_till || null;
    if (note !== undefined) row.note = note || null;
    await row.save();
    res.json({ id: row.id, moq_min: row.moq_min, moq_max: row.moq_max, price_per_unit: toNum(row.price_per_unit), valid_till: row.valid_till, note: row.note });
  } catch (err) {
    console.error('updateTier error', err);
    res.status(500).json({ error: 'Failed to update tier' });
  }
}

async function deleteTier(req, res) {
  try {
    const tierId = parseInt(req.params.tierId, 10);
    if (Number.isNaN(tierId)) return res.status(400).json({ error: 'Invalid tierId' });
    const row = await ItemListTier.findByPk(tierId);
    if (!row) return res.status(404).json({ error: 'Tier not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteTier error', err);
    res.status(500).json({ error: 'Failed to delete tier' });
  }
}

module.exports = {
  pageItemsList,
  listItemsList,
  getItemsListById,
  createItemsList,
  updateItemsList,
  deleteItemsList,
  listRates,
  createRate,
  updateRate,
  deleteRate,
  createTier,
  updateTier,
  deleteTier,
};
