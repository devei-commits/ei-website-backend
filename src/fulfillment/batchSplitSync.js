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
const SalesOrder = require('../salesOrders/models');
const { softDeleteWhere, activeRowWhere } = require('../lib/softDelete');

const norm = (v) => String(v ?? '').trim().toLowerCase();

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

/** Fulfillment lifecycle stages past fg_ready — production-side sync must never rewrite these. */
const TERMINAL_FF_STATUSES = ['invoiced', 'shipped', 'delivered', 'closed'];

/** Parse a display string like "1,000.00 kg" (planning_extracted.total_kg_display) into a plain number. */
function parseKgDisplay(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pack qty a batch is planned to yield — the same math as the Planning "Batches" table's "Planned
 * Qty" column (batchUnitsFromSize): the PLANNING batch's size_kg through the planning line's
 * kg-per-unit ratio (total_kg / order_qty). All three come from Planning, the source of truth;
 * production_batches.batch_size / order_qty are snapshots taken at send time and can be stale
 * (e.g. an SO qty edit left 100 KG / 8,413 units showing as 9,613). They are only fallbacks.
 * @param {object} plain production_batches row, annotated by loadProductionBatchesBySoNo
 * @returns {number}
 */
function computeBatchPlannedPacks(plain) {
  const orderUnits = Number(plain.resolved_order_units) || Number(plain.order_qty) || 0;
  const totalKg = Number(plain.resolved_total_kg) || 0;
  const sizeKg = Number(plain.resolved_size_kg) || Number(plain.batch_size) || 0;
  if (orderUnits > 0 && totalKg > 0 && sizeKg > 0) {
    const kgPerUnit = totalKg / orderUnits;
    if (kgPerUnit > 0) return Math.max(0, Math.round(sizeKg / kgPerUnit));
  }
  return Math.max(0, Math.floor(orderUnits / (Number(plain.total_batches) || 1))) || Math.max(0, sizeKg);
}

/**
 * Load the production batches that belong to each SO — resolved THROUGH PLANNING, which is the
 * single source of truth: sales_orders -> active planning_extracted lines -> planning_batches ->
 * the production batch sent for each planning batch. Grouped by so_no, one pass for many SOs.
 *
 * Reading production_batches by so_no instead surfaced batches Planning no longer has: stale
 * leftovers still carrying the SO number, and batches linked to the wrong planning line (SO-00032:
 * a KIT batch pointing at the non-KIT line's planning batch showed on both lines).
 *
 * Exactly one production batch is kept per planning batch — the one whose sku is the planning
 * line's product (or blank); extra/mismatched ones are ignored. Each kept row is annotated with the
 * planning line's product code/name, total kg, order units, and the planning batch's size_kg.
 * @param {string[]} soNos
 * @returns {Promise<Map<string, object[]>>}
 */
async function loadProductionBatchesBySoNo(soNos) {
  const map = new Map();
  const unique = [...new Set((soNos || []).filter(Boolean))];
  if (!unique.length) return map;

  const sos = await SalesOrder.findAll({ where: activeRowWhere({ order_id: { [Op.in]: unique } }), attributes: ['id', 'order_id'] });
  if (!sos.length) return map;
  const soNoBySoId = new Map(sos.map((s) => [s.id, s.order_id]));
  // Every resolved SO gets an entry, even with no batches: "Planning has nothing" is an answer
  // (its splits get unlinked), distinct from "SO unknown" (no entry — left untouched).
  for (const soNo of soNoBySoId.values()) map.set(soNo, []);

  const pes = await PlanningExtracted.findAll({
    where: activeRowWhere({ sales_order_id: { [Op.in]: [...soNoBySoId.keys()] } }),
    attributes: ['id', 'sales_order_id', 'product_id', 'total_kg_display', 'order_qty_display'],
    include: [{ model: Product, as: 'product', attributes: ['product_code', 'zoho_sku_code', 'product_name'], required: false }],
  });
  if (!pes.length) return map;
  const peById = new Map(pes.map((pe) => [pe.id, pe.get({ plain: true })]));

  const planBatches = await PlanningBatch.findAll({
    where: { planning_extracted_id: { [Op.in]: [...peById.keys()] } },
    attributes: ['id', 'planning_extracted_id', 'sequence', 'size_kg'],
    order: [['planning_extracted_id', 'ASC'], ['sequence', 'ASC']],
  });
  if (!planBatches.length) return map;

  const prodRows = await ProductionBatch.findAll({
    where: activeRowWhere({ planning_batch_id: { [Op.in]: planBatches.map((b) => b.id) } }),
    attributes: PRODUCTION_BATCH_SYNC_ATTRS,
    order: [['id', 'ASC']],
  });
  const prodByPlanBatchId = new Map();
  for (const r of prodRows) {
    const plain = r.get({ plain: true });
    if (!prodByPlanBatchId.has(plain.planning_batch_id)) prodByPlanBatchId.set(plain.planning_batch_id, []);
    prodByPlanBatchId.get(plain.planning_batch_id).push(plain);
  }

  for (const plb of planBatches) {
    const pe = peById.get(plb.planning_extracted_id);
    const product = pe.product || {};
    const lineCodes = new Set([norm(product.product_code), norm(product.zoho_sku_code)].filter(Boolean));
    // Of the batches sent for this planning batch, the real one is the line's product and the size
    // Planning set; older re-sends are left behind at other sizes (SO-00085: 97 kg vs 420 kg for a
    // 97.2 kg plan). Ties go to the oldest.
    const planKg = Number(plb.size_kg) || 0;
    const chosen = (prodByPlanBatchId.get(plb.id) || [])
      .filter((pb) => !norm(pb.sku) || !lineCodes.size || lineCodes.has(norm(pb.sku)))
      .sort((a, b) => Math.abs((Number(a.batch_size) || 0) - planKg) - Math.abs((Number(b.batch_size) || 0) - planKg) || a.id - b.id)[0];
    if (!chosen) continue;
    chosen.resolved_product_code = product.product_code || product.zoho_sku_code || null;
    chosen.resolved_product_name = product.product_name || null;
    chosen.resolved_total_kg = parseKgDisplay(pe.total_kg_display) || null;
    chosen.resolved_order_units = parseKgDisplay(pe.order_qty_display) || null;
    chosen.resolved_size_kg = plb.size_kg != null ? Number(plb.size_kg) || null : null;
    const soNo = soNoBySoId.get(pe.sales_order_id);
    if (!map.has(soNo)) map.set(soNo, []);
    map.get(soNo).push(chosen);
  }
  return map;
}

/**
 * Splits linked to a production batch that Planning no longer backs — deleted batches, stale
 * leftovers still carrying the SO number, extra batches pointing at a planning batch that already
 * has its own — are unlinked. Planning is the source of truth: `prodBatches` is exactly the set of
 * batches Planning resolves for this SO (see loadProductionBatchesBySoNo).
 * @param {object[]} items plain order items with `batchSplits`
 * @param {object[]} prodBatches the SO's planning-backed production batches
 * @returns {Promise<boolean>} true when any split was written
 */
async function unlinkSplitsNotBackedByPlanning(items, prodBatches) {
  const validIds = new Set(prodBatches.map((pb) => pb.id));
  return unlinkStaleSplits(items, (s) => Boolean(s.production_batch_id) && !validIds.has(s.production_batch_id));
}

/**
 * The same production batch linked more than once on one line (concurrent syncs created four
 * splits for one batch on SO-00032 within a second) — keep the oldest, unlink the rest.
 * @returns {Promise<boolean>} true when any split was written
 */
async function unlinkDuplicateSplits(items) {
  const seenByItem = new Map();
  return unlinkStaleSplits(items, (s, item) => {
    if (!s.production_batch_id) return false;
    if (!seenByItem.has(item.id)) seenByItem.set(item.id, new Set());
    const seen = seenByItem.get(item.id);
    if (seen.has(s.production_batch_id)) return true;
    seen.add(s.production_batch_id);
    return false;
  });
}

/**
 * Shared unlink step: for each item, splits matching `isStale` (and not yet producing FG or past
 * fg_ready) are unlinked — the line's last split falls back to the pre-planning placeholder
 * (production_batch_id null, full ordered qty); any other is soft-deleted.
 * Mutates each item's in-memory `batchSplits` so the rest of the sync sees the unlinked state.
 * @returns {Promise<boolean>} true when any split was written
 */
async function unlinkStaleSplits(items, isStale) {
  let changed = false;
  for (const item of items) {
    const splits = item.batchSplits || [];
    const stale = splits.filter((s) => isStale(s, item)
      && !TERMINAL_FF_STATUSES.includes(s.ff_status)
      && !(Number(s.fg_qty) > 0));
    if (!stale.length) continue;
    const keepsOther = splits.some((s) => !stale.includes(s));
    const [first, ...rest] = stale;
    const toDelete = keepsOther ? stale : rest;
    for (const s of toDelete) {
      await softDeleteWhere(FulfillmentBatchSplit, { id: s.id });
    }
    if (!keepsOther) {
      const placeholder = {
        production_batch_id: null,
        bmr_no: null,
        bpr_no: null,
        planned_qty: Number(item.ordered_qty) || 0,
        fg_qty: 0,
        ff_status: 'fg_pending',
      };
      await FulfillmentBatchSplit.update(placeholder, { where: { id: first.id } });
      Object.assign(first, placeholder);
    }
    item.batchSplits = splits.filter((s) => !toDelete.includes(s));
    changed = true;
  }
  return changed;
}

/**
 * Does this production batch belong to this SO line? Decided by the PLANNING line's product, never
 * the batch's own sku/name (SO-00032: a KIT-sku batch linked to the non-KIT planning line matched
 * both SO lines). The item's code is its product_code, or its sku — for imported lines the sku IS
 * the PR code and product_code is null. Names are compared only when the item has no code, and only
 * exactly: a "contains" match tied "…MASK 10 GM" batches to the "…MASK 10 GM(KIT)" line (SO-00247).
 */
function batchMatchesItem(pb, item) {
  const planCode = norm(pb.resolved_product_code);
  const itemCodes = [norm(item.product_code), norm(item.sku)].filter(Boolean);
  if (itemCodes.length && planCode) return itemCodes.includes(planCode);
  const itemName = norm(item.product_name);
  const planName = norm(pb.resolved_product_name);
  return Boolean(itemName && planName && itemName === planName);
}

/**
 * Splits linked to a live production batch of a DIFFERENT product (left over from the old loose
 * name match, or a product swapped on the SO) are unlinked the same way as deleted-batch splits:
 * the line's last split becomes the pre-planning placeholder, any other is soft-deleted. Splits
 * that already produced FG or moved past fg_ready are left alone.
 * @returns {Promise<boolean>} true when any split was written
 */
async function unlinkSplitsOfMismatchedBatches(items, prodBatches) {
  const batchById = new Map(prodBatches.map((pb) => [pb.id, pb]));
  return unlinkStaleSplits(items, (s, item) => {
    const pb = s.production_batch_id ? batchById.get(s.production_batch_id) : null;
    return Boolean(pb) && !batchMatchesItem(pb, item);
  });
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
  const batchesBySoNo = preloadedBatchesBySoNo || await loadProductionBatchesBySoNo([soNo]);
  // Only an SO that resolves to a sales order is judged against Planning. One that doesn't (so_no
  // with no sales_orders row) has no planning view at all, and must not have every split unlinked.
  if (!batchesBySoNo.has(soNo)) return false;
  const prodBatches = batchesBySoNo.get(soNo);

  // Tracks whether any row was actually written, so callers can skip a re-fetch when nothing changed.
  let changed = await unlinkSplitsNotBackedByPlanning(items, prodBatches);
  changed = (await unlinkSplitsOfMismatchedBatches(items, prodBatches)) || changed;
  changed = (await unlinkDuplicateSplits(items)) || changed;
  if (!prodBatches.length) return changed;

  for (const item of items) {
    const matchingBatches = prodBatches.filter((pb) => batchMatchesItem(pb, item));

    // Used to avoid creating a 2nd split for the same production batch.
    const existingSplitBatchIds = new Set((item.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    // When SO was created before Planning created production batches, we create placeholder splits
    // with `production_batch_id = null`. Reuse those placeholders when the real batches arrive
    // so the split count doesn't inflate.
    const placeholderSplits = (item.batchSplits || []).filter((s) => !s.production_batch_id);

    for (const pb of matchingBatches) {
      const plain = pb.get ? pb.get({ plain: true }) : pb;
      if (existingSplitBatchIds.has(plain.id)) continue;

      // Pack qty this batch is actually planned to yield (see computeBatchPlannedPacks) — never the
      // raw batch_size (KG), a different unit shown separately as "RM: … KG" on the batch row.
      const plannedQty = computeBatchPlannedPacks(plain);
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

  // Repair planned_qty on already-existing linked splits that don't match computeBatchPlannedPacks:
  // earlier versions of this sync used the raw batch_size (KG) or an even order_qty/total_batches
  // split, both of which can disagree with the batch's real kg-ratio share of the order (see
  // computeBatchPlannedPacks above). Runs unconditionally, unlike the FG-yield backfill below, since
  // a batch doesn't need to be fg_ready yet for its planned pack qty to be wrong.
  const batchById = new Map(prodBatches.map((pb) => {
    const plain = pb.get ? pb.get({ plain: true }) : pb;
    return [plain.id, plain];
  }));
  for (const item of items) {
    for (const split of item.batchSplits || []) {
      if (!split.production_batch_id) continue;
      const plain = batchById.get(split.production_batch_id);
      if (!plain) continue;
      const correctPlanned = computeBatchPlannedPacks(plain);
      if (correctPlanned > 0 && Number(split.planned_qty) !== correctPlanned) {
        await FulfillmentBatchSplit.update({ planned_qty: correctPlanned }, { where: { id: split.id } });
        changed = true;
      }
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
  // repair pass below (the repair pass used to re-query once per production batch). Once a split
  // has moved past fg_ready in the fulfillment lifecycle (picked/invoiced/shipped/...) — including
  // one Fast Forward closed out directly, skipping fg_ready entirely — production-side qty/QC
  // corrections must never touch it again: doing so would silently regress an invoiced split's
  // ff_status back to 'fg_ready', un-invoicing it the next time this SO happens to sync.
  const existingSplits = (await FulfillmentBatchSplit.findAll({
    where: { fulfillment_order_id: orderId, production_batch_id: batchIdsToBackfill },
    order: [['production_batch_id', 'ASC'], ['id', 'ASC']],
  })).filter((s) => !TERMINAL_FF_STATUSES.includes(s.ff_status));
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
