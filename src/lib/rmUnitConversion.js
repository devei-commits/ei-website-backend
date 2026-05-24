/**
 * RM primary UoM (KG, GM, L, ML) ↔ kilograms for planning vs procurement/PO.
 * Volume: kg = litres × specific_gravity; litres = kg / specific_gravity.
 */

const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');

function normRmPrimaryUom(raw) {
  const u = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!u) return 'KG';
  if (u === 'KG' || u === 'KGS' || u === 'KILO' || u === 'KILOS' || u === 'KILOGRAM' || u === 'KILOGRAMS') return 'KG';
  if (u === 'G' || u === 'GM' || u === 'GRAM' || u === 'GRAMS') return 'GM';
  if (
    u === 'L' ||
    u === 'LT' ||
    u === 'LTR' ||
    u === 'LITRE' ||
    u === 'LITER' ||
    u === 'LITRES' ||
    u === 'LITERS'
  ) {
    return 'L';
  }
  if (u === 'ML' || u === 'MILLILITRE' || u === 'MILLILITER' || u === 'MILLILITRES' || u === 'MILLILITERS') {
    return 'ML';
  }
  return u;
}

function parseSpecificGravity(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isVolumePrimaryUom(primaryUom) {
  const p = normRmPrimaryUom(primaryUom);
  return p === 'L' || p === 'ML';
}

function isMassPrimaryUom(primaryUom) {
  const p = normRmPrimaryUom(primaryUom);
  return p === 'KG' || p === 'GM';
}

/**
 * @param {number} kg
 * @param {string} primaryUom
 * @param {number} [specificGravity]
 */
function kgToRmPrimaryQty(kg, primaryUom, specificGravity = 1) {
  const k = Number(kg);
  if (!Number.isFinite(k)) return 0;
  const sg = parseSpecificGravity(specificGravity);
  const p = normRmPrimaryUom(primaryUom);
  if (p === 'KG') return roundPlanningMaterialQty(k);
  if (p === 'GM') return roundPlanningMaterialQty(k * 1000);
  if (p === 'L') return roundPlanningMaterialQty(sg > 0 ? k / sg : k);
  if (p === 'ML') return roundPlanningMaterialQty(sg > 0 ? (k / sg) * 1000 : k * 1000);
  return roundPlanningMaterialQty(k);
}

/**
 * @param {number} qty — in RM primary UoM
 * @param {string} primaryUom
 * @param {number} [specificGravity]
 */
function rmPrimaryQtyToKg(qty, primaryUom, specificGravity = 1) {
  const q = Number(qty);
  if (!Number.isFinite(q)) return 0;
  const sg = parseSpecificGravity(specificGravity);
  const p = normRmPrimaryUom(primaryUom);
  if (p === 'KG') return roundPlanningMaterialQty(q);
  if (p === 'GM') return roundPlanningMaterialQty(q / 1000);
  if (p === 'L') return roundPlanningMaterialQty(q * sg);
  if (p === 'ML') return roundPlanningMaterialQty((q / 1000) * sg);
  return roundPlanningMaterialQty(q);
}

/** True when line quantities are still planning-canonical kilograms. */
function procurementLineQtyIsCanonicalKg(line, primaryUom) {
  const primary = normRmPrimaryUom(primaryUom);
  const lineU = normRmPrimaryUom(line?.unit);
  if (!line?.unit || lineU === 'KG') return true;
  if (primary === 'GM' && (lineU === 'GM' || lineU === 'G')) return false;
  if (primary === 'L' && isVolumePrimaryUom(lineU)) return false;
  if (primary === 'ML' && lineU === 'ML') return false;
  if (primary === lineU) return false;
  return lineU === 'KG';
}

/**
 * Convert RM procurement lines from planning kg → RM primary UoM for PO release.
 * @param {object[]} items
 * @param {Map<number, { uom?: string, specific_gravity?: number }>} rmMap
 */
function applyProcurementRmPrimaryUnits(items, rmMap) {
  if (!Array.isArray(items) || !rmMap) return items;
  return items.map((line) => {
    if (!line || line.type !== 'RM') return line;
    const rmId = line.raw_material_id != null ? Number(line.raw_material_id) : NaN;
    if (!Number.isFinite(rmId) || rmId <= 0 || !rmMap.has(rmId)) return line;
    const rm = rmMap.get(rmId);
    const primary = normRmPrimaryUom(rm.uom);
    const sg = parseSpecificGravity(line.specific_gravity ?? rm.specific_gravity);
    const out = { ...line, unit: primary };
    if (!procurementLineQtyIsCanonicalKg(line, primary)) return out;
    const fields = ['quantity_requested', 'required', 'shortage'];
    for (const f of fields) {
      if (out[f] == null || out[f] === '') continue;
      const kg = Number(out[f]);
      if (!Number.isFinite(kg)) continue;
      out[f] = kgToRmPrimaryQty(kg, primary, sg);
    }
    return out;
  });
}

function procurementMoqUnitLabel(line) {
  const u = normRmPrimaryUom(line?.unit);
  if (u === 'KG') return 'kg';
  if (u === 'GM') return 'g';
  if (u === 'L') return 'L';
  if (u === 'ML') return 'ml';
  return 'units';
}

module.exports = {
  normRmPrimaryUom,
  parseSpecificGravity,
  isVolumePrimaryUom,
  isMassPrimaryUom,
  kgToRmPrimaryQty,
  rmPrimaryQtyToKg,
  procurementLineQtyIsCanonicalKg,
  applyProcurementRmPrimaryUnits,
  procurementMoqUnitLabel,
};
