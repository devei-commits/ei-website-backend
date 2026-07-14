/**
 * Vendor rating recompute on PO close (Flowchart: "Vendor rating recomputed on
 * CLOSED"). Computed purely from PO + po_tracking data — NO warehouse/GRN reads:
 *
 *   On-time delivery : grn/delivered date ≤ expected shipment date
 *   QC pass          : PO has no RTV raised (rtv_status derived on the PO side)
 *   Communication SLA: vendor acknowledged on/before the 48h ack SLA
 *   Full supply      : PO not short-closed (no accepted shortfall)
 *
 * Averaged across the vendor's completed POs → 0–5 stored on vendor_clients.rating,
 * with the KPI breakdown in vendor_clients.data.ratingBreakdown.
 */
const PurchaseOrder = require('./models');
const PoTracking = require('../poTracking/models');
const VendorClient = require('../vendorClient/models');

function dateOnly(v) {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Per-PO KPI scores (each 0..1, or null when not measurable). */
function poKpis(po, t) {
  const expected = dateOnly(po.expected_shipment_date);
  const completedOn = dateOnly(t && t.grn_complete_at) || dateOnly(t && t.delivered_at);
  const onTime = expected && completedOn ? (completedOn <= expected ? 1 : 0) : null;

  const qcPass = po.rtv_status ? 0 : 1; // any RTV (QC-fail) → miss

  const acked = dateOnly(t && t.vendor_confirmed_at);
  const sla = dateOnly(t && t.ack_sla_due_at);
  const commSla = acked && sla ? (acked <= sla ? 1 : 0) : (acked ? 1 : null);

  const fullSupply = po.short_closed_at ? 0.5 : 1; // accepted shortfall → partial credit

  return { onTime, qcPass, commSla, fullSupply };
}

const KPI_KEYS = ['onTime', 'qcPass', 'commSla', 'fullSupply'];

/**
 * Aggregate KPI scores across POs into a 0–5 rating + breakdown.
 * @param {Array<{onTime:?number,qcPass:?number,commSla:?number,fullSupply:?number}>} kpiList
 * @returns {{ rating: number|null, overall: number|null, poCount: number, kpi: object }}
 */
function aggregateRating(kpiList) {
  const poCount = kpiList.length;
  if (poCount === 0) return { rating: null, overall: null, poCount: 0, kpi: {} };

  const kpi = {};
  const perKpiAverages = [];
  for (const key of KPI_KEYS) {
    const vals = kpiList.map((k) => k[key]).filter((v) => typeof v === 'number');
    if (vals.length) {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      kpi[key] = Math.round(avg * 100) / 100;
      perKpiAverages.push(avg);
    } else {
      kpi[key] = null;
    }
  }
  if (perKpiAverages.length === 0) return { rating: null, overall: null, poCount, kpi };

  const overall = perKpiAverages.reduce((s, v) => s + v, 0) / perKpiAverages.length;
  const rating = Math.max(0, Math.min(5, Math.round(overall * 5)));
  return { rating, overall: Math.round(overall * 1000) / 1000, poCount, kpi };
}

function poMatchesVendor(poPlain, vendorClientId, vendorName) {
  const fd = poPlain.form_data && typeof poPlain.form_data === 'object' ? poPlain.form_data : {};
  const fid = fd.vendorClientId ?? fd.vendor_client_id;
  if (vendorClientId != null && fid != null) return String(fid) === String(vendorClientId);
  const vn = String(vendorName || '').trim().toLowerCase();
  return !!vn && String(poPlain.vendor_name || '').trim().toLowerCase() === vn;
}

/**
 * Recompute + persist a vendor's rating from their completed POs.
 * Best-effort: resolves the vendor by id, else by name. Returns the result or null.
 */
async function recomputeVendorRating({ vendorClientId, vendorName } = {}, opts = {}) {
  const nowIso = opts.nowIso || new Date().toISOString();
  // Resolve the vendor master row.
  let vendor = null;
  if (vendorClientId != null) vendor = await VendorClient.findByPk(vendorClientId).catch(() => null);
  if (!vendor && vendorName) {
    vendor = await VendorClient.findOne({
      where: { name: vendorName, type: 'vendor' },
    }).catch(() => null);
  }
  if (!vendor) return null;

  const resolvedId = vendor.get('id');
  const resolvedName = vendor.get('name');

  // All completed POs (filter to this vendor in JS — form_data is JSON).
  const completed = await PurchaseOrder.findAll({
    where: { status: 'Completed' },
    attributes: ['id', 'vendor_name', 'form_data', 'expected_shipment_date', 'rtv_status', 'short_closed_at'],
  }).catch(() => []);
  const mine = completed
    .map((p) => (p.get ? p.get({ plain: true }) : p))
    .filter((p) => poMatchesVendor(p, resolvedId, resolvedName));

  if (mine.length === 0) return { rating: null, overall: null, poCount: 0, kpi: {} };

  // Load tracking for those POs in one query.
  const ids = mine.map((p) => p.id);
  const trackings = await PoTracking.findAll({ where: { purchase_order_id: ids } }).catch(() => []);
  const trackingByPo = new Map();
  for (const tr of trackings) {
    const d = tr.get ? tr.get({ plain: true }) : tr;
    trackingByPo.set(d.purchase_order_id, d);
  }

  const kpiList = mine.map((p) => poKpis(p, trackingByPo.get(p.id) || null));
  const result = aggregateRating(kpiList);

  if (result.rating != null) {
    const prevData = vendor.get('data');
    const data = prevData && typeof prevData === 'object' ? { ...prevData } : {};
    data.ratingBreakdown = {
      rating: result.rating,
      overall: result.overall,
      poCount: result.poCount,
      kpi: result.kpi,
      computedAt: nowIso,
    };
    try {
      await vendor.update({ rating: result.rating, data });
    } catch (e) {
      console.warn('[vendorRating] update failed:', e && e.message ? e.message : e);
    }
  }
  return { ...result, vendorClientId: resolvedId };
}

module.exports = {
  poKpis,
  aggregateRating,
  poMatchesVendor,
  recomputeVendorRating,
};
