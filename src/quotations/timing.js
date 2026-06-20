// ─────────────────────────────────────────────────────────────
// EI TIME ESTIMATION ENGINE (DB-driven)
// All numeric rules (procurement / manufacturing / QC / dispatch)
// now come from the quote_* config tables, passed in as parameters.
// Only product-type keyword detection stays in code (most stable part).
//
// Total = max(RM procurement, PM procurement)   (parallel sourcing)
//       + manufacturing (product type × MOQ band)
//       + QC (grade)
//       + dispatch
// ─────────────────────────────────────────────────────────────

const DEFAULT_PROCUREMENT_DAYS = 12;
const DEFAULT_MFG_DAYS = 3;
const DEFAULT_QC_DAYS = 7;
const DEFAULT_DISPATCH_DAYS = 2;

// Product type detection from BOM name (first keyword hit wins).
const TYPE_KEYWORDS = [
  ['serum',    ['SERUM', 'CONCENTRATE', 'CONC', 'AMPOULE']],
  ['wash',     ['SHAMPOO', 'WASH', 'CLEANSER', 'CONDITIONER']],
  ['emulsion', ['CREAM', 'LOTION', 'MOISTURISER', 'MOISTURIZER']],
  ['gel',      ['GEL', 'TONER', 'ESSENCE']],
];

function detectProductType(bomName) {
  const s = String(bomName || '').toUpperCase();
  for (const [type, words] of TYPE_KEYWORDS) {
    if (words.some(w => s.includes(w))) return type;
  }
  return 'general';
}

// ── Procurement: one lead value per material line ──
function lineLeadDays(line, rules, useBatch) {
  // 1. Real DB lead_time_days on the material wins (hybrid mode).
  const lt = parseInt(line && line.lead_time_days);
  if (Number.isFinite(lt) && lt > 0) return lt;
  // 2. Else look up the procurement rule by category (RM) / material (PM).
  const key = line && (line._procKey != null ? line._procKey : '');
  const rule = rules.byKey.get(String(key)) || rules.byKey.get('DEFAULT');
  if (!rule) return DEFAULT_PROCUREMENT_DAYS;
  const batch = rule.batch_lead_days;
  if (useBatch && Number.isFinite(parseInt(batch)) && parseInt(batch) > 0) return parseInt(batch);
  return parseInt(rule.individual_lead_days) || DEFAULT_PROCUREMENT_DAYS;
}

function indexProcurementRules(procurementRules) {
  const rm = { byKey: new Map() };
  const pm = { byKey: new Map() };
  for (const r of procurementRules || []) {
    const target = String(r.material_type).toUpperCase() === 'PM' ? pm : rm;
    target.byKey.set(String(r.category_or_material), r);
  }
  return { rm, pm };
}

function procurementDays(rmLines, pmLines, procIndex, useBatch) {
  let max = 0;
  let usedReal = false;
  for (const l of rmLines || []) {
    if (Number.isFinite(parseInt(l && l.lead_time_days)) && parseInt(l.lead_time_days) > 0) usedReal = true;
    const d = lineLeadDays({ ...l, _procKey: l.category }, procIndex.rm, useBatch);
    if (d > max) max = d;
  }
  for (const l of pmLines || []) {
    if (Number.isFinite(parseInt(l && l.lead_time_days)) && parseInt(l.lead_time_days) > 0) usedReal = true;
    const d = lineLeadDays({ ...l, _procKey: l.material }, procIndex.pm, useBatch);
    if (d > max) max = d;
  }
  if (max === 0) max = DEFAULT_PROCUREMENT_DAYS;
  return { days: max, source: usedReal ? 'db+rule' : 'rule' };
}

// ── Manufacturing: lookup product_type [+ subtype] × band ──
function manufacturingForBand(mfgRules, productType, productSubtype, bandIndex) {
  const subtype = productSubtype || '';
  const match = (type, sub) => (mfgRules || []).find(r =>
    r.product_type === type &&
    (r.product_subtype || '') === sub &&
    parseInt(r.band_index) === bandIndex
  );
  // 1. exact type+subtype  2. type base ('')  3. general base
  const row = (subtype && match(productType, subtype)) || match(productType, '') || match('general', '');
  if (!row) return { manufacturing: DEFAULT_MFG_DAYS, cycle: DEFAULT_MFG_DAYS };
  const mfg = parseInt(row.manufacturing_days);
  const cycle = Number.isFinite(parseInt(row.cycle_time_days)) ? parseInt(row.cycle_time_days) : mfg;
  return { manufacturing: Number.isFinite(mfg) ? mfg : DEFAULT_MFG_DAYS, cycle };
}

// ── QC: grade override → grade_ref rule → default ──
function qcForGrade(qcRules, gradeRef, gradeQcOverride) {
  if (Number.isFinite(parseInt(gradeQcOverride)) && parseInt(gradeQcOverride) > 0) return parseInt(gradeQcOverride);
  const byRef = new Map((qcRules || []).map(r => [r.grade_ref, parseInt(r.qc_days)]));
  if (byRef.has(gradeRef)) return byRef.get(gradeRef);
  if (byRef.has('default')) return byRef.get('default');
  return DEFAULT_QC_DAYS;
}

// ── Dispatch: grade_ref override → default ──
function dispatchForGrade(dispatchConfig, gradeRef) {
  const byRef = new Map((dispatchConfig || []).map(r => [r.grade_ref, parseInt(r.dispatch_days)]));
  if (byRef.has(gradeRef)) return byRef.get(gradeRef);
  if (byRef.has('default')) return byRef.get('default');
  return DEFAULT_DISPATCH_DAYS;
}

/**
 * Estimate the delivery timeline for one MOQ band.
 *
 * @param {object} args
 * @param {string} args.bomName
 * @param {Array}  args.rmLines           [{category, lead_time_days}]
 * @param {Array}  args.pmLines           [{material, lead_time_days}]
 * @param {number} args.bandIndex         0..6
 * @param {boolean} args.useBatchLead
 * @param {string} args.gradeRef          'system_1' | custom grade_ref
 * @param {number|null} args.gradeQcOverride  quote_grades.qc_days (optional)
 * @param {string} [args.productSubtype]
 * @param {object} args.config            { procurementRules, manufacturingRules, qcRules, dispatchConfig }
 */
function estimateTimeline({ bomName, rmLines, pmLines, bandIndex, useBatchLead = false, gradeRef, gradeQcOverride = null, productSubtype = '', config }) {
  const { procurementRules = [], manufacturingRules = [], qcRules = [], dispatchConfig = [] } = config || {};
  const productType = detectProductType(bomName);
  const idx = Math.max(0, Math.min(6, parseInt(bandIndex) || 0));

  const procIndex = indexProcurementRules(procurementRules);
  const proc = procurementDays(rmLines, pmLines, procIndex, useBatchLead);
  const { manufacturing, cycle } = manufacturingForBand(manufacturingRules, productType, productSubtype, idx);
  const qc = qcForGrade(qcRules, gradeRef, gradeQcOverride);
  const dispatch = dispatchForGrade(dispatchConfig, gradeRef);
  const total = proc.days + manufacturing + qc + dispatch;

  return {
    procurement: proc.days,
    manufacturing,
    cycle_time: cycle,
    qc,
    dispatch,
    total,
    weeks: Math.ceil(total / 7),
    product_type: productType,
    procurement_source: proc.source,
  };
}

module.exports = { estimateTimeline, detectProductType };
