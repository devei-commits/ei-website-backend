// ─────────────────────────────────────────────────────────────
// Idempotent baseline seed for the quotation engine config tables.
// Called once per boot (after db.sync). Each table is seeded only when
// empty, so it is safe to run on every restart and never overwrites
// admin edits.
// ─────────────────────────────────────────────────────────────
const {
  QuoteGrade,
  QuoteOverhead,
  QuoteProcurementRule,
  QuoteManufacturingRule,
  QuoteQcRule,
  QuoteDispatchConfig,
} = require('./models');

const G12_LABELS = ['500', '1,000', '2,500', '5,000', '10,000', '15,000', '25,000'];
const G12_VALUES = [500, 1000, 2500, 5000, 10000, 15000, 25000];
const G12_BMAP = [
  { b: '1-1000', f: 1.05 }, { b: '1-1000', f: 1.00 },
  { b: '1000-5000', f: 1.05 }, { b: '1000-5000', f: 1.00 },
  { b: '5000-10000', f: 1.00 }, { b: '10000+', f: 1.00 }, { b: '10000+', f: 0.92 },
];

const SYSTEM_GRADES = [
  {
    name: 'Grade 1 — Standard', description: 'Full-service, MOQ 500–25K',
    moq_labels: G12_LABELS, moq_values: G12_VALUES,
    markups: [0.70, 0.65, 0.60, 0.55, 0.50, 0.45, 0.40],
    zero_pm: false, bmap: G12_BMAP, qc_days: 5, is_system: true, grade_ref: 'system_1',
  },
  {
    name: 'Grade 2 — Moderate', description: 'Moderate margin (40→15%), MOQ 500–25K',
    moq_labels: G12_LABELS, moq_values: G12_VALUES,
    markups: [0.40, 0.35, 0.32, 0.28, 0.25, 0.20, 0.15],
    zero_pm: false, bmap: G12_BMAP, qc_days: 7, is_system: true, grade_ref: 'system_2',
  },
  {
    name: 'Grade 3 — Customer PPM', description: 'Customer supplies PM, margin 50→20%, MOQ 2K–50K',
    moq_labels: ['2,000', '5,000', '10,000', '15,000', '25,000', '35,000', '50,000'],
    moq_values: [2000, 5000, 10000, 15000, 25000, 35000, 50000],
    markups: [0.50, 0.45, 0.40, 0.35, 0.30, 0.25, 0.20],
    zero_pm: true,
    bmap: [
      { b: '1000-5000', f: 1.05 }, { b: '1000-5000', f: 1.00 },
      { b: '5000-10000', f: 1.00 }, { b: '10000+', f: 1.00 },
      { b: '10000+', f: 0.95 }, { b: '10000+', f: 0.92 }, { b: '10000+', f: 0.88 },
    ],
    qc_days: 10, is_system: true, grade_ref: 'system_3',
  },
];

// 15 overhead heads × 7 base MOQ bands (category 'all' baseline).
const OVERHEAD_HEADS = [
  ['In-Process QC',          [0.80, 0.70, 0.55, 0.45, 0.35, 0.30, 0.25]],
  ['Final Product Testing',  [0.50, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15]],
  ['Stability & Micro Test', [0.40, 0.35, 0.25, 0.20, 0.15, 0.12, 0.10]],
  ['Material Handling',      [0.50, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15]],
  ['Warehousing & Storage',  [0.50, 0.40, 0.30, 0.25, 0.20, 0.15, 0.12]],
  ['Dispatch & Loading',     [0.35, 0.30, 0.25, 0.20, 0.15, 0.12, 0.10]],
  ['GMP / ISO Compliance',   [0.25, 0.20, 0.15, 0.12, 0.10, 0.08, 0.06]],
  ['Batch Documentation',    [0.20, 0.18, 0.15, 0.12, 0.10, 0.08, 0.06]],
  ['CoA & Regulatory',       [0.15, 0.12, 0.10, 0.08, 0.06, 0.05, 0.04]],
  ['Working Capital Cost',   [0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.12]],
  ['Insurance',              [0.15, 0.12, 0.10, 0.08, 0.06, 0.05, 0.04]],
  ['Admin & IT',             [0.20, 0.18, 0.15, 0.12, 0.10, 0.08, 0.06]],
  ['In-Process Rejection',   [0.35, 0.30, 0.25, 0.20, 0.15, 0.12, 0.10]],
  ['Sampling & Retention',   [0.20, 0.18, 0.15, 0.12, 0.10, 0.08, 0.06]],
  ['Consumables',            [0.15, 0.12, 0.10, 0.08, 0.06, 0.05, 0.04]],
];

const RM_PROCUREMENT = [
  ['Pre-mixed Bases', 21, 18], ['CLUB Items', 14, 12], ['Club Items', 14, 12],
  ['Bulk Raw Materials', 12, 10], ['Bulk raw materials', 12, 10], ['Raw Materials', 12, 10],
  ['Solvents & Carriers', 10, 8], ['DEFAULT', 12, 10],
];
const PM_PROCUREMENT = [
  ['Packaging - Primary', 18, 15], ['Shrink Sleeves', 16, 14], ['Monocartons', 12, 10],
  ['Packaging - Secondary', 12, 10], ['Packing Material', 10, 9], ['Other Components', 10, 9],
  ['Labels', 9, 7], ['Stickers & Kits', 9, 7], ['DEFAULT', 12, 10],
];

const MFG_DAYS = {
  serum:    [2, 2, 3, 4, 5, 7, 8],
  emulsion: [1, 2, 2, 3, 4, 6, 7],
  wash:     [1, 1, 2, 2, 3, 4, 5],
  gel:      [1, 1, 2, 3, 4, 5, 6],
  general:  [1, 2, 2, 3, 4, 5, 6],
};

const QC_RULES = [['system_1', 5], ['system_2', 7], ['system_3', 10], ['default', 7]];
const DISPATCH = [['default', 2]];

async function seedTable(Model, count, buildRows, label) {
  const n = await Model.count();
  if (n > 0) return;
  await Model.bulkCreate(buildRows());
  console.log(`[quotations] Seeded ${label}.`);
}

async function seedQuotationDefaults() {
  try {
    await seedTable(QuoteGrade, null, () =>
      SYSTEM_GRADES.map(g => ({ ...g })), 'system grades');

    await seedTable(QuoteOverhead, null, () =>
      OVERHEAD_HEADS.map(([head_name, band_values], i) => ({
        product_category: 'all', head_name, band_values, sort_order: i,
      })), 'overhead baseline (category=all)');

    await seedTable(QuoteProcurementRule, null, () => [
      ...RM_PROCUREMENT.map(([cat, ind, batch], i) => ({
        material_type: 'RM', category_or_material: cat, individual_lead_days: ind, batch_lead_days: batch, sort_order: i,
      })),
      ...PM_PROCUREMENT.map(([mat, ind, batch], i) => ({
        material_type: 'PM', category_or_material: mat, individual_lead_days: ind, batch_lead_days: batch, sort_order: i,
      })),
    ], 'procurement rules');

    await seedTable(QuoteManufacturingRule, null, () => {
      const rows = [];
      for (const [type, days] of Object.entries(MFG_DAYS)) {
        days.forEach((d, band) => rows.push({
          product_type: type, product_subtype: '', band_index: band, manufacturing_days: d, cycle_time_days: null,
        }));
      }
      return rows;
    }, 'manufacturing rules');

    await seedTable(QuoteQcRule, null, () =>
      QC_RULES.map(([grade_ref, qc_days]) => ({ grade_ref, qc_days })), 'QC rules');

    await seedTable(QuoteDispatchConfig, null, () =>
      DISPATCH.map(([grade_ref, dispatch_days]) => ({ grade_ref, dispatch_days })), 'dispatch config');
  } catch (err) {
    console.error('[quotations] seedQuotationDefaults failed:', err && err.message ? err.message : err);
  }
}

module.exports = { seedQuotationDefaults };
