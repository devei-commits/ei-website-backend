/**
 * Order-level FG mass (kg) from units × fill size, BOM % splits, and production batch size.
 * Used by planning_extracted sync and fulfillment SO → planning row creation.
 */

/** RM kg, PM counts, and related snapshot qtys: store at 5 decimal places. */
const PLANNING_MATERIAL_QTY_DECIMALS = 5;
const PLANNING_MATERIAL_QTY_FACTOR = 10 ** PLANNING_MATERIAL_QTY_DECIMALS;

/**
 * @param {unknown} q
 * @returns {number}
 */
function roundPlanningMaterialQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return n;
  return Math.round((n + Number.EPSILON) * PLANNING_MATERIAL_QTY_FACTOR) / PLANNING_MATERIAL_QTY_FACTOR;
}

function parseOrderQtyNum(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse product fill size to KG per unit.
 * Supports: 100g, 0.1 kg, 100 ml, 0.1 L.
 * Volume → kg: liters × specific gravity (ml → L/1000 then × SG).
 */
function parseFillSizeToKgPerUnit(fillSizeRaw, sg = 1) {
  const text = String(fillSizeRaw || '').trim().toLowerCase();
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*([a-z]+)/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = String(m[2] || '').toLowerCase();
  if (!(Number.isFinite(value) && value > 0)) return null;
  const specificGravity = Number(sg) > 0 ? Number(sg) : 1;

  if (unit.startsWith('kg')) return value;
  if (unit === 'g' || unit === 'gm' || unit === 'gms' || unit.startsWith('gram')) return value / 1000;
  if (unit === 'ml' || unit === 'millilitre' || unit === 'milliliter' || unit === 'milliliters' || unit === 'millilitres') {
    return (value / 1000) * specificGravity;
  }
  if (unit === 'l' || unit === 'lt' || unit === 'ltr' || unit === 'litre' || unit === 'liter' || unit === 'liters' || unit === 'litres') {
    return value * specificGravity;
  }
  return null;
}

function inferBlendSpecificGravity(rmLines) {
  const lines = Array.isArray(rmLines) ? rmLines : [];
  let weighted = 0;
  let pctSum = 0;
  for (const line of lines) {
    const pct = Number(line?.pct_w_w ?? line?.pct ?? 0);
    const sg = Number(line?.specific_gravity);
    if (!(Number.isFinite(pct) && pct > 0 && Number.isFinite(sg) && sg > 0)) continue;
    weighted += pct * sg;
    pctSum += pct;
  }
  if (pctSum <= 0) return 1;
  return weighted / pctSum;
}

function estimateTotalKgFromRmLines({ rmLines, orderQty, batchSizeKg, batchesRequired }) {
  const lines = Array.isArray(rmLines) ? rmLines : [];
  if (lines.length === 0) return 0;

  let totalKg = 0;
  for (const line of lines) {
    const quantity = Number(line?.quantity);
    if (Number.isFinite(quantity) && quantity > 0) {
      totalKg += quantity;
      continue;
    }

    const pct = Number(line?.pct_w_w ?? line?.pct ?? 0);
    if (Number.isFinite(pct) && pct > 0 && Number(batchSizeKg) > 0 && Number(batchesRequired) > 0) {
      totalKg += (Number(batchSizeKg) * pct) / 100 * Number(batchesRequired);
      continue;
    }

    const qtyPerUnit = Number(line?.qty_per_unit ?? line?.qty);
    if (Number.isFinite(qtyPerUnit) && qtyPerUnit > 0 && Number(orderQty) > 0) {
      const sg = Number(line?.specific_gravity) || 1;
      totalKg += Number(orderQty) * qtyPerUnit * sg;
    }
  }

  return roundPlanningMaterialQty(totalKg);
}

/**
 * Total kg of finished product for the sales order line (units × fill → kg, or BOM fallback).
 */
function estimateOrderTotalKg({ orderQty, product, rmLines, batchSizeKg, batchesRequired }) {
  const qty = Number(orderQty) || 0;
  if (qty <= 0) return 0;
  const blendSg = inferBlendSpecificGravity(rmLines);
  const kgPerUnit = parseFillSizeToKgPerUnit(product?.fill_size, blendSg);
  if (kgPerUnit != null && kgPerUnit > 0) {
    return roundPlanningMaterialQty(qty * kgPerUnit);
  }
  return estimateTotalKgFromRmLines({ rmLines, orderQty: qty, batchSizeKg, batchesRequired });
}

/**
 * How many manufacturing batches (of batchSizeKg each) are needed to cover total FG kg.
 */
function batchesRequiredForOrderKg(totalOrderKg, batchSizeKg) {
  const t = Number(totalOrderKg) || 0;
  const b = Number(batchSizeKg) || 0;
  if (t <= 0 || b <= 0) return 1;
  return Math.max(1, Math.ceil(t / b));
}

/**
 * Snapshot RM/PM requirement lines for planning_extracted (full order).
 * RM: pct of total FG kg (blend). PM: pieces per FG unit × order units.
 */
function buildPlanningSnapshotFromBom(bomRmLines, bomPmLines, orderQty, safeTotalKg, batchSizeKg) {
  const oq = Number(orderQty) || 0;
  const tkg = Number(safeTotalKg) || 0;
  const bsk = Number(batchSizeKg) || 0;
  const raw_materials = (Array.isArray(bomRmLines) ? bomRmLines : []).map((line) => {
    const pct = Number(line.pct_w_w ?? line.pct ?? 0) || 0;
    const q = tkg > 0 ? (tkg * pct) / 100 : (bsk * pct) / 100;
    return {
      raw_material_id: line.raw_material_id ?? null,
      name: line.inci_name ?? line.name ?? line.rm_code ?? '',
      quantity: roundPlanningMaterialQty(q),
      unit: 'KG',
      code: line.rm_code ?? line.code ?? '',
    };
  });
  const packaging_materials = (Array.isArray(bomPmLines) ? bomPmLines : []).map((line) => {
    const qtyPerUnit = Number(line.qty_per_unit ?? line.qty ?? 1) || 1;
    const required = oq * qtyPerUnit;
    return {
      pack_material_id: line.pack_material_id ?? null,
      name: line.description ?? line.name ?? line.pm_code ?? '',
      quantity: roundPlanningMaterialQty(required),
      unit: 'PCS',
      code: line.pm_code ?? line.code ?? '',
    };
  });
  return { raw_materials, packaging_materials };
}

module.exports = {
  PLANNING_MATERIAL_QTY_DECIMALS,
  roundPlanningMaterialQty,
  parseOrderQtyNum,
  parseFillSizeToKgPerUnit,
  inferBlendSpecificGravity,
  estimateTotalKgFromRmLines,
  estimateOrderTotalKg,
  batchesRequiredForOrderKg,
  buildPlanningSnapshotFromBom,
};
