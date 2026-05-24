const { Op } = require('sequelize');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('./models');
const { partyWhereForItemsListRowType } = require('./partyTypeWhere');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const VendorClient = require('../vendorClient/models');
const { Product } = require('../products/models');
const { parseMoqQuantity } = require('../lib/moqQuantity');

function toNum(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

function ratePartyWhereForPageType(pageType) {
  return partyWhereForItemsListRowType(pageType);
}

function partyTypeFromRateRow(rate) {
  const t = String(rate.party_type || 'vendor').toLowerCase();
  return t === 'client' ? 'client' : 'vendor';
}

/**
 * Duplicate items_list rows for the same RM/PM/PR FK can exist historically.
 * Map-building used only the last row per FK, so rates on another row were invisible.
 * Prefer the row with the most rates of the correct party kind; tie-break lower id.
 */
async function pickCanonicalItemsListRow(rows, pageType) {
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const partyWhere = ratePartyWhereForPageType(pageType);
  let best = rows[0];
  let bestCount = -1;
  for (const row of rows) {
    const n = await ItemListVendorRate.count({ where: { items_list_id: row.id, ...partyWhere } });
    if (n > bestCount || (n === bestCount && row.id < best.id)) {
      best = row;
      bestCount = n;
    }
  }
  return best;
}

function groupItemsListRowsByFk(listRows, fkField) {
  const groups = new Map();
  for (const r of listRows) {
    const fk = r[fkField];
    if (fk == null) continue;
    if (!groups.has(fk)) groups.set(fk, []);
    groups.get(fk).push(r);
  }
  return groups;
}

/**
 * Resolve item row to display shape from RM or PM master (async, single row).
 */
async function resolveItemMaster(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  if (d.type === 'RM' && d.raw_material_id) {
    const rm = await RawMaterial.findByPk(d.raw_material_id);
    if (!rm) return null;
    const r = rm.get ? rm.get({ plain: true }) : rm;
    return resolveItemMasterFromMaps(d, r, null, null);
  }
  if (d.type === 'PM' && d.pack_material_id) {
    const pm = await PackMaterial.findByPk(d.pack_material_id);
    if (!pm) return null;
    const p = pm.get ? pm.get({ plain: true }) : pm;
    return resolveItemMasterFromMaps(d, null, p, null);
  }
  if (d.type === 'PR' && d.product_id) {
    const prod = await Product.findByPk(d.product_id);
    if (!prod) return null;
    const p = prod.get ? prod.get({ plain: true }) : prod;
    return resolveItemMasterFromMaps(d, null, null, p);
  }
  return null;
}

/** Sync resolution when RM/PM/PR maps are already loaded (for batch list). */
function resolveItemMasterFromMaps(d, r, p, prod) {
  if (r) {
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
      product_id: null,
    };
  }
  if (p) {
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
      product_id: null,
    };
  }
  if (prod) {
    const price = toNum(prod.mrp_price);
    return {
      id: String(d.id),
      code: prod.product_code || String(prod.product_id),
      name: prod.product_name || prod.generic_name || prod.brand_name || prod.product_code || String(prod.product_id),
      type: 'PR',
      category: prod.category || '',
      pricePerUnit: price ?? 0,
      uom: 'UNIT',
      gst: toNum(prod.tax_rate) ?? 0,
      status: d.status || prod.status || 'Active',
      raw_material_id: null,
      pack_material_id: null,
      product_id: d.product_id ?? null,
    };
  }
  return null;
}

const {
  parsePageQuery,
  buildPriceListPage,
  buildPriceListPageStats,
} = require('./pageItemsListPage');

/**
 * GET /page/stats — dashboard counts without loading full catalog.
 */
async function pageItemsStats(req, res) {
  try {
    const stats = await buildPriceListPageStats();
    res.json(stats);
  } catch (err) {
    console.error('pageItemsStats error', err);
    res.status(500).json({ error: 'Failed to load price list stats' });
  }
}

/**
 * GET /page?type=RM|PM|PR — price list rows for Items List UI.
 * With limit/offset/search/party_id returns { rows, total, limit, offset } (paginated).
 * Without limit returns all rows as a JSON array (legacy consumers).
 */
async function pageItemsList(req, res) {
  try {
    const { type, limit, offset, search, partyId, paginated } = parsePageQuery(req);
    if (type !== 'RM' && type !== 'PM' && type !== 'PR') {
      return res.status(400).json({ error: 'Query type must be RM, PM, or PR' });
    }
    const result = await buildPriceListPage(type, {
      limit: paginated ? limit : null,
      offset,
      search,
      partyId,
    });
    if (paginated) return res.json(result);
    return res.json(result.rows);
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
    const typeFilter = req.query.type; // 'RM' | 'PM' | 'PR' | omit = all
    const where = {};
    if (typeFilter === 'RM' || typeFilter === 'PM' || typeFilter === 'PR') where.type = typeFilter;

    const rows = await ItemsList.findAll({ where, order: [['id', 'ASC']] });
    const rowIds = rows.map((r) => r.id);
    const rmIds = [...new Set(rows.map((r) => (r.get ? r.get({ plain: true }) : r).raw_material_id).filter(Boolean))];
    const pmIds = [...new Set(rows.map((r) => (r.get ? r.get({ plain: true }) : r).pack_material_id).filter(Boolean))];
    const prodIds = [...new Set(rows.map((r) => (r.get ? r.get({ plain: true }) : r).product_id).filter(Boolean))];

    const [ratesList, rmsList, pmsList, prodsList] = await Promise.all([
      rowIds.length ? ItemListVendorRate.findAll({ where: { items_list_id: { [Op.in]: rowIds } }, order: [['id', 'ASC']] }) : Promise.resolve([]),
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds } }) : Promise.resolve([]),
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds } }) : Promise.resolve([]),
      prodIds.length ? Product.findAll({ where: { product_id: prodIds } }) : Promise.resolve([]),
    ]);
    const rateIds = (ratesList || []).map((r) => r.id);
    const tiersList = rateIds.length
      ? await ItemListTier.findAll({ where: { item_list_vendor_rate_id: { [Op.in]: rateIds } }, attributes: ['item_list_vendor_rate_id'] })
      : [];

    const ratesByListId = new Map();
    for (const r of ratesList) {
      const listId = r.items_list_id;
      if (!ratesByListId.has(listId)) ratesByListId.set(listId, []);
      ratesByListId.get(listId).push(r);
    }
    const tierCountByRateId = new Map();
    for (const t of tiersList) {
      const rid = t.item_list_vendor_rate_id;
      tierCountByRateId.set(rid, (tierCountByRateId.get(rid) || 0) + 1);
    }
    const rmMap = new Map((rmsList || []).map((x) => {
      const d = x.get ? x.get({ plain: true }) : x;
      return [d.id, d];
    }));
    const pmMap = new Map((pmsList || []).map((x) => {
      const d = x.get ? x.get({ plain: true }) : x;
      return [d.id, d];
    }));
    const prodMap = new Map((prodsList || []).map((x) => {
      const d = x.get ? x.get({ plain: true }) : x;
      return [d.product_id, d];
    }));

    const list = [];
    for (const row of rows) {
      const d = row.get ? row.get({ plain: true }) : row;
      const r = d.type === 'RM' && d.raw_material_id ? rmMap.get(d.raw_material_id) : null;
      const p = d.type === 'PM' && d.pack_material_id ? pmMap.get(d.pack_material_id) : null;
      const prod = d.type === 'PR' && d.product_id ? prodMap.get(d.product_id) : null;
      const base = resolveItemMasterFromMaps(d, r, p, prod);
      if (!base) continue;
      const allRatesForRow = ratesByListId.get(row.id) || [];
      const rates = allRatesForRow.filter((rate) => {
        const pt = partyTypeFromRateRow(rate);
        if (d.type === 'PR') return pt === 'client';
        return pt === 'vendor';
      });
      const tierCount = rates.reduce((sum, rate) => sum + (tierCountByRateId.get(rate.id) || 0), 0);
      let lastUpdated = row.updated_at;
      for (const rate of rates) {
        const u = rate.updated_at;
        if (u && (!lastUpdated || new Date(u) > new Date(lastUpdated))) lastUpdated = u;
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
    const rowPlain = row.get ? row.get({ plain: true }) : row;
    const partyWhere = partyWhereForItemsListRowType(rowPlain.type);
    const [base, rates] = await Promise.all([
      resolveItemMaster(row),
      ItemListVendorRate.findAll({ where: { items_list_id: id, ...partyWhere }, order: [['id', 'ASC']] }),
    ]);
    if (!base) return res.status(404).json({ error: 'Master not found' });

    const vendorIds = [...new Set(rates.map((r) => r.vendor_id))];
    const rateIds = rates.map((r) => r.id);
    const [vendors, allTiers] = await Promise.all([
      vendorIds.length ? VendorClient.findAll({ where: { id: vendorIds } }) : Promise.resolve([]),
      rateIds.length
        ? ItemListTier.findAll({
            where: { item_list_vendor_rate_id: { [Op.in]: rateIds } },
            order: [
              ['item_list_vendor_rate_id', 'ASC'],
              ['moq_min', 'ASC'],
            ],
          })
        : Promise.resolve([]),
    ]);
    const vendorById = new Map(vendors.map((v) => [v.id, v.get ? v.get({ plain: true }) : v]));
    const tiersByRateId = new Map();
    for (const t of allTiers) {
      const rid = t.item_list_vendor_rate_id;
      if (!tiersByRateId.has(rid)) tiersByRateId.set(rid, []);
      tiersByRateId.get(rid).push(t);
    }

    const ratesWithTiers = rates.map((r) => {
      const tiers = tiersByRateId.get(r.id) || [];
      const v = vendorById.get(r.vendor_id);
      return {
        id: r.id,
        party_type: partyTypeFromRateRow(r),
        vendor_id: r.vendor_id,
        vendor_name: v ? v.name : null,
        vendor_code: v ? v.entity_code : null,
        default_rate: toNum(r.default_rate),
        default_moq: toNum(r.default_moq),
        lead_time_days: r.lead_time_days != null ? Number(r.lead_time_days) : null,
        currency: r.currency || 'INR',
        payment_terms: r.payment_terms || null,
        status: r.status,
        tiers: tiers.map((t) => ({
          id: t.id,
          moq_min: t.moq_min,
          moq_max: t.moq_max,
          price_per_unit: toNum(t.price_per_unit),
          valid_till: t.valid_till || null,
          note: t.note || null,
        })),
      };
    });

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
 * POST / — add item (type + raw_material_id, pack_material_id, or product_id).
 */
async function createItemsList(req, res) {
  try {
    const { type, raw_material_id, pack_material_id, product_id, status } = req.body;
    if (type !== 'RM' && type !== 'PM' && type !== 'PR') {
      return res.status(400).json({ error: 'type must be RM, PM, or PR' });
    }
    const rmId = raw_material_id != null ? parseInt(raw_material_id, 10) : null;
    const pmId = pack_material_id != null ? parseInt(pack_material_id, 10) : null;
    const prodId = product_id != null ? parseInt(product_id, 10) : null;
    if (type === 'RM') {
      if (rmId == null || Number.isNaN(rmId)) return res.status(400).json({ error: 'raw_material_id required for RM' });
      const existing = await ItemsList.findOne({ where: { type: 'RM', raw_material_id: rmId } });
      if (existing) return res.status(409).json({ error: 'This raw material is already in the items list' });
    } else if (type === 'PM') {
      if (pmId == null || Number.isNaN(pmId)) return res.status(400).json({ error: 'pack_material_id required for PM' });
      const existing = await ItemsList.findOne({ where: { type: 'PM', pack_material_id: pmId } });
      if (existing) return res.status(409).json({ error: 'This pack material is already in the items list' });
    } else {
      if (prodId == null || Number.isNaN(prodId)) return res.status(400).json({ error: 'product_id required for PR' });
      const existing = await ItemsList.findOne({ where: { type: 'PR', product_id: prodId } });
      if (existing) return res.status(409).json({ error: 'This product is already in the items list' });
    }
    const row = await ItemsList.create({
      type,
      raw_material_id: type === 'RM' ? rmId : null,
      pack_material_id: type === 'PM' ? pmId : null,
      product_id: type === 'PR' ? prodId : null,
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
    const rowPlain = row.get ? row.get({ plain: true }) : row;
    const partyWhere = partyWhereForItemsListRowType(rowPlain.type);
    const rates = await ItemListVendorRate.findAll({ where: { items_list_id: id, ...partyWhere } });
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
    const item = await ItemsList.findByPk(itemsListId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const itemPlain = item.get ? item.get({ plain: true }) : item;
    const partyWhere = partyWhereForItemsListRowType(itemPlain.type);
    const rates = await ItemListVendorRate.findAll({
      where: { items_list_id: itemsListId, ...partyWhere },
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
        party_type: partyTypeFromRateRow(r),
        vendor_id: r.vendor_id,
        vendor_name: v ? v.name : null,
        vendor_code: v ? v.entity_code : null,
        default_rate: toNum(r.default_rate),
        default_moq: toNum(r.default_moq),
        lead_time_days: r.lead_time_days != null ? Number(r.lead_time_days) : null,
        currency: r.currency || 'INR',
        payment_terms: r.payment_terms || null,
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
    const itemPlain = item.get ? item.get({ plain: true }) : item;
    const partyType = itemPlain.type === 'PR' ? 'client' : 'vendor';
    const { vendor_id, default_rate, default_moq, currency, payment_terms, lead_time_days, leadTimeDays } = req.body;
    const vendorId = vendor_id != null ? parseInt(vendor_id, 10) : null;
    if (vendorId == null || Number.isNaN(vendorId)) return res.status(400).json({ error: 'vendor_id required' });
    const vc = await VendorClient.findByPk(vendorId);
    if (!vc) return res.status(404).json({ error: 'Vendor/client master not found' });
    const vcPlain = vc.get ? vc.get({ plain: true }) : vc;
    const vcType = String(vcPlain.type || '').toLowerCase();
    if (partyType === 'vendor' && vcType !== 'vendor') {
      return res.status(400).json({ error: 'Raw/pack price lists require a vendor from Masters → Vendors' });
    }
    if (partyType === 'client' && vcType !== 'client') {
      return res.status(400).json({ error: 'Product price lists require a client from Masters → Clients' });
    }
    const existing = await ItemListVendorRate.findOne({
      where: { items_list_id: itemsListId, vendor_id: vendorId, party_type: partyType },
    });
    if (existing) {
      return res.status(409).json({
        error:
          partyType === 'client'
            ? 'Client pricing already exists for this product'
            : 'Vendor rate already exists for this item',
      });
    }
    const row = await ItemListVendorRate.create({
      items_list_id: itemsListId,
      vendor_id: vendorId,
      party_type: partyType,
      default_rate: default_rate != null ? parseFloat(default_rate) : null,
      default_moq: default_moq != null ? parseMoqQuantity(default_moq) : null,
      lead_time_days:
        lead_time_days != null
          ? parseInt(lead_time_days, 10)
          : leadTimeDays != null
            ? parseInt(leadTimeDays, 10)
            : null,
      currency: currency || 'INR',
      payment_terms: payment_terms || null,
      status: 'active',
    });
    const plain = vcPlain;
    res.status(201).json({
      id: row.id,
      party_type: partyType,
      vendor_id: row.vendor_id,
      vendor_name: plain.name || null,
      vendor_code: plain.entity_code || null,
      default_rate: toNum(row.default_rate),
      default_moq: toNum(row.default_moq),
      lead_time_days: row.lead_time_days != null ? Number(row.lead_time_days) : null,
      currency: row.currency || 'INR',
      payment_terms: row.payment_terms || null,
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
    const { default_rate, default_moq, currency, payment_terms, status, lead_time_days, leadTimeDays } = req.body;
    if (default_rate !== undefined) row.default_rate = default_rate;
    if (default_moq !== undefined) row.default_moq = default_moq == null ? null : parseMoqQuantity(default_moq);
    if (lead_time_days !== undefined) row.lead_time_days = lead_time_days == null ? null : parseInt(lead_time_days, 10);
    if (leadTimeDays !== undefined) row.lead_time_days = leadTimeDays == null ? null : parseInt(leadTimeDays, 10);
    if (currency !== undefined) row.currency = currency;
    if (payment_terms !== undefined) row.payment_terms = payment_terms;
    if (status !== undefined) row.status = status;
    await row.save();
    const v = await VendorClient.findByPk(row.vendor_id);
    const plain = v ? v.get({ plain: true }) : {};
    const tiers = await ItemListTier.findAll({ where: { item_list_vendor_rate_id: rateId }, order: [['moq_min', 'ASC']] });
    res.json({
      id: row.id,
      party_type: partyTypeFromRateRow(row),
      vendor_id: row.vendor_id,
      vendor_name: plain.name || null,
      vendor_code: plain.entity_code || null,
      default_rate: toNum(row.default_rate),
      default_moq: toNum(row.default_moq),
      lead_time_days: row.lead_time_days != null ? Number(row.lead_time_days) : null,
      currency: row.currency || 'INR',
      payment_terms: row.payment_terms || null,
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
    const moqMin = moq_min != null ? parseMoqQuantity(moq_min) : null;
    if (moqMin == null) return res.status(400).json({ error: 'moq_min required' });
    const price = price_per_unit != null ? parseFloat(price_per_unit) : null;
    if (price == null || Number.isNaN(price)) return res.status(400).json({ error: 'price_per_unit required' });
    const row = await ItemListTier.create({
      item_list_vendor_rate_id: rateId,
      moq_min: moqMin,
      moq_max: moq_max != null ? parseMoqQuantity(moq_max) : null,
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
    if (moq_min !== undefined) {
      const parsed = parseMoqQuantity(moq_min);
      if (parsed == null) return res.status(400).json({ error: 'moq_min required' });
      row.moq_min = parsed;
    }
    if (moq_max !== undefined) row.moq_max = moq_max == null ? null : parseMoqQuantity(moq_max);
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

async function resolveClientProductPriceHandler(req, res) {
  try {
    const { resolveClientProductPrice } = require('./resolveClientProductPrice');
    const productId = parseInt(req.query.product_id, 10);
    const clientId = parseInt(req.query.client_id, 10);
    const quantity = req.query.quantity != null ? parseInt(req.query.quantity, 10) : 1;
    if (Number.isNaN(productId) || productId <= 0) {
      return res.status(400).json({ error: 'product_id is required' });
    }
    if (Number.isNaN(clientId) || clientId <= 0) {
      return res.status(400).json({ error: 'client_id is required' });
    }
    const result = await resolveClientProductPrice({
      productId,
      clientId,
      quantity: Number.isNaN(quantity) ? 1 : quantity,
    });
    res.json(result);
  } catch (err) {
    console.error('resolveClientProductPriceHandler error', err);
    res.status(500).json({ error: 'Failed to resolve client product price' });
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
  resolveClientProductPriceHandler,
  pageItemsList,
  pageItemsStats,
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
