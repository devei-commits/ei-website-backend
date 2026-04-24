const Enquiry = require('./models');
const sequelize = require('../../db');
const { createTicketSchema, updateTicketSchema, addMessageSchema } = require('./schemas');
const {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SOURCES,
  ACTIVITY_TYPES,
  CROSS_TEAM_TEAMS,
  TICKET_ISSUE_AREAS,
} = require('./constants');
const { Op } = require('sequelize');

const ADMIN_ROLES = ['super_admin', 'admin'];

function isAdmin(req) {
  return req.user && req.user.role && ADMIN_ROLES.includes(req.user.role);
}

function normalizeCollaboration(raw) {
  if (!raw || typeof raw !== 'object') {
    return { taggedMembers: [], taggedTeams: [], issueAreas: [] };
  }
  return {
    taggedMembers: Array.isArray(raw.taggedMembers) ? raw.taggedMembers : [],
    taggedTeams: Array.isArray(raw.taggedTeams) ? raw.taggedTeams : [],
    issueAreas: Array.isArray(raw.issueAreas) ? raw.issueAreas : [],
  };
}

/** Admin, ticket owner, or @mentioned on an internal ticket */
function canAccessTicket(row, req) {
  if (!row || !req.user) return false;
  if (isAdmin(req)) return true;
  const uid = Number(req.user.id);
  if (Number(row.user_id) === uid) return true;
  const plain = row.get ? row.get({ plain: true }) : row;
  if (plain.ticket_scope === 'internal' && plain.collaboration) {
    const c = normalizeCollaboration(plain.collaboration);
    return c.taggedMembers.some((m) => Number(m.userid) === uid);
  }
  return false;
}

/** Format DB row to ticket response (camelCase, computed isOverdue) */
function formatTicket(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const sla = d.sla_deadline ? new Date(d.sla_deadline) : null;
  const now = new Date();
  const isOverdue = sla && now > sla && !d.resolved_at;
  const scope = d.ticket_scope || 'customer';
  return {
    id: String(d.enquiry_id),
    ticketNumber: d.ticket_number || `TKT-${d.enquiry_id}`,
    ticketScope: scope,
    customer: d.customer || null,
    subject: d.subject,
    description: d.description,
    category: d.category,
    priority: d.priority || 'medium',
    status: d.status || 'new',
    source: d.source,
    collaboration: scope === 'internal' ? normalizeCollaboration(d.collaboration) : undefined,
    tags: Array.isArray(d.tags) ? d.tags : [],
    currentAssignee: d.current_assignee || undefined,
    assignmentHistory: Array.isArray(d.assignment_history) ? d.assignment_history : [],
    linkedOrders: Array.isArray(d.linked_orders) ? d.linked_orders : [],
    messages: Array.isArray(d.messages) ? d.messages : [],
    activities: Array.isArray(d.activities) ? d.activities : [],
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    firstResponseAt: d.first_response_at || undefined,
    slaDeadline: d.sla_deadline || undefined,
    resolvedAt: d.resolved_at || undefined,
    resolutionNotes: d.resolution_notes || undefined,
    isOverdue: !!isOverdue,
    responseCount: d.response_count != null ? d.response_count : 0,
  };
}

/** Get ticket types (categories, priorities, statuses, sources) for dropdowns */
function getTicketTypes(req, res) {
  res.status(200).json({
    success: true,
    data: {
      categories: TICKET_CATEGORIES,
      priorities: TICKET_PRIORITIES,
      statuses: TICKET_STATUSES,
      sources: TICKET_SOURCES,
      activityTypes: ACTIVITY_TYPES,
      crossTeamTeams: CROSS_TEAM_TEAMS,
      issueAreas: TICKET_ISSUE_AREAS,
    },
  });
}

/** Generate next ticket number TKT-YYYY-NNNN */
async function getNextTicketNumber() {
  const year = new Date().getFullYear();
  const prefix = `TKT-${year}-`;
  const last = await Enquiry.findOne({
    where: { ticket_number: { [Op.like]: `${prefix}%` } },
    order: [['enquiry_id', 'DESC']],
    attributes: ['ticket_number'],
  });
  let next = 1;
  if (last && last.ticket_number) {
    const match = last.ticket_number.match(new RegExp(`${prefix}(\\d+)`));
    if (match) next = parseInt(match[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/** Raise a new ticket (create). Customer snapshot from req.user or body. */
async function createTicket(req, res, next) {
  try {
    const { error, value } = createTicketSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const now = new Date();
    const user = req.user;

    let customer = value.customer;
    if (!customer && user) {
      customer = {
        id: user.id ? String(user.id) : undefined,
        name: user.fullName || user.email || '',
        email: user.email || '',
        phone: user.mobile || user.phone || '',
        company: undefined,
        isRegistered: true,
      };
    }
    if (!customer) {
      return res.status(400).json({ success: false, message: 'Customer info or authentication required' });
    }

    const ticketNumber = await getNextTicketNumber();
    const slaDeadline = new Date(now);
    slaDeadline.setDate(slaDeadline.getDate() + 1);

    const ticketScope = value.ticket_scope || 'customer';
    const source =
      ticketScope === 'internal' ? value.source || 'internal-cross-team' : value.source || 'website';
    const collaboration =
      ticketScope === 'internal' ? normalizeCollaboration(value.collaboration) : null;

    const activity = {
      id: `ACT-${Date.now()}`,
      ticketId: null,
      type: 'created',
      description:
        ticketScope === 'internal'
          ? 'Cross-team internal ticket created'
          : `Ticket created from ${source}`,
      performedBy: { id: user?.id ? String(user.id) : 'SYSTEM', name: user?.fullName || 'System', role: user?.roleName || 'System' },
      timestamp: now.toISOString(),
    };

    const record = await Enquiry.create({
      ticket_number: ticketNumber,
      user_id: user ? user.id : null,
      customer,
      subject: value.subject,
      description: value.description || '',
      category: value.category || 'other',
      priority: value.priority || 'medium',
      status: 'new',
      source,
      ticket_scope: ticketScope,
      collaboration,
      tags: value.tags || [],
      current_assignee: null,
      assignment_history: [],
      linked_orders: [],
      messages: [],
      activities: [activity],
      first_response_at: null,
      sla_deadline: slaDeadline,
      resolved_at: null,
      resolution_notes: null,
      response_count: 0,
      created_at: now,
      updated_at: now,
    });

    activity.ticketId = String(record.enquiry_id);
    await record.update({ activities: [activity], updated_at: now });

    res.status(201).json({
      success: true,
      message: 'Ticket raised successfully',
      data: formatTicket(record),
    });
  } catch (err) {
    console.error('Error creating ticket:', err);
    next(err);
  }
}

/** List tickets: admin sees all, other users see only their own (user_id = req.user.id) */
async function listTickets(req, res, next) {
  try {
    const ticketScopeQuery = req.query.ticket_scope;
    let where = {};

    if (isAdmin(req)) {
      if (ticketScopeQuery === 'internal') where.ticket_scope = 'internal';
      else if (ticketScopeQuery === 'customer') {
        where = { [Op.or]: [{ ticket_scope: 'customer' }, { ticket_scope: null }] };
      }
    } else {
      const uid = Number(req.user.id);
      const taggedInternalLiteral = sequelize.literal(`EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(("Enquiry"."collaboration"::jsonb)->'taggedMembers', '[]'::jsonb)) elem
        WHERE (elem->>'userid')::int = ${uid}
      )`);
      const ownOrTaggedInternal = {
        [Op.or]: [{ user_id: req.user.id }, { [Op.and]: [{ ticket_scope: 'internal' }, taggedInternalLiteral] }],
      };
      if (ticketScopeQuery === 'internal') {
        where = { [Op.and]: [ownOrTaggedInternal, { ticket_scope: 'internal' }] };
      } else if (ticketScopeQuery === 'customer') {
        where = {
          [Op.and]: [
            { user_id: req.user.id },
            { [Op.or]: [{ ticket_scope: 'customer' }, { ticket_scope: null }] },
          ],
        };
      } else {
        where = ownOrTaggedInternal;
      }
    }

    const rows = await Enquiry.findAll({
      where,
      order: [['created_at', 'DESC']],
    });
    res.status(200).json({
      success: true,
      data: rows.map(formatTicket),
    });
  } catch (err) {
    console.error('Error listing tickets:', err);
    next(err);
  }
}

/** Get one ticket by id. Admin: any; user: only own. */
async function getTicketById(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const row = await Enquiry.findByPk(id);
    if (!row) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!canAccessTicket(row, req)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this ticket' });
    }
    res.status(200).json({ success: true, data: formatTicket(row) });
  } catch (err) {
    console.error('Error fetching ticket:', err);
    next(err);
  }
}

/** Update ticket. Admin: full update; user: only own ticket, limited fields (e.g. no status/assignee). */
async function updateTicket(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const row = await Enquiry.findByPk(id);
    if (!row) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!canAccessTicket(row, req)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this ticket' });
    }

    const { error, value } = updateTicketSchema.validate(req.body, { allowUnknown: true });
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const now = new Date();
    const allowedSnake = [
      'subject', 'description', 'category', 'priority', 'status', 'source', 'tags',
      'current_assignee', 'assignment_history', 'linked_orders', 'messages', 'activities',
      'first_response_at', 'sla_deadline', 'resolved_at', 'resolution_notes', 'response_count',
    ];
    const camelToSnake = {
      currentAssignee: 'current_assignee',
      assignmentHistory: 'assignment_history',
      linkedOrders: 'linked_orders',
      firstResponseAt: 'first_response_at',
      slaDeadline: 'sla_deadline',
      resolvedAt: 'resolved_at',
      resolutionNotes: 'resolution_notes',
      responseCount: 'response_count',
    };

    if (!isAdmin(req)) {
      // Non-admin: only allow updating subject/description for their own ticket; use POST /:id/messages to add a message
      const userAllowed = ['subject', 'description'];
      for (const key of userAllowed) {
        const snake = camelToSnake[key] || key;
        if (value[key] !== undefined) row.set(snake, value[key]);
      }
    } else {
      for (const key of allowedSnake) {
        if (value[key] !== undefined) {
          row.set(key, key === 'collaboration' ? normalizeCollaboration(value[key]) : value[key]);
        }
      }
      for (const [camel, snake] of Object.entries(camelToSnake)) {
        if (value[camel] !== undefined) {
          row.set(snake, snake === 'collaboration' ? normalizeCollaboration(value[camel]) : value[camel]);
        }
      }
    }

    row.set('updated_at', now);
    await row.save();

    const updated = await Enquiry.findByPk(id);
    res.status(200).json({ success: true, message: 'Ticket updated', data: formatTicket(updated) });
  } catch (err) {
    console.error('Error updating ticket:', err);
    next(err);
  }
}

/** Add a message to a ticket (customer or staff). User can add to own ticket; admin to any. */
async function addMessage(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const { error, value } = addMessageSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const row = await Enquiry.findByPk(id);
    if (!row) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!canAccessTicket(row, req)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this ticket' });
    }

    const user = req.user;
    const senderType = isAdmin(req) ? 'staff' : 'customer';
    const msg = {
      id: `MSG-${Date.now()}`,
      ticketId: String(id),
      senderId: String(user.id),
      senderName: user.fullName || user.email || 'Customer',
      senderType,
      content: value.content,
      sentAt: new Date().toISOString(),
      isInternal: !!value.isInternal,
    };
    const messages = Array.isArray(row.messages) ? [...row.messages] : [];
    messages.push(msg);

    const now = new Date();
    let firstResponseAt = row.first_response_at;
    if (!firstResponseAt && senderType === 'staff') firstResponseAt = now;
    const responseCount = (row.response_count || 0) + (senderType === 'customer' ? 0 : 1);

    await row.update({
      messages,
      first_response_at: firstResponseAt,
      response_count: responseCount,
      updated_at: now,
    });

    const updated = await Enquiry.findByPk(id);
    res.status(200).json({ success: true, message: 'Message added', data: formatTicket(updated) });
  } catch (err) {
    console.error('Error adding message:', err);
    next(err);
  }
}

module.exports = {
  getTicketTypes,
  createTicket,
  listTickets,
  getTicketById,
  updateTicket,
  addMessage,
  formatTicket,
  isAdmin,
};
