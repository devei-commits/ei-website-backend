/**
 * Paginated, batch-loaded price-list page (RM / PM / PR).
 * Replaces per-row rate/tier queries in pageItemsList.
 */
const { Op } = require('sequelize');
const db = require('../../db');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('./models');
const { partyWhereForItemsListRowType } = require('./partyTypeWhere');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const VendorClient = require('../vendorClient/models');
const { Product } = require('../products/models');
const { normalizeMasterApprovalStatus } = require('../lib/masterApprovalStatus');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const APPROVAL_ORDER = ['Draft', 'Under Review', 'Under Approval', 'Active'];

/**
 * Global price-list status index for a type: per-status master counts, and the
 * master-FK sets that carry each non-Draft status. A master with no price list
 * (or a Draft one) counts as Draft. Used so the status tabs' counts and filtering
 * are computed over the WHOLE catalog, consistent with server pagination.
 */
async function buildStatusIndex(pageType) {
  const fkField = fkFieldForType(pageType);
  const rows = await ItemsList.findAll({
    where: { type: pageType },
    attributes: [fkField, 'status'],
    raw: true,
  });
  const rank = (s) => {
    const i = APPROVAL_ORDER.indexOf(normalizeMasterApprovalStatus(s));
    return i < 0 ? 0 : i;
  };
  // canonical status per FK = the most-advanced status among its price-list rows
  const statusByFk = new Map();
  for (const r of rows) {
    const fk = r[fkField];
    if (fk == null) continue;
    const s = normalizeMasterApprovalStatus(r.status);
    const cur = statusByFk.get(fk);
    if (cur == null || rank(s) > rank(cur)) statusByFk.set(fk, s);
  }
  const totalMasters = await masterCountForType(pageType);
  const counts = { all: totalMasters, Draft: 0, 'Under Review': 0, 'Under Approval': 0, Active: 0 };
  const fksByStatus = { 'Under Review': [], 'Under Approval': [], Active: [] };
  const nonDraftFks = [];
  let draftPriced = 0;
  for (const [fk, s] of statusByFk) {
    if (s === 'Draft') {
      draftPriced += 1;
      continue;
    }
    counts[s] = (counts[s] || 0) + 1;
    nonDraftFks.push(fk);
    if (fksByStatus[s]) fksByStatus[s].push(fk);
  }
  // Draft = priced-but-draft + every master with no price list at all
  counts.Draft = draftPriced + Math.max(0, totalMasters - statusByFk.size);
  return { counts, fksByStatus, nonDraftFks };
}

async function masterCountForType(pageType) {
  if (pageType === 'RM') return RawMaterial.count();
  if (pageType === 'PM') return PackMaterial.count();
  return Product.count();
}

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

function groupItemsListRowsByFk(listRows, fkField) {
  const groups = new Map();
  for (const r of listRows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    const fk = plain[fkField];
    if (fk == null) continue;
    if (!groups.has(fk)) groups.set(fk, []);
    groups.get(fk).push(plain);
  }
  return groups;
}

function buildCanonicalMap(groups, ratesCountByListId) {
  const byFk = new Map();
  for (const [fk, group] of groups) {
    let best = group[0];
    let bestN = ratesCountByListId.get(best.id) || 0;
    for (let i = 1; i < group.length; i++) {
      const row = group[i];
      const n = ratesCountByListId.get(row.id) || 0;
      if (n > bestN || (n === bestN && row.id < best.id)) {
        best = row;
        bestN = n;
      }
    }
    byFk.set(fk, best);
  }
  return byFk;
}

async function loadRatesCountByListId(listIds, partyWhere) {
  const map = new Map();
  if (!listIds.length) return map;
  const rows = await ItemListVendorRate.findAll({
    attributes: ['items_list_id', [db.fn('COUNT', db.col('id')), 'cnt']],
    where: { items_list_id: { [Op.in]: listIds }, ...partyWhere },
    group: ['items_list_id'],
    raw: true,
  });
  for (const row of rows) {
    map.set(Number(row.items_list_id), Number(row.cnt) || 0);
  }
  return map;
}

function mapTier(t) {
  return {
    id: t.id,
    moq_min: t.moq_min,
    moq_max: t.moq_max,
    price_per_unit: toNum(t.price_per_unit),
    valid_till: t.valid_till || null,
    note: t.note || null,
  };
}

function mapRateWithTiers(rate, tiers, partyById) {
  const v = partyById.get(rate.vendor_id);
  return {
    id: rate.id,
    party_type: partyTypeFromRateRow(rate),
    vendor_id: rate.vendor_id,
    vendor_name: v ? v.name : null,
    vendor_code: v ? v.entity_code : null,
    lead_time_days: rate.lead_time_days != null ? Number(rate.lead_time_days) : null,
    currency: rate.currency || 'INR',
    payment_terms: rate.payment_terms || null,
    tiers: tiers.map(mapTier),
  };
}

async function batchRatesForListIds(listIds, pageType) {
  const partyWhere = ratePartyWhereForPageType(pageType);
  const ratesByListId = new Map();
  if (!listIds.length) return ratesByListId;

  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: { [Op.in]: listIds }, ...partyWhere },
    order: [['id', 'ASC']],
  });
  const ratePlain = rates.map((r) => (r.get ? r.get({ plain: true }) : r));
  const rateIds = ratePlain.map((r) => r.id);
  const tiers =
    rateIds.length > 0
      ? await ItemListTier.findAll({
          where: { item_list_vendor_rate_id: { [Op.in]: rateIds } },
          order: [
            ['item_list_vendor_rate_id', 'ASC'],
            ['moq_min', 'ASC'],
          ],
        })
      : [];
  const tiersByRateId = new Map();
  for (const t of tiers) {
    const p = t.get ? t.get({ plain: true }) : t;
    const rid = p.item_list_vendor_rate_id;
    if (!tiersByRateId.has(rid)) tiersByRateId.set(rid, []);
    tiersByRateId.get(rid).push(p);
  }
  const partyIds = new Set(ratePlain.map((r) => r.vendor_id));
  const parties =
    partyIds.size > 0
      ? await VendorClient.findAll({ where: { id: { [Op.in]: [...partyIds] } } })
      : [];
  const partyById = new Map(
    parties.map((v) => {
      const p = v.get ? v.get({ plain: true }) : v;
      return [p.id, p];
    })
  );
  for (const r of ratePlain) {
    if (!ratesByListId.has(r.items_list_id)) ratesByListId.set(r.items_list_id, []);
    ratesByListId.get(r.items_list_id).push(
      mapRateWithTiers(r, tiersByRateId.get(r.id) || [], partyById)
    );
  }
  return ratesByListId;
}

function searchWhereForType(pageType, search) {
  const q = String(search || '').trim();
  if (!q) return null;
  const like = { [Op.iLike]: `%${q}%` };
  if (pageType === 'RM') {
    return { [Op.or]: [{ code: like }, { name: like }, { inci: like }] };
  }
  if (pageType === 'PM') {
    return { [Op.or]: [{ code: like }, { description: like }] };
  }
  return {
    [Op.or]: [
      { product_code: like },
      { product_name: like },
      { generic_name: like },
      { brand_name: like },
    ],
  };
}

function fkFieldForType(pageType) {
  if (pageType === 'RM') return 'raw_material_id';
  if (pageType === 'PM') return 'pack_material_id';
  return 'product_id';
}

function masterPkField(pageType) {
  return pageType === 'PR' ? 'product_id' : 'id';
}

async function fkIdsForPartyFilter(pageType, partyId) {
  const partyWhere = ratePartyWhereForPageType(pageType);
  const rates = await ItemListVendorRate.findAll({
    attributes: ['items_list_id'],
    where: { vendor_id: partyId, ...partyWhere },
    raw: true,
  });
  const listIds = [...new Set(rates.map((r) => Number(r.items_list_id)).filter(Boolean))];
  if (!listIds.length) return [];
  const fkField = fkFieldForType(pageType);
  const listRows = await ItemsList.findAll({
    attributes: [fkField],
    where: { id: { [Op.in]: listIds }, type: pageType },
    raw: true,
  });
  return [...new Set(listRows.map((r) => r[fkField]).filter((id) => id != null))];
}

async function fetchMasters(pageType, { search, partyId, limit, offset, fkFilterIds, fkExcludeIds }) {
  const searchClause = searchWhereForType(pageType, search);
  const pk = masterPkField(pageType);
  let where = searchClause ? { ...searchClause } : {};
  if (fkFilterIds && fkFilterIds.length > 0) {
    where = { [Op.and]: [where, { [pk]: { [Op.in]: fkFilterIds } }] };
  } else if (fkFilterIds && fkFilterIds.length === 0) {
    return { masters: [], total: 0 };
  }
  if (fkExcludeIds && fkExcludeIds.length > 0) {
    where = { [Op.and]: [where, { [pk]: { [Op.notIn]: fkExcludeIds } }] };
  }

  if (pageType === 'RM') {
    const total = await RawMaterial.count({ where });
    const query = { where, order: [['code', 'ASC']] };
    if (limit != null) {
      query.limit = limit;
      query.offset = offset;
    }
    const masters = await RawMaterial.findAll(query);
    return { masters, total };
  }
  if (pageType === 'PM') {
    const total = await PackMaterial.count({ where });
    const query = { where, order: [['code', 'ASC']] };
    if (limit != null) {
      query.limit = limit;
      query.offset = offset;
    }
    const masters = await PackMaterial.findAll(query);
    return { masters, total };
  }
  const total = await Product.count({ where });
  const query = { where, order: [['product_code', 'ASC']] };
  if (limit != null) {
    query.limit = limit;
    query.offset = offset;
  }
  const masters = await Product.findAll(query);
  return { masters, total };
}

function buildItemFromMaster(pageType, master, listRow, vendorRates) {
  if (pageType === 'RM') {
    const r = master.get ? master.get({ plain: true }) : master;
    return {
      code: r.code,
      name: r.name || r.code,
      type: 'RM',
      uom: r.uom || 'KG',
      gst: toNum(r.gst) ?? 0,
      pricePerUnit: toNum(r.price_per_kg) ?? 0,
      raw_material_id: r.id,
      pack_material_id: null,
      product_id: null,
      itemsListId: listRow ? listRow.id : null,
      status: listRow ? listRow.status || 'Draft' : 'Draft',
      updatedAt: listRow ? listRow.updated_at || null : null,
      createdAt: listRow ? listRow.created_at || null : null,
      vendorRates,
    };
  }
  if (pageType === 'PM') {
    const p = master.get ? master.get({ plain: true }) : master;
    return {
      code: p.code,
      name: p.description || p.code,
      type: 'PM',
      pack_type: p.type || '',
      level: p.level || '',
      pricePerUnit: toNum(p.price_per_pc) ?? 0,
      moq: toNum(p.moq) ?? 0,
      raw_material_id: null,
      pack_material_id: p.id,
      product_id: null,
      itemsListId: listRow ? listRow.id : null,
      status: listRow ? listRow.status || 'Draft' : 'Draft',
      updatedAt: listRow ? listRow.updated_at || null : null,
      createdAt: listRow ? listRow.created_at || null : null,
      vendorRates,
    };
  }
  const prod = master.get ? master.get({ plain: true }) : master;
  return {
    code: prod.product_code || String(prod.product_id),
    name:
      prod.product_name ||
      prod.generic_name ||
      prod.brand_name ||
      prod.product_code ||
      String(prod.product_id),
    type: 'PR',
    uom: 'UNIT',
    gst: toNum(prod.tax_rate) ?? 0,
    pricePerUnit: toNum(prod.mrp_price) ?? 0,
    raw_material_id: null,
    pack_material_id: null,
    product_id: prod.product_id,
    itemsListId: listRow ? listRow.id : null,
    status: listRow ? listRow.status || 'Draft' : 'Draft',
    updatedAt: listRow ? listRow.updated_at || null : null,
    createdAt: listRow ? listRow.created_at || null : null,
    vendorRates,
  };
}

/**
 * @param {'RM'|'PM'|'PR'} pageType
 * @param {{ limit?: number|null, offset?: number, search?: string, partyId?: number|null }} opts
 */
async function buildPriceListPage(pageType, opts = {}) {
  const limit = opts.limit != null ? Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT)) : null;
  const offset = Math.max(0, Number(opts.offset) || 0);
  const search = opts.search || '';
  const partyId = opts.partyId != null && !Number.isNaN(Number(opts.partyId)) ? Number(opts.partyId) : null;

  const fkField = fkFieldForType(pageType);
  const partyFkFilterIds = partyId != null ? await fkIdsForPartyFilter(pageType, partyId) : null;

  // Status tabs: counts over the whole catalog + FK sets to filter/paginate server-side.
  const statusIndex = await buildStatusIndex(pageType);
  const statusFilter = opts.status ? normalizeMasterApprovalStatus(opts.status) : null;

  // Combine party filter (IN) and status filter (IN for non-Draft, NOT IN for Draft).
  let fkFilterIds = partyFkFilterIds;
  let fkExcludeIds = null;
  if (statusFilter && statusFilter !== 'Draft') {
    const statusFks = statusIndex.fksByStatus[statusFilter] || [];
    fkFilterIds =
      partyFkFilterIds != null
        ? partyFkFilterIds.filter((id) => statusFks.includes(id))
        : statusFks;
  } else if (statusFilter === 'Draft') {
    // Draft = masters with no active price list → exclude every non-Draft FK.
    fkExcludeIds = statusIndex.nonDraftFks;
  }

  const { masters, total } = await fetchMasters(pageType, {
    search,
    partyId,
    limit,
    offset,
    fkFilterIds,
    fkExcludeIds,
  });

  if (masters.length === 0) {
    return {
      rows: [],
      total,
      limit: limit ?? total,
      offset: limit != null ? offset : 0,
      statusCounts: statusIndex.counts,
    };
  }

  const pageFkValues = masters.map((m) => {
    const plain = m.get ? m.get({ plain: true }) : m;
    return pageType === 'PR' ? plain.product_id : plain.id;
  });

  const listRows = await ItemsList.findAll({
    where: { type: pageType, [fkField]: { [Op.in]: pageFkValues } },
    order: [['id', 'ASC']],
  });
  const listPlain = listRows.map((r) => (r.get ? r.get({ plain: true }) : r));
  const listIds = listPlain.map((r) => r.id);
  const ratesCountByListId = await loadRatesCountByListId(listIds, ratePartyWhereForPageType(pageType));
  const groups = groupItemsListRowsByFk(listPlain, fkField);
  const canonicalByFk = buildCanonicalMap(groups, ratesCountByListId);

  const pageListIds = [];
  for (const fk of pageFkValues) {
    const row = canonicalByFk.get(fk);
    if (row) pageListIds.push(row.id);
  }
  const ratesByListId = await batchRatesForListIds(pageListIds, pageType);

  const rows = masters.map((m) => {
    const plain = m.get ? m.get({ plain: true }) : m;
    const fk = pageType === 'PR' ? plain.product_id : plain.id;
    const listRow = canonicalByFk.get(fk) || null;
    const vendorRates = listRow ? ratesByListId.get(listRow.id) || [] : [];
    return buildItemFromMaster(pageType, m, listRow, vendorRates);
  });

  return {
    rows,
    total,
    limit: limit ?? total,
    offset: limit != null ? offset : 0,
    statusCounts: statusIndex.counts,
  };
}

async function countMastersWithRates(pageType) {
  const fkField = fkFieldForType(pageType);
  const partyWhere = ratePartyWhereForPageType(pageType);
  const rateRows = await ItemListVendorRate.findAll({
    attributes: ['items_list_id'],
    where: partyWhere,
    raw: true,
  });
  const listIds = [...new Set(rateRows.map((r) => Number(r.items_list_id)).filter(Boolean))];
  if (!listIds.length) return 0;
  const listRows = await ItemsList.findAll({
    attributes: [fkField],
    where: { id: { [Op.in]: listIds }, type: pageType, [fkField]: { [Op.ne]: null } },
    raw: true,
  });
  return new Set(listRows.map((r) => r[fkField])).size;
}

async function buildPriceListPageStats() {
  const [rmWithTiers, pmWithTiers, prWithTiers, totalRateRows, totalTiers] = await Promise.all([
    countMastersWithRates('RM'),
    countMastersWithRates('PM'),
    countMastersWithRates('PR'),
    ItemListVendorRate.count(),
    ItemListTier.count(),
  ]);

  return {
    rmWithTiers,
    pmWithTiers,
    prWithTiers,
    totalRateRows,
    totalTiers,
  };
}

function parsePageQuery(req) {
  const type = req.query.type;
  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const search = String(req.query.search || '').trim();
  const statusRaw = String(req.query.status || '').trim();
  const status = statusRaw && statusRaw.toLowerCase() !== 'all' ? statusRaw : null;
  const partyIdRaw = req.query.party_id;
  const partyId =
    partyIdRaw != null && String(partyIdRaw).trim() !== ''
      ? parseInt(String(partyIdRaw), 10)
      : null;
  const paginated =
    limitRaw != null ||
    offsetRaw != null ||
    search.length > 0 ||
    (partyId != null && !Number.isNaN(partyId));
  const limit =
    limitRaw != null
      ? Math.min(MAX_LIMIT, Math.max(1, parseInt(String(limitRaw), 10) || DEFAULT_LIMIT))
      : null;
  const offset = offsetRaw != null ? Math.max(0, parseInt(String(offsetRaw), 10) || 0) : 0;
  return {
    type,
    limit,
    offset,
    search,
    status,
    partyId: partyId != null && !Number.isNaN(partyId) ? partyId : null,
    paginated,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parsePageQuery,
  buildPriceListPage,
  buildPriceListPageStats,
};
