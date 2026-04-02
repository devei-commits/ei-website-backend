/**
 * Procurement line lead-time: parse from line_notes, merge canonical "Lead: Nd" segment,
 * and resolve from Items List vendor rates when RM/PM/PR ids + preferred vendor match.
 */

const { Op } = require('sequelize');
const { ItemsList, ItemListVendorRate } = require('../itemsList/models');
const VendorClient = require('../vendorClient/models');

function normVendorName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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
  };
  if (keys.size === 0) return empty;

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
  for (const row of rows) {
    const plain = row.get ? row.get({ plain: true }) : row;
    let k = null;
    if (plain.type === 'RM' && plain.raw_material_id) k = `RM:${plain.raw_material_id}`;
    else if (plain.type === 'PM' && plain.pack_material_id) k = `PM:${plain.pack_material_id}`;
    else if (plain.type === 'PR' && plain.product_id) k = `PR:${plain.product_id}`;
    if (k && !listIdByKey.has(k)) listIdByKey.set(k, plain.id);
  }
  const listIds = [...new Set([...listIdByKey.values()])];
  if (!listIds.length) {
    return { listIdByKey, ratesByListId: new Map(), vendorNameById: new Map() };
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
    if (!ratesByListId.has(lid)) ratesByListId.set(lid, []);
    ratesByListId.get(lid).push(rr);
  }
  return { listIdByKey, ratesByListId, vendorNameById };
}

function enrichProcurementItemsWithResolvedLead(items, preferredVendor, cache) {
  if (!Array.isArray(items)) return [];
  return items.map((i) => {
    const row = { ...i };
    let lead = null;
    if (row.lead_time_days != null && row.lead_time_days !== '') {
      const d = parseInt(String(row.lead_time_days).replace(/\D/g, ''), 10);
      if (Number.isFinite(d) && d >= 0) lead = d;
    }
    if (lead === null) {
      const fromNotes = parseLeadFromLineNotes(row.line_notes);
      if (fromNotes !== null) lead = fromNotes;
    }
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

module.exports = {
  parseLeadFromLineNotes,
  mergeLeadIntoLineNotes,
  keyForItem,
  buildLeadResolutionCache,
  enrichProcurementItemsWithResolvedLead,
};
