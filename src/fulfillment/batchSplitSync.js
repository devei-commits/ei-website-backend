/**
 * Shared production-batch <-> fulfillment_batch_splits sync, used by both controller.js
 * (listOrders/getOrderById — the Batches tab) and dashboardController.js (the SO list's
 * Batch Stage column), so both views agree on which production batches belong to an SO
 * the moment a batch is created, not only once someone happens to open the SO/Batches views.
 *
 * Split into its own module (rather than living in controller.js) so dashboardController.js
 * can call it without a circular require — controller.js already depends on dashboardController.js.
 */

const { Op } = require('sequelize');
const { ProductionBatch } = require('../production/models');
const { FulfillmentBatchSplit } = require('./models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const PlanningExtracted = require('../planningExtracted/models');
const { Product } = require('../products/models');

/**
 * FG units produced for a batch (from QC yields). Matches production applyBprFgReadyToInventory logic.
 * @param {object} plain production_batches row (plain object)
 * @returns {number|null}
 */
function resolveFgReadyProducedQty(plain) {
  if (!plain) return null;
  const fgYieldQty = Number(plain.fg_yield);
  const fillYieldQty = Number(plain.fill_yield);
  const plannedFallback = Math.max(0, parseInt(plain.batch_size || plain.order_qty || 0, 10) || 0);
  if (Number.isFinite(fgYieldQty) && fgYieldQty >= 0) return Math.max(0, Math.round(fgYieldQty * 1000) / 1000);
  if (Number.isFinite(fillYieldQty) && fillYieldQty > 0) return Math.max(0, Math.round(fillYieldQty * 1000) / 1000);
  return plannedFallback;
}

const PRODUCTION_BATCH_SYNC_ATTRS = ['id', 'so_no', 'bmr_no', 'bpr_no', 'sku', 'product_name', 'batch_size', 'order_qty', 'total_batches', 'bpr_status', 'fg_yield', 'fill_yield', 'planning_batch_id'];

/**
 * Resolve each production batch's Planning PR product_code (planning_batch_id -> planning_batches
 * -> planning_extracted -> products.product_code) — the authoritative link between a production
 * batch and the SO line it fulfills. A batch's own `sku` is `products.zoho_sku_code`, which can be
 * blank pre-Zoho-sync or simply differ from the SO line's cached product_code, so it is only a
 * fallback for matching, never the primary key.
 * @param {object[]} prodBatchPlains plain production_batches rows (each with planning_batch_id)
 * @returns {Promise<Map<number, string>>} production_batch.id -> product_code
 */
async function resolveProductCodesByProductionBatchId(prodBatchPlains) {
  const result = new Map();
  const planningBatchIds = [...new Set(prodBatchPlains.map((pb) => pb.planning_batch_id).filter(Boolean))];
  if (!planningBatchIds.length) return result;

  const planBatches = await PlanningBatch.findAll({
    where: { id: { [Op.in]: planningBatchIds } },
    attributes: ['id', 'planning_extracted_id'],
  });
  const peIdByPlanBatchId = new Map(planBatches.map((b) => [b.id, b.planning_extracted_id]).filter(([, peId]) => peId != null));

  const peIds = [...new Set([...peIdByPlanBatchId.values()])];
  const pes = peIds.length
    ? await PlanningExtracted.findAll({ where: { id: { [Op.in]: peIds } }, attributes: ['id', 'product_id'] })
    : [];
  const productIdByPeId = new Map(pes.map((pe) => [pe.id, pe.product_id]).filter(([, pid]) => pid != null));

  const productIds = [...new Set([...productIdByPeId.values()])];
  const products = productIds.length
    ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, attributes: ['product_id', 'product_code'] })
    : [];
  const codeByProductId = new Map(products.map((p) => [p.product_id, p.product_code]).filter(([, code]) => code));

  for (const pb of prodBatchPlains) {
    if (!pb.planning_batch_id) continue;
    const peId = peIdByPlanBatchId.get(pb.planning_batch_id);
    const productId = peId != null ? productIdByPeId.get(peId) : null;
    const code = productId != null ? codeByProductId.get(productId) : null;
    if (code) result.set(pb.id, code);
  }
  return result;
}

/**
 * Load production batches for many SOs in one query, grouped by so_no. Lets the list endpoint sync
 * N orders without running N separate batch queries. Each returned row is annotated with
 * `resolved_product_code` (see resolveProductCodesByProductionBatchId).
 * @param {string[]} soNos
 * @returns {Promise<Map<string, object[]>>}
 */
async function loadProductionBatchesBySoNo(soNos) {
  const map = new Map();
  const unique = [...new Set((soNos || []).filter(Boolean))];
  if (!unique.length) return map;
  const rows = await ProductionBatch.findAll({
    where: { so_no: { [Op.in]: unique } },
    attributes: PRODUCTION_BATCH_SYNC_ATTRS,
    order: [['batch_index', 'ASC'], ['id', 'ASC']],
  });
  const plains = rows.map((r) => (r.get ? r.get({ plain: true }) : r));
  const codeByBatchId = await resolveProductCodesByProductionBatchId(plains);
  for (const plain of plains) {
    plain.resolved_product_code = codeByBatchId.get(plain.id) || null;
    if (!map.has(plain.so_no)) map.set(plain.so_no, []);
    map.get(plain.so_no).push(plain);
  }
  return map;
}

/**
 * Ensure fulfillment has a batch split for every production batch linked to this SO (from Planning).
 * So the SO detail shows all batches and which are FG ready.
 * @param {object} orderRow fulfillment order (with `items` + `batchSplits` included)
 * @param {Map<string, object[]>|null} preloadedBatchesBySoNo pre-grouped batches, to avoid a per-order query
 * @returns {Promise<boolean>} true when any split row was created or updated
 */
async function syncOrderSplitsFromProduction(orderRow, preloadedBatchesBySoNo = null) {
  const d = orderRow.get ? orderRow.get({ plain: true }) : orderRow;
  const soNo = d.so_no;
  if (!soNo) return false;
  const orderId = d.id;
  const items = d.items || [];
  if (!items.length) return false;

  // On the list endpoint the caller pre-loads every SO's batches in one query (see loadProductionBatchesBySoNo)
  // so this stays a single query per request instead of one per order.
  const prodBatches = preloadedBatchesBySoNo
    ? (preloadedBatchesBySoNo.get(soNo) || [])
    : await loadProductionBatchesBySoNo([soNo]).then((m) => m.get(soNo) || []);
  if (!prodBatches.length) return false;

  // Tracks whether any row was actually written, so callers can skip a re-fetch when nothing changed.
  let changed = false;

  for (const item of items) {
    const itemSku = (item.sku || '').trim().toLowerCase();
    const itemProductCode = (item.product_code || '').trim().toLowerCase();
    const itemProductName = (item.product_name || '').trim().toLowerCase();
    const matchingBatches = prodBatches.filter((pb) => {
      // Authoritative: same Planning PR product_code. Only when both sides have one — a batch with
      // no planning_batch_id (created outside Planning) falls through to the sku/name match below.
      const pbCode = (pb.resolved_product_code || '').trim().toLowerCase();
      if (itemProductCode && pbCode) return itemProductCode === pbCode;
      const pbSku = (pb.sku || '').trim().toLowerCase();
      const pbName = (pb.product_name || '').trim().toLowerCase();
      return (itemSku && pbSku && itemSku === pbSku) || (itemProductName && pbName && (itemProductName === pbName || itemProductName.includes(pbName) || pbName.includes(itemProductName)));
    });

    // Used to avoid creating a 2nd split for the same production batch.
    const existingSplitBatchIds = new Set((item.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    // When SO was created before Planning created production batches, we create placeholder splits
    // with `production_batch_id = null`. Reuse those placeholders when the real batches arrive
    // so the split count doesn't inflate.
    const placeholderSplits = (item.batchSplits || []).filter((s) => !s.production_batch_id);

    for (const pb of matchingBatches) {
      const plain = pb.get ? pb.get({ plain: true }) : pb;
      if (existingSplitBatchIds.has(plain.id)) continue;

      const plannedQty = Math.max(0, Number(plain.batch_size) || 0) || Math.max(0, Math.floor((Number(plain.order_qty) || 0) / (Number(plain.total_batches) || 1)));
      const isFgReady = plain.bpr_status === 'fg_ready';
      const producedQty = isFgReady ? resolveFgReadyProducedQty(plain) : 0;
      const fgQty = isFgReady ? Math.min(plannedQty, producedQty) : 0;

      // Prefer updating an existing placeholder split (production_batch_id is null) to avoid duplicates.
      const placeholder = placeholderSplits.shift();
      if (placeholder && placeholder.id != null) {
        await FulfillmentBatchSplit.update(
          {
            production_batch_id: plain.id,
            bmr_no: plain.bmr_no || '',
            bpr_no: plain.bpr_no || '',
            planned_qty: plannedQty,
            fg_qty: fgQty,
            ff_status: isFgReady ? 'fg_ready' : 'fg_pending',
          },
          { where: { id: placeholder.id } }
        );
        changed = true;
      } else {
        await FulfillmentBatchSplit.create({
          fulfillment_order_item_id: item.id,
          fulfillment_order_id: orderId,
          production_batch_id: plain.id,
          bmr_no: plain.bmr_no || '',
          bpr_no: plain.bpr_no || '',
          planned_qty: plannedQty,
          fg_qty: fgQty,
          ff_status: isFgReady ? 'fg_ready' : 'fg_pending',
        });
        changed = true;
      }
      existingSplitBatchIds.add(plain.id);
    }
  }

  // Backfill fg_qty on existing splits that have production_batch_id but fg_qty 0 when the batch is already fg_ready
  // (e.g. split was created by sync after BPR was already marked fg_ready, so applyBprFgReadyToInventory never ran for it)
  const batchIdToProduced = {};
  prodBatches.forEach((pb) => {
    const plain = pb.get ? pb.get({ plain: true }) : pb;
    if (plain.bpr_status === 'fg_ready') {
      batchIdToProduced[plain.id] = resolveFgReadyProducedQty(plain);
    }
  });
  const batchIdsToBackfill = Object.keys(batchIdToProduced).map(Number).filter(Boolean);
  if (batchIdsToBackfill.length === 0) return changed;

  // Single read of every fg_ready split for this order — reused by both the backfill and the
  // repair pass below (the repair pass used to re-query once per production batch).
  const existingSplits = await FulfillmentBatchSplit.findAll({
    where: { fulfillment_order_id: orderId, production_batch_id: batchIdsToBackfill },
    order: [['production_batch_id', 'ASC'], ['id', 'ASC']],
  });
  const splitsWithZeroFg = existingSplits.filter((s) => !(Number(s.fg_qty) > 0));
  if (splitsWithZeroFg.length === 0) return changed;

  let remainingByBatch = { ...batchIdToProduced };
  for (const split of splitsWithZeroFg) {
    const bid = split.production_batch_id;
    const produced = remainingByBatch[bid];
    if (produced == null || produced <= 0) continue;
    const planned = Number(split.planned_qty) || 0;
    const qty = Math.min(planned, produced);
    if (qty > 0) {
      await split.update({ fg_qty: qty, ff_status: 'fg_ready' });
      remainingByBatch[bid] = produced - qty;
      changed = true;
    }
  }

  // Repair splits that still store planned qty while production QC yields are lower (or higher).
  // `existingSplits` instances were mutated in place by the backfill above, so their fg_qty is current.
  const splitsByBatchId = new Map();
  for (const split of existingSplits) {
    const bid = split.production_batch_id;
    if (!splitsByBatchId.has(bid)) splitsByBatchId.set(bid, []);
    splitsByBatchId.get(bid).push(split);
  }
  for (const pb of prodBatches) {
    const plain = pb.get ? pb.get({ plain: true }) : pb;
    if (plain.bpr_status !== 'fg_ready') continue;
    const produced = resolveFgReadyProducedQty(plain);
    if (!(produced >= 0)) continue;
    for (const split of splitsByBatchId.get(plain.id) || []) {
      const planned = Number(split.planned_qty) || 0;
      const correct = Math.min(planned > 0 ? planned : produced, produced);
      const stored = Number(split.fg_qty) || 0;
      if (correct >= 0 && stored !== correct) {
        await split.update({ fg_qty: correct, ff_status: 'fg_ready' });
        changed = true;
      }
    }
  }
  return changed;
}

module.exports = {
  resolveFgReadyProducedQty,
  PRODUCTION_BATCH_SYNC_ATTRS,
  loadProductionBatchesBySoNo,
  syncOrderSplitsFromProduction,
};
