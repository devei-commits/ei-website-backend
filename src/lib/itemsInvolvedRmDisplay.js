/**
 * Unit policy for RM across modules:
 * - Planning / BOM / production / batch math: kilograms (L → kg via SG).
 * - Warehouse inventory (SIH, reserved, in_transit, wh_stock): RM standard UoM (L, KG, …).
 * - Procurement / PO / Items Involved display: RM standard UoM; PR lines converted from planning kg on release.
 */
const {
  normRmPrimaryUom,
  parseSpecificGravity,
  kgToRmPrimaryQty,
  rmPrimaryQtyToKg,
  procurementLineQtyIsCanonicalKg,
} = require('./rmUnitConversion');

/** Qty fields that originate from planning/BOM/procurement pipeline (kg-canonical). */
const PLANNING_KG_FIELDS = [
  'totalRequired',
  'unallocatedToBatches',
  'plannedQty',
  'poQty',
  'inTransitQty',
  'underGrn',
  'whQty',
  'totalReleased',
  'batchAllocatedQty',
  'totalOnPO',
  'totalReceived',
  // Reserved specifically for these PIs' batches (spec §6.3 supply term). Stored in KG on
  // reserved_batch_items, so it is kg→primary converted like the other RM qty fields.
  'scopedReserved',
];

/** Warehouse_inventory columns already stored in standard UoM — never kg→L converted. */
const WAREHOUSE_NATIVE_FIELDS = ['sih', 'reserved', 'inTransit', 'reorderPt', 'avgMo'];

function buildRmMetaMap(rmsList) {
  const map = new Map();
  for (const r of rmsList || []) {
    const plain = r.get ? r.get({ plain: true }) : r;
    const id = Number(plain.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    map.set(id, {
      uom: plain.uom,
      specific_gravity: plain.specific_gravity,
    });
  }
  return map;
}

function rmMetaForId(rmMetaById, rmId) {
  if (!rmMetaById) return null;
  const id = Number(rmId);
  return Number.isFinite(id) && id > 0 ? rmMetaById.get(id) : null;
}

function warehouseStorageUom(whUnit, rmMeta) {
  return normRmPrimaryUom(whUnit || rmMeta?.uom);
}

/** Warehouse row qty (standard UoM) → kg for planning gap / items-involved math. */
function warehouseNativeQtyToKg(qtyNative, whUnit, rmMeta) {
  const u = warehouseStorageUom(whUnit, rmMeta);
  const sg = parseSpecificGravity(rmMeta?.specific_gravity);
  return rmPrimaryQtyToKg(Number(qtyNative) || 0, u, sg);
}

/** Planning-canonical kg → RM master primary UoM for API/UI. */
function planningKgToPrimaryDisplay(qtyKg, rmMeta) {
  const primary = normRmPrimaryUom(rmMeta?.uom);
  const sg = parseSpecificGravity(rmMeta?.specific_gravity);
  return kgToRmPrimaryQty(Number(qtyKg) || 0, primary, sg);
}

/**
 * @param {object} line — PR/PO line
 * @param {{ uom?: string, specific_gravity?: number } | null} rmMeta
 */
function procurementOrPoLineQtyToKg(line, rmMeta) {
  const qty =
    Number(
      line.quantity_requested ??
        line.shortage ??
        line.required ??
        line.quantity ??
        line.qty ??
        line.poQty ??
        0
    ) || 0;
  if (!(qty > 0)) return 0;
  const primary = normRmPrimaryUom(rmMeta?.uom ?? line.unit);
  const sg = parseSpecificGravity(line.specific_gravity ?? rmMeta?.specific_gravity);
  if (procurementLineQtyIsCanonicalKg(line, primary)) return qty;
  return rmPrimaryQtyToKg(qty, line.unit ?? primary, sg);
}

/**
 * Build Items Involved RM API row: planning fields in primary UoM; warehouse fields in native WH UoM.
 * @param {object} rowKg — row with planning/pipeline numbers in kg
 * @param {{ uom?: string, specific_gravity?: number } | null} rmMeta
 * @param {{ sih: number, reserved: number, inTransit: number, reorderPt?: number, avgMo?: number, whUnit?: string }} warehouseNative
 */
function finalizeItemsInvolvedRmRow(rowKg, rmMeta, warehouseNative) {
  if (!rowKg || rowKg.type !== 'RM') return rowKg;
  const primary = normRmPrimaryUom(rmMeta?.uom ?? rowKg.unit);
  const whUnit = warehouseNative?.whUnit;
  const toDisplay = (kg) => planningKgToPrimaryDisplay(kg, rmMeta);

  const out = {
    ...rowKg,
    unit: primary,
    sih: Number(warehouseNative?.sih) || 0,
    reserved: Number(warehouseNative?.reserved) || 0,
    inTransit: Number(warehouseNative?.inTransit) || 0,
    reorderPt: Number(warehouseNative?.reorderPt ?? rowKg.reorderPt) || 0,
    avgMo: Number(warehouseNative?.avgMo ?? rowKg.avgMo) || 0,
  };

  for (const f of PLANNING_KG_FIELDS) {
    if (rowKg[f] == null || rowKg[f] === '') continue;
    out[f] = toDisplay(rowKg[f]);
  }

  const sihKg = warehouseNativeQtyToKg(out.sih, whUnit, rmMeta);
  const inTrKg = warehouseNativeQtyToKg(out.inTransit, whUnit, rmMeta);
  const reqKg = Number(rowKg.totalRequired) || 0;
  out.surplusShortage = toDisplay(sihKg + inTrKg - reqKg);

  if (rowKg.coverage != null) {
    const denom = reqKg;
    out.coverage =
      denom > 0 ? Math.min(100, Math.round(((sihKg + inTrKg) / denom) * 100)) : rowKg.coverage;
  }

  return out;
}

/** @deprecated Use finalizeItemsInvolvedRmRow */
function applyRmPrimaryDisplayToItemsInvolvedRow(row, rmMeta) {
  return finalizeItemsInvolvedRmRow(
    row,
    rmMeta,
    {
      sih: row.sih,
      reserved: row.reserved,
      inTransit: row.inTransit,
      reorderPt: row.reorderPt,
      avgMo: row.avgMo,
    }
  );
}

/** Pipeline totals (kg) → warehouse standard UoM for display columns. */
function warehousePipelineKgToDisplay(qtyKg, whUnit, masterUom, specificGravity) {
  const displayUnit = warehouseStorageUom(whUnit, { uom: masterUom });
  return kgToRmPrimaryQty(Number(qtyKg) || 0, displayUnit, parseSpecificGravity(specificGravity));
}

module.exports = {
  PLANNING_KG_FIELDS,
  WAREHOUSE_NATIVE_FIELDS,
  buildRmMetaMap,
  rmMetaForId,
  warehouseStorageUom,
  warehouseNativeQtyToKg,
  planningKgToPrimaryDisplay,
  procurementOrPoLineQtyToKg,
  finalizeItemsInvolvedRmRow,
  applyRmPrimaryDisplayToItemsInvolvedRow,
  warehousePipelineKgToDisplay,
};
