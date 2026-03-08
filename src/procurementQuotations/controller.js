const ProcurementQuotation = require('./models');
const ProcurementRequest = require('../procurementRequests/models');
const VendorClient = require('../vendorClient/models');

function formatQuotation(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: d.id,
    procurementRequestId: d.procurement_request_id,
    vendorId: d.vendor_id,
    quoteDate: d.quote_date,
    quotedBy: d.quoted_by,
    attachmentRef: d.attachment_ref,
    attachmentStatus: d.attachment_status,
    items: d.items,
    leadTimeDays: d.lead_time_days,
    paymentTerms: d.payment_terms,
    validTill: d.valid_till,
    totalValue: d.total_value != null ? Number(d.total_value) : null,
    notes: d.notes,
    status: d.status,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    vendorName: d.vendor?.name ?? null,
    procurementRequest: d.procurementRequest
      ? {
          id: d.procurementRequest.id,
          priority: d.procurementRequest.priority,
          requiredByDate: d.procurementRequest.required_by_date ?? d.procurementRequest.requiredByDate,
          status: d.procurementRequest.status,
        }
      : undefined,
  };
}

async function listProcurementQuotations(req, res) {
  try {
    const procurementRequestId =
      req.query.procurement_request_id != null ? parseInt(req.query.procurement_request_id, 10) : null;
    const vendorId = req.query.vendor_id != null ? parseInt(req.query.vendor_id, 10) : null;
    const status = req.query.status || null;
    const where = {};
    if (procurementRequestId != null && !Number.isNaN(procurementRequestId)) {
      where.procurement_request_id = procurementRequestId;
    }
    if (vendorId != null && !Number.isNaN(vendorId)) {
      where.vendor_id = vendorId;
    }
    if (status) {
      where.status = status;
    }
    const rows = await ProcurementQuotation.findAll({
      where,
      order: [['quote_date', 'DESC'], ['created_at', 'DESC']],
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', attributes: ['id', 'priority', 'required_by_date', 'status', 'items'], required: false },
        { model: VendorClient, as: 'vendor', attributes: ['id', 'name', 'entity_code', 'category', 'payment_terms', 'rating'], required: false },
      ],
    });
    res.json(rows.map((r) => formatQuotation(r)));
  } catch (err) {
    console.error('listProcurementQuotations error', err);
    res.status(500).json({ error: 'Failed to list procurement quotations' });
  }
}

async function getProcurementQuotationById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementQuotation.findByPk(id, {
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', required: false },
        { model: VendorClient, as: 'vendor', required: false },
      ],
    });
    if (!row) return res.status(404).json({ error: 'Procurement quotation not found' });
    res.json(formatQuotation(row));
  } catch (err) {
    console.error('getProcurementQuotationById error', err);
    res.status(500).json({ error: 'Failed to fetch procurement quotation' });
  }
}

async function createProcurementQuotation(req, res) {
  try {
    const body = req.body || {};
    const procurementRequestId = body.procurementRequestId ?? body.procurement_request_id;
    const vendorId = body.vendorId ?? body.vendor_id;
    if (procurementRequestId == null) {
      return res.status(400).json({ error: 'procurementRequestId is required' });
    }
    if (vendorId == null) {
      return res.status(400).json({ error: 'vendorId is required' });
    }
    const prId = parseInt(procurementRequestId, 10);
    const vId = parseInt(vendorId, 10);
    if (Number.isNaN(prId)) return res.status(400).json({ error: 'Invalid procurementRequestId' });
    if (Number.isNaN(vId)) return res.status(400).json({ error: 'Invalid vendorId' });
    const [prRow, vendorRow] = await Promise.all([
      ProcurementRequest.findByPk(prId),
      VendorClient.findByPk(vId),
    ]);
    if (!prRow) return res.status(404).json({ error: 'Procurement request not found' });
    if (!vendorRow) return res.status(404).json({ error: 'Vendor not found' });
    const row = await ProcurementQuotation.create({
      procurement_request_id: prId,
      vendor_id: vId,
      quote_date: body.quoteDate ?? body.quote_date ?? null,
      quoted_by: body.quotedBy ?? body.quoted_by ?? req.user?.email ?? null,
      attachment_ref: body.attachmentRef ?? body.attachment_ref ?? null,
      attachment_status: body.attachmentStatus ?? body.attachment_status ?? 'pending',
      items: body.items ?? [],
      lead_time_days: body.leadTimeDays ?? body.lead_time_days ?? null,
      payment_terms: body.paymentTerms ?? body.payment_terms ?? null,
      valid_till: body.validTill ?? body.valid_till ?? null,
      total_value: body.totalValue ?? body.total_value ?? null,
      notes: body.notes ?? null,
      status: body.status ?? 'pending',
    });
    const created = await ProcurementQuotation.findByPk(row.id, {
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', attributes: ['id', 'priority', 'required_by_date', 'status'], required: false },
        { model: VendorClient, as: 'vendor', attributes: ['id', 'name', 'entity_code'], required: false },
      ],
    });
    res.status(201).json(formatQuotation(created));
  } catch (err) {
    console.error('createProcurementQuotation error', err);
    res.status(500).json({ error: 'Failed to create procurement quotation' });
  }
}

async function updateProcurementQuotation(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementQuotation.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement quotation not found' });
    const body = req.body || {};
    const updates = {};
    if (body.quoteDate !== undefined) updates.quote_date = body.quoteDate;
    if (body.quote_date !== undefined) updates.quote_date = body.quote_date;
    if (body.quotedBy !== undefined) updates.quoted_by = body.quotedBy;
    if (body.quoted_by !== undefined) updates.quoted_by = body.quoted_by;
    if (body.attachmentRef !== undefined) updates.attachment_ref = body.attachmentRef;
    if (body.attachment_ref !== undefined) updates.attachment_ref = body.attachment_ref;
    if (body.attachmentStatus !== undefined) updates.attachment_status = body.attachmentStatus;
    if (body.attachment_status !== undefined) updates.attachment_status = body.attachment_status;
    if (body.items !== undefined) updates.items = body.items;
    if (body.leadTimeDays !== undefined) updates.lead_time_days = body.leadTimeDays;
    if (body.lead_time_days !== undefined) updates.lead_time_days = body.lead_time_days;
    if (body.paymentTerms !== undefined) updates.payment_terms = body.paymentTerms;
    if (body.payment_terms !== undefined) updates.payment_terms = body.payment_terms;
    if (body.validTill !== undefined) updates.valid_till = body.validTill;
    if (body.valid_till !== undefined) updates.valid_till = body.valid_till;
    if (body.totalValue !== undefined) updates.total_value = body.totalValue;
    if (body.total_value !== undefined) updates.total_value = body.total_value;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.status !== undefined) updates.status = body.status;
    if (Object.keys(updates).length > 0) {
      await row.update(updates);
    }
    const updated = await ProcurementQuotation.findByPk(id, {
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', attributes: ['id', 'priority', 'required_by_date', 'status'], required: false },
        { model: VendorClient, as: 'vendor', attributes: ['id', 'name', 'entity_code'], required: false },
      ],
    });
    res.json(formatQuotation(updated));
  } catch (err) {
    console.error('updateProcurementQuotation error', err);
    res.status(500).json({ error: 'Failed to update procurement quotation' });
  }
}

async function deleteProcurementQuotation(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementQuotation.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement quotation not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteProcurementQuotation error', err);
    res.status(500).json({ error: 'Failed to delete procurement quotation' });
  }
}

module.exports = {
  listProcurementQuotations,
  getProcurementQuotationById,
  createProcurementQuotation,
  updateProcurementQuotation,
  deleteProcurementQuotation,
};
