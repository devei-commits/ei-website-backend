// ─────────────────────────────────────────────────────────────
// CONFIG LOADER
// Batch-loads the quote_* configuration tables for a calculation
// request. Overhead resolution merges the global 'all' baseline with
// category-specific overrides at the head level, so a category can
// override some heads and inherit the rest.
// ─────────────────────────────────────────────────────────────
const {
  QuoteOverhead,
  QuoteProcurementRule,
  QuoteManufacturingRule,
  QuoteQcRule,
  QuoteDispatchConfig,
} = require('./models');

function plain(rows) { return rows.map(r => (r.get ? r.get({ plain: true }) : r)); }

/**
 * Load timeline rules (procurement / manufacturing / qc / dispatch) in one shot.
 * @returns {Promise<{procurementRules, manufacturingRules, qcRules, dispatchConfig}>}
 */
async function loadTimelineConfig() {
  const [procurementRules, manufacturingRules, qcRules, dispatchConfig] = await Promise.all([
    QuoteProcurementRule.findAll({ order: [['sort_order', 'ASC']] }),
    QuoteManufacturingRule.findAll(),
    QuoteQcRule.findAll(),
    QuoteDispatchConfig.findAll(),
  ]);
  return {
    procurementRules: plain(procurementRules),
    manufacturingRules: plain(manufacturingRules),
    qcRules: plain(qcRules),
    dispatchConfig: plain(dispatchConfig),
  };
}

/**
 * Resolve overhead rows for a product category. Starts from the 'all'
 * baseline and overlays any category-specific heads on top.
 * @param {string} productCategory - 'serum' | 'emulsion' | ... | 'all'
 * @returns {Promise<Array<{head_name, band_values, product_category}>>}
 */
async function loadOverheadRows(productCategory) {
  const cats = productCategory && productCategory !== 'all' ? ['all', productCategory] : ['all'];
  const rows = plain(await QuoteOverhead.findAll({
    where: { product_category: cats },
    order: [['sort_order', 'ASC']],
  }));
  const byHead = new Map();
  // 'all' first so category-specific entries overwrite per head.
  for (const r of rows.filter(r => r.product_category === 'all')) byHead.set(r.head_name, r);
  for (const r of rows.filter(r => r.product_category !== 'all')) byHead.set(r.head_name, r);
  return [...byHead.values()];
}

module.exports = { loadTimelineConfig, loadOverheadRows };
