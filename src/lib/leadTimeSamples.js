'use strict';

/**
 * Build lead-time samples per (itemType, itemId, vendor) from completed GRNs and their POs (spec §10).
 * A sample = GRN-completion date − PO-issued (order) date, in days, applied to every RM/PM line on the
 * PO. Partial-GRN handling (§10.2): use the FIRST completed GRN per PO (earliest completion date), so a
 * PO that is received in several drops contributes one sample dated at first ≥-completion.
 *
 * Pure — pass already-fetched PO/GRN rows (Sequelize instances or plain objects).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function plain(row) {
  return row && row.get ? row.get({ plain: true }) : row;
}

function dateMs(dateStr) {
  if (!dateStr) return null;
  const ms = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function daysBetween(issuedDateStr, completedDateStr) {
  const a = dateMs(issuedDateStr);
  const b = dateMs(completedDateStr);
  if (a == null || b == null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/** A GRN counts once it is fully received/posted. */
function isCompletedGrn(g) {
  const status = String(g.status || '').trim().toLowerCase();
  const stage = String(g.stage || '').trim().toLowerCase();
  return status === 'grn complete' || status === 'completed' || stage === 'grn_completed';
}

function grnCompletionDate(g) {
  return g.grn_date || g.received_date || null;
}

function vendorKey(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * @param {Array} purchaseOrders - PO rows (id, order_date, vendor_name, items[])
 * @param {Array} grns - GRN rows (purchase_order_id, status/stage, grn_date/received_date, vendor)
 * @returns {Map<string, {itemType:'RM'|'PM', itemId:number, vendor:string, samples:Array<{leadDays:number, completedAtMs:number}>}>}
 *   keyed `${itemType}|${itemId}|${vendor}`
 */
function buildLeadTimeSamples(purchaseOrders, grns) {
  const poById = new Map();
  for (const po of purchaseOrders || []) {
    const p = plain(po);
    if (p && p.id != null) poById.set(Number(p.id), p);
  }

  // Earliest completed GRN per PO.
  const firstGrnByPo = new Map();
  for (const grn of grns || []) {
    const g = plain(grn);
    if (!g || !isCompletedGrn(g)) continue;
    const poId = Number(g.purchase_order_id);
    if (!Number.isFinite(poId) || poId <= 0) continue;
    const comp = grnCompletionDate(g);
    if (!comp) continue;
    const prev = firstGrnByPo.get(poId);
    if (!prev || String(comp) < String(grnCompletionDate(prev))) firstGrnByPo.set(poId, g);
  }

  const byKey = new Map();
  for (const [poId, g] of firstGrnByPo) {
    const po = poById.get(poId);
    if (!po || !po.order_date) continue;
    const lead = daysBetween(po.order_date, grnCompletionDate(g));
    if (lead == null || lead < 0) continue;
    const completedAtMs = dateMs(grnCompletionDate(g)) || 0;
    const vendor = vendorKey(po.vendor_name || g.vendor);
    const items = Array.isArray(po.items) ? po.items : [];
    const seen = new Set(); // one sample per PO per item
    for (const line of items) {
      let itemType = null;
      let itemId = null;
      if (line.raw_material_id != null) {
        itemType = 'RM';
        itemId = Number(line.raw_material_id);
      } else if (line.pack_material_id != null) {
        itemType = 'PM';
        itemId = Number(line.pack_material_id);
      }
      if (!itemType || !Number.isFinite(itemId) || itemId <= 0) continue;
      const key = `${itemType}|${itemId}|${vendor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byKey.has(key)) byKey.set(key, { itemType, itemId, vendor, samples: [] });
      byKey.get(key).samples.push({ leadDays: lead, completedAtMs });
    }
  }
  return byKey;
}

module.exports = {
  buildLeadTimeSamples,
  daysBetween,
  isCompletedGrn,
  grnCompletionDate,
  vendorKey,
  MS_PER_DAY,
};
