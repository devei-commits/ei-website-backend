/**
 * Items Involved stage-flow helpers: scope PO qty to planning_extracted rows (SO/PI),
 * not all purchase orders for a material globally.
 * RM PO lines are summed in kg when rmMetaById is provided.
 */
const { procurementOrPoLineQtyToKg, rmMetaForId } = require('./itemsInvolvedRmDisplay');

/** Parse `reference` like `Planning PE-123`. */
function planningExtractedIdFromPlanningPoReference(reference) {
  const ref = String(reference || '');
  const m = ref.match(/^Planning\s+PE-(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildPrPlanningExtractedIdByRequestId(allPrs) {
  const map = new Map();
  for (const pr of allPrs) {
    const plain = pr.get ? pr.get({ plain: true }) : pr;
    const id = String(plain.id ?? '').replace(/\D/g, '').trim();
    const peId = Number(plain.planning_extracted_id);
    if (id && Number.isFinite(peId) && peId > 0) map.set(id, peId);
  }
  return map;
}

function purchaseOrderMatchesPlanningExtractedIds(po, peIdSet, prPeByRequestId) {
  if (!peIdSet || peIdSet.size === 0) return false;
  const plain = po.get ? po.get({ plain: true }) : po;
  const peRef = planningExtractedIdFromPlanningPoReference(plain.reference);
  if (peRef != null && peIdSet.has(peRef)) return true;
  const fd = plain.form_data && typeof plain.form_data === 'object' ? plain.form_data : {};
  const reqId = String(fd.requestId ?? fd.request_id ?? '').replace(/\D/g, '').trim();
  if (!reqId) return false;
  const peId = prPeByRequestId.get(reqId);
  return peId != null && peIdSet.has(peId);
}

function sumScopedPurchaseOrderQtyForKey(
  itemKey,
  planningExtractedIds,
  allPos,
  prPeByRequestId,
  rmMetaById
) {
  const peSet = new Set();
  for (const x of planningExtractedIds || []) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) peSet.add(n);
  }
  if (peSet.size === 0) return 0;
  let sum = 0;
  for (const po of allPos) {
    if (!purchaseOrderMatchesPlanningExtractedIds(po, peSet, prPeByRequestId)) continue;
    const items = Array.isArray(po.items) ? po.items : [];
    for (const line of items) {
      let key = null;
      if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
      else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
      if (key !== itemKey) continue;
      if (key.startsWith('rm-') && rmMetaById) {
        const rmId = Number(String(key).slice(3));
        sum += procurementOrPoLineQtyToKg(line, rmMetaForId(rmMetaById, rmId));
      } else {
        const qty = line.quantity ?? line.qty ?? line.poQty;
        const n = qty != null ? Number(qty) : 0;
        if (n > 0) sum += n;
      }
    }
  }
  return sum;
}

/**
 * @param {string} itemKey - `rm-{id}` or `pm-{id}`
 * @param {number} totalReleased - PR / planning-linked draft PO qty for this PI scope
 * @param {number} stockInHand - warehouse stock in hand (for whQty)
 * @param {number[]} planningExtractedIds - PI ids for this items-involved row
 * @param {object[]} allPos - purchase order rows
 * @param {Map<string, number>} prPeByRequestId - procurement request id → planning_extracted_id
 * @param {Map<string, number>} inTransitByKey
 * @param {Map<string, number>} grnReceivedNative
 */
function computeItemsInvolvedStageFlow(
  itemKey,
  totalReleased,
  stockInHand,
  planningExtractedIds,
  allPos,
  prPeByRequestId,
  inTransitByKey,
  grnReceivedNative,
  rmMetaById
) {
  const flowEpsilon = 1e-6;
  const released = Math.max(0, Number(totalReleased) || 0);
  const scopedRaw = sumScopedPurchaseOrderQtyForKey(
    itemKey,
    planningExtractedIds,
    allPos,
    prPeByRequestId,
    rmMetaById
  );
  const totalOnPO = Math.min(Math.max(0, scopedRaw), released + flowEpsilon);
  const totalInTransit = Number(inTransitByKey.get(itemKey) ?? 0) || 0;
  const totalReceived = Number(grnReceivedNative.get(itemKey) ?? 0) || 0;
  const plannedQty = Math.max(0, released - totalOnPO);
  const poQty = Math.max(0, totalOnPO - totalInTransit - totalReceived);
  const inTransitQty = totalInTransit;
  const whQty = Math.max(0, Number(stockInHand) || 0);
  return { totalOnPO, totalInTransit, totalReceived, plannedQty, poQty, inTransitQty, whQty };
}

module.exports = {
  planningExtractedIdFromPlanningPoReference,
  buildPrPlanningExtractedIdByRequestId,
  purchaseOrderMatchesPlanningExtractedIds,
  sumScopedPurchaseOrderQtyForKey,
  computeItemsInvolvedStageFlow,
};
