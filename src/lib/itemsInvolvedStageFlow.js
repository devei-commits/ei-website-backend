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

/**
 * A PO counts toward the "PO Qty" bucket only once it is COMMITTED — i.e. it has
 * passed approval (`approval_status='approved'`) or been released to the vendor
 * (`status`='released'/'po released'). Draft / under-review / changes-requested /
 * rejected POs are NOT committed: their qty stays in "Planned" until approval.
 * This is what keeps Planned populated across the PR → draft-PO window and only
 * moves qty to PO Qty when the PO is actually approved.
 */
function isCommittedPurchaseOrder(poPlain) {
  const appr = String(poPlain.approval_status ?? '').trim().toLowerCase();
  if (appr === 'approved') return true;
  if (appr === 'rejected') return false;
  const status = String(poPlain.status ?? '').trim().toLowerCase();
  return status === 'released' || status === 'po released';
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
    const poPlain = po.get ? po.get({ plain: true }) : po;
    // Only committed (approved/released) POs move qty out of "Planned" into "PO Qty".
    if (!isCommittedPurchaseOrder(poPlain)) continue;
    if (!purchaseOrderMatchesPlanningExtractedIds(po, peSet, prPeByRequestId)) continue;
    const items = Array.isArray(poPlain.items) ? poPlain.items : [];
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

/** Rejected/cancelled POs never count in any bucket. */
function isDeadPurchaseOrder(poPlain) {
  const appr = String(poPlain.approval_status ?? '').trim().toLowerCase();
  if (appr === 'rejected') return true;
  const exc = String(poPlain.exception_status ?? '').trim().toLowerCase();
  if (exc === 'cancelled' || exc === 'canceled') return true;
  const status = String(poPlain.status ?? '').trim().toLowerCase();
  return status === 'cancelled' || status === 'canceled';
}

/** rm-{id}/pm-{id} key + kg-or-native qty for a PO/PR line; returns null if it doesn't match a material id. */
function poLineKeyAndQty(line, rmMetaById, qtyFields) {
  let key = null;
  if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
  else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
  if (!key) return null;
  let qty;
  if (key.startsWith('rm-') && rmMetaById) {
    qty = procurementOrPoLineQtyToKg(line, rmMetaForId(rmMetaById, Number(key.slice(3))));
  } else {
    let raw;
    for (const f of qtyFields) { if (line[f] != null) { raw = line[f]; break; } }
    qty = raw != null ? Number(raw) : 0;
  }
  return qty > 0 ? { key, qty } : null;
}

/**
 * GLOBAL (material-wide, not planning-scoped) PO qty maps for Items Involved.
 *   committedByKey = Approved/Issued POs   → "PO Qty" bucket
 *   draftByKey     = not-yet-approved POs  → part of "Planned" bucket
 * Rejected/cancelled POs are excluded from both.
 */
function buildGlobalPoMaps(allPos, rmMetaById) {
  const committedByKey = new Map();
  const draftByKey = new Map();
  const PO_QTY_FIELDS = ['quantity', 'qty', 'poQty'];
  for (const po of allPos) {
    const p = po.get ? po.get({ plain: true }) : po;
    if (isDeadPurchaseOrder(p)) continue;
    const target = isCommittedPurchaseOrder(p) ? committedByKey : draftByKey;
    const items = Array.isArray(p.items) ? p.items : [];
    for (const line of items) {
      const hit = poLineKeyAndQty(line, rmMetaById, PO_QTY_FIELDS);
      if (hit) target.set(hit.key, (target.get(hit.key) || 0) + hit.qty);
    }
  }
  return { committedByKey, draftByKey };
}

/**
 * PR qty per material for PRs NOT yet turned into a PO. Once a PR is "released to draft" (a PO carries
 * its id in form_data.requestId) it is no longer considered — the draft PO represents it instead.
 * Cancelled/rejected PRs excluded.
 */
function buildUnlinkedPrMap(allPrs, allPos, rmMetaById) {
  const linkedPrIds = new Set();
  for (const po of allPos) {
    const p = po.get ? po.get({ plain: true }) : po;
    const fd = p.form_data && typeof p.form_data === 'object' ? p.form_data : {};
    const reqId = String(fd.requestId ?? fd.request_id ?? '').replace(/\D/g, '').trim();
    if (reqId) linkedPrIds.add(reqId);
  }
  const byKey = new Map();
  const PR_QTY_FIELDS = ['quantity_requested', 'shortage', 'required', 'quantity', 'qty'];
  for (const pr of allPrs) {
    const p = pr.get ? pr.get({ plain: true }) : pr;
    const prId = String(p.id ?? '').replace(/\D/g, '').trim();
    if (prId && linkedPrIds.has(prId)) continue; // released to draft → not considered
    const st = String(p.status ?? '').trim().toLowerCase();
    if (/cancel|reject/.test(st)) continue;
    const items = Array.isArray(p.items) ? p.items : [];
    for (const line of items) {
      const hit = poLineKeyAndQty(line, rmMetaById, PR_QTY_FIELDS);
      if (hit) byKey.set(hit.key, (byKey.get(hit.key) || 0) + hit.qty);
    }
  }
  return byKey;
}

/**
 * Global per-material supply pipeline for one item key. All inputs pre-summed globally (kg for RM,
 * native for PM). Cascade: committed PO drains as goods ship → arrive → receive.
 */
function computeGlobalItemsInvolvedFlow(key, maps) {
  const committed = Number(maps.committedByKey.get(key) ?? 0) || 0;
  const draftPo = Number(maps.draftByKey.get(key) ?? 0) || 0;
  const prPlanned = Number(maps.unlinkedPrByKey.get(key) ?? 0) || 0;
  const inTransit = Number(maps.inTransitByKey.get(key) ?? 0) || 0;
  const underGrn = Number(maps.underGrnByKey.get(key) ?? 0) || 0;
  const received = Number(maps.receivedByKey.get(key) ?? 0) || 0;
  const plannedQty = Math.max(0, prPlanned + draftPo);
  const poQty = Math.max(0, committed - inTransit - underGrn - received);
  return { plannedQty, poQty, inTransitQty: inTransit, underGrn, totalOnPO: committed, totalReceived: received };
}

/** Human-readable PO status for the PO-Qty click-through popup. */
function poDisplayStatus(poPlain) {
  const appr = String(poPlain.approval_status ?? '').trim().toLowerCase();
  const status = String(poPlain.status ?? '').trim().toLowerCase();
  if (status === 'released' || status === 'po released') return 'Issued';
  if (appr === 'approved') return 'Approved';
  if (appr === 'under_review') return 'Under Review';
  if (appr === 'under_approval') return 'Under Approval';
  if (appr === 'changes_requested') return 'Changes Requested';
  return 'Draft';
}

/**
 * Per-material list of the POs behind its numbers, for the "click PO Qty" popup.
 * Map<rm-{id}|pm-{id}, [{ poNo, qty, unit, status, expectedDate }]>. Qty is the raw PO line qty
 * (as entered, with its unit) summed across that PO's lines for the material; rejected/cancelled excluded.
 */
function buildPoBreakdownByKey(allPos) {
  const byKey = new Map();
  for (const po of allPos) {
    const p = po.get ? po.get({ plain: true }) : po;
    if (isDeadPurchaseOrder(p)) continue;
    const poNo = p.order_id || `PO-${p.id}`;
    const status = poDisplayStatus(p);
    const expectedDate = p.expected_shipment_date || null;
    const items = Array.isArray(p.items) ? p.items : [];
    const perKey = new Map();
    for (const line of items) {
      let key = null;
      if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
      else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
      if (!key) continue;
      const q = Number(line.quantity ?? line.qty ?? line.poQty ?? 0) || 0;
      if (!(q > 0)) continue;
      const unit = String(line.unit ?? line.uom ?? line.UOM ?? '').trim() || (key.startsWith('rm-') ? 'KG' : 'PCS');
      const prev = perKey.get(key);
      if (prev) prev.qty += q; else perKey.set(key, { qty: q, unit });
    }
    for (const [key, { qty, unit }] of perKey) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ ref: poNo, qty, unit, status, expectedDate });
    }
  }
  return byKey;
}

module.exports = {
  planningExtractedIdFromPlanningPoReference,
  buildPoBreakdownByKey,
  buildPrPlanningExtractedIdByRequestId,
  purchaseOrderMatchesPlanningExtractedIds,
  isCommittedPurchaseOrder,
  isDeadPurchaseOrder,
  sumScopedPurchaseOrderQtyForKey,
  computeItemsInvolvedStageFlow,
  buildGlobalPoMaps,
  buildUnlinkedPrMap,
  computeGlobalItemsInvolvedFlow,
};
