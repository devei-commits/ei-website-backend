const VendorClient = require('./models');
const { Op } = require('sequelize');

function formatRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const data = d.data && typeof d.data === 'object' ? d.data : {};
  return {
    id: String(d.id),
    type: d.type,
    zohoId: d.zoho_id ?? '',
    name: d.name || '',
    email: d.email || '',
    phone: d.phone || '',
    location: d.location || '',
    country: d.country || '',
    city: d.city || '',
    category: d.category || '',
    status: d.status || 'pending',
    paymentTerms: d.payment_terms || '',
    notes: d.notes || '',
    rating: d.rating != null ? d.rating : 0,
    moq: d.moq || '',
    leadTime: d.lead_time || '',
    createdAt: d.created_at,
    lastModified: d.updated_at,
    data: { ...data, entityCode: d.entity_code },
  };
}

async function listVendorClients(req, res) {
  try {
    const typeFilter = req.query.type; // 'vendor' | 'client'
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const statusFilter = req.query.status != null ? String(req.query.status).trim() : '';
    const categoryFilter = req.query.category != null ? String(req.query.category).trim() : '';
    const wantsPagination = req.query.limit != null || req.query.offset != null;

    const where = {};
    if (typeFilter === 'vendor' || typeFilter === 'client') where.type = typeFilter;
    if (statusFilter && statusFilter !== 'all') where.status = statusFilter;
    if (categoryFilter && categoryFilter !== 'all') where.category = categoryFilter;
    if (search) {
      where[Op.or] = [
        { entity_code: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { location: { [Op.iLike]: `%${search}%` } },
        { country: { [Op.iLike]: `%${search}%` } },
        { category: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (wantsPagination) {
      const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : undefined;
      if (limit == null || offset == null || Number.isNaN(limit) || Number.isNaN(offset) || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid limit/offset' });
      }

      const total = await VendorClient.count({ where });
      const rows = await VendorClient.findAll({
        where,
        order: [['updated_at', 'DESC'], ['entity_code', 'ASC']],
        limit,
        offset,
      });
      return res.json({ rows: rows.map(formatRow), total, limit, offset });
    }

    const rows = await VendorClient.findAll({
      where,
      order: [['entity_code', 'ASC']],
    });
    res.json(rows.map(formatRow));
  } catch (err) {
    console.error('listVendorClients error', err);
    res.status(500).json({ error: 'Failed to list vendor/clients' });
  }
}

async function getVendorClientById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await VendorClient.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Vendor/Client not found' });
    res.json(formatRow(row));
  } catch (err) {
    console.error('getVendorClientById error', err);
    res.status(500).json({ error: 'Failed to fetch vendor/client' });
  }
}

/** GET /vendor-client/next-code?type=vendor|client → { nextCode: 'EI-VEN-00001' } */
async function getNextCode(req, res) {
  try {
    const type = (req.query.type || '').toLowerCase();
    const prefix = type === 'client' ? 'EI-CLI-' : 'EI-VEN-';
    const { Op } = require('sequelize');
    const rows = await VendorClient.findAll({
      where: { entity_code: { [Op.like]: `${prefix}%` } },
      attributes: ['entity_code'],
      order: [['entity_code', 'DESC']],
    });
    let nextNum = 1;
    const numericPart = rows
      .map((r) => {
        const code = r.entity_code || r.get?.('entity_code');
        const match = String(code).replace(prefix, '').match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => !Number.isNaN(n));
    if (numericPart.length > 0) nextNum = Math.max(...numericPart) + 1;
    const nextCode = `${prefix}${String(nextNum).padStart(5, '0')}`;
    res.json({ nextCode });
  } catch (err) {
    console.error('getNextCode error', err);
    res.status(500).json({ error: 'Failed to generate next code' });
  }
}

function bodyToPayload(body, type) {
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  return {
    entity_code: body.entityCode ?? data.entityCode ?? null,
    type: type || body.type || 'vendor',
    zoho_id: body.zohoId ?? body.zoho_id ?? data.zohoId ?? data.zoho_id ?? null,
    name: body.name ?? data.tradeName ?? data.legalName ?? null,
    email: body.email ?? data.primaryEmail ?? null,
    phone: body.phone ?? data.primaryPhone ?? null,
    location: body.location ?? data.state ?? null,
    country: body.country ?? data.country ?? null,
    city: body.city ?? null,
    category: body.category ?? data.setupCategory ?? null,
    status: body.status ?? 'pending',
    payment_terms: body.paymentTerms ?? data.paymentTerms ?? null,
    notes: body.notes ?? data.notes ?? null,
    rating: body.rating != null ? body.rating : null,
    moq: body.moq ?? null,
    lead_time: body.leadTime ?? null,
    data,
  };
}

async function createVendorClient(req, res) {
  try {
    const body = req.body || {};
    const type = (body.type || 'vendor').toLowerCase() === 'client' ? 'client' : 'vendor';
    const payload = bodyToPayload(body, type);
    if (!payload.entity_code || !String(payload.entity_code).trim()) {
      return res.status(400).json({ error: 'entityCode is required' });
    }
    const existing = await VendorClient.findOne({
      where: { entity_code: payload.entity_code },
    });
    if (existing) {
      return res.status(400).json({ error: 'An entry with this code already exists' });
    }
    const row = await VendorClient.create({
      entity_code: String(payload.entity_code).trim(),
      type: payload.type,
      zoho_id: payload.zoho_id || null,
      name: payload.name,
      email: payload.email,
      phone: payload.phone,
      location: payload.location,
      country: payload.country,
      city: payload.city,
      category: payload.category,
      status: payload.status,
      payment_terms: payload.payment_terms,
      notes: payload.notes,
      rating: payload.rating,
      moq: payload.moq,
      lead_time: payload.lead_time,
      data: payload.data,
    });
    console.log('[vendor-client] Created', type, 'id=', row.id, 'entity_code=', row.entity_code);
    res.status(201).json(formatRow(row));
  } catch (err) {
    console.error('createVendorClient error', err);
    res.status(500).json({ error: 'Failed to create vendor/client' });
  }
}

async function updateVendorClient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await VendorClient.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Vendor/Client not found' });
    const body = req.body || {};
    const payload = bodyToPayload(body, row.type);

    if (payload.entity_code !== undefined) row.entity_code = String(payload.entity_code).trim();
    if (payload.zoho_id !== undefined) row.zoho_id = payload.zoho_id || null;
    if (payload.name !== undefined) row.name = payload.name;
    if (payload.email !== undefined) row.email = payload.email;
    if (payload.phone !== undefined) row.phone = payload.phone;
    if (payload.location !== undefined) row.location = payload.location;
    if (payload.country !== undefined) row.country = payload.country;
    if (payload.city !== undefined) row.city = payload.city;
    if (payload.category !== undefined) row.category = payload.category;
    if (payload.status !== undefined) row.status = payload.status;
    if (payload.payment_terms !== undefined) row.payment_terms = payload.payment_terms;
    if (payload.notes !== undefined) row.notes = payload.notes;
    if (payload.rating !== undefined) row.rating = payload.rating;
    if (payload.moq !== undefined) row.moq = payload.moq;
    if (payload.lead_time !== undefined) row.lead_time = payload.lead_time;
    if (payload.data !== undefined) row.data = payload.data;

    await row.save();
    res.json(formatRow(row));
  } catch (err) {
    console.error('updateVendorClient error', err);
    res.status(500).json({ error: 'Failed to update vendor/client' });
  }
}

async function deleteVendorClient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await VendorClient.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'Vendor/Client not found' });
    res.status(204).send();
  } catch (err) {
    console.error('deleteVendorClient error', err);
    res.status(500).json({ error: 'Failed to delete vendor/client' });
  }
}

module.exports = {
  listVendorClients,
  getVendorClientById,
  getNextCode,
  createVendorClient,
  updateVendorClient,
  deleteVendorClient,
};
