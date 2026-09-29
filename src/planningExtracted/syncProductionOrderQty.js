/**
 * Keep production_batches.order_qty in step with its planning line's order quantity.
 *
 * Production copies the line's order qty onto each batch when Planning sends it, and never looks
 * back — so editing an SO's quantity afterwards (e.g. 9,613 -> 8,413) left every already-sent batch
 * carrying the old figure, and anything reading it (Production, the Fulfillment "Planned" column)
 * showed a quantity that no longer existed in Planning.
 *
 * order_qty is not always the whole line: a vessel/remainder split stores each half's share. So the
 * update scales every batch by the same factor (new ÷ old line qty) instead of overwriting it —
 * a whole-line batch becomes exactly the new qty, and split shares keep their proportion.
 */
'use strict';

const { Op } = require('sequelize');
const { ProductionBatch } = require('../production/models');
const PlanningBatch = require('./planningBatchModel');
const { activeRowWhere } = require('../lib/softDelete');

/** "8413 units" -> 8413. Keeps the decimal point so "154.4 units" doesn't read as 1544. */
function parseOrderUnits(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} planningExtractedId
 * @param {string|number} prevOrderQty order_qty_display (or number) before the change
 * @param {string|number} nextOrderQty order_qty_display (or number) after the change
 * @returns {Promise<number>} production batches updated
 */
async function syncProductionOrderQtyForPlanningLine(planningExtractedId, prevOrderQty, nextOrderQty) {
  const prev = parseOrderUnits(prevOrderQty);
  const next = parseOrderUnits(nextOrderQty);
  if (!planningExtractedId || !(prev > 0) || !(next > 0) || prev === next) return 0;

  const planBatches = await PlanningBatch.findAll({
    where: { planning_extracted_id: planningExtractedId },
    attributes: ['id'],
  });
  const planningBatchIds = planBatches.map((b) => b.id);
  if (!planningBatchIds.length) return 0;

  const prodBatches = await ProductionBatch.findAll({
    where: activeRowWhere({ planning_batch_id: { [Op.in]: planningBatchIds } }),
  });
  const factor = next / prev;
  let updated = 0;
  for (const pb of prodBatches) {
    // A batch that already reached FG is a finished record — leave its figures as produced.
    if (String(pb.get('bpr_status') || '').toLowerCase() === 'fg_ready') continue;
    const current = Number(pb.get('order_qty')) || 0;
    // Nothing stored yet: the batch is taken to cover the whole line, as a normal send does.
    const scaled = current > 0 ? Math.max(0, Math.round(current * factor)) : Math.round(next);
    if (scaled === current) continue;
    await pb.update({ order_qty: scaled });
    updated += 1;
  }
  return updated;
}

module.exports = { syncProductionOrderQtyForPlanningLine, parseOrderUnits };
