/**
 * Warehouse Overview — KPIs, zones (from locations), recent activity, open GRNs.
 * Composes data from warehouse_inventory, warehouse_locations, grn, mrn.
 */
const { fn, col } = require('sequelize');
const WarehouseInventory = require('../warehouseInventory/models');
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('../warehouseLocations/models');
const { activeRowWhere } = require('../lib/softDelete');
const GoodsReceivedNote = require('../grn/models');
const MaterialRequestNote = require('../mrn/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Resolve display names (code/name) for a SMALL set of warehouse_inventory rows — the low-stock
 * ones only. The landing must not fetch the full RM/PM/Product catalogs just to label a handful
 * of alerts, so this takes the already-filtered rows and looks up only their masters.
 * @returns Map<warehouseInventoryId, {code, name}>
 */
async function buildNameMapForRows(rows) {
  const rmIds = [...new Set(rows.filter((r) => r.item_type === 'RM').map((r) => r.raw_material_id).filter(Boolean))];
  const pmIds = [...new Set(rows.filter((r) => r.item_type === 'PM').map((r) => r.pack_material_id).filter(Boolean))];
  const prIds = [...new Set(rows.filter((r) => r.item_type === 'PR').map((r) => r.product_id).filter(Boolean))];
  const [rms, pms, products] = await Promise.all([
    rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'], raw: true }) : [],
    pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'], raw: true }) : [],
    prIds.length ? Product.findAll({ where: { product_id: prIds }, attributes: ['product_id', 'product_code', 'product_name'], raw: true }) : [],
  ]);
  const rmMap = new Map(rms.map((r) => [r.id, { code: r.code || '', name: r.name || r.code || '' }]));
  const pmMap = new Map(pms.map((p) => [p.id, { code: p.code || '', name: p.description || p.code || '' }]));
  const prMap = new Map(products.map((p) => [p.product_id, { code: p.product_code || '', name: p.product_name || p.product_code || '' }]));
  const out = new Map();
  for (const wh of rows) {
    if (wh.item_type === 'RM') out.set(wh.id, rmMap.get(wh.raw_material_id) || {});
    else if (wh.item_type === 'PM') out.set(wh.id, pmMap.get(wh.pack_material_id) || {});
    else if (wh.item_type === 'PR') out.set(wh.id, prMap.get(wh.product_id) || {});
  }
  return out;
}

/** Human-readable time ago. */
function timeAgo(date) {
  if (!date) return '';
  const d = new Date(date);
  const now = new Date();
  const diffMs = now - d;
  const diffM = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMs / 3600000);
  const diffD = Math.floor(diffMs / 86400000);
  if (diffM < 60) return diffM <= 1 ? 'Just now' : `${diffM}m ago`;
  if (diffH < 24) return `${diffH}h ago`;
  if (diffD === 1) return 'Yesterday';
  if (diffD < 7) return `${diffD} days ago`;
  return d.toLocaleDateString();
}

/**
 * GET /api/v1/warehouse/overview
 * Landing summary only — counts, zone summaries, recent activity, open GRNs, and the top low-stock
 * items. Deliberately lightweight: it does NOT return the full inventory / locations / GRN / MRN
 * rows (those are fetched lazily when the user drills into a zone or opens Inventory).
 * Returns { kpis, zones, recentActivity, openGrns, lowStockItems, alertCount }.
 */
async function getOverview(req, res) {
  try {
    // Inventory KPIs are computed in SQL — never load the full inventory table (thousands of rows)
    // just to count. Status mirrors the list logic: only rows still flagged 'In Stock' with a
    // reorder point can fall Low/Critical (< reorder_pt / < half reorder_pt on total on-hand).
    const sequelize = WarehouseInventory.sequelize;
    const sih = '(COALESCE(wh_stock,0)+COALESCE(ml1_stock,0)+COALESCE(ml2_stock,0))';
    const inStock = "COALESCE(NULLIF(TRIM(qc_status),''),'In Stock') = 'In Stock'";
    const lowCond = `(${inStock}) AND COALESCE(reorder_pt,0) > 0 AND ${sih} < reorder_pt`;

    const [
      countsRows,
      lowRowsRaw,
      grnRows,
      mrnRows,
      locations,
      rackItemCounts,
    ] = await Promise.all([
      sequelize.query(
        `SELECT
           COUNT(*)::int AS total_skus,
           COUNT(*) FILTER (WHERE ${lowCond})::int AS low_critical,
           COUNT(*) FILTER (WHERE item_type='PR' AND LOWER(COALESCE(qc_status,'')) LIKE '%qc%')::int AS fg_under_qc
         FROM warehouse_inventory`,
        { type: sequelize.QueryTypes.SELECT },
      ),
      // Only the handful of low-stock rows actually shown (alerts + list), critical first.
      sequelize.query(
        `SELECT id, item_type, raw_material_id, pack_material_id, product_id, wh_unit,
           ${sih} AS sih, reorder_pt, updated_at, created_at,
           CASE WHEN ${sih} < reorder_pt*0.5 THEN 'Critical' ELSE 'Low Stock' END AS status
         FROM warehouse_inventory
         WHERE ${lowCond}
         ORDER BY status ASC, updated_at DESC NULLS LAST
         LIMIT 5`,
        { type: sequelize.QueryTypes.SELECT },
      ),
      GoodsReceivedNote.findAll({
        attributes: ['id', 'grn_no', 'po_no', 'vendor', 'status', 'items', 'po_value', 'received_date', 'expected_date', 'updated_at'],
        order: [['expected_date', 'DESC'], ['id', 'DESC']],
        raw: true,
      }),
      MaterialRequestNote.findAll({
        attributes: ['id', 'mrn_no', 'status', 'assigned_picker', 'requested_by', 'notes', 'updated_at'],
        order: [['id', 'DESC']],
        raw: true,
      }),
      WarehouseLocation.findAll({
        order: [['id', 'ASC']],
        include: [
          // Racks only — NOT their items. Item counts come from the aggregate below, so the landing
          // never materialises every warehouse_rack_items row just to show per-zone counts.
          { model: WarehouseRack, as: 'WarehouseRacks', required: false, attributes: ['id', 'code', 'levels', 'slots_total'] },
        ],
      }),
      WarehouseRackItem.findAll({
        where: activeRowWhere(),
        attributes: ['rack_id', [fn('COUNT', col('id')), 'cnt']],
        group: ['rack_id'],
        raw: true,
      }),
    ]);

    const counts = countsRows[0] || {};
    const totalSkus = toNum(counts.total_skus);
    const lowCriticalStock = toNum(counts.low_critical);
    const fgUnderQc = toNum(counts.fg_under_qc);
    const lowRows = lowRowsRaw.map((r) => ({
      ...r,
      _stockInHand: toNum(r.sih),
      _reorderPt: toNum(r.reorder_pt),
      _status: r.status,
    }));

    // Names only for the low-stock rows (small set), never the whole catalog.
    const nameMap = await buildNameMapForRows(lowRows);

    const itemCountByRack = new Map(rackItemCounts.map((r) => [r.rack_id, toNum(r.cnt)]));
    const pendingGrn = grnRows.filter((r) => (r.status || '') !== 'GRN Complete').length;
    const openMrn = mrnRows.filter((r) => (r.status || '') !== 'Completed').length;

    let totalRacks = 0;
    const zones = locations.map((loc) => {
      const locPlain = loc.get ? loc.get({ plain: true }) : loc;
      const racks = locPlain.WarehouseRacks || [];
      totalRacks += racks.length;
      let itemsCount = 0;
      let utilisationSum = 0;
      const tags = [];
      racks.forEach((r) => {
        const cnt = itemCountByRack.get(r.id) || 0;
        itemsCount += cnt;
        const levels = toNum(r.levels) || 4;
        const slots = toNum(r.slots_total) || 16;
        const totalSlots = levels * slots;
        const pct = totalSlots > 0 ? Math.round((cnt / totalSlots) * 100) : 0;
        utilisationSum += pct;
        if (r.code) tags.push(r.code);
      });
      const utilisationPct = racks.length ? Math.round(utilisationSum / racks.length) : 0;
      const areaSqm = locPlain.area_sqm != null ? locPlain.area_sqm : '';
      const desc = locPlain.description || '';
      const footprint = [areaSqm ? `${areaSqm} sqm` : '', desc].filter(Boolean).join(' · ') || '—';
      return {
        id: `zone-${locPlain.id}`,
        name: locPlain.zone_label || locPlain.code || locPlain.name,
        title: locPlain.name || locPlain.code,
        description: desc || 'Warehouse zone',
        items: itemsCount,
        racks: racks.length,
        alerts: 0,
        utilization: utilisationPct,
        footprint,
        tags: tags.slice(0, 8),
      };
    });

    const recentActivity = [];
    grnRows.slice(0, 5).forEach((d) => {
      const statusLabel = d.status === 'GRN Complete' ? 'completed' : d.status || 'Pending';
      recentActivity.push({
        id: `grn-${d.id}`,
        type: 'grn',
        title: `${d.grn_no || 'GRN'} — ${statusLabel}`,
        subtitle: `${d.vendor || ''} · ${d.items || 0} items · ${d.po_value != null ? `₹${Number(d.po_value).toLocaleString()}` : ''}`,
        meta: timeAgo(d.received_date || d.expected_date || d.updated_at),
        sortAt: d.received_date || d.expected_date || d.updated_at,
      });
    });
    mrnRows.slice(0, 5).forEach((d) => {
      recentActivity.push({
        id: `mrn-${d.id}`,
        type: 'mrn',
        title: `${d.mrn_no || 'MRN'} — ${d.status || 'Pending'}${d.assigned_picker ? ` by ${d.assigned_picker}` : ''}`,
        subtitle: (d.requested_by || '') + (d.notes ? ` · ${String(d.notes).slice(0, 50)}` : ''),
        meta: timeAgo(d.updated_at),
        sortAt: d.updated_at,
      });
    });
    lowRows.slice(0, 5).forEach((wh) => {
      const nm = nameMap.get(wh.id) || {};
      recentActivity.push({
        id: `alert-wh-${wh.id}`,
        type: 'alert',
        title: `Low stock — ${nm.name || nm.code || wh.id} (${nm.code || ''})`,
        subtitle: `Stock: ${wh._stockInHand} · Reorder: ${wh._reorderPt}`,
        meta: timeAgo(wh.updated_at),
        sortAt: wh.updated_at || wh.created_at,
      });
    });
    recentActivity.sort((a, b) => new Date(b.sortAt || 0) - new Date(a.sortAt || 0));
    const recentActivityClean = recentActivity.slice(0, 10).map(({ id, type, title, subtitle, meta }) => ({ id, type, title, subtitle, meta }));

    const lowStockItems = lowRows.slice(0, 5).map((wh) => {
      const nm = nameMap.get(wh.id) || {};
      return {
        id: `wh-${wh.id}`,
        code: nm.code || '',
        name: nm.name || '',
        status: wh._status,
        stockInHand: wh._stockInHand,
        whUnit: wh.wh_unit || '',
        reorderPt: wh._reorderPt,
      };
    });

    const openGrns = grnRows
      .filter((r) => (r.status || '') !== 'GRN Complete')
      .slice(0, 10)
      .map((d) => ({
        id: String(d.id),
        grnNo: d.grn_no,
        poNo: d.po_no || '',
        vendor: d.vendor || '',
        status: d.status || 'Pending',
      }));

    const kpis = [
      { id: 'total-skus', label: 'Total SKUs', subtitle: 'RM · PM · Finished Goods', value: String(totalSkus), accentColor: 'border-emerald-500 text-emerald-600 bg-emerald-50' },
      { id: 'low-stock', label: 'Low / Critical Stock', subtitle: 'Items below reorder', value: String(lowCriticalStock), accentColor: 'border-amber-500 text-amber-600 bg-amber-50' },
      { id: 'pending-grn', label: 'Pending GRN', subtitle: 'POs awaiting GRN', value: String(pendingGrn), accentColor: 'border-sky-500 text-sky-600 bg-sky-50' },
      { id: 'open-requests', label: 'Open Requests', subtitle: 'MRNs in progress', value: String(openMrn), accentColor: 'border-indigo-500 text-indigo-600 bg-indigo-50' },
      { id: 'fg-under-qc', label: 'FG Under QC', subtitle: 'Batches pending release', value: String(fgUnderQc), accentColor: 'border-fuchsia-500 text-fuchsia-600 bg-fuchsia-50' },
      { id: 'wh-zones', label: 'WH Zones', subtitle: `${totalRacks} racks`, value: String(zones.length), accentColor: 'border-slate-400 text-slate-700 bg-slate-50' },
    ];

    res.json({
      kpis,
      zones,
      recentActivity: recentActivityClean,
      openGrns,
      lowStockItems,
      alertCount: lowCriticalStock,
    });
  } catch (err) {
    console.error('[warehouse/overview] error:', err);
    res.status(500).json({ error: err.message || 'Failed to load warehouse overview' });
  }
}

module.exports = { getOverview };
