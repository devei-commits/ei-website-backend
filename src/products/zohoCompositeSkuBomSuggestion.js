/**
 * Build SKU BOM (per-unit) lines from Zoho Inventory/Books composite `mapped_items`,
 * matching local Raw Material masters. Used by PR wizard / dashboard.
 */

const RawMaterial = require('../rawMaterials/models');
const { fetchCompositeItem, normalizeZohoId } = require('../services/zohoBooks');
const { normUom } = require('../bom/skuBomMath');

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function makeKeyMaps(rows, cfg) {
  const byZohoId = new Map();
  const bySku = new Map();
  const byCode = new Map();
  const byName = new Map();
  for (const r of rows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    const zid = normalizeZohoId(plain[cfg.zohoField]);
    if (zid) byZohoId.set(zid, plain);
    const sku = norm(plain[cfg.skuField]);
    if (sku) bySku.set(sku, plain);
    const code = norm(plain[cfg.codeField]);
    if (code) byCode.set(code, plain);
    for (const f of cfg.nameFields) {
      const k = norm(plain[f]);
      if (k && !byName.has(k)) byName.set(k, plain);
    }
  }
  return { byZohoId, bySku, byCode, byName };
}

function matchMaster(mappedItem, maps) {
  const zid = normalizeZohoId(mappedItem.item_id);
  if (zid && maps.byZohoId.has(zid)) return maps.byZohoId.get(zid);
  const sku = norm(mappedItem.sku);
  if (sku && maps.bySku.has(sku)) return maps.bySku.get(sku);
  if (sku && maps.byCode.has(sku)) return maps.byCode.get(sku);
  const nm = norm(mappedItem.name);
  if (nm && maps.byName.has(nm)) return maps.byName.get(nm);
  return null;
}

/** Heuristic only — name-based so RM lines in odd Zoho UOMs are not misclassified. */
function looksLikePmItem(mappedItem) {
  const name = norm(mappedItem?.name);
  const packKeywords = [
    'pack',
    'bottle',
    'pump',
    'label',
    'monocarton',
    'carton',
    'shipper',
    'sticker',
    'cap',
    'tube',
    'jar',
  ];
  return packKeywords.some((k) => name.includes(k));
}

/** Map Zoho unit string to SKU BOM UOM (G, KG, ML, L, PCS). */
function zohoUnitToSkuUom(zohoUnit) {
  const x = norm(zohoUnit).replace(/\./g, '');
  if (['g', 'gm', 'gram', 'grams'].includes(x)) return 'G';
  if (['kg', 'kilogram', 'kilograms', 'kgs'].includes(x)) return 'KG';
  if (['ml', 'milliliter', 'millilitre', 'milliliters', 'millilitres'].includes(x)) return 'ML';
  if (['l', 'ltr', 'litre', 'liter', 'litres', 'liters'].includes(x)) return 'L';
  if (['nos', 'pcs', 'pc', 'unit', 'units', 'qty', 'quantity'].includes(x)) return 'PCS';
  return 'G';
}

function lineToMassMg(qty, uom) {
  const u = normUom(uom);
  const q = parseFloat(String(qty).replace(/[^\d.-]/g, ''));
  if (Number.isNaN(q) || q < 0) return null;
  if (u === 'G') return q * 1000;
  if (u === 'KG') return q * 1_000_000;
  return null;
}

function lineToVolumeMicroL(qty, uom) {
  const u = normUom(uom);
  const q = parseFloat(String(qty).replace(/[^\d.-]/g, ''));
  if (Number.isNaN(q) || q < 0) return null;
  if (u === 'ML') return q * 1000;
  if (u === 'L') return q * 1_000_000;
  return null;
}

/**
 * Suggest net per unit from lines (homogeneous mass or volume only).
 * @param {Array<{ qty_per_unit: number, uom: string }>} lines
 */
function suggestLimitFromSkuLines(lines) {
  const massParts = [];
  const volParts = [];
  const pcsParts = [];
  for (const l of lines) {
    const mg = lineToMassMg(l.qty_per_unit, l.uom);
    const ul = lineToVolumeMicroL(l.qty_per_unit, l.uom);
    const u = normUom(l.uom);
    if (mg != null) massParts.push(mg);
    else if (ul != null) volParts.push(ul);
    else if (u === 'PCS') pcsParts.push(1);
  }
  if (massParts.length && volParts.length) {
    return {
      ok: false,
      warning: 'Mapped items mix mass and volume UOMs; set net per unit manually (e.g. from Fill Size).',
    };
  }
  if (massParts.length) {
    const sumMg = massParts.reduce((a, b) => a + b, 0);
    return { ok: true, limitQty: sumMg / 1000, limitUom: 'GM' };
  }
  if (volParts.length) {
    const sumUl = volParts.reduce((a, b) => a + b, 0);
    return { ok: true, limitQty: sumUl / 1000, limitUom: 'ML' };
  }
  if (pcsParts.length) {
    return {
      ok: false,
      warning:
        'Only count-based (PCS) components found; SKU BOM net limit must be mass/volume — set Fill Size or manual net and adjust line UOMs if needed.',
    };
  }
  return { ok: false, warning: 'Could not derive net per unit from mapped item units.' };
}

async function buildSuggestionForCompositeId(zohoCompositeId) {
  const composite = await fetchCompositeItem(zohoCompositeId);
  const mappedItems = Array.isArray(composite.mapped_items) ? composite.mapped_items : [];

  const allRm = await RawMaterial.findAll({
    attributes: ['id', 'code', 'sku', 'name', 'inci', 'zoho_id', 'uom'],
  });
  const rmMaps = makeKeyMaps(allRm, {
    zohoField: 'zoho_id',
    skuField: 'sku',
    codeField: 'code',
    nameFields: ['name', 'inci'],
  });

  const packHints = [];
  const skuCandidates = [];
  for (const item of mappedItems) {
    if (looksLikePmItem(item)) {
      packHints.push({
        name: String(item.name || '').trim(),
        sku: String(item.sku || '').trim(),
        item_id: normalizeZohoId(item.item_id),
        quantity: Number(item.quantity),
        unit: String(item.unit || '').trim(),
      });
      continue;
    }
    skuCandidates.push(item);
  }

  const skuBom = [];
  const unmatched = [];
  let rowNum = 1;
  for (const item of skuCandidates) {
    const rm = matchMaster(item, rmMaps);
    const qty = Number(item.quantity);
    const qtyPer = Number.isFinite(qty) ? qty : 0;
    const uom = zohoUnitToSkuUom(item.unit);
    const name = String(item.name || '').trim();
    const sku = String(item.sku || '').trim();
    const zItemId = normalizeZohoId(item.item_id);

    if (rm) {
      skuBom.push({
        row_number: rowNum,
        inci_name: rm.inci || rm.name || name || sku,
        rm_code: rm.code || sku || String(rowNum),
        raw_material_id: rm.id,
        qty_per_unit: qtyPer,
        uom,
      });
    } else {
      skuBom.push({
        row_number: rowNum,
        inci_name: name || sku || zItemId || `Component ${rowNum}`,
        rm_code: sku || zItemId || String(rowNum),
        raw_material_id: null,
        qty_per_unit: qtyPer,
        uom,
      });
      unmatched.push({
        name,
        sku,
        item_id: zItemId,
        quantity: qtyPer,
        unit: String(item.unit || '').trim(),
      });
    }
    rowNum += 1;
  }

  const limitInfo = suggestLimitFromSkuLines(skuBom);

  return {
    composite_item_id: normalizeZohoId(composite.composite_item_id) || normalizeZohoId(zohoCompositeId),
    composite_name: String(composite.name || '').trim() || null,
    sku_bom: skuBom,
    sku_bom_limit_qty: limitInfo.ok ? limitInfo.limitQty : null,
    sku_bom_limit_uom: limitInfo.ok ? limitInfo.limitUom : null,
    pack_hints: packHints,
    unmatched_components: unmatched,
    warnings: [limitInfo.warning].filter(Boolean),
  };
}

/**
 * GET /api/v1/products/zoho-composite/:zohoCompositeId/sku-bom-suggestion
 */
async function getZohoCompositeSkuBomSuggestion(req, res) {
  const zohoCompositeId = req.params.zohoCompositeId;
  try {
    const data = await buildSuggestionForCompositeId(zohoCompositeId);
    return res.json({ success: true, data });
  } catch (e) {
    const status = e.statusCode && Number(e.statusCode) >= 400 && Number(e.statusCode) < 600 ? Number(e.statusCode) : 500;
    const message = e instanceof Error ? e.message : String(e);
    return res.status(status).json({ success: false, error: message });
  }
}

module.exports = {
  getZohoCompositeSkuBomSuggestion,
  buildSuggestionForCompositeId,
  /** For one-off DB scripts: UOM + net limit helpers */
  zohoUnitToSkuUom,
  suggestLimitFromSkuLines,
  makeKeyMaps,
  matchMaster,
  normalizeZohoId,
};
