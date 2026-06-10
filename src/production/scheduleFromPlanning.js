/**
 * Seed production batch stage dates from Planning planned_start_date.
 * Mirrors frontend productionScheduleMath offsets (MFG → Fill +3d → Pack +1d → FG +1d).
 */

/** Days between MFG start dates for multi-batch SOs (B-01, B-02, …). */
const MFG_STAGGER_DAYS_PER_BATCH = 7;

function normalizeIsoDateOnly(d) {
  if (!d) return null;
  const s = String(d).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function addDaysToDateStr(dateStr, n) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** Derive fill, pack, fg, rm, pm dates from mfg date (fixed offsets). */
function deriveScheduleDatesFromMfg(mfgDate) {
  const fillDate = addDaysToDateStr(mfgDate, 3);
  const packDate = addDaysToDateStr(fillDate, 1);
  const fgDate = addDaysToDateStr(packDate, 1);
  const rmConnectDate = addDaysToDateStr(mfgDate, -2);
  const pmConnectDate = addDaysToDateStr(fillDate, -2);
  return { fillDate, packDate, fgDate, rmConnectDate, pmConnectDate };
}

function mfgDateForBatchSequence(plannedStartDate, sequence) {
  const base = normalizeIsoDateOnly(plannedStartDate);
  if (!base) return null;
  const seq = Math.max(1, Number(sequence) || 1);
  return addDaysToDateStr(base, (seq - 1) * MFG_STAGGER_DAYS_PER_BATCH);
}

function batchPlainForOccupancy(row) {
  const d = row?.get ? row.get({ plain: true }) : row;
  return {
    mainVessel: d.main_vessel || '',
    mfgDate: d.mfg_date || '',
    fillingLine: d.filling_line || '',
    fillDate: d.fill_date || '',
    packagingLine: d.packaging_line || '',
    packDate: d.pack_date || '',
    bmrNo: d.bmr_no || '',
  };
}

function isEquipmentFreeOnDate(batches, equipId, dateStr, excludeBmrNo) {
  if (!equipId || !dateStr) return false;
  return !batches.some((b) => {
    const plain = batchPlainForOccupancy(b);
    if (excludeBmrNo && plain.bmrNo === excludeBmrNo) return false;
    return (
      (plain.mainVessel === equipId && plain.mfgDate === dateStr)
      || (plain.fillingLine === equipId && plain.fillDate === dateStr)
      || (plain.packagingLine === equipId && plain.packDate === dateStr)
    );
  });
}

function getFirstFreeEquipment(equipIds, dateStr, batches, excludeBmrNo) {
  for (const id of equipIds) {
    if (isEquipmentFreeOnDate(batches, id, dateStr, excludeBmrNo)) return id;
  }
  return equipIds[0] || '';
}

function groupEquipmentIds(equipmentGrouped) {
  const mfg = (equipmentGrouped?.manufacturing ?? [])
    .filter((e) => e.type !== 'support')
    .map((e) => e.id);
  const fill = (equipmentGrouped?.filling ?? []).map((e) => e.id);
  const pack = (equipmentGrouped?.packaging ?? []).map((e) => e.id);
  return { mfg, fill, pack };
}

/**
 * Build schedule patch from planning row. Returns null when batch already scheduled or plan has no start date.
 */
function buildSchedulePatchFromPlanning(planPlain, sequence, batchRow, allBatches, equipmentGrouped) {
  const row = batchRow?.get ? batchRow.get({ plain: true }) : batchRow;
  if (!row) return null;
  if (normalizeIsoDateOnly(row.mfg_date)) return null;

  const mfgDate = mfgDateForBatchSequence(planPlain?.planned_start_date, sequence);
  if (!mfgDate) return null;

  const dates = deriveScheduleDatesFromMfg(mfgDate);
  const { mfg, fill, pack } = groupEquipmentIds(equipmentGrouped);
  const bmrNo = row.bmr_no || '';
  const occupancy = Array.isArray(allBatches) ? allBatches : [];

  return {
    mfg_date: mfgDate,
    fill_date: dates.fillDate,
    pack_date: dates.packDate,
    fg_date: dates.fgDate,
    rm_connect_date: dates.rmConnectDate,
    pm_connect_date: dates.pmConnectDate,
    main_vessel: getFirstFreeEquipment(mfg, mfgDate, occupancy, bmrNo) || null,
    filling_line: getFirstFreeEquipment(fill, dates.fillDate, occupancy, bmrNo) || null,
    packaging_line: getFirstFreeEquipment(pack, dates.packDate, occupancy, bmrNo) || null,
  };
}

module.exports = {
  MFG_STAGGER_DAYS_PER_BATCH,
  addDaysToDateStr,
  deriveScheduleDatesFromMfg,
  mfgDateForBatchSequence,
  buildSchedulePatchFromPlanning,
  isEquipmentFreeOnDate,
};
