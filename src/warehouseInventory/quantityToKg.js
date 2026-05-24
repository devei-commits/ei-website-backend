/**
 * Normalize procurement / GRN / PO quantities to kilograms for warehouse_inventory.
 * Count-based lines (PCS) convert when we can infer mass per piece from PM size_spec (e.g. "50g") or explicit kg_per_piece.
 * RM volume (L, ML): kg = qty × specific_gravity (litres) or (ml/1000) × SG.
 */

const {
  normRmPrimaryUom,
  rmPrimaryQtyToKg,
  parseSpecificGravity,
  isVolumePrimaryUom,
} = require('../lib/rmUnitConversion');

function normUom(s) {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Try to read a nominal piece mass in grams from pack_materials.size_spec (e.g. "50g / 82mm", "150ml" skipped).
 */
function gramsPerPieceFromSizeSpec(sizeSpec) {
  if (sizeSpec == null || sizeSpec === '') return null;
  const s = String(sizeSpec);
  const m = s.match(/(\d+(?:\.\d+)?)\s*g(?:\b|ram)/i);
  if (!m) return null;
  const g = Number(m[1]);
  return Number.isFinite(g) && g > 0 ? g : null;
}

/**
 * @param {number} qty
 * @param {string} [unitRaw] line or PO unit
 * @param {object} [ctx]
 * @param {'RM'|'PM'|'PR'} [ctx.itemType]
 * @param {string} [ctx.masterUom] raw_materials.uom or pack_materials.unit
 * @param {string} [ctx.sizeSpec] pack_materials.size_spec
 * @param {number} [ctx.kgPerPiece] optional explicit conversion (form_data etc.)
 * @returns {number} kilograms (>= 0)
 */
function quantityToKg(qty, unitRaw, ctx = {}) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return 0;

  const u = normUom(unitRaw);
  const { itemType, masterUom, sizeSpec, kgPerPiece, specificGravity } = ctx;
  const kpp = Number(kgPerPiece);
  if (Number.isFinite(kpp) && kpp > 0) return q * kpp;

  const sg = parseSpecificGravity(specificGravity);
  if (
    u === 'L' ||
    u === 'LT' ||
    u === 'LTR' ||
    u === 'LITRE' ||
    u === 'LITER' ||
    u === 'LITRES' ||
    u === 'LITERS'
  ) {
    return q * sg;
  }
  if (u === 'ML' || u === 'MILLILITRE' || u === 'MILLILITER' || u === 'MILLILITRES' || u === 'MILLILITERS') {
    return (q / 1000) * sg;
  }

  // Mass units
  if (u === 'KG' || u === 'KGS' || u === 'KILO' || u === 'KILOS' || u === 'KILOGRAM' || u === 'KILOGRAMS') return q;
  if (u === 'G' || u === 'GM' || u === 'GRAM' || u === 'GRAMS') return q / 1000;
  if (u === 'MG' || u === 'MILLIGRAM' || u === 'MILLIGRAMS') return q / 1e6;
  if (u === 'T' || u === 'TON' || u === 'TONS' || u === 'TONNE' || u === 'TONNES' || u === 'MT') return q * 1000;
  if (u === 'LB' || u === 'LBS' || u === 'POUND' || u === 'POUNDS') return q * 0.45359237;
  if (u === 'OZ' || u === 'OUNCE' || u === 'OUNCES') return q * 0.028349523125;

  const countLike = new Set([
    'PCS',
    'PC',
    'PIECE',
    'PIECES',
    'NOS',
    'NO',
    'UNIT',
    'UNITS',
    'EA',
    'EACH',
    'QTY',
    'NUM',
    'PK',
    'PACK',
    'BOX',
    'CARTON',
  ]);

  const gPiece = gramsPerPieceFromSizeSpec(sizeSpec);
  if (gPiece != null) return (q * gPiece) / 1000;

  if (countLike.has(u) || (itemType === 'PM' && !u)) {
    if (itemType === 'RM') {
      const mu = normUom(masterUom);
      if (mu && (mu === 'G' || mu === 'GM' || mu === 'GRAM')) return q / 1000;
      return q;
    }
    // PM count units without a gram hint in size_spec: cannot infer mass; treat qty as kg (set PO/GRN line unit to G/KG or add …g in size_spec).
    return q;
  }

  const mu = normRmPrimaryUom(masterUom);
  if (itemType === 'RM' && (isVolumePrimaryUom(mu) || mu === 'GM')) {
    return rmPrimaryQtyToKg(q, mu, sg);
  }
  if (mu === 'G' || mu === 'GM' || mu === 'GRAM') return q / 1000;
  if (mu === 'MG') return q / 1e6;
  if (itemType === 'RM' && !u) return q;

  return q;
}

module.exports = {
  quantityToKg,
  gramsPerPieceFromSizeSpec,
  normUom,
};
