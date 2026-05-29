/**
 * Exact material qty compare (up to 16 dp) — transfers/MTR/dispensing use DB precision.
 * Uses integer scaling so transferred qty equals received qty (no float drift).
 */
const SCALE = 16;
const SCALE_POW = 10n ** BigInt(SCALE);
/** Snap JS number inputs at 10 dp to kill BOM float noise (44.799999… vs 44.800000…0001). */
const FLOAT_SNAP_SCALE = 10;
const FLOAT_SNAP_POW = 10 ** FLOAT_SNAP_SCALE;

function fromScaledBigInt(bi) {
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const intPart = abs / SCALE_POW;
  const frac = abs % SCALE_POW;
  if (frac === 0n) return `${neg ? '-' : ''}${intPart}`;
  const fracStr = frac.toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}.${fracStr}`;
}

function snapJsFloatNumber(n) {
  return Math.round(n * FLOAT_SNAP_POW + Number.EPSILON) / FLOAT_SNAP_POW;
}

function parseDecimalStringToScaledBigInt(s) {
  let str = String(s).trim();
  if (str === '' || str === '-') return 0n;
  const neg = str.startsWith('-');
  if (neg) str = str.slice(1);
  const dot = str.indexOf('.');
  let intPart = (dot >= 0 ? str.slice(0, dot) : str).replace(/[^\d]/g, '') || '0';
  let fracPart = (dot >= 0 ? str.slice(dot + 1) : '').replace(/[^\d]/g, '');

  if (fracPart.length > SCALE) {
    const roundDigit = parseInt(fracPart[SCALE] || '0', 10);
    fracPart = fracPart.slice(0, SCALE);
    if (roundDigit >= 5) {
      let fracBi = BigInt(fracPart || '0') + 1n;
      let intBi = BigInt(intPart);
      if (fracBi >= SCALE_POW) {
        fracBi = 0n;
        intBi += 1n;
      }
      intPart = String(intBi);
      fracPart = fracBi.toString().padStart(SCALE, '0');
    }
  } else {
    fracPart = fracPart.padEnd(SCALE, '0');
  }

  const combined = BigInt(intPart) * SCALE_POW + BigInt(fracPart || '0');
  return neg ? -combined : combined;
}

/** All inputs (DB strings, JSON numbers, BOM floats) → same canonical decimal string. */
function canonicalQtyNumericString(value) {
  if (value == null || value === '') return '0';
  const s = typeof value === 'string' ? value.trim() : String(value);
  if (s === '' || s === '-') return '0';
  const n = Number(s);
  if (!Number.isFinite(n)) return '0';
  return String(snapJsFloatNumber(n));
}

/** Canonical qty string at SCALE dp. */
function toQtyString(value) {
  return fromScaledBigInt(parseDecimalStringToScaledBigInt(canonicalQtyNumericString(value)));
}

function toScaledBigInt(value) {
  return parseDecimalStringToScaledBigInt(canonicalQtyNumericString(value));
}

function compareMaterialQty(a, b) {
  const ai = toScaledBigInt(a);
  const bi = toScaledBigInt(b);
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

function materialQtyGte(a, b) {
  return compareMaterialQty(a, b) >= 0;
}

function materialQtyLte(a, b) {
  return compareMaterialQty(a, b) <= 0;
}

function materialQtyGt(a, b) {
  return compareMaterialQty(a, b) > 0;
}

function materialQtyLt(a, b) {
  return compareMaterialQty(a, b) < 0;
}

function materialQtyAdd(a, b) {
  return fromScaledBigInt(toScaledBigInt(a) + toScaledBigInt(b));
}

function materialQtySub(a, b) {
  return fromScaledBigInt(toScaledBigInt(a) - toScaledBigInt(b));
}

/** a − b, floored at zero (reserved reductions, rack qty). */
function materialQtySubNonNeg(a, b) {
  const diff = toScaledBigInt(a) - toScaledBigInt(b);
  return fromScaledBigInt(diff < 0n ? 0n : diff);
}

function materialQtyMin(a, b) {
  return materialQtyLte(a, b) ? materialQtyFromDb(a) : materialQtyFromDb(b);
}

function materialQtyToNum(value) {
  const s = toQtyString(value);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isMaterialQtyPositive(value) {
  return materialQtyGt(value, 0);
}

/** Preserve DB DECIMAL string when Sequelize returns a string; else exact fixed string. */
function materialQtyFromDb(value) {
  if (value == null) return '0';
  return toQtyString(value);
}

/** Normalize MRN/MTR line_items[].quantity for JSON + rack moves. */
function sanitizeMrnLineItemQuantity(value) {
  return materialQtyFromDb(value);
}

function sanitizeMrnLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((line) => ({
    ...line,
    quantity: sanitizeMrnLineItemQuantity(line?.quantity),
  }));
}

/** Packaging (pcs) dispensing/MU checks at 2 dp — BOM 2.496 vs ML1 2.5 must not false-short. */
const PCS_DISPENSING_POW = 100;

function snapPackagingQtyString(value) {
  const s = toQtyString(value);
  const n = Number(s);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * PCS_DISPENSING_POW + Number.EPSILON) / PCS_DISPENSING_POW);
}

/** @param {'RM'|'PM'|'kg'|'pcs'} materialType */
function qtyForDispensingCompare(value, materialType) {
  const isPcs = materialType === 'PM' || materialType === 'pcs';
  return isPcs ? snapPackagingQtyString(value) : toQtyString(value);
}

function materialQtyGteForDispensing(a, b, materialType) {
  return compareMaterialQty(qtyForDispensingCompare(a, materialType), qtyForDispensingCompare(b, materialType)) >= 0;
}

function materialQtyLteForDispensing(a, b, materialType) {
  return compareMaterialQty(qtyForDispensingCompare(a, materialType), qtyForDispensingCompare(b, materialType)) <= 0;
}

/** PM consume at most physical at-MU qty (no round-up): 2.5 request vs 2.496 on hand → 2.496. */
function capPmDispenseConsumption(requested, atMu) {
  const req = materialQtyToNum(qtyForDispensingCompare(requested, 'PM'));
  const at = materialQtyToNum(materialQtyFromDb(atMu));
  return req <= at ? req : at;
}

module.exports = {
  SCALE,
  compareMaterialQty,
  materialQtyGte,
  materialQtyLte,
  qtyForDispensingCompare,
  materialQtyGteForDispensing,
  materialQtyLteForDispensing,
  capPmDispenseConsumption,
  materialQtyGt,
  materialQtyLt,
  materialQtyAdd,
  materialQtySub,
  materialQtySubNonNeg,
  materialQtyMin,
  materialQtyToNum,
  isMaterialQtyPositive,
  materialQtyFromDb,
  sanitizeMrnLineItemQuantity,
  sanitizeMrnLineItems,
  toQtyString,
};
