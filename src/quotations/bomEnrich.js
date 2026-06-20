// ─────────────────────────────────────────────────────────────
// BOM ENRICHMENT for the quotation engine.
// Adapted to this backend (Sequelize db.query) and extended with:
//   1. Blended SG auto-computation from each RM's specific_gravity,
//      with explicit tracking of ingredients missing an SG value so
//      the admin can fill them in manually.
//   2. Vendor lead-time lookup from item_list_vendor_rates (used by
//      the timing engine when raw_materials.lead_time_days is NULL).
// ─────────────────────────────────────────────────────────────
const { QueryTypes } = require('sequelize');
const db = require('../../db');

function pf(v) { return parseFloat(v) || 0; }

// Min vendor lead time per material id, keyed by raw_material_id / pack_material_id.
async function vendorLeadMap(materialType, ids) {
  if (!ids.length) return {};
  const col = materialType === 'PM' ? 'pack_material_id' : 'raw_material_id';
  // Use `bind` (positional $n) so pg binds the id array natively for ANY($n).
  const rows = await db.query(
    `SELECT il.${col} AS material_id, MIN(vr.lead_time_days) AS lead_time_days
       FROM items_list il
       JOIN item_list_vendor_rates vr
         ON vr.items_list_id = il.id
        AND vr.deleted_at IS NULL
        AND vr.lead_time_days IS NOT NULL
      WHERE il.type = $1
        AND il.${col} = ANY($2)
        AND il.deleted_at IS NULL
      GROUP BY il.${col}`,
    { bind: [materialType, ids], type: QueryTypes.SELECT }
  );
  const map = {};
  for (const r of rows) map[r.material_id] = parseInt(r.lead_time_days);
  return map;
}

/**
 * Enrich a raw `boms` row (with product join fields optional) into the
 * canonical quotation BOM detail: priced + lead-timed rm/pm lines, parsed
 * volume, and the blended-SG computation (with missing-value tracking).
 *
 * @param {object} bom - row from boms (rm_lines / pm_lines are JSON arrays)
 * @param {object} [opts]
 * @param {object} [opts.rmOverrides] - { rm_code: price_per_kg }
 * @param {object} [opts.pmOverrides] - { pm_code: price_per_pc }
 * @param {object} [opts.sgOverrides] - { rm_code: specific_gravity } manual SG
 */
async function enrichBom(bom, opts = {}) {
  const { rmOverrides = {}, pmOverrides = {}, sgOverrides = {} } = opts;

  const rmIds = (bom.rm_lines || []).filter(r => r.raw_material_id).map(r => r.raw_material_id);
  const pmIds = (bom.pm_lines || []).filter(p => p.pack_material_id).map(p => p.pack_material_id);

  // ── RM master lookup ──
  let rmMap = {};
  if (rmIds.length) {
    const rows = await db.query(
      `SELECT id, name, inci, price_per_kg, category, specific_gravity, lead_time_days
         FROM raw_materials WHERE id = ANY($1) AND deleted_at IS NULL`,
      { bind: [rmIds], type: QueryTypes.SELECT }
    );
    for (const r of rows) rmMap[r.id] = r;
  }
  // ── PM master lookup ──
  let pmMap = {};
  if (pmIds.length) {
    const rows = await db.query(
      `SELECT id, description, material, type, level, price_per_pc, lead_time_days
         FROM pack_materials WHERE id = ANY($1) AND deleted_at IS NULL`,
      { bind: [pmIds], type: QueryTypes.SELECT }
    );
    for (const r of rows) pmMap[r.id] = r;
  }

  // ── Vendor lead-time fallbacks ──
  const [rmVendorLead, pmVendorLead] = await Promise.all([
    vendorLeadMap('RM', rmIds),
    vendorLeadMap('PM', pmIds),
  ]);

  // ── Build RM lines + blended SG ──
  let blendedSgKnown = 0;     // Σ (pct/100 × sg) over lines that have an SG
  let knownPct = 0;           // Σ pct over lines that have an SG
  const missingSgLines = [];  // ingredients with no SG anywhere

  const rmLines = (bom.rm_lines || []).map(r => {
    const master = rmMap[r.raw_material_id] || {};
    const code = r.rm_code || r.zoho_sku_code || '';
    const dbPrice = pf(master.price_per_kg);
    const price = rmOverrides[code] !== undefined ? pf(rmOverrides[code]) : dbPrice;
    // SG: manual override → master SG → none
    const masterSg = master.specific_gravity != null ? pf(master.specific_gravity) : null;
    const overrideSg = sgOverrides[code] !== undefined ? pf(sgOverrides[code]) : null;
    const sg = overrideSg != null ? overrideSg : masterSg;
    const pct = pf(r.pct_w_w);
    if (sg != null && sg > 0) {
      blendedSgKnown += (pct / 100) * sg;
      knownPct += pct;
    } else {
      missingSgLines.push({ rm_code: code, name: r.inci_name || master.name || code, pct_w_w: pct });
    }
    // Lead time: master value (currently NULL) → vendor min → null (rule-based)
    const leadTime = master.lead_time_days != null ? parseInt(master.lead_time_days)
      : (rmVendorLead[r.raw_material_id] != null ? rmVendorLead[r.raw_material_id] : null);
    return {
      raw_material_id: r.raw_material_id,
      rm_code: code,
      inci_name: r.inci_name || master.name || '',
      pct_w_w: pct,
      price_per_kg: price,
      db_price: dbPrice,
      overridden: rmOverrides[code] !== undefined,
      specific_gravity: sg,
      sg_source: overrideSg != null ? 'manual' : (masterSg != null ? 'db' : 'missing'),
      category: master.category || r.category || null,
      lead_time_days: leadTime,
      found_in_db: !!rmMap[r.raw_material_id],
    };
  });

  const sgComplete = missingSgLines.length === 0;
  const blendedSg = sgComplete ? Math.round(blendedSgKnown * 1000) / 1000 : null;

  // ── Build PM lines ──
  const pmLines = (bom.pm_lines || []).map(p => {
    const master = pmMap[p.pack_material_id] || {};
    const code = p.pm_code || p.zoho_sku_code || '';
    const dbPrice = pf(master.price_per_pc);
    const price = pmOverrides[code] !== undefined ? pf(pmOverrides[code]) : dbPrice;
    const leadTime = master.lead_time_days != null ? parseInt(master.lead_time_days)
      : (pmVendorLead[p.pack_material_id] != null ? pmVendorLead[p.pack_material_id] : null);
    return {
      pack_material_id: p.pack_material_id,
      pm_code: code,
      description: p.pm_description || p.description || master.description || '',
      qty_per_unit: pf(p.qty_per_unit),
      price_per_pc: price,
      db_price: dbPrice,
      overridden: pmOverrides[code] !== undefined,
      material: master.material || p.material || null,
      lead_time_days: leadTime,
      found_in_db: !!pmMap[p.pack_material_id],
    };
  });

  // ── Parse fill volume from pack_size (e.g. "50 ML") ──
  const m = (bom.pack_size || '').match(/(\d+(?:\.\d+)?)\s*(ML|G|GM|MG|L)/i);
  const parsedVolume = m ? pf(m[1]) : 0;
  const parsedUnit = m ? m[2].toUpperCase() : 'ML';

  return {
    id: bom.id,
    bom_code: bom.bom_code,
    name: bom.name,
    pack_size: bom.pack_size,
    product_code: bom.product_code || null,
    brand_name: bom.brand_name || null,
    parsed_volume_ml: parsedUnit === 'ML' ? parsedVolume : 0,
    rm_lines: rmLines,
    pm_lines: pmLines,
    rm_count: rmLines.length,
    pm_count: pmLines.length,
    // Blended SG computation surfaced for the UI:
    blended_sg: blendedSg,           // number when complete, null when any SG missing
    blended_sg_partial: Math.round(blendedSgKnown * 1000) / 1000,
    sg_complete: sgComplete,
    sg_known_pct: Math.round(knownPct * 100) / 100,
    missing_sg_lines: missingSgLines, // [{rm_code, name, pct_w_w}]
  };
}

module.exports = { enrichBom };
