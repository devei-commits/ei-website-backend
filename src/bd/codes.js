/**
 * BD human-readable code helpers — MTG-YYYY-NNNN / QRY-YYYY-NNNN / GRV-YYYY-NNNN.
 *
 * Uses the established "insert-then-derive from autoincrement id" pattern
 * (cf. src/grn/shipmentBatchController.js) to avoid max-suffix race conditions.
 * Phase 1 doesn't mint coded entities (events are uncoded); these are ready for
 * the Phase 2 meetings/queries/grievances build.
 */
function pad4(n) { return String(n).padStart(4, '0'); }
function yearOf(date = new Date()) { return new Date(date).getFullYear(); }

/**
 * Assign `PREFIX-YYYY-NNNN` to `field` on a freshly-created instance, deriving
 * NNNN from its autoincrement id. Call inside the same transaction as create().
 * @param {import('sequelize').Model} instance
 * @param {string} prefix  e.g. 'MTG'
 * @param {string} field   e.g. 'code'
 * @param {{ transaction?: import('sequelize').Transaction, year?: number }} [opts]
 */
async function assignSequentialCode(instance, prefix, field, opts = {}) {
  const year = opts.year || yearOf();
  instance[field] = `${prefix}-${year}-${pad4(instance.id)}`;
  await instance.save({ transaction: opts.transaction });
  return instance[field];
}

module.exports = { pad4, yearOf, assignSequentialCode };
