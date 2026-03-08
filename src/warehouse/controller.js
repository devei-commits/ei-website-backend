/**
 * Warehouse Overview — KPIs, zones (from locations), recent activity, open GRNs.
 * Composes data from warehouse_inventory, warehouse_locations, grn, mrn.
 */
const WarehouseInventory = require('../warehouseInventory/models');
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('../warehouseLocations/models');
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

/** Build inventory summary map for rack item counts (code, name, type). */
async function buildInventorySummaryMap() {
  const whRows = await WarehouseInventory.findAll({ order: [['id', 'ASC']] });
  const rmIds = [...new Set(whRows.map((r) => r.raw_material_id).filter(Boolean))];
  const pmIds = [...new Set(whRows.map((r) => r.pack_material_id).filter(Boolean))];
  const productIds = [...new Set(whRows.map((r) => r.product_id).filter(Boolean))];
  const [rms, pms, products] = await Promise.all([
    rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'] }) : [],
    pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : [],
    productIds.length ? Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_code', 'product_name'] }) : [],
  ]);
  const rmMap = new Map(rms.map((r) => [r.id, { code: r.code || '', name: r.name || r.code || '' }]));
  const pmMap = new Map(pms.map((p) => [p.id, { code: p.code || '', name: p.description || p.code || '' }]));
  const productMap = new Map(products.map((p) => [p.product_id, { code: p.product_code || '', name: p.product_name || p.product_code || '' }]));
  const out = new Map();
  for (const w of whRows) {
    const wh = w.get ? w.get({ plain: true }) : w;
    let code = '', name = '', type = 'RM';
    if (wh.item_type === 'RM' && wh.raw_material_id) {
      const m = rmMap.get(wh.raw_material_id);
      if (m) { code = m.code; name = m.name; type = 'RM'; }
    } else if (wh.item_type === 'PM' && wh.pack_material_id) {
      const m = pmMap.get(wh.pack_material_id);
      if (m) { code = m.code; name = m.name; type = 'PM'; }
    } else if (wh.item_type === 'PR' && wh.product_id) {
      const m = productMap.get(wh.product_id);
      if (m) { code = m.code; name = m.name; type = 'FG/PR'; }
    }
    out.set(wh.id, { code, name, type });
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
 * Returns { kpis, zones, recentActivity, openGrns, alertCount }.
 */
async function getOverview(req, res) {
  try {
    const [invMap, whRows] = await Promise.all([
      buildInventorySummaryMap(),
      WarehouseInventory.findAll({
        order: [['item_type', 'ASC'], ['raw_material_id', 'ASC'], ['pack_material_id', 'ASC'], ['product_id', 'ASC']],
      }),
    ]);

    let totalSkus = 0;
    let lowCriticalStock = 0;
    let fgUnderQc = 0;
    const lowStockAlerts = [];

    for (const w of whRows) {
      const wh = w.get ? w.get({ plain: true }) : w;
      const whStock = toNum(wh.wh_stock);
      const ml1 = toNum(wh.ml1_stock);
      const ml2 = toNum(wh.ml2_stock);
      const stockInHand = whStock + ml1 + ml2;
      const reorderPt = toNum(wh.reorder_pt);
      let status = (wh.qc_status || 'In Stock').trim();
      if (status === 'In Stock' && reorderPt > 0) {
        if (stockInHand < reorderPt * 0.5) status = 'Critical';
        else if (stockInHand < reorderPt) status = 'Low Stock';
      }
      totalSkus += 1;
      if (status === 'Low Stock' || status === 'Critical') {
        lowCriticalStock += 1;
        const inv = invMap.get(wh.id) || {};
        lowStockAlerts.push({
          id: `alert-wh-${wh.id}`,
          type: 'alert',
          title: `Low stock — ${inv.name || inv.code || wh.id} (${inv.code || ''})`,
          subtitle: `Stock: ${stockInHand} · Reorder: ${reorderPt}`,
          meta: timeAgo(wh.updated_at),
          sortAt: wh.updated_at || wh.created_at,
        });
      }
      if (wh.item_type === 'PR' && (wh.qc_status || '').toLowerCase().includes('qc')) {
        fgUnderQc += 1;
      }
    }

    const [grnRows, mrnRows, locations] = await Promise.all([
      GoodsReceivedNote.findAll({ order: [['expected_date', 'DESC'], ['id', 'DESC']] }),
      MaterialRequestNote.findAll({ order: [['id', 'DESC']] }),
      WarehouseLocation.findAll({
        order: [['id', 'ASC']],
        include: [
          { model: WarehouseRack, as: 'WarehouseRacks', required: false, include: [{ model: WarehouseRackItem, as: 'WarehouseRackItems', required: false }] },
        ],
      }),
    ]);

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
        const rPlain = r.get ? r.get({ plain: true }) : r;
        const items = rPlain.WarehouseRackItems || [];
        itemsCount += items.length;
        const levels = toNum(rPlain.levels) || 4;
        const slots = toNum(rPlain.slots_total) || 16;
        const totalSlots = levels * slots;
        const pct = totalSlots > 0 ? Math.round((items.length / totalSlots) * 100) : 0;
        utilisationSum += pct;
        if (rPlain.code) tags.push(rPlain.code);
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
    grnRows.slice(0, 5).forEach((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
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
    mrnRows.slice(0, 5).forEach((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      recentActivity.push({
        id: `mrn-${d.id}`,
        type: 'mrn',
        title: `${d.mrn_no || 'MRN'} — ${d.status || 'Pending'}${d.assigned_picker ? ` by ${d.assigned_picker}` : ''}`,
        subtitle: (d.requested_by || '') + (d.notes ? ` · ${String(d.notes).slice(0, 50)}` : ''),
        meta: timeAgo(d.updated_at),
        sortAt: d.updated_at,
      });
    });
    lowStockAlerts.slice(0, 5).forEach((a) => recentActivity.push(a));
    recentActivity.sort((a, b) => new Date(b.sortAt || 0) - new Date(a.sortAt || 0));
    const recentActivityClean = recentActivity.slice(0, 10).map(({ id, type, title, subtitle, meta }) => ({ id, type, title, subtitle, meta }));

    const openGrns = grnRows
      .filter((r) => (r.status || '') !== 'GRN Complete')
      .slice(0, 10)
      .map((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        return {
          id: String(d.id),
          grnNo: d.grn_no,
          poNo: d.po_no || '',
          vendor: d.vendor || '',
          status: d.status || 'Pending',
        };
      });

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
      alertCount: lowCriticalStock,
    });
  } catch (err) {
    console.error('[warehouse/overview] error:', err);
    res.status(500).json({ error: err.message || 'Failed to load warehouse overview' });
  }
}

module.exports = { getOverview };
