'use strict';

/**
 * Kit BOM expansion for Items Involved.
 *
 * A "kit" PR does not consume raw materials directly. Its formula BOM (`boms.rm_lines`) carries
 * references to OTHER PRs (sub-products) — each line = N finished units of that sub-PR per kit unit
 * — and its `pm_lines` carry the kit's OWN outer packaging (box/carton). For procurement we must
 * expand a kit into the real materials it ultimately needs:
 *
 *   kit → for each sub-PR line: (sub-PR's own RM from its SKU BOM) + (sub-PR's own PM)
 *       + the kit's own pack material (outer packaging)
 *
 * Scaling: subUnits = kitUnits × units_per_kit. Sub-PR RM comes from `sku_rm_lines`
 * (qty_per_unit per finished unit) converted to kg; sub-PR PM from `pm_lines` (qty_per_unit).
 *
 * Output rows match buildPlanningSnapshotFromBom (orderKgMath.js) exactly so downstream id
 * resolution / pipeline / display need no change:
 *   RM: { raw_material_id, name, quantity, unit: 'KG', code }
 *   PM: { pack_material_id, name, quantity, unit: 'PCS', code }
 */

const { Op } = require('sequelize');
const { roundPlanningMaterialQty } = require('./orderKgMath');
const { rmPrimaryQtyToKg } = require('../lib/rmUnitConversion');
// BOM (DB-backed) is required lazily inside loadSubBomMap so the pure expansion helpers
// (isKitRmLines / expandKitToMaterialRows) are unit-testable without a database connection.

/** Max kit nesting depth (a sub-PR may itself be a kit). Guards runaway recursion. */
const KIT_MAX_DEPTH = 3;

/**
 * True when a rm_lines array holds kit PR references rather than raw-material lines.
 * Robust to override / planning_batches copies that don't carry the is_kit flag.
 * @param {any[]} rmLines
 */
function isKitRmLines(rmLines) {
  if (!Array.isArray(rmLines)) return false;
  return rmLines.some((l) => {
    if (!l || typeof l !== 'object') return false;
    if (String(l.type || '').toUpperCase() === 'PR') return true;
    const pid = l.product_id ?? l.productId;
    const hasProduct = pid != null && Number.isFinite(Number(pid)) && Number(pid) > 0;
    const hasRm = l.rm_code != null || l.raw_material_id != null;
    return hasProduct && !hasRm;
  });
}

/** Unique, valid sub-product ids referenced by kit formula lines. */
function collectKitSubProductIds(rmLines) {
  const out = new Set();
  for (const l of Array.isArray(rmLines) ? rmLines : []) {
    const pid = Number(l && (l.product_id ?? l.productId));
    if (Number.isFinite(pid) && pid > 0) out.add(pid);
  }
  return [...out];
}

/**
 * Batch-load each referenced sub-PR's BOM into a Map<product_id, bomPlain>, recursing into
 * sub-kits up to KIT_MAX_DEPTH. Accepts a pre-seeded accumulator so callers can preload once.
 * @param {any[]} rootRmLines
 * @param {number} depth
 * @param {Map<number, object>} acc
 * @returns {Promise<Map<number, object>>}
 */
async function loadSubBomMap(rootRmLines, depth = 0, acc = new Map()) {
  const ids = collectKitSubProductIds(rootRmLines).filter((id) => !acc.has(id));
  if (ids.length === 0 || depth > KIT_MAX_DEPTH) return acc;
  const BOM = require('../bom/models');
  const rows = await BOM.findAll({
    where: { product_id: { [Op.in]: ids } },
    attributes: [
      'product_id',
      'sku_rm_lines',
      'pm_lines',
      'rm_lines',
      'is_kit',
      'sku_bom_limit_qty',
      'sku_bom_limit_uom',
    ],
  });
  const plains = rows.map((r) => (r.get ? r.get({ plain: true }) : r));
  for (const p of plains) acc.set(Number(p.product_id), p);
  // Recurse into any sub-PR that is itself a kit.
  for (const p of plains) {
    if (p.is_kit || isKitRmLines(p.rm_lines)) {
      await loadSubBomMap(p.rm_lines, depth + 1, acc);
    }
  }
  return acc;
}

function addRmRow(map, srcLine, qtyKg) {
  const code = String(srcLine.rm_code || srcLine.code || '').trim();
  const rawMaterialId = srcLine.raw_material_id ?? srcLine.rawMaterialId ?? null;
  const key = code || (rawMaterialId != null ? `id:${rawMaterialId}` : `name:${String(srcLine.inci_name || srcLine.name || '').trim().toLowerCase()}`);
  if (!key) return;
  const prev = map.get(key);
  if (prev) {
    prev.quantity += qtyKg;
    return;
  }
  map.set(key, {
    raw_material_id: rawMaterialId,
    name: srcLine.inci_name ?? srcLine.name ?? srcLine.rm_code ?? '',
    quantity: qtyKg,
    unit: 'KG',
    code,
  });
}

function addPmRow(map, srcLine, qtyPcs) {
  const code = String(srcLine.pm_code || srcLine.code || '').trim();
  const packMaterialId = srcLine.pack_material_id ?? srcLine.packMaterialId ?? null;
  const key = code || (packMaterialId != null ? `id:${packMaterialId}` : `name:${String(srcLine.description || srcLine.name || '').trim().toLowerCase()}`);
  if (!key) return;
  const prev = map.get(key);
  if (prev) {
    prev.quantity += qtyPcs;
    return;
  }
  map.set(key, {
    pack_material_id: packMaterialId,
    name: srcLine.description ?? srcLine.name ?? srcLine.pm_code ?? '',
    quantity: qtyPcs,
    unit: 'PCS',
    code,
  });
}

/**
 * Expand a kit into concrete RM/PM material rows. Synchronous — all sub-PR BOMs must be preloaded
 * into subBomMap (via loadSubBomMap).
 * @param {any[]} kitRmLines  kit formula PR lines
 * @param {any[]} kitPmLines  kit's own outer-packaging PM lines
 * @param {number} kitUnits   number of kit units to make
 * @param {Map<number, object>} subBomMap
 * @param {{ depth?: number, visited?: Set<number> }} [opts]
 * @returns {{ raw_materials: object[], packaging_materials: object[] }}
 */
function expandKitToMaterialRows(kitRmLines, kitPmLines, kitUnits, subBomMap, opts = {}) {
  const depth = opts.depth || 0;
  const visited = opts.visited || new Set();
  const rmMap = new Map();
  const pmMap = new Map();
  const units = Number(kitUnits) || 0;

  for (const line of Array.isArray(kitRmLines) ? kitRmLines : []) {
    const pid = Number(line && (line.product_id ?? line.productId));
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (depth >= KIT_MAX_DEPTH || visited.has(pid)) continue; // cycle / depth guard
    const sub = subBomMap.get(pid);
    if (!sub) continue;
    const perKit = Number(line.units_per_kit ?? line.unitsPerKit ?? line.qty ?? line.qty_per_unit ?? 0) || 0;
    const subUnits = units * perKit;
    if (subUnits <= 0) continue;

    // Nested kit → recurse into its sub-materials.
    if (sub.is_kit || isKitRmLines(sub.rm_lines)) {
      const nested = expandKitToMaterialRows(sub.rm_lines, sub.pm_lines, subUnits, subBomMap, {
        depth: depth + 1,
        visited: new Set([...visited, pid]),
      });
      for (const r of nested.raw_materials) addRmRow(rmMap, r, Number(r.quantity) || 0);
      for (const p of nested.packaging_materials) addPmRow(pmMap, p, Number(p.quantity) || 0);
      continue;
    }

    // Sub-PR RM from its SKU BOM (per finished unit), converted to kg.
    const skuLines = Array.isArray(sub.sku_rm_lines) ? sub.sku_rm_lines : [];
    if (skuLines.length > 0) {
      for (const sk of skuLines) {
        const kgPerUnit = rmPrimaryQtyToKg(
          Number(sk.qty_per_unit ?? sk.qty ?? 0) || 0,
          sk.uom || 'GM',
          Number(sk.specific_gravity ?? sk.specificGravity) || 1
        );
        if (kgPerUnit > 0) addRmRow(rmMap, sk, subUnits * kgPerUnit);
      }
    } else {
      // Fallback: no SKU BOM — approximate per-unit net weight from sku_bom_limit_qty × formula pct.
      const netKgPerUnit = rmPrimaryQtyToKg(
        Number(sub.sku_bom_limit_qty) || 0,
        sub.sku_bom_limit_uom || 'GM',
        1
      );
      if (netKgPerUnit > 0 && Array.isArray(sub.rm_lines)) {
        for (const fl of sub.rm_lines) {
          const pct = Number(fl.pct_w_w ?? fl.pct ?? 0) || 0;
          if (pct > 0) addRmRow(rmMap, fl, subUnits * netKgPerUnit * (pct / 100));
        }
      } else {
        console.warn(
          `[kit-expansion] sub-PR product_id=${pid} has no sku_rm_lines and no usable formula fallback — RM omitted`
        );
      }
    }

    // Sub-PR PM (its own primary packaging).
    for (const pm of Array.isArray(sub.pm_lines) ? sub.pm_lines : []) {
      const qpu = Number(pm.qty_per_unit ?? pm.qty ?? 1) || 1;
      addPmRow(pmMap, pm, subUnits * qpu);
    }
  }

  // Kit's OWN outer packaging, scaled by kit units.
  for (const pm of Array.isArray(kitPmLines) ? kitPmLines : []) {
    const qpu = Number(pm.qty_per_unit ?? pm.qty ?? 1) || 1;
    addPmRow(pmMap, pm, units * qpu);
  }

  const raw_materials = [...rmMap.values()].map((r) => ({
    ...r,
    quantity: roundPlanningMaterialQty(r.quantity),
  }));
  const packaging_materials = [...pmMap.values()].map((p) => ({
    ...p,
    quantity: roundPlanningMaterialQty(p.quantity),
  }));
  return { raw_materials, packaging_materials };
}

/**
 * Convenience wrapper: load sub-PR BOMs then expand. For callers without a preloaded map.
 * @param {any[]} kitRmLines
 * @param {any[]} kitPmLines
 * @param {number} kitUnits
 * @returns {Promise<{ raw_materials: object[], packaging_materials: object[] }>}
 */
async function expandKitBomToMaterials(kitRmLines, kitPmLines, kitUnits) {
  const subBomMap = await loadSubBomMap(kitRmLines);
  return expandKitToMaterialRows(kitRmLines, kitPmLines, kitUnits, subBomMap);
}

module.exports = {
  KIT_MAX_DEPTH,
  isKitRmLines,
  collectKitSubProductIds,
  loadSubBomMap,
  expandKitToMaterialRows,
  expandKitBomToMaterials,
};
