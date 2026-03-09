const VendorClient = require('../vendorClient/models');
const { ClientQuery, ClientDevelopment, ClientOrder, ClientAppointment } = require('./models');
const { User } = require('../users/models');

function formatClient(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    entityCode: d.entity_code,
    name: d.name || '',
    email: d.email || '',
    phone: d.phone || '',
    segment: d.segment || '',
    priority: d.priority || 'medium',
    sinceYear: d.since_year,
    revenueValue: d.revenue_value ? parseFloat(d.revenue_value) : 0,
    avatarColor: d.avatar_color || 'blue',
    initials: (d.name || '').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2),
    accountManagerId: d.account_manager_id,
    accountManagerName: d.accountManager
      ? [d.accountManager.fname, d.accountManager.lname].filter(Boolean).join(' ') || d.accountManager.display_name || d.accountManager.email
      : null,
    contacts: Array.isArray(d.contacts) ? d.contacts : [],
    status: d.status || 'active',
    category: d.category || '',
    queries: (d.clientQueries || []).map(formatQuery),
    devs: (d.clientDevelopments || []).map(formatDev),
    orders: (d.clientOrders || []).map(formatOrder),
    appts: (d.clientAppointments || []).map(formatAppt),
  };
}

function formatQuery(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return { id: String(d.id), title: d.title, status: d.status, due: d.due_date, cat: d.category, note: d.notes || '' };
}

function formatDev(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return { id: String(d.id), pr: d.pr_code, name: d.name, stage: d.stage, status: d.status, due: d.due_date, phase: d.phase };
}

function formatOrder(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return { id: String(d.id), prod: d.product_name, qty: d.quantity, status: d.status, due: d.due_date, batch: d.batch_code };
}

function formatAppt(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return { id: String(d.id), title: d.title, date: d.appointment_date, time: d.appointment_time, type: d.type, with: d.with_person };
}

const clientIncludes = [
  { model: User, as: 'accountManager', attributes: ['userid', 'fname', 'lname', 'display_name', 'email'] },
  { model: ClientQuery, as: 'clientQueries', order: [['due_date', 'ASC']] },
  { model: ClientDevelopment, as: 'clientDevelopments', order: [['due_date', 'ASC']] },
  { model: ClientOrder, as: 'clientOrders', order: [['due_date', 'ASC']] },
  { model: ClientAppointment, as: 'clientAppointments', order: [['appointment_date', 'ASC']] },
];

async function getDashboard(req, res) {
  try {
    const rows = await VendorClient.findAll({
      where: { type: 'client' },
      include: clientIncludes,
      order: [['name', 'ASC']],
    });

    const clients = rows.map(formatClient);

    let totalRevenue = 0;
    let totalOverdue = 0;
    let totalPending = 0;
    let totalActiveOrders = 0;
    let totalDevs = 0;
    let totalAppts = 0;
    let highPriority = 0;

    for (const c of clients) {
      totalRevenue += c.revenueValue || 0;
      if (c.priority === 'high') highPriority++;
      totalDevs += c.devs.length;
      totalAppts += c.appts.length;
      for (const q of c.queries) {
        if (q.status === 'overdue') totalOverdue++;
        if (q.status === 'pending') totalPending++;
      }
      for (const d of c.devs) {
        if (d.status === 'overdue') totalOverdue++;
        if (d.status === 'pending') totalPending++;
      }
      for (const o of c.orders) {
        if (o.status === 'overdue') totalOverdue++;
        if (o.status === 'pending') totalPending++;
        if (['inprog', 'pending'].includes(o.status)) totalActiveOrders++;
      }
    }

    res.json({
      clients,
      kpis: {
        totalOverdue,
        totalPending,
        activeClients: clients.length,
        highPriority,
        activeOrders: totalActiveOrders,
        totalDevs,
        totalAppts,
        totalRevenue,
      },
    });
  } catch (err) {
    console.error('getDashboard error:', err);
    res.status(500).json({ error: 'Failed to load client hub dashboard' });
  }
}

async function getClientById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const row = await VendorClient.findOne({
      where: { id, type: 'client' },
      include: clientIncludes,
    });
    if (!row) return res.status(404).json({ error: 'Client not found' });

    res.json(formatClient(row));
  } catch (err) {
    console.error('getClientById error:', err);
    res.status(500).json({ error: 'Failed to fetch client' });
  }
}

async function createClient(req, res) {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { Op } = require('sequelize');
    const existingCodes = await VendorClient.findAll({
      where: { entity_code: { [Op.like]: 'EI-CLI-%' } },
      attributes: ['entity_code'],
      order: [['entity_code', 'DESC']],
    });
    let nextNum = 1;
    for (const r of existingCodes) {
      const m = String(r.entity_code).replace('EI-CLI-', '').match(/^(\d+)/);
      if (m) { nextNum = Math.max(nextNum, parseInt(m[1], 10) + 1); }
    }
    const entityCode = `EI-CLI-${String(nextNum).padStart(5, '0')}`;

    const row = await VendorClient.create({
      entity_code: entityCode,
      type: 'client',
      name: String(body.name).trim(),
      email: body.email || null,
      phone: body.phone || null,
      status: 'active',
      priority: body.priority || 'medium',
      segment: body.segment || null,
      since_year: body.sinceYear || new Date().getFullYear(),
      revenue_value: body.revenueValue || 0,
      avatar_color: body.avatarColor || 'blue',
      account_manager_id: body.accountManagerId || null,
      contacts: body.contacts || [],
    });

    const full = await VendorClient.findByPk(row.id, { include: clientIncludes });
    res.status(201).json(formatClient(full));
  } catch (err) {
    console.error('createClient error:', err);
    res.status(500).json({ error: 'Failed to create client' });
  }
}

async function addQuery(req, res) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: 'title is required' });
    const row = await ClientQuery.create({
      client_id: clientId,
      title: body.title,
      status: body.status || 'new',
      due_date: body.due || null,
      category: body.cat || null,
      notes: body.note || null,
    });
    res.status(201).json(formatQuery(row));
  } catch (err) {
    console.error('addQuery error:', err);
    res.status(500).json({ error: 'Failed to add query' });
  }
}

async function addDevelopment(req, res) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: 'name is required' });
    const row = await ClientDevelopment.create({
      client_id: clientId,
      pr_code: body.pr || null,
      name: body.name,
      stage: body.stage || 'R&D Stage',
      status: body.status || 'new',
      due_date: body.due || null,
      phase: body.phase || null,
    });
    res.status(201).json(formatDev(row));
  } catch (err) {
    console.error('addDevelopment error:', err);
    res.status(500).json({ error: 'Failed to add development' });
  }
}

async function addOrder(req, res) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const body = req.body || {};
    if (!body.prod) return res.status(400).json({ error: 'prod is required' });
    const row = await ClientOrder.create({
      client_id: clientId,
      product_name: body.prod,
      quantity: body.qty || null,
      status: body.status || 'pending',
      due_date: body.due || null,
      batch_code: body.batch || null,
    });
    res.status(201).json(formatOrder(row));
  } catch (err) {
    console.error('addOrder error:', err);
    res.status(500).json({ error: 'Failed to add order' });
  }
}

async function addAppointment(req, res) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: 'title is required' });
    const row = await ClientAppointment.create({
      client_id: clientId,
      title: body.title,
      appointment_date: body.date || null,
      appointment_time: body.time || null,
      type: body.type || null,
      with_person: body.with || null,
    });
    res.status(201).json(formatAppt(row));
  } catch (err) {
    console.error('addAppointment error:', err);
    res.status(500).json({ error: 'Failed to add appointment' });
  }
}

async function updateQuery(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await ClientQuery.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Query not found' });
    const body = req.body || {};
    if (body.title !== undefined) row.title = body.title;
    if (body.status !== undefined) row.status = body.status;
    if (body.due !== undefined) row.due_date = body.due;
    if (body.cat !== undefined) row.category = body.cat;
    if (body.note !== undefined) row.notes = body.note;
    await row.save();
    res.json(formatQuery(row));
  } catch (err) {
    console.error('updateQuery error:', err);
    res.status(500).json({ error: 'Failed to update query' });
  }
}

async function updateDevelopment(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await ClientDevelopment.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Development not found' });
    const body = req.body || {};
    if (body.pr !== undefined) row.pr_code = body.pr;
    if (body.name !== undefined) row.name = body.name;
    if (body.stage !== undefined) row.stage = body.stage;
    if (body.status !== undefined) row.status = body.status;
    if (body.due !== undefined) row.due_date = body.due;
    if (body.phase !== undefined) row.phase = body.phase;
    await row.save();
    res.json(formatDev(row));
  } catch (err) {
    console.error('updateDevelopment error:', err);
    res.status(500).json({ error: 'Failed to update development' });
  }
}

async function updateOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await ClientOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Order not found' });
    const body = req.body || {};
    if (body.prod !== undefined) row.product_name = body.prod;
    if (body.qty !== undefined) row.quantity = body.qty;
    if (body.status !== undefined) row.status = body.status;
    if (body.due !== undefined) row.due_date = body.due;
    if (body.batch !== undefined) row.batch_code = body.batch;
    await row.save();
    res.json(formatOrder(row));
  } catch (err) {
    console.error('updateOrder error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
}

async function updateAppointment(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await ClientAppointment.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Appointment not found' });
    const body = req.body || {};
    if (body.title !== undefined) row.title = body.title;
    if (body.date !== undefined) row.appointment_date = body.date;
    if (body.time !== undefined) row.appointment_time = body.time;
    if (body.type !== undefined) row.type = body.type;
    if (body.with !== undefined) row.with_person = body.with;
    await row.save();
    res.json(formatAppt(row));
  } catch (err) {
    console.error('updateAppointment error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
}

module.exports = {
  getDashboard,
  getClientById,
  createClient,
  addQuery,
  addDevelopment,
  addOrder,
  addAppointment,
  updateQuery,
  updateDevelopment,
  updateOrder,
  updateAppointment,
};
