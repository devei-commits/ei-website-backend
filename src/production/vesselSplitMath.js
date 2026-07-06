/** Minimum remainder (kg) to create a split batch. */
const MIN_REMAINDER_KG = 1;

const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');

/** Scale numeric qty fields on planning_batches BOM JSON when batch size changes. */
function scalePlanningJsonLines(lines, scale) {
  if (!Array.isArray(lines) || !(scale > 0) || Math.abs(scale - 1) < 1e-9) return lines;
  return lines.map((line) => {
    if (!line || typeof line !== 'object') return line;
    const copy = { ...line };
    for (const k of ['qty', 'qty_kg', 'required_kg', 'required', 'amount', 'qty_per_batch']) {
      if (typeof copy[k] === 'number' && Number.isFinite(copy[k])) {
        copy[k] = roundPlanningMaterialQty(copy[k] * scale);
      }
    }
    return copy;
  });
}

function scaleDispensingJsonLines(lines, scale) {
  if (!Array.isArray(lines) || !(scale > 0) || Math.abs(scale - 1) < 1e-9) return lines;
  return lines.map((line) => {
    if (!line || typeof line !== 'object') return line;
    const copy = { ...line };
    if (typeof copy.required === 'number' && Number.isFinite(copy.required)) {
      copy.required = roundPlanningMaterialQty(copy.required * scale);
    }
    return copy;
  });
}

/**
 * @param {number} totalKg
 * @param {number|null|undefined} batchVolumeLiters
 * @param {number} vesselCapacityLiters
 * @returns {{ totalKg: number, firstRunKg: number, remainderKg: number, needsSplit: boolean } | null}
 */
function proposeVesselSplitSizes(totalKg, batchVolumeLiters, vesselCapacityLiters) {
  const total = Number(totalKg);
  const vesselCap = Number(vesselCapacityLiters);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(vesselCap) || vesselCap <= 0) return null;

  const volL = Number(batchVolumeLiters);
  const effectiveVol = Number.isFinite(volL) && volL > 0 ? volL : total;
  if (effectiveVol <= vesselCap) {
    return { totalKg: total, firstRunKg: total, remainderKg: 0, needsSplit: false };
  }

  const ratio = vesselCap / effectiveVol;
  const firstRunRaw = total * ratio;
  const firstRunKg = Math.max(
    1,
    Math.min(total - MIN_REMAINDER_KG, Math.round(firstRunRaw)),
  );
  const remainderKg = Math.max(0, Math.round((total - firstRunKg) * 1000) / 1000);
  const needsSplit = remainderKg >= MIN_REMAINDER_KG;
  return { totalKg: total, firstRunKg, remainderKg, needsSplit };
}

const SPLITTABLE_BMR = new Set(['draft', 'batch_confirmed', 'rm_reserved', 'scheduled']);

function assertBatchEligibleForVesselSplit(plain) {
  const bpr = String(plain?.bpr_status || 'draft').toLowerCase();
  const bmr = String(plain?.bmr_status || 'draft').toLowerCase();
  if (bpr !== 'draft') {
    return 'Split is only allowed before packaging (BPR must be draft).';
  }
  if (!SPLITTABLE_BMR.has(bmr)) {
    return 'Split is only allowed before RM connect / dispensing (draft through scheduled).';
  }
  return null;
}

function hasDispensingProgress(dispensingRm, dispensingPm) {
  const lines = [...(dispensingRm || []), ...(dispensingPm || [])];
  return lines.some((l) => Number(l?.dispensed) > 0 || l?.done === true);
}

module.exports = {
  proposeVesselSplitSizes,
  assertBatchEligibleForVesselSplit,
  hasDispensingProgress,
  scalePlanningJsonLines,
  scaleDispensingJsonLines,
  MIN_REMAINDER_KG,
};
