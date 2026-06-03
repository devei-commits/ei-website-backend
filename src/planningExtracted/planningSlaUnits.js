const { parseOrderQtyNum } = require('./orderKgMath');

function parseKgFromDisplay(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Mirror Planning UI: planned units from custom batch kg or batch_count × batch_size. */
function getCreatedAndRemainingUnitsFromPlanningRow(row) {
  const orderUnits = parseOrderQtyNum(row?.order_qty_display);
  if (orderUnits <= 0) return { createdUnits: 0, remainingUnits: 0 };

  const totalKg = parseKgFromDisplay(row?.total_kg_display);
  const kgPerUnit = totalKg > 0 ? totalKg / orderUnits : 0;

  const customBatchKg = Array.isArray(row?.custom_batches)
    ? row.custom_batches.reduce((sum, b) => sum + (Number(b?.sizeKg) || 0), 0)
    : 0;
  const batchSizeKg =
    Number(row?.batch_size_kg) > 0 ? Number(row.batch_size_kg) : parseKgFromDisplay(row?.batch_size_display);
  const fallbackBatchKg = (Number(row?.batch_count) || 0) * batchSizeKg;
  const plannedKg = customBatchKg > 0 ? customBatchKg : fallbackBatchKg;

  const createdUnitsRaw = kgPerUnit > 0 ? Math.round(plannedKg / kgPerUnit) : 0;
  const createdUnits = Math.max(0, createdUnitsRaw);
  const remainingUnits = Math.max(0, orderUnits - Math.min(createdUnits, orderUnits));
  return { createdUnits, remainingUnits };
}

module.exports = {
  getCreatedAndRemainingUnitsFromPlanningRow,
};
