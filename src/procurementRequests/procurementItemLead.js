/**
 * Procurement line lead-time: parse from line_notes, merge canonical "Lead: Nd" segment,
 * and resolve from Items List vendor rates when RM/PM/PR ids + preferred vendor match.
 */

const { Op } = require('sequelize');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const VendorClient = require('../vendorClient/models');
const LeadTimeStat = require('../leadTime/leadTimeStatModel');

function normVendorName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Actual-from-history lead (spec §10): pick the cached avg ACTUAL lead for the preferred vendor.
 * Only rows with real history (source history / history-12m) and a numeric avg qualify; on a
 * preferred-vendor miss we return null so the price-list (quoted) fallback for THAT vendor applies.
 */
function resolveActualLeadFromStats(stats, preferredVendor) {
  if (!stats || !stats.length) return null;
  const usable = stats.filter(
    (s) => s.avgActualDays != null && (s.source === 'history' || s.source === 'history-12m')
  );
  if (!usable.length) return null;
  const pref = normVendorName(preferredVendor);
  if (pref) {
    const match = usable.find((s) => {
      const vn = normVendorName(s.vendor);
      return vn && (vn === pref || vn.includes(pref) || pref.includes(vn));
    });
    return match ? Math.round(Number(match.avgActualDays)) : null;
  }
  return Math.round(Number(usable[0].avgActualDays));
}

/** Match Planning / Procurement UI: "Lead: 14d" (case-insensitive). */
function parseLeadFromLineNotes(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/Lead:\s*(\d+)\s*d/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Ensure line_notes contains a Lead segment consistent with leadDays.
 * Replaces an existing Lead: Nd segment; otherwise appends " | Lead: Nd".
 */
function mergeLeadIntoLineNotes(notes, leadDays) {
  if (leadDays == null || !Number.isFinite(leadDays) || leadDays < 0) return notes ?? '';
  const leadSeg = `Lead: ${leadDays}d`;
  const s = String(notes ?? '').trim();
  if (!s) return leadSeg;
  if (/Lead:\s*\d+\s*d/i.test(s)) return s.replace(/Lead:\s*\d+\s*d/i, leadSeg);
  return `${s} | ${leadSeg}`;
}

function keyForItem(it) {
  const rm = it.raw_material_id != null ? Number(it.raw_material_id) : NaN;
  const pm = it.pack_material_id != null ? Number(it.pack_material_id) : NaN;
  const pr = it.product_id != null ? Number(it.product_id) : NaN;
  if (Number.isFinite(rm) && rm > 0) return `RM:${rm}`;
  if (Number.isFinite(pm) && pm > 0) return `PM:${pm}`;
  if (Number.isFinite(pr) && pr > 0) return `PR:${pr}`;
  return null;
}

function resolveLeadFromRates(rates, preferredVendor, vendorNameById) {
  const pref = normVendorName(preferredVendor);
  if (pref) {
    for (const r of rates) {
      const vn = vendorNameById.get(r.vendor_id);
      const vnName = normVendorName(vn);
      if (vnName && (vnName === pref || vnName.includes(pref) || pref.includes(vnName))) {
        if (r.lead_time_days != null && Number.isFinite(Number(r.lead_time_days))) {
          return Number(r.lead_time_days);
        }
      }
    }
  }
  for (const r of rates) {
    if (r.lead_time_days != null && Number.isFinite(Number(r.lead_time_days))) {
      return Number(r.lead_time_days);
    }
  }
  return null;
}

/**
 * One DB round-trip for all RM/PM/PR keys in items — used by list + get.
 */
async function buildLeadResolutionCache(allItems) {
  const keys = new Set();
  for (const it of allItems || []) {
    const k = keyForItem(it);
    if (k) keys.add(k);
  }
  const empty = {
    listIdByKey: new Map(),
    ratesByListId: new Map(),
    vendorNameById: new Map(),
    listTypeById: new Map(),
    leadStatsByItemKey: new Map(),
  };
  if (keys.size === 0) return empty;

  // Actual-from-history lead stats (spec §10) for these items, keyed `RM:id` / `PM:id`.
  const leadStatsByItemKey = new Map();
  {
    const rmIds = [];
    const pmIds = [];
    for (const k of keys) {
      const [t, idStr] = k.split(':');
      const n = parseInt(idStr, 10);
      if (!Number.isFinite(n)) continue;
      if (t === 'RM') rmIds.push(n);
      else if (t === 'PM') pmIds.push(n);
    }
    const statOr = [];
    if (rmIds.length) statOr.push({ raw_material_id: { [Op.in]: rmIds } });
    if (pmIds.length) statOr.push({ pack_material_id: { [Op.in]: pmIds } });
    if (statOr.length) {
      try {
        const statRows = await LeadTimeStat.findAll({ where: { [Op.or]: statOr } });
        for (const sr of statRows) {
          const s = sr.get ? sr.get({ plain: true }) : sr;
          const ik = s.item_type === 'RM' ? `RM:${s.raw_material_id}` : `PM:${s.pack_material_id}`;
          if (!leadStatsByItemKey.has(ik)) leadStatsByItemKey.set(ik, []);
          leadStatsByItemKey.get(ik).push({
            vendor: s.vendor_name,
            avgActualDays: s.avg_actual_days != null ? Number(s.avg_actual_days) : null,
            source: s.source,
            trendUp: Boolean(s.trend_up),
          });
        }
      } catch {
        // lead_time_stats table may not exist yet (pre-sync) — price-list fallback remains.
      }
    }
  }

  const or = [];
  for (const k of keys) {
    const [t, idStr] = k.split(':');
    const n = parseInt(idStr, 10);
    if (!Number.isFinite(n)) continue;
    if (t === 'RM') or.push({ type: 'RM', raw_material_id: n });
    if (t === 'PM') or.push({ type: 'PM', pack_material_id: n });
    if (t === 'PR') or.push({ type: 'PR', product_id: n });
  }
  if (!or.length) return empty;

  const rows = await ItemsList.findAll({ where: { [Op.or]: or }, order: [['id', 'ASC']] });
  const listIdByKey = new Map();
  const listTypeById = new Map();
  for (const row of rows) {
    const plain = row.get ? row.get({ plain: true }) : row;
    listTypeById.set(plain.id, plain.type);
    let k = null;
    if (plain.type === 'RM' && plain.raw_material_id) k = `RM:${plain.raw_material_id}`;
    else if (plain.type === 'PM' && plain.pack_material_id) k = `PM:${plain.pack_material_id}`;
    else if (plain.type === 'PR' && plain.product_id) k = `PR:${plain.product_id}`;
    if (k && !listIdByKey.has(k)) listIdByKey.set(k, plain.id);
  }
  const listIds = [...new Set([...listIdByKey.values()])];
  if (!listIds.length) {
    return { listIdByKey, ratesByListId: new Map(), vendorNameById: new Map(), listTypeById, leadStatsByItemKey };
  }

  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: { [Op.in]: listIds } },
    order: [['id', 'ASC']],
  });
  const vendorIds = [
    ...new Set(
      rates.map((r) => {
        const rr = r.get ? r.get({ plain: true }) : r;
        return rr.vendor_id;
      })
    ),
  ];
  const vendors = vendorIds.length
    ? await VendorClient.findAll({
        where: { id: { [Op.in]: vendorIds } },
        attributes: ['id', 'name'],
      })
    : [];
  const vendorNameById = new Map(
    vendors.map((v) => {
      const p = v.get ? v.get({ plain: true }) : v;
      return [p.id, p.name];
    })
  );
  const ratesByListId = new Map();
  for (const r of rates) {
    const rr = r.get ? r.get({ plain: true }) : r;
    const lid = rr.items_list_id;
    const listType = listTypeById.get(lid);
    const pt = String(rr.party_type || 'vendor').toLowerCase();
    if (listType === 'PR') {
      if (pt !== 'client') continue;
    } else if (pt === 'client') {
      continue;
    }
    if (!ratesByListId.has(lid)) ratesByListId.set(lid, []);
    ratesByListId.get(lid).push(rr);
  }
  return { listIdByKey, ratesByListId, vendorNameById, listTypeById, leadStatsByItemKey };
}

function enrichProcurementItemsWithResolvedLead(items, preferredVendor, cache) {
  if (!Array.isArray(items)) return [];
  return items.map((i) => {
    const row = { ...i };
    let lead = null;
    // 1. Explicit manual lead on the line wins (deliberate override).
    if (row.lead_time_days != null && row.lead_time_days !== '') {
      const d = parseInt(String(row.lead_time_days).replace(/\D/g, ''), 10);
      if (Number.isFinite(d) && d >= 0) lead = d;
    }
    // 2. Avg ACTUAL lead from purchase history (spec §10) — must beat the quoted price-list value.
    if (lead === null) {
      const k = keyForItem(row);
      const stats = k && cache.leadStatsByItemKey ? cache.leadStatsByItemKey.get(k) : null;
      const actual = resolveActualLeadFromStats(stats, preferredVendor);
      if (actual !== null) lead = actual;
    }
    // 3. Lead segment previously written into line_notes.
    if (lead === null) {
      const fromNotes = parseLeadFromLineNotes(row.line_notes);
      if (fromNotes !== null) lead = fromNotes;
    }
    // 4. Price-list (quoted) fallback — §10 secondary reference only.
    if (lead === null) {
      const k = keyForItem(row);
      if (k && cache.listIdByKey.has(k)) {
        const listId = cache.listIdByKey.get(k);
        const rates = cache.ratesByListId.get(listId) || [];
        const resolved = resolveLeadFromRates(rates, preferredVendor, cache.vendorNameById);
        if (resolved !== null) lead = resolved;
      }
    }
    if (lead !== null) {
      row.lead_time_days = lead;
      row.line_notes = mergeLeadIntoLineNotes(row.line_notes, lead);
    }
    return row;
  });
}

/**
 * Vendor × MOQ price-list tiers for one item (Procurement spec §3A dual-pane).
 * Sources items_list → item_list_vendor_rates → item_list_tiers. Rates without
 * explicit tiers fall back to a single default_rate / default_moq row.
 * @returns {Promise<Array<{vendor,vendorCode,tier,price,lead}>>}
 */
async function getItemPriceListTiers({ rawMaterialId, packMaterialId }) {
  const rmId = rawMaterialId != null ? Number(rawMaterialId) : NaN;
  const pmId = packMaterialId != null ? Number(packMaterialId) : NaN;
  const where = { lifecycle_status: 'active' };
  if (Number.isFinite(rmId) && rmId > 0) { where.type = 'RM'; where.raw_material_id = rmId; }
  else if (Number.isFinite(pmId) && pmId > 0) { where.type = 'PM'; where.pack_material_id = pmId; }
  else return [];

  const itemRow = await ItemsList.findOne({ where });
  if (!itemRow) return [];

  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: itemRow.id, party_type: 'vendor' },
  });
  if (!rates.length) return [];
  const ratesPlain = rates.map((r) => (r.get ? r.get({ plain: true }) : r));
  const rateIds = ratesPlain.map((r) => r.id);
  const vendorIds = [...new Set(ratesPlain.map((r) => r.vendor_id).filter(Boolean))];

  const [tiers, vendors] = await Promise.all([
    ItemListTier.findAll({ where: { item_list_vendor_rate_id: rateIds }, order: [['moq_min', 'ASC']] }),
    vendorIds.length ? VendorClient.findAll({ where: { id: vendorIds } }) : Promise.resolve([]),
  ]);
  const vendorMap = new Map(vendors.map((v) => { const d = v.get ? v.get({ plain: true }) : v; return [d.id, d]; }));
  const rateMap = new Map(ratesPlain.map((r) => [r.id, r]));
  const vendorOf = (rate) => {
    const v = rate ? vendorMap.get(rate.vendor_id) : null;
    return { vendor: v ? (v.name || '—') : '—', vendorCode: v ? (v.entity_code || null) : null };
  };

  const out = [];
  const ratesWithTier = new Set();
  for (const t of tiers.map((x) => (x.get ? x.get({ plain: true }) : x))) {
    const rate = rateMap.get(t.item_list_vendor_rate_id);
    if (!rate) continue;
    ratesWithTier.add(rate.id);
    const tierLabel = t.moq_max != null ? `${Number(t.moq_min)}–${Number(t.moq_max)}` : `${Number(t.moq_min)}+`;
    out.push({ ...vendorOf(rate), tier: tierLabel, price: Number(t.price_per_unit) || 0, lead: rate.lead_time_days != null ? Number(rate.lead_time_days) : 0 });
  }
  for (const r of ratesPlain) {
    if (ratesWithTier.has(r.id) || r.default_rate == null) continue;
    out.push({ ...vendorOf(r), tier: r.default_moq != null ? `${Number(r.default_moq)}+` : '—', price: Number(r.default_rate) || 0, lead: r.lead_time_days != null ? Number(r.lead_time_days) : 0 });
  }
  return out;
}

module.exports = {
  parseLeadFromLineNotes,
  mergeLeadIntoLineNotes,
  keyForItem,
  buildLeadResolutionCache,
  enrichProcurementItemsWithResolvedLead,
  getItemPriceListTiers,
};
