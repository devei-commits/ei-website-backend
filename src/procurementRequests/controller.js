const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const ProcurementRequest = require('./models');
const PlanningExtracted = require('../planningExtracted/models');
const SalesOrder = require('../salesOrders/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { validateProcurementItemsMoq } = require('./moqValidation');
const {
  parseLeadFromLineNotes,
  mergeLeadIntoLineNotes,
  buildLeadResolutionCache,
  enrichProcurementItemsWithResolvedLead,
  getItemPriceListTiers,
} = require('./procurementItemLead');
const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');
const { applyProcurementRmPrimaryUnits, normRmPrimaryUom } = require('../lib/rmUnitConversion');

/**
 * Coerce item quantities to finite numbers (handles strings / comma-formatted values from clients).
 * Lead: accepts lead_time_days or leadTimeDays; syncs line_notes "Lead: Nd" when a value is known.
 */
function normalizeProcurementItems(items) {
  if (!Array.isArray(items)) return [];
  const toNum = (v) => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = parseFloat(String(v).replace(/,/g, '').replace(/\s/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  };
  return items.map((i) => {
    const out = { ...i };
    if (out.lead_time_days == null && out.leadTimeDays != null) {
      out.lead_time_days = out.leadTimeDays;
    }
    if (out.leadTimeDays !== undefined) delete out.leadTimeDays;
    out.quantity_requested = roundPlanningMaterialQty(toNum(out.quantity_requested));
    if (out.required != null) out.required = roundPlanningMaterialQty(toNum(out.required));
    if (out.shortage != null) out.shortage = roundPlanningMaterialQty(toNum(out.shortage));
    if (out.moq_min != null && out.moq_min !== '') {
      const m = toNum(out.moq_min);
      if (m > 0) out.moq_min = m;
      else delete out.moq_min;
    }
    if (out.planned_unit_price != null && out.planned_unit_price !== '') {
      const p = toNum(out.planned_unit_price);
      if (p > 0) out.planned_unit_price = p;
      else delete out.planned_unit_price;
    }
    let leadResolved = null;
    if (out.lead_time_days != null && out.lead_time_days !== '') {
      const d = parseInt(String(out.lead_time_days).replace(/\D/g, ''), 10);
      if (Number.isFinite(d) && d >= 0) leadResolved = d;
    }
    if (leadResolved === null) {
      const fromNotes = parseLeadFromLineNotes(out.line_notes);
      if (fromNotes !== null) leadResolved = fromNotes;
    }
    if (leadResolved !== null) {
      out.lead_time_days = leadResolved;
      out.line_notes = mergeLeadIntoLineNotes(out.line_notes, leadResolved);
    } else {
      delete out.lead_time_days;
    }
    return out;
  });
}

/**
 * Normalize + fill lead from line_notes / Items List vendor rates before persisting `items` JSON.
 */
async function finalizeItemsForPersistence(items, preferredVendor) {
  const n = normalizeProcurementItems(items);
  const { rmMap } = await loadMasterMapsForItems(n);
  const withUnits = applyProcurementRmPrimaryUnits(n, rmMap);
  const cache = await buildLeadResolutionCache(withUnits);
  return enrichProcurementItemsWithResolvedLead(withUnits, preferredVendor, cache);
}

/**
 * Load RM/PM master rows for procurement line items (fill missing name/code on read).
 */
async function loadMasterMapsForItems(itemsArray) {
  const rmIds = new Set();
  const pmIds = new Set();
  for (const i of itemsArray || []) {
    const rm = i.raw_material_id != null ? Number(i.raw_material_id) : NaN;
    const pm = i.pack_material_id != null ? Number(i.pack_material_id) : NaN;
    if (Number.isFinite(rm) && rm > 0) rmIds.add(rm);
    if (Number.isFinite(pm) && pm > 0) pmIds.add(pm);
  }
  const [rms, pms] = await Promise.all([
    rmIds.size
      ? RawMaterial.findAll({
        where: { id: [...rmIds] },
        attributes: ['id', 'code', 'name', 'uom', 'specific_gravity'],
      })
      : Promise.resolve([]),
    pmIds.size
      ? PackMaterial.findAll({ where: { id: [...pmIds] }, attributes: ['id', 'code', 'description'] })
      : Promise.resolve([]),
  ]);
  return {
    rmMap: new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r])),
    pmMap: new Map(pms.map((p) => [p.id, p.get ? p.get({ plain: true }) : p])),
  };
}

function enrichItemsWithMasters(items, rmMap, pmMap) {
  if (!Array.isArray(items)) return [];
  return items.map((i) => {
    const out = { ...i };
    const rmId = i.raw_material_id != null ? Number(i.raw_material_id) : null;
    const pmId = i.pack_material_id != null ? Number(i.pack_material_id) : null;
    if (rmId != null && Number.isFinite(rmId) && rmId > 0 && rmMap.has(rmId)) {
      const rm = rmMap.get(rmId);
      if (rm) {
        if (!out.name || !String(out.name).trim()) out.name = rm.name;
        if (!out.code || !String(out.code).trim()) out.code = rm.code;
        if (out.type === 'RM' && (!out.unit || !String(out.unit).trim())) {
          out.unit = normRmPrimaryUom(rm.uom);
        }
      }
    }
    if (pmId != null && Number.isFinite(pmId) && pmId > 0 && pmMap.has(pmId)) {
      const pm = pmMap.get(pmId);
      if (pm) {
        if (!out.name || !String(out.name).trim()) out.name = pm.description;
        if (!out.code || !String(out.code).trim()) out.code = pm.code;
      }
    }
    return out;
  });
}

function isStockCheckPendingStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'pending' || s === 'requested' || s === 'in progress';
}

function parseStockCheckNotesPayload(notes) {
  const raw = String(notes ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isStockCheckOneTimeCompleted(status, notes) {
  const s = String(status || '').trim().toLowerCase();
  if (s !== 'completed') return false;
  const parsed = parseStockCheckNotesPayload(notes);
  const outcome = String(parsed?.outcome ?? '').trim().toLowerCase();
  const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  // Lock only when warehouse has successfully completed stock check
  // and sent qty-level line data back.
  return outcome === 'all_ok' && lines.length > 0;
}

function formatPR(row, enrichedItems) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const pe = d.planningExtracted || {};
  const so = pe.salesOrder || {};
  const prod = pe.product || {};
  const itemsRaw = enrichedItems != null ? enrichedItems : (Array.isArray(d.items) ? d.items : []);
  return {
    id: String(d.id),
    planningExtractedId: d.planning_extracted_id,
    source: d.source ?? (d.planning_extracted_id != null ? 'planning' : 'manual'),
    planningBatchId: d.planning_batch_id ?? null,
    priority: d.priority,
    requiredByDate: d.required_by_date,
    notes: d.notes,
    items: itemsRaw,
    status: d.status,
    preferredVendor: d.preferred_vendor,
    requestedBy: d.requested_by,
    stockCheckAssignedTo: d.stock_check_assigned_to ?? null,
    stockCheckStatus: d.stock_check_status ?? null,
    stockCheckDueDate: d.stock_check_due_date ?? null,
    stockCheckNotes: d.stock_check_notes ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    planningSoNumber: so.order_id ?? null,
    planningCustomerName: so.customer_name ?? null,
    planningProductName: prod.product_name ?? null,
    planningProductCode: prod.product_code ?? null,
    planningProductMrp: prod.mrp_price != null ? Number(prod.mrp_price) : null,
  };
}

const prIncludePlanning = {
  model: PlanningExtracted,
  as: 'planningExtracted',
  attributes: ['id', 'sales_order_id', 'product_id'],
  required: false,
  include: [
    { model: SalesOrder, as: 'salesOrder', attributes: ['order_id', 'customer_name'] },
    { model: Product, as: 'product', attributes: ['product_name', 'product_code', 'mrp_price'] },
  ],
};

async function fetchPrFormattedById(id) {
  const row = await ProcurementRequest.findByPk(id, { include: [prIncludePlanning] });
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const items = Array.isArray(d.items) ? d.items : [];
  const { rmMap, pmMap } = await loadMasterMapsForItems(items);
  let enriched = enrichItemsWithMasters(items, rmMap, pmMap);
  const cache = await buildLeadResolutionCache(items);
  enriched = enrichProcurementItemsWithResolvedLead(enriched, d.preferred_vendor, cache);
  return formatPR(row, enriched);
}

async function listProcurementRequests(req, res) {
  try {
    const planningExtractedId = req.query.planning_extracted_id != null
      ? parseInt(req.query.planning_extracted_id, 10)
      : null;
    const planningBatchId = req.query.planning_batch_id != null
      ? parseInt(req.query.planning_batch_id, 10)
      : null;
    const filters = {};
    if (planningExtractedId != null && !Number.isNaN(planningExtractedId)) {
      filters.planning_extracted_id = planningExtractedId;
    }
    if (planningBatchId != null && !Number.isNaN(planningBatchId)) {
      filters.planning_batch_id = planningBatchId;
    }
    const where = activeRowWhere(filters);
    const rows = await ProcurementRequest.findAll({
      where,
      order: [['created_at', 'DESC']],
      include: [prIncludePlanning],
    });
    const allItems = rows.flatMap((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      return Array.isArray(d.items) ? d.items : [];
    });
    const { rmMap, pmMap } = await loadMasterMapsForItems(allItems);
    const leadCache = await buildLeadResolutionCache(allItems);
    const out = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const items = Array.isArray(d.items) ? d.items : [];
      let enriched = enrichItemsWithMasters(items, rmMap, pmMap);
      enriched = enrichProcurementItemsWithResolvedLead(enriched, d.preferred_vendor, leadCache);
      return formatPR(r, enriched);
    });
    res.json(out);
  } catch (err) {
    console.error('listProcurementRequests error', err);
    res.status(500).json({ error: 'Failed to list procurement requests' });
  }
}

async function getProcurementRequestById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const formatted = await fetchPrFormattedById(id);
    if (!formatted) return res.status(404).json({ error: 'Procurement request not found' });
    res.json(formatted);
  } catch (err) {
    console.error('getProcurementRequestById error', err);
    res.status(500).json({ error: 'Failed to fetch procurement request' });
  }
}

const PR_SOURCES = ['planning', 'manual', 'blanket_calloff', 'consignment'];

async function createProcurementRequest(req, res) {
  try {
    const body = req.body || {};
    const planningExtractedId = body.planningExtractedId ?? body.planning_extracted_id;
    const preferredVendor = body.preferredVendor ?? body.preferred_vendor ?? null;
    const requestedSource = String(body.source ?? '').trim().toLowerCase();

    // Planning-sourced PR: validate the planning row exists (unchanged behaviour).
    let planningId = null;
    if (planningExtractedId != null) {
      const id = parseInt(planningExtractedId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid planningExtractedId' });
      const planRow = await PlanningExtracted.findByPk(id);
      if (!planRow) return res.status(404).json({ error: 'Planning extracted record not found' });
      planningId = id;
    } else {
      // Manual / non-Planning PR (Direct PR · blanket call-off · consignment): needs at least one line.
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        return res.status(400).json({ error: 'A manual PR needs at least one line item (or provide planningExtractedId).' });
      }
    }

    const source = planningId != null
      ? 'planning'
      : (PR_SOURCES.includes(requestedSource) && requestedSource !== 'planning' ? requestedSource : 'manual');

    const planningBatchId = body.planningBatchId ?? body.planning_batch_id;
    const batchId = planningBatchId != null ? parseInt(planningBatchId, 10) : null;
    const row = await ProcurementRequest.create({
      planning_extracted_id: planningId,
      source,
      planning_batch_id: batchId != null && !Number.isNaN(batchId) ? batchId : null,
      priority: body.priority ?? null,
      required_by_date: body.requiredByDate ?? body.required_by_date ?? null,
      notes: body.notes ?? null,
      items: await finalizeItemsForPersistence(body.items ?? [], preferredVendor),
      status: body.status ?? 'Pending',
      requested_by: body.requestedBy ?? body.requested_by ?? req.user?.email ?? null,
      preferred_vendor: preferredVendor,
    });
    const formatted = await fetchPrFormattedById(row.id);
    res.status(201).json(formatted);
  } catch (err) {
    console.error('createProcurementRequest error', err);
    res.status(500).json({ error: 'Failed to create procurement request' });
  }
}

async function updateProcurementRequest(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementRequest.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement request not found' });
    const body = req.body || {};
    const updates = {};
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.requiredByDate !== undefined) updates.required_by_date = body.requiredByDate;
    if (body.required_by_date !== undefined) updates.required_by_date = body.required_by_date;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.items !== undefined) {
      const pv =
        body.preferredVendor ?? body.preferred_vendor ?? row.preferred_vendor ?? null;
      updates.items = await finalizeItemsForPersistence(body.items, pv);
    }
    if (body.status !== undefined) updates.status = body.status;
    if (body.preferredVendor !== undefined) updates.preferred_vendor = body.preferredVendor;
    if (body.preferred_vendor !== undefined) updates.preferred_vendor = body.preferred_vendor;
    if (body.stockCheckAssignedTo !== undefined) updates.stock_check_assigned_to = body.stockCheckAssignedTo;
    if (body.stock_check_assigned_to !== undefined) updates.stock_check_assigned_to = body.stock_check_assigned_to;
    if (body.stockCheckStatus !== undefined) updates.stock_check_status = body.stockCheckStatus;
    if (body.stock_check_status !== undefined) updates.stock_check_status = body.stock_check_status;
    if (body.stockCheckDueDate !== undefined) updates.stock_check_due_date = body.stockCheckDueDate;
    if (body.stock_check_due_date !== undefined) updates.stock_check_due_date = body.stock_check_due_date;
    if (body.stockCheckNotes !== undefined) updates.stock_check_notes = body.stockCheckNotes;
    if (body.stock_check_notes !== undefined) updates.stock_check_notes = body.stock_check_notes;
    if (body.planningBatchId !== undefined) updates.planning_batch_id = body.planningBatchId;
    if (body.planning_batch_id !== undefined) updates.planning_batch_id = body.planning_batch_id;

    const nextStatus = updates.status !== undefined ? updates.status : row.status;
    const nextStockCheckStatus =
      updates.stock_check_status !== undefined ? updates.stock_check_status : row.stock_check_status;
    const nextStockCheckAssignedTo =
      updates.stock_check_assigned_to !== undefined
        ? updates.stock_check_assigned_to
        : row.stock_check_assigned_to;
    const lockStockCheckReopen = isStockCheckOneTimeCompleted(
      row.stock_check_status,
      row.stock_check_notes,
    );
    if (lockStockCheckReopen && updates.stock_check_status !== undefined) {
      const incoming = String(updates.stock_check_status ?? '').trim().toLowerCase();
      if (incoming === 'pending' || incoming === 'requested' || incoming === 'in progress') {
        return res.status(409).json({
          error:
            'Stock check is a one-time procedure once warehouse has completed it successfully with quantity data.',
          code: 'STOCK_CHECK_ONE_TIME_LOCKED',
        });
      }
    }
    if (nextStatus === 'PO Released' && isStockCheckPendingStatus(nextStockCheckStatus)) {
      return res.status(409).json({
        error:
          'Stock check is still pending. Warehouse must complete stock check before PO can be released.',
        code: 'STOCK_CHECK_PENDING',
      });
    }
    {
      const assignee = String(nextStockCheckAssignedTo ?? '').trim();
      const stockStatusLower = String(nextStockCheckStatus ?? '').trim().toLowerCase();
      const needsAssignee = stockStatusLower === 'in progress' || stockStatusLower === 'completed';
      if (needsAssignee && !assignee) {
        return res.status(400).json({
          error: 'Assign a person for stock check before setting stock check to In Progress or Completed.',
          code: 'STOCK_CHECK_ASSIGNEE_REQUIRED',
        });
      }
    }
    if (updates.items !== undefined) {
      const moqCheck = await validateProcurementItemsMoq(updates.items);
      if (!moqCheck.ok) {
        const first = moqCheck.errors[0];
        return res.status(400).json({
          error: first?.message || 'MOQ validation failed',
          code: 'MOQ_NOT_MET',
          details: moqCheck.errors,
        });
      }
    }
    if (Object.keys(updates).length > 0) {
      await row.update(updates);
    }
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[procurementRequests] syncWarehouseInTransitAll failed:', e && e.message ? e.message : e);
    }
    const formatted = await fetchPrFormattedById(id);
    res.json(formatted);
  } catch (err) {
    console.error('updateProcurementRequest error', err);
    res.status(500).json({ error: 'Failed to update procurement request' });
  }
}

async function deleteProcurementRequest(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementRequest.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement request not found' });
    await softDeleteInstance(row);
    res.status(204).send();
  } catch (err) {
    console.error('deleteProcurementRequest error', err);
    res.status(500).json({ error: 'Failed to delete procurement request' });
  }
}

/**
 * GET /api/v1/procurement/item-price-list?rawMaterialId=&packMaterialId=
 * Vendor × MOQ price tiers for an item (PR Edit popup §3A dual-pane).
 */
async function getItemPriceList(req, res) {
  try {
    const tiers = await getItemPriceListTiers({
      rawMaterialId: req.query.rawMaterialId,
      packMaterialId: req.query.packMaterialId,
    });
    res.json({ tiers });
  } catch (err) {
    console.error('getItemPriceList error', err);
    res.status(500).json({ error: 'Failed to fetch item price list' });
  }
}

/**
 * GET /api/v1/procurement/pending-stock-audits
 * Returns PRs that have an open stock audit (status Pending/Requested/In Progress).
 * Used by Warehouse module to see what physical counts are needed.
 */
async function listPendingStockAudits(req, res) {
  try {
    const { Op } = require('sequelize');
    const rows = await ProcurementRequest.findAll({
      where: {
        stock_check_status: { [Op.in]: ['Pending', 'Requested', 'In Progress'] },
        ...activeRowWhere(),
      },
      include: [prIncludePlanning],
      order: [['stock_check_due_date', 'ASC NULLS LAST']],
    });
    const result = await Promise.all(
      rows.map(async (row) => {
        const d = row.get ? row.get({ plain: true }) : row;
        const items = Array.isArray(d.items) ? d.items : [];
        const { rmMap, pmMap } = await loadMasterMapsForItems(items);
        const enriched = enrichItemsWithMasters(items, rmMap, pmMap);
        return formatPR(row, enriched);
      }),
    );
    res.json({ requests: result });
  } catch (err) {
    console.error('listPendingStockAudits error', err);
    res.status(500).json({ error: 'Failed to list pending stock audits' });
  }
}

/**
 * POST /api/v1/procurement/:id/stock-check-result
 * Warehouse submits physical count results for a stock audit.
 * Body: { lines: [{itemCode, itemName, physicalQty, location?, zone?, batchNo?, remarks?}], completedBy, outcome? }
 * Merges physical quantities into stock_check_notes JSON and sets status to Completed.
 */
async function submitStockCheckResult(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementRequest.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement request not found' });

    const { lines, completedBy, outcome } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'lines array with at least one entry is required' });
    }

    const existing = parseStockCheckNotesPayload(row.stock_check_notes) ?? {};
    const existingLines = Array.isArray(existing.lines) ? existing.lines : [];
    const now = new Date().toISOString();
    const auditor = String(completedBy ?? '').trim() || null;

    // Merge incoming physical quantities into existing line entries.
    const mergedLines = existingLines.map((el) => {
      const incoming = lines.find(
        (l) =>
          String(l.itemCode ?? '').trim().toLowerCase() ===
          String(el.itemCode ?? '').trim().toLowerCase(),
      );
      if (!incoming) return el;
      return {
        ...el,
        physicalQty: Number(incoming.physicalQty),
        ...(incoming.location != null ? { location: incoming.location } : {}),
        ...(incoming.zone != null ? { zone: incoming.zone } : {}),
        ...(incoming.batchNo != null ? { batchNo: incoming.batchNo } : {}),
        ...(incoming.remarks != null ? { remarks: incoming.remarks } : {}),
        auditedAt: now,
        auditedBy: auditor,
      };
    });

    // Append lines that had no existing entry (e.g. extra locations).
    for (const l of lines) {
      const matched = mergedLines.find(
        (ml) =>
          String(ml.itemCode ?? '').trim().toLowerCase() ===
          String(l.itemCode ?? '').trim().toLowerCase(),
      );
      if (!matched) {
        mergedLines.push({
          itemCode: l.itemCode,
          itemName: l.itemName,
          physicalQty: Number(l.physicalQty),
          location: l.location ?? existing.warehouseCodes?.[0] ?? 'MAIN',
          zone: l.zone ?? l.location ?? 'MAIN',
          ...(l.batchNo != null ? { batchNo: l.batchNo } : {}),
          remarks: l.remarks ?? '',
          auditedAt: now,
          auditedBy: auditor,
        });
      }
    }

    const mergedNotes = JSON.stringify({
      ...existing,
      lines: mergedLines,
      outcome: outcome ?? 'all_ok',
      completedAt: now,
      completedBy: auditor,
    });

    await row.update({
      stock_check_status: 'Completed',
      stock_check_assigned_to: auditor ?? row.stock_check_assigned_to,
      stock_check_notes: mergedNotes,
    });

    const formatted = await fetchPrFormattedById(id);
    res.json(formatted);
  } catch (err) {
    console.error('submitStockCheckResult error', err);
    res.status(500).json({ error: 'Failed to submit stock check result' });
  }
}

module.exports = {
  listProcurementRequests,
  getProcurementRequestById,
  createProcurementRequest,
  updateProcurementRequest,
  deleteProcurementRequest,
  getItemPriceList,
  listPendingStockAudits,
  submitStockCheckResult,
};
