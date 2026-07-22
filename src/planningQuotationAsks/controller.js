const PlanningQuotationAsk = require('./models');
const PlanningExtracted = require('../planningExtracted/models');
const SalesOrder = require('../salesOrders/models');
const { Product } = require('../products/models');
const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');
const { askMergeKey } = require('./mergeKey');

const peIncludePlanning = {
  model: PlanningExtracted,
  as: 'planningExtracted',
  attributes: ['id', 'sales_order_id', 'product_id'],
  required: false,
  include: [
    { model: SalesOrder, as: 'salesOrder', attributes: ['order_id', 'customer_name'] },
    { model: Product, as: 'product', attributes: ['product_name', 'product_code'] },
  ],
};

function formatAsk(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const pe = d.planningExtracted || {};
  const so = pe.salesOrder || {};
  const prod = pe.product || {};
  return {
    id: d.id,
    planningExtractedId: d.planning_extracted_id,
    itemType: d.item_type,
    rawMaterialId: d.raw_material_id ?? null,
    packMaterialId: d.pack_material_id ?? null,
    itemCode: d.item_code ?? null,
    itemName: d.item_name ?? null,
    quantityRequested: Number(d.quantity_requested) || 0,
    unit: d.unit ?? null,
    vendorHint: d.vendor_hint ?? null,
    moqHint: d.moq_hint != null ? Number(d.moq_hint) : null,
    source: d.source ?? 'planning',
    moqBands: Array.isArray(d.moq_bands) ? d.moq_bands : [],
    expectedRequiredDate: d.expected_required_date ?? null,
    status: d.status,
    notes: d.notes ?? null,
    requestedBy: d.requested_by ?? null,
    fulfilledAt: d.fulfilled_at ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    planningSoNumber: so.order_id ?? null,
    planningCustomerName: so.customer_name ?? null,
    planningProductName: prod.product_name ?? null,
    planningProductCode: prod.product_code ?? null,
  };
}

function buildAskNotes(itemName, itemCode, vendorHint, moqHint) {
  let notes = `Quotation requested from Planning · ${itemName} (${itemCode})`;
  if (vendorHint) notes += ` · Vendor: ${vendorHint}`;
  if (moqHint > 0) notes += ` · MOQ: ${moqHint}`;
  return notes;
}

async function listPlanningQuotationAsks(req, res) {
  try {
    const statusRaw = String(req.query.status ?? 'pending').trim().toLowerCase();
    const planningExtractedId =
      req.query.planning_extracted_id != null
        ? parseInt(req.query.planning_extracted_id, 10)
        : null;

    const where = {};
    if (statusRaw && statusRaw !== 'all') {
      where.status = statusRaw;
    }
    if (planningExtractedId != null && !Number.isNaN(planningExtractedId)) {
      where.planning_extracted_id = planningExtractedId;
    }

    const rows = await PlanningQuotationAsk.findAll({
      where,
      include: [peIncludePlanning],
      order: [['created_at', 'DESC']],
    });
    res.json(rows.map(formatAsk));
  } catch (err) {
    console.error('listPlanningQuotationAsks error', err);
    res.status(500).json({ error: 'Failed to list planning quotation asks' });
  }
}

async function createPlanningQuotationAsk(req, res) {
  try {
    const body = req.body || {};
    // planningExtractedId is optional — a quotation may be requested from Procurement (source='procurement').
    const peIdRaw = body.planningExtractedId ?? body.planning_extracted_id;
    const planningExtractedId =
      peIdRaw != null && String(peIdRaw).trim() !== '' ? parseInt(peIdRaw, 10) : null;
    const source = String(body.source ?? (planningExtractedId ? 'planning' : 'procurement')).trim().toLowerCase() || 'planning';
    if (planningExtractedId != null) {
      if (Number.isNaN(planningExtractedId) || planningExtractedId <= 0) {
        return res.status(400).json({ error: 'planningExtractedId must be a positive id when provided' });
      }
      const planRow = await PlanningExtracted.findByPk(planningExtractedId);
      if (!planRow) {
        return res.status(404).json({ error: 'Planning extracted record not found' });
      }
    }

    const qtyRaw = body.quantityRequested ?? body.quantity_requested;
    const qty = roundPlanningMaterialQty(Number(qtyRaw));
    if (!(qty > 0)) {
      return res.status(400).json({ error: 'quantityRequested must be greater than 0' });
    }

    const itemType = String(body.itemType ?? body.item_type ?? 'RM').trim().toUpperCase();
    if (itemType !== 'RM' && itemType !== 'PM') {
      return res.status(400).json({ error: 'itemType must be RM or PM' });
    }

    const rawMaterialId =
      body.rawMaterialId != null
        ? parseInt(body.rawMaterialId, 10)
        : body.raw_material_id != null
          ? parseInt(body.raw_material_id, 10)
          : null;
    const packMaterialId =
      body.packMaterialId != null
        ? parseInt(body.packMaterialId, 10)
        : body.pack_material_id != null
          ? parseInt(body.pack_material_id, 10)
          : null;

    const vendorHint = String(body.vendorHint ?? body.vendor_hint ?? '').trim() || null;
    const moqHintRaw = body.moqHint ?? body.moq_hint;
    const moqHint =
      moqHintRaw != null && moqHintRaw !== '' ? roundPlanningMaterialQty(Number(moqHintRaw)) : null;
    const moqHintVal = moqHint != null && moqHint > 0 ? moqHint : null;

    const itemCode = String(body.itemCode ?? body.item_code ?? '').trim() || null;
    const itemName = String(body.itemName ?? body.item_name ?? '').trim() || null;
    const unit = String(body.unit ?? '').trim() || null;
    // RFQ MOQs to be quoted (no price): number[] of order quantities. Tolerates legacy {min} objects.
    const bandsIn = body.moqBands ?? body.moq_bands;
    const moqBands = Array.isArray(bandsIn)
      ? bandsIn
          .map((b) => (b != null && typeof b === 'object' ? Number(b.value ?? b.moq ?? b.min) : Number(b)))
          .filter((n) => Number.isFinite(n) && n > 0)
      : null;
    const expectedRequiredDate = String(body.expectedRequiredDate ?? body.expected_required_date ?? '').trim() || null;
    const notesIn = body.notes != null ? String(body.notes).trim() : '';
    const notes =
      notesIn ||
      buildAskNotes(itemName || 'Material', itemCode || '—', vendorHint || '', moqHintVal || 0);

    const incomingKey = askMergeKey({
      item_type: itemType,
      raw_material_id: rawMaterialId,
      pack_material_id: packMaterialId,
      item_code: itemCode,
      vendor_hint: vendorHint,
      moq_hint: moqHintVal,
    });

    // Dedup/merge only for planning-origin asks (same PI). Procurement-origin requests always create new.
    const pendingRows = planningExtractedId != null
      ? await PlanningQuotationAsk.findAll({
          where: { planning_extracted_id: planningExtractedId, status: 'pending' },
        })
      : [];

    const existing = pendingRows.find((r) => askMergeKey(r) === incomingKey);

    if (existing) {
      const prev = Number(existing.quantity_requested) || 0;
      const nextQty = roundPlanningMaterialQty(prev + qty);
      await existing.update({
        quantity_requested: nextQty,
        notes,
        ...(vendorHint ? { vendor_hint: vendorHint } : {}),
        ...(moqHintVal != null ? { moq_hint: moqHintVal } : {}),
        ...(moqBands ? { moq_bands: moqBands } : {}),
        ...(expectedRequiredDate ? { expected_required_date: expectedRequiredDate } : {}),
      });
      const reloaded = await PlanningQuotationAsk.findByPk(existing.id, {
        include: [peIncludePlanning],
      });
      return res.json(formatAsk(reloaded));
    }

    const row = await PlanningQuotationAsk.create({
      planning_extracted_id: planningExtractedId,
      source,
      moq_bands: moqBands,
      expected_required_date: expectedRequiredDate,
      item_type: itemType,
      raw_material_id:
        itemType === 'RM' && rawMaterialId != null && !Number.isNaN(rawMaterialId) && rawMaterialId > 0
          ? rawMaterialId
          : null,
      pack_material_id:
        itemType === 'PM' && packMaterialId != null && !Number.isNaN(packMaterialId) && packMaterialId > 0
          ? packMaterialId
          : null,
      item_code: itemCode,
      item_name: itemName,
      quantity_requested: qty,
      unit,
      vendor_hint: vendorHint,
      moq_hint: moqHintVal,
      status: 'pending',
      notes,
      requested_by: body.requestedBy ?? body.requested_by ?? req.user?.email ?? null,
    });

    const formatted = await PlanningQuotationAsk.findByPk(row.id, {
      include: [peIncludePlanning],
    });
    res.status(201).json(formatAsk(formatted));
  } catch (err) {
    console.error('createPlanningQuotationAsk error', err);
    res.status(500).json({ error: 'Failed to create planning quotation ask' });
  }
}

async function updatePlanningQuotationAsk(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const row = await PlanningQuotationAsk.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Planning quotation ask not found' });

    const body = req.body || {};
    const updates = {};

    if (body.status !== undefined) {
      const st = String(body.status).trim().toLowerCase();
      if (!['pending', 'fulfilled', 'cancelled'].includes(st)) {
        return res.status(400).json({ error: 'status must be pending, fulfilled, or cancelled' });
      }
      updates.status = st;
      if (st === 'fulfilled') {
        updates.fulfilled_at = new Date();
      } else if (st === 'pending') {
        updates.fulfilled_at = null;
      }
    }

    if (body.notes !== undefined) updates.notes = body.notes;

    const qtyRaw = body.quantityRequested ?? body.quantity_requested;
    if (qtyRaw !== undefined) {
      const qty = Number(qtyRaw);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'quantityRequested must be a positive number' });
      }
      updates.quantity_requested = qty;
    }

    // Editable RFQ fields (Quote Requests → Edit): vendor, MOQ bands, expected date, item, unit.
    if (body.vendorHint !== undefined || body.vendor_hint !== undefined) {
      updates.vendor_hint = String(body.vendorHint ?? body.vendor_hint ?? '').trim() || null;
    }
    if (body.expectedRequiredDate !== undefined || body.expected_required_date !== undefined) {
      updates.expected_required_date =
        String(body.expectedRequiredDate ?? body.expected_required_date ?? '').trim() || null;
    }
    const bandsIn = body.moqBands ?? body.moq_bands;
    if (bandsIn !== undefined) {
      updates.moq_bands = Array.isArray(bandsIn)
        ? bandsIn
            .map((b) => (b != null && typeof b === 'object' ? Number(b.value ?? b.moq ?? b.min) : Number(b)))
            .filter((n) => Number.isFinite(n) && n > 0)
        : null;
    }
    if (body.itemType !== undefined || body.item_type !== undefined) {
      const it = String(body.itemType ?? body.item_type ?? '').trim().toUpperCase();
      if (it !== 'RM' && it !== 'PM') return res.status(400).json({ error: 'itemType must be RM or PM' });
      updates.item_type = it;
      const rmId = body.rawMaterialId ?? body.raw_material_id;
      const pmId = body.packMaterialId ?? body.pack_material_id;
      updates.raw_material_id = it === 'RM' && rmId != null && Number(rmId) > 0 ? parseInt(rmId, 10) : null;
      updates.pack_material_id = it === 'PM' && pmId != null && Number(pmId) > 0 ? parseInt(pmId, 10) : null;
    }
    if (body.itemCode !== undefined || body.item_code !== undefined) {
      updates.item_code = String(body.itemCode ?? body.item_code ?? '').trim() || null;
    }
    if (body.itemName !== undefined || body.item_name !== undefined) {
      updates.item_name = String(body.itemName ?? body.item_name ?? '').trim() || null;
    }
    if (body.unit !== undefined) updates.unit = String(body.unit ?? '').trim() || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await row.update(updates);
    const reloaded = await PlanningQuotationAsk.findByPk(id, { include: [peIncludePlanning] });
    res.json(formatAsk(reloaded));
  } catch (err) {
    console.error('updatePlanningQuotationAsk error', err);
    res.status(500).json({ error: 'Failed to update planning quotation ask' });
  }
}

module.exports = {
  listPlanningQuotationAsks,
  createPlanningQuotationAsk,
  updatePlanningQuotationAsk,
};
