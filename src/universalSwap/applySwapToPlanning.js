/**
 * Carry an applied universal swap into Planning.
 *
 * `applySwapEffects` rewrites item groups and the PRODUCT master BOMs. But planning keeps its own
 * copies of the formula, and those are what the Plan Batches screen, Items Involved and dispensing
 * actually read:
 *
 *   planning_extracted.raw_materials  — the planning row's material list (qty in KG)
 *   planning_batches.rm_lines         — the per-batch BOM copy taken when the batch plan is saved
 *
 * Neither was touched, so an approved swap left the old ingredient in every planning row and batch
 * that had already been created from the master BOM.
 *
 * Batches already sent to production are deliberately skipped: their BOM copy is what the floor is
 * executing, and silently rewriting it would change a batch mid-flight. Those are reported back so
 * the caller can surface them.
 */
const { Op } = require('sequelize');
const PlanningExtracted = require('../planningExtracted/models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const { applySwapRatioToPct } = require('../lib/swapRatio');

function plainOf(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

/** Does this entry name the swapped-from material? Matches on id first, then code. */
function isFromMaterial(entry, fromCode, fromRawMaterialId) {
  const rmId = entry?.raw_material_id != null ? parseInt(entry.raw_material_id, 10) : NaN;
  if (!Number.isNaN(rmId) && rmId === fromRawMaterialId) return true;
  const code = String(entry?.rm_code ?? entry?.code ?? '').trim();
  return code !== '' && code === String(fromCode || '').trim();
}

/** A planning batch whose 0-based index is in the planning row's sent_batch_indices. */
function isBatchSent(planPlain, sequence) {
  const sent = Array.isArray(planPlain?.sent_batch_indices) ? planPlain.sent_batch_indices : [];
  const idx0 = Number(sequence) - 1;
  return sent.some((x) => Number(x) === idx0);
}

/**
 * Rewrite one list of formula entries, splitting the measured amount by the swap ratio.
 * `field` is the key holding the amount — `pct_w_w` for batch BOM lines, `quantity` for planning.
 */
function swapEntries(entries, { field, fromCode, fromRawMaterialId, toCode, toRawMaterialId, toInci, toSku, swapRatio }) {
  const out = [];
  let changed = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isFromMaterial(entry, fromCode, fromRawMaterialId)) {
      out.push(entry);
      continue;
    }
    changed = true;
    const withToIdentity = (amount) => {
      const next = { ...entry, [field]: amount };
      if (toRawMaterialId != null) next.raw_material_id = toRawMaterialId;
      if ('rm_code' in next) next.rm_code = toCode;
      if ('code' in next) next.code = toCode;
      if ('inci_name' in next) next.inci_name = toInci;
      if ('name' in next) next.name = toInci;
      if ('zoho_sku_code' in next) next.zoho_sku_code = toSku || toCode;
      return next;
    };

    const amount = Number(entry?.[field] ?? 0) || 0;
    if (amount <= 0) {
      // Nothing to split — carry the identity across at zero.
      out.push(withToIdentity(0));
      continue;
    }
    const { newPct: newAmount, remainderPct: remainderAmount } = applySwapRatioToPct(amount, swapRatio);
    if (newAmount > 0) out.push(withToIdentity(newAmount));
    if (remainderAmount > 0) out.push({ ...entry, [field]: remainderAmount });
  }
  return { entries: out, changed };
}

/**
 * Propagate a swap into planning rows and batch BOM copies for the given products.
 *
 * @param {object} args
 * @param {number[]} args.productIds  products whose planning should follow the swap
 * @returns {Promise<{planningRows:number, batches:number, skippedSentBatches:string[]}>}
 */
async function applySwapToPlanning({
  productIds,
  fromRawMaterialId,
  toRawMaterialId,
  swapRatio,
  fromPlain,
  toPlain,
}, opts = {}) {
  // Threading the caller's transaction lets this be exercised and rolled back safely, and keeps it
  // atomic with the BOM/group updates when the caller wraps the whole swap.
  const tx = opts.transaction ? { transaction: opts.transaction } : {};
  const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return { planningRows: 0, batches: 0, skippedSentBatches: [] };

  const shared = {
    fromCode: fromPlain?.code || '',
    fromRawMaterialId,
    toCode: toPlain?.code || '',
    toRawMaterialId,
    toInci: toPlain?.inci || toPlain?.name || toPlain?.code || '',
    toSku: toPlain?.zoho_sku_code || toPlain?.code || '',
    swapRatio,
  };

  const plans = await PlanningExtracted.findAll({
    where: { product_id: { [Op.in]: ids }, deleted_at: { [Op.is]: null } },
    ...tx,
  });

  let planningRows = 0;
  let batches = 0;
  const skippedSentBatches = [];

  for (const plan of plans) {
    const planPlain = plainOf(plan);

    const rm = swapEntries(planPlain.raw_materials, { ...shared, field: 'quantity' });
    if (rm.changed) {
      await plan.update({ raw_materials: rm.entries }, tx);
      planningRows += 1;
    }

    const planBatches = await PlanningBatch.findAll({ where: { planning_extracted_id: planPlain.id }, ...tx });
    for (const batch of planBatches) {
      const bp = plainOf(batch);
      const lines = swapEntries(bp.rm_lines, { ...shared, field: 'pct_w_w' });
      if (!lines.changed) continue;
      if (isBatchSent(planPlain, bp.sequence)) {
        // Already on the production floor — its BOM copy is what is being made.
        skippedSentBatches.push(bp.batch_code || `PE-${planPlain.id}-B${bp.sequence}`);
        continue;
      }
      await batch.update({ rm_lines: lines.entries }, tx);
      batches += 1;
    }
  }

  return { planningRows, batches, skippedSentBatches };
}

module.exports = { applySwapToPlanning, swapEntries, isFromMaterial };
