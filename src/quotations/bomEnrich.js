// ─────────────────────────────────────────────────────────────
// BOM ENRICHMENT for the quotation engine.
// Adapted to this backend (Sequelize db.query) and extended with:
//   1. Blended SG auto-computation from each RM's specific_gravity,
//      with explicit tracking of ingredients missing an SG value.
//   2. Vendor rate + lead-time lookup from item_list_vendor_rates:
//      surfaces the cheapest vendor price alongside the master price so
//      the admin can quote on either (pricingSource = 'master' | 'vendor').
// ─────────────────────────────────────────────────────────────
const { QueryTypes } = require('sequelize');
const db = require('../../db');

function pf(v) { return parseFloat(v) || 0; }

// Per material id: cheapest vendor rate + shortest vendor lead time.
// Keyed by raw_material_id / pack_material_id.
async function vendorMap(materialType, ids) {
  if (!ids.length) return {};
  const col = materialType === 'PM' ? 'pack_material_id' : 'raw_material_id';
  const rows = await db.query(
    `SELECT il.${col} AS material_id,
            MIN(vr.default_rate) FILTER (WHERE vr.default_rate IS NOT NULL)   AS rate,
            MIN(vr.lead_time_days) FILTER (WHERE vr.lead_time_days IS NOT NULL) AS lead
       FROM items_list il
       JOIN item_list_vendor_rates vr
         ON vr.items_list_id = il.id AND vr.deleted_at IS NULL
      WHERE il.type = $1 AND il.${col} = ANY($2) AND il.deleted_at IS NULL
      GROUP BY il.${col}`,
    { bind: [materialType, ids], type: QueryTypes.SELECT }
  );
  const map = {};
  for (const r of rows) {
    map[r.material_id] = {
      rate: r.rate != null ? pf(r.rate) : null,
      lead: r.lead != null ? parseInt(r.lead) : null,
    };
  }
  return map;
}

/**
 * Enrich a raw `boms` row into the canonical quotation BOM detail.
 * @param {object} bom - row from boms (rm_lines / pm_lines are JSON arrays)
 * @param {object} [opts]
 * @param {object} [opts.rmOverrides] - { rm_code: price_per_kg }
 * @param {object} [opts.pmOverrides] - { pm_code: price_per_pc }
 * @param {object} [opts.sgOverrides] - { rm_code: specific_gravity }
 * @param {'master'|'vendor'} [opts.pricingSource] - which price to use (default 'master')
 */
async function enrichBom(bom, opts = {}) {
  const { rmOverrides = {}, pmOverrides = {}, sgOverrides = {}, pricingSource = 'master' } = opts;
  const useVendor = pricingSource === 'vendor';

  const rmIds = (bom.rm_lines || []).filter(r => r.raw_material_id).map(r => r.raw_material_id);
  const pmIds = (bom.pm_lines || []).filter(p => p.pack_material_id).map(p => p.pack_material_id);

  let rmMaster = {};
  if (rmIds.length) {
    const rows = await db.query(
      `SELECT id, name, inci, price_per_kg, category, specific_gravity, lead_time_days
         FROM raw_materials WHERE id = ANY($1) AND deleted_at IS NULL`,
      { bind: [rmIds], type: QueryTypes.SELECT });
    for (const r of rows) rmMaster[r.id] = r;
  }
  let pmMaster = {};
  if (pmIds.length) {
    const rows = await db.query(
      `SELECT id, description, material, type, level, price_per_pc, lead_time_days
         FROM pack_materials WHERE id = ANY($1) AND deleted_at IS NULL`,
      { bind: [pmIds], type: QueryTypes.SELECT });
    for (const r of rows) pmMaster[r.id] = r;
  }

  const [rmVendor, pmVendor] = await Promise.all([vendorMap('RM', rmIds), vendorMap('PM', pmIds)]);

  // ── RM lines + blended SG ──
  let blendedSgKnown = 0, knownPct = 0;
  const missingSgLines = [];
  const rmLines = (bom.rm_lines || []).map(r => {
    const m = rmMaster[r.raw_material_id] || {};
    const v = rmVendor[r.raw_material_id] || {};
    const code = r.rm_code || r.zoho_sku_code || '';
    const dbPrice = pf(m.price_per_kg);
    const vendorPrice = v.rate != null ? v.rate : null;
    const overridden = rmOverrides[code] !== undefined;
    const sourcePrice = useVendor ? (vendorPrice != null ? vendorPrice : dbPrice) : dbPrice;
    const price = overridden ? pf(rmOverrides[code]) : sourcePrice;

    const masterSg = m.specific_gravity != null ? pf(m.specific_gravity) : null;
    const overrideSg = sgOverrides[code] !== undefined ? pf(sgOverrides[code]) : null;
    const sg = overrideSg != null ? overrideSg : masterSg;
    const pct = pf(r.pct_w_w);
    if (sg != null && sg > 0) { blendedSgKnown += (pct / 100) * sg; knownPct += pct; }
    else missingSgLines.push({ raw_material_id: r.raw_material_id || null, rm_code: code, name: r.inci_name || m.name || code, pct_w_w: pct });

    const leadTime = m.lead_time_days != null ? parseInt(m.lead_time_days) : (v.lead != null ? v.lead : null);
    return {
      raw_material_id: r.raw_material_id, rm_code: code, inci_name: r.inci_name || m.name || '',
      pct_w_w: pct, price_per_kg: price, db_price: dbPrice, vendor_price: vendorPrice,
      price_source: overridden ? 'override' : (useVendor && vendorPrice != null ? 'vendor' : 'master'),
      overridden, specific_gravity: sg, sg_source: overrideSg != null ? 'manual' : (masterSg != null ? 'db' : 'missing'),
      category: m.category || r.category || null, lead_time_days: leadTime, found_in_db: !!rmMaster[r.raw_material_id],
    };
  });
  const sgComplete = missingSgLines.length === 0;
  const blendedSg = sgComplete ? Math.round(blendedSgKnown * 1000) / 1000 : null;

  // ── PM lines ──
  const pmLines = (bom.pm_lines || []).map(p => {
    const m = pmMaster[p.pack_material_id] || {};
    const v = pmVendor[p.pack_material_id] || {};
    const code = p.pm_code || p.zoho_sku_code || '';
    const dbPrice = pf(m.price_per_pc);
    const vendorPrice = v.rate != null ? v.rate : null;
    const overridden = pmOverrides[code] !== undefined;
    const sourcePrice = useVendor ? (vendorPrice != null ? vendorPrice : dbPrice) : dbPrice;
    const price = overridden ? pf(pmOverrides[code]) : sourcePrice;
    const leadTime = m.lead_time_days != null ? parseInt(m.lead_time_days) : (v.lead != null ? v.lead : null);
    return {
      pack_material_id: p.pack_material_id, pm_code: code, description: p.pm_description || p.description || m.description || '',
      qty_per_unit: pf(p.qty_per_unit), price_per_pc: price, db_price: dbPrice, vendor_price: vendorPrice,
      price_source: overridden ? 'override' : (useVendor && vendorPrice != null ? 'vendor' : 'master'),
      overridden, material: m.material || p.material || null, lead_time_days: leadTime, found_in_db: !!pmMaster[p.pack_material_id],
    };
  });

  const mtch = (bom.pack_size || '').match(/(\d+(?:\.\d+)?)\s*(ML|G|GM|MG|L)/i);
  const parsedVolume = mtch ? pf(mtch[1]) : 0;
  const parsedUnit = mtch ? mtch[2].toUpperCase() : 'ML';

  return {
    id: bom.id, bom_code: bom.bom_code, name: bom.name, pack_size: bom.pack_size,
    product_code: bom.product_code || null, brand_name: bom.brand_name || null,
    parsed_volume_ml: parsedUnit === 'ML' ? parsedVolume : 0,
    rm_lines: rmLines, pm_lines: pmLines, rm_count: rmLines.length, pm_count: pmLines.length,
    pricing_source: pricingSource,
    blended_sg: blendedSg, blended_sg_partial: Math.round(blendedSgKnown * 1000) / 1000,
    sg_complete: sgComplete, sg_known_pct: Math.round(knownPct * 100) / 100, missing_sg_lines: missingSgLines,
  };
}

module.exports = { enrichBom };
