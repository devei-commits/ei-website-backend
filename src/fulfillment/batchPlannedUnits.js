/**
 * A batch's planned quantity in UNITS, for display against the order quantity.
 *
 * `fulfillment_batch_splits.planned_qty` is the batch size in **KG** (copied from
 * production_batches.batch_size ← planning_batches.size_kg), while the order quantity is in
 * **units**. Rendering them as "5 / 1,000" compared kilograms to units — two different things — and
 * read as though the batch covered 0.5% of the order when it actually covers 10%.
 *
 * The conversion factor comes from the planning row that produced the batch: total KG ÷ order units
 * gives kg-per-unit, so 5 kg of a 50 KG / 1,000-unit order is 100 units.
 */
'use strict';

/** "1000 units" / "50 KG" -> 1000 / 50. Returns 0 when the label carries no number. */
function parseQtyLabel(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * KG per unit for a planning row, or 0 when it cannot be derived.
 * Both figures must be positive — a zero on either side would make the ratio meaningless.
 */
function kgPerUnitForPlanning(planPlain) {
  const totalKg = parseQtyLabel(planPlain?.total_kg_display);
  const orderUnits = parseQtyLabel(planPlain?.order_qty_display);
  if (!(totalKg > 0) || !(orderUnits > 0)) return 0;
  return totalKg / orderUnits;
}

/**
 * Convert a batch size in KG to units.
 * Returns null when the ratio is unknown, so callers can fall back rather than show a wrong number.
 */
function batchUnitsFromKg(batchKg, kgPerUnit) {
  const kg = Number(batchKg);
  if (!(kg > 0) || !(kgPerUnit > 0)) return null;
  return Math.round(kg / kgPerUnit);
}

/** Percent of the order this batch covers, from units on both sides. */
function coveragePctFromUnits(plannedUnits, orderedUnits) {
  const p = Number(plannedUnits);
  const o = Number(orderedUnits);
  if (!(p > 0) || !(o > 0)) return 0;
  return Math.round((p / o) * 100);
}

module.exports = { parseQtyLabel, kgPerUnitForPlanning, batchUnitsFromKg, coveragePctFromUnits };
