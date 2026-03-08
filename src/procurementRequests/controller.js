const ProcurementRequest = require('./models');
const PlanningExtracted = require('../planningExtracted/models');

function formatPR(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    planningExtractedId: d.planning_extracted_id,
    priority: d.priority,
    requiredByDate: d.required_by_date,
    notes: d.notes,
    items: d.items,
    status: d.status,
    preferredVendor: d.preferred_vendor,
    requestedBy: d.requested_by,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

async function listProcurementRequests(req, res) {
  try {
    const planningExtractedId = req.query.planning_extracted_id != null
      ? parseInt(req.query.planning_extracted_id, 10)
      : null;
    const where = {};
    if (planningExtractedId != null && !Number.isNaN(planningExtractedId)) {
      where.planning_extracted_id = planningExtractedId;
    }
    const rows = await ProcurementRequest.findAll({
      where,
      order: [['created_at', 'DESC']],
      include: [{ model: PlanningExtracted, as: 'planningExtracted', attributes: ['id'], required: false }],
    });
    res.json(rows.map(formatPR));
  } catch (err) {
    console.error('listProcurementRequests error', err);
    res.status(500).json({ error: 'Failed to list procurement requests' });
  }
}

async function getProcurementRequestById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementRequest.findByPk(id, {
      include: [{ model: PlanningExtracted, as: 'planningExtracted', required: false }],
    });
    if (!row) return res.status(404).json({ error: 'Procurement request not found' });
    res.json(formatPR(row));
  } catch (err) {
    console.error('getProcurementRequestById error', err);
    res.status(500).json({ error: 'Failed to fetch procurement request' });
  }
}

async function createProcurementRequest(req, res) {
  try {
    const body = req.body || {};
    const planningExtractedId = body.planningExtractedId ?? body.planning_extracted_id;
    if (planningExtractedId == null) {
      return res.status(400).json({ error: 'planningExtractedId is required' });
    }
    const id = parseInt(planningExtractedId, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid planningExtractedId' });
    const planRow = await PlanningExtracted.findByPk(id);
    if (!planRow) return res.status(404).json({ error: 'Planning extracted record not found' });
    const row = await ProcurementRequest.create({
      planning_extracted_id: id,
      priority: body.priority ?? null,
      required_by_date: body.requiredByDate ?? body.required_by_date ?? null,
      notes: body.notes ?? null,
      items: body.items ?? [],
      status: body.status ?? 'Pending',
      requested_by: body.requestedBy ?? body.requested_by ?? req.user?.email ?? null,
    });
    const created = await ProcurementRequest.findByPk(row.id);
    res.status(201).json(formatPR(created));
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
    if (body.items !== undefined) updates.items = body.items;
    if (body.status !== undefined) updates.status = body.status;
    if (body.preferredVendor !== undefined) updates.preferred_vendor = body.preferredVendor;
    if (body.preferred_vendor !== undefined) updates.preferred_vendor = body.preferred_vendor;
    if (Object.keys(updates).length > 0) {
      await row.update(updates);
    }
    const updated = await ProcurementRequest.findByPk(id);
    res.json(formatPR(updated));
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
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteProcurementRequest error', err);
    res.status(500).json({ error: 'Failed to delete procurement request' });
  }
}

module.exports = {
  listProcurementRequests,
  getProcurementRequestById,
  createProcurementRequest,
  updateProcurementRequest,
  deleteProcurementRequest,
};
