/**
 * BD Management — Phase 2 transaction queues: Meetings (§3H), Queries (§3F),
 * Grievances (§3G). Cross-client queues plus per-client create endpoints.
 *
 * Conventions mirror controller.js: bare-JSON responses, snake→camel formatRow,
 * `id: String(...)`, `res.status(500).json({ error })`. Every create/transition
 * writes a bd_events row (source 'auto') so the §3B timeline stays in sync.
 *
 * Honesty note: the spec's external sends (email / WhatsApp / PDF / auto-page)
 * have no integration in this codebase. These handlers persist the response/MoM
 * text and advance status truthfully; they do NOT claim to have dispatched a
 * message. The UI surfaces "recorded", not "sent".
 */
const { Op } = require('sequelize');
const { activeRowWhere } = require('../lib/softDelete');
const VendorClient = require('../vendorClient/models');
const { BdMeeting, BdQuery, BdGrievance, BdEvent, BdClientProfile } = require('./models');
const { assignSequentialCode } = require('./codes');
const { tierFromRevenue } = require('./rollups');

/* ── small shared helpers (kept local so this file is self-contained) ─────── */
function plain(row) { return row && row.get ? row.get({ plain: true }) : row; }

function displayCode(entityCode) {
  const m = String(entityCode || '').match(/(\d+)\s*$/);
  return m ? `C-${String(parseInt(m[1], 10)).padStart(3, '0')}` : (entityCode || '—');
}

function actorFromReq(req) {
  const u = req.user || {};
  return {
    id: u.userid ?? u.id ?? null,
    name: u.display_name || [u.fname, u.lname].filter(Boolean).join(' ').trim() || u.email || null,
  };
}

/** Resolve a client by entity_code (EI-CLI-…) or numeric id; clients only. */
async function loadClientByCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  const where = /^\d+$/.test(raw) ? { id: Number(raw) } : { entity_code: raw };
  return VendorClient.findOne({ where: activeRowWhere({ type: 'client', ...where }) });
}

/** Best-effort tier for a client (manual profile override, else from stored revenue). */
function tierForClient(client, profile) {
  if (profile && profile.tier) return profile.tier;
  return tierFromRevenue(Number(client.revenue_value || 0));
}

const QUERY_SLA_HOURS = { platinum: 4, gold: 8, silver: 24, bronze: 48 };
const GRIEVANCE_SLA_HOURS = { critical: 1, high: 4, medium: 24, low: 48 };

/** Write a timeline event (auto). Never throws into the request path. */
async function recordEvent(clientId, type, title, opts = {}) {
  try {
    await BdEvent.create({
      client_id: clientId,
      type,
      title,
      body: opts.body || null,
      ref_type: opts.refType || null,
      ref_id: opts.refId || null,
      actor_id: opts.actorId ?? null,
      actor_name: opts.actorName || null,
      source: opts.source || 'auto',
      occurred_at: opts.occurredAt || new Date(),
    });
  } catch (e) {
    console.error('bd.recordEvent failed', e.message);
  }
}

/** Index every client once → { byId } for queue joins (name/code/tier chips). */
async function loadClientIndex() {
  const [clients, profiles] = await Promise.all([
    VendorClient.findAll({ where: activeRowWhere({ type: 'client' }) }),
    BdClientProfile.findAll({ where: activeRowWhere() }),
  ]);
  const profileByClient = new Map(profiles.map((p) => [Number(plain(p).client_id), plain(p)]));
  const byId = new Map();
  for (const row of clients) {
    const c = plain(row);
    byId.set(Number(c.id), { client: c, profile: profileByClient.get(Number(c.id)) || null });
  }
  return byId;
}

function clientChip(entry) {
  if (!entry) return { id: null, code: null, displayCode: '—', name: '—', tier: 'bronze' };
  const { client, profile } = entry;
  return {
    id: String(client.id),
    code: client.entity_code,
    displayCode: displayCode(client.entity_code),
    name: client.name,
    tier: tierForClient(client, profile),
  };
}

/* ════════════════════════════ QUERIES (§3F) ════════════════════════════ */
function formatQuery(d, chip) {
  return {
    id: String(d.id),
    code: d.code,
    client: chip,
    origin: d.origin,
    relatedType: d.related_type,
    relatedRef: d.related_ref,
    relatedInfo: d.related_info,
    subject: d.subject,
    description: d.description,
    assignee: { id: d.assignee_id != null ? String(d.assignee_id) : null, name: d.assignee_name },
    status: d.status,
    escalation: d.escalated_dept || d.escalated_to_name
      ? { dept: d.escalated_dept, toId: d.escalated_to_id != null ? String(d.escalated_to_id) : null, toName: d.escalated_to_name, note: d.escalation_note }
      : null,
    internalReply: d.internal_reply,
    response: d.response,
    sourceChannel: d.source_channel,
    slaTargetHours: d.sla_target_hours,
    respondedAt: d.responded_at,
    resolvedAt: d.resolved_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

async function listQueries(req, res) {
  try {
    const { status, client, related_type: relatedType, origin } = req.query || {};
    const where = activeRowWhere();
    if (status) where.status = status;
    if (origin) where.origin = origin;
    if (relatedType) where.related_type = relatedType;
    const idx = await loadClientIndex();
    if (client) {
      const c = await loadClientByCode(client);
      where.client_id = c ? c.id : -1;
    }
    const rows = await BdQuery.findAll({ where, order: [['created_at', 'DESC']] });
    res.json(rows.map((r) => { const d = plain(r); return formatQuery(d, clientChip(idx.get(Number(d.client_id)))); }));
  } catch (err) {
    console.error('bd.listQueries error', err);
    res.status(500).json({ error: 'Failed to list queries' });
  }
}

async function createQuery(req, res) {
  try {
    const code = req.params.code || (req.body && req.body.clientCode);
    const client = await loadClientByCode(code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);
    const b = req.body || {};
    if (!b.description) return res.status(400).json({ error: 'description is required' });

    const profile = plain(await BdClientProfile.findOne({ where: activeRowWhere({ client_id: c.id }) }));
    const tier = tierForClient(c, profile);
    const actor = actorFromReq(req);

    const row = await BdQuery.create({
      client_id: c.id,
      origin: b.origin === 'ei' ? 'ei' : 'customer',
      related_type: b.relatedType || null,
      related_ref: b.relatedRef || null,
      related_info: b.relatedInfo || null,
      subject: b.subject || null,
      description: b.description,
      assignee_id: b.assigneeId != null && b.assigneeId !== '' ? Number(b.assigneeId) : (profile && profile.bd_poc_id) || actor.id,
      assignee_name: b.assigneeName || actor.name || null,
      status: 'open',
      source_channel: b.sourceChannel || null,
      sla_target_hours: QUERY_SLA_HOURS[tier] ?? 48,
    });
    await assignSequentialCode(row, 'QRY', 'code');
    const d = plain(row);
    await recordEvent(c.id, 'query', `Query ${d.code} raised`, { body: d.subject || d.description, refType: 'Query', refId: d.code, actorId: actor.id, actorName: actor.name });

    const idx = await loadClientIndex();
    res.status(201).json(formatQuery(d, clientChip(idx.get(Number(c.id)))));
  } catch (err) {
    console.error('bd.createQuery error', err);
    res.status(500).json({ error: 'Failed to create query' });
  }
}

async function getQuery(req, res) {
  try {
    const row = await BdQuery.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Query not found' });
    const d = plain(row);
    const idx = await loadClientIndex();
    res.json(formatQuery(d, clientChip(idx.get(Number(d.client_id)))));
  } catch (err) {
    console.error('bd.getQuery error', err);
    res.status(500).json({ error: 'Failed to load query' });
  }
}

function queryIdWhere(id) {
  const raw = String(id || '').trim();
  return /^\d+$/.test(raw) ? { id: Number(raw) } : { code: raw };
}

async function transitionQuery(req, res) {
  try {
    const row = await BdQuery.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Query not found' });
    const d = plain(row);
    const b = req.body || {};
    const actor = actorFromReq(req);
    const action = String(b.action || '').toLowerCase();
    const patch = {};
    let eventTitle = null;

    if (action === 'escalate') {
      if (!b.dept && !b.toName) return res.status(400).json({ error: 'Escalation needs a department or person' });
      patch.status = 'escalated';
      patch.escalated_dept = b.dept || null;
      patch.escalated_to_id = b.toId != null && b.toId !== '' ? Number(b.toId) : null;
      patch.escalated_to_name = b.toName || null;
      patch.escalation_note = b.note || null;
      eventTitle = `Query ${d.code} escalated${b.dept ? ` → ${b.dept}` : ''}`;
    } else if (action === 'internal_reply') {
      patch.internal_reply = b.text || null;
      patch.status = 'under_review';
      eventTitle = `Query ${d.code}: internal reply received`;
    } else if (action === 'respond') {
      patch.response = b.text || d.response;
      if (b.draft) { patch.status = 'response_drafted'; eventTitle = `Query ${d.code}: response drafted`; }
      else { patch.status = 'responded'; patch.responded_at = new Date(); eventTitle = `Query ${d.code}: responded (recorded)`; }
    } else if (action === 'resolve') {
      patch.status = 'resolved';
      patch.resolved_at = new Date();
      eventTitle = `Query ${d.code} resolved`;
    } else if (action === 'reopen') {
      patch.status = 'reopened';
      patch.resolved_at = null;
      eventTitle = `Query ${d.code} reopened`;
    } else if (action === 'status' && b.status) {
      patch.status = b.status;
      eventTitle = `Query ${d.code} → ${String(b.status).toUpperCase()}`;
    } else {
      return res.status(400).json({ error: 'Unknown or missing action' });
    }
    if (b.assigneeId !== undefined) {
      patch.assignee_id = b.assigneeId != null && b.assigneeId !== '' ? Number(b.assigneeId) : null;
      patch.assignee_name = b.assigneeName || null;
    }

    await row.update(patch);
    await recordEvent(d.client_id, 'query', eventTitle, { refType: 'Query', refId: d.code, actorId: actor.id, actorName: actor.name });
    const fresh = plain(row);
    const idx = await loadClientIndex();
    res.json(formatQuery(fresh, clientChip(idx.get(Number(fresh.client_id)))));
  } catch (err) {
    console.error('bd.transitionQuery error', err);
    res.status(500).json({ error: 'Failed to update query' });
  }
}

/* ══════════════════════════ GRIEVANCES (§3G) ══════════════════════════ */
function formatGrievance(d, chip) {
  return {
    id: String(d.id),
    code: d.code,
    client: chip,
    origin: d.origin,
    relatedType: d.related_type,
    relatedRef: d.related_ref,
    relatedInfo: d.related_info,
    severity: d.severity,
    category: d.category,
    description: d.description,
    assignee: { id: d.assignee_id != null ? String(d.assignee_id) : null, name: d.assignee_name },
    status: d.status,
    escalation: d.escalated_dept || d.escalated_to_name
      ? { dept: d.escalated_dept, toId: d.escalated_to_id != null ? String(d.escalated_to_id) : null, toName: d.escalated_to_name, note: d.escalation_note }
      : null,
    internalReply: d.internal_reply,
    rootCause: d.root_cause,
    correctiveAction: d.corrective_action,
    customerConfirmed: !!d.customer_confirmed,
    response: d.response,
    sourceChannel: d.source_channel,
    slaTargetHours: d.sla_target_hours,
    respondedAt: d.responded_at,
    resolvedAt: d.resolved_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

async function listGrievances(req, res) {
  try {
    const { status, severity, client } = req.query || {};
    const where = activeRowWhere();
    if (status) where.status = status;
    if (severity) where.severity = severity;
    const idx = await loadClientIndex();
    if (client) {
      const c = await loadClientByCode(client);
      where.client_id = c ? c.id : -1;
    }
    const rows = await BdGrievance.findAll({ where, order: [['created_at', 'DESC']] });
    res.json(rows.map((r) => { const d = plain(r); return formatGrievance(d, clientChip(idx.get(Number(d.client_id)))); }));
  } catch (err) {
    console.error('bd.listGrievances error', err);
    res.status(500).json({ error: 'Failed to list grievances' });
  }
}

async function createGrievance(req, res) {
  try {
    const code = req.params.code || (req.body && req.body.clientCode);
    const client = await loadClientByCode(code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);
    const b = req.body || {};
    if (!b.description) return res.status(400).json({ error: 'description is required' });
    const severity = ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium';
    const profile = plain(await BdClientProfile.findOne({ where: activeRowWhere({ client_id: c.id }) }));
    const actor = actorFromReq(req);

    const row = await BdGrievance.create({
      client_id: c.id,
      origin: b.origin === 'ei' ? 'ei' : 'customer',
      related_type: b.relatedType || null,
      related_ref: b.relatedRef || null,
      related_info: b.relatedInfo || null,
      severity,
      category: b.category || null,
      description: b.description,
      assignee_id: b.assigneeId != null && b.assigneeId !== '' ? Number(b.assigneeId) : (profile && profile.bd_poc_id) || actor.id,
      assignee_name: b.assigneeName || actor.name || null,
      status: 'open',
      source_channel: b.sourceChannel || null,
      sla_target_hours: GRIEVANCE_SLA_HOURS[severity] ?? 24,
    });
    await assignSequentialCode(row, 'GRV', 'code');
    const d = plain(row);
    await recordEvent(c.id, 'grievance', `Grievance ${d.code} logged (${severity.toUpperCase()})`, { body: d.description, refType: 'Grievance', refId: d.code, actorId: actor.id, actorName: actor.name });

    const idx = await loadClientIndex();
    res.status(201).json(formatGrievance(d, clientChip(idx.get(Number(c.id)))));
  } catch (err) {
    console.error('bd.createGrievance error', err);
    res.status(500).json({ error: 'Failed to create grievance' });
  }
}

async function getGrievance(req, res) {
  try {
    const row = await BdGrievance.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Grievance not found' });
    const d = plain(row);
    const idx = await loadClientIndex();
    res.json(formatGrievance(d, clientChip(idx.get(Number(d.client_id)))));
  } catch (err) {
    console.error('bd.getGrievance error', err);
    res.status(500).json({ error: 'Failed to load grievance' });
  }
}

async function transitionGrievance(req, res) {
  try {
    const row = await BdGrievance.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Grievance not found' });
    const d = plain(row);
    const b = req.body || {};
    const actor = actorFromReq(req);
    const action = String(b.action || '').toLowerCase();
    const patch = {};
    let eventTitle = null;

    if (action === 'escalate') {
      if (!b.dept && !b.toName) return res.status(400).json({ error: 'Escalation needs a department or person' });
      patch.status = 'escalated';
      patch.escalated_dept = b.dept || null;
      patch.escalated_to_id = b.toId != null && b.toId !== '' ? Number(b.toId) : null;
      patch.escalated_to_name = b.toName || null;
      patch.escalation_note = b.note || null;
      eventTitle = `Grievance ${d.code} escalated${b.dept ? ` → ${b.dept}` : ''}`;
    } else if (action === 'internal_reply') {
      patch.internal_reply = b.text || null;
      patch.status = 'under_review';
      eventTitle = `Grievance ${d.code}: internal reply received`;
    } else if (action === 'root_cause') {
      patch.root_cause = b.text || null;
      patch.status = 'root_caused';
      eventTitle = `Grievance ${d.code}: root cause captured`;
    } else if (action === 'capa') {
      patch.corrective_action = b.text || null;
      if (b.customerConfirmed !== undefined) patch.customer_confirmed = !!b.customerConfirmed;
      patch.status = 'capa_initiated';
      eventTitle = `Grievance ${d.code}: CAPA initiated`;
    } else if (action === 'respond') {
      patch.response = b.text || d.response;
      patch.status = 'responded';
      patch.responded_at = new Date();
      eventTitle = `Grievance ${d.code}: responded (recorded)`;
    } else if (action === 'resolve') {
      const rootCause = b.rootCause || d.root_cause;
      const corrective = b.correctiveAction || d.corrective_action;
      if (!rootCause || !corrective) return res.status(400).json({ error: 'Root cause and corrective action are required before resolving' });
      patch.root_cause = rootCause;
      patch.corrective_action = corrective;
      if (b.customerConfirmed !== undefined) patch.customer_confirmed = !!b.customerConfirmed;
      patch.status = 'resolved';
      patch.resolved_at = new Date();
      eventTitle = `Grievance ${d.code} resolved`;
    } else if (action === 'reopen') {
      patch.status = 'reopened';
      patch.resolved_at = null;
      eventTitle = `Grievance ${d.code} reopened`;
    } else if (action === 'status' && b.status) {
      patch.status = b.status;
      eventTitle = `Grievance ${d.code} → ${String(b.status).toUpperCase()}`;
    } else {
      return res.status(400).json({ error: 'Unknown or missing action' });
    }
    if (b.assigneeId !== undefined) {
      patch.assignee_id = b.assigneeId != null && b.assigneeId !== '' ? Number(b.assigneeId) : null;
      patch.assignee_name = b.assigneeName || null;
    }

    await row.update(patch);
    await recordEvent(d.client_id, 'grievance', eventTitle, { refType: 'Grievance', refId: d.code, actorId: actor.id, actorName: actor.name });
    const fresh = plain(row);
    const idx = await loadClientIndex();
    res.json(formatGrievance(fresh, clientChip(idx.get(Number(fresh.client_id)))));
  } catch (err) {
    console.error('bd.transitionGrievance error', err);
    res.status(500).json({ error: 'Failed to update grievance' });
  }
}

/* ════════════════════════════ MEETINGS (§3H) ════════════════════════════ */
function formatMeeting(d, chip) {
  return {
    id: String(d.id),
    code: d.code,
    client: chip,
    origin: d.origin,
    requestedAt: d.requested_at,
    scheduledFor: d.scheduled_for,
    oldScheduledFor: d.old_scheduled_for,
    mode: d.mode,
    type: d.type,
    assignee: { id: d.assignee_id != null ? String(d.assignee_id) : null, name: d.assignee_name },
    attendees: Array.isArray(d.attendees) ? d.attendees : [],
    status: d.status,
    agenda: d.agenda,
    mom: d.mom,
    actionItems: Array.isArray(d.action_items) ? d.action_items : [],
    nextMeetingAt: d.next_meeting_at,
    attendedAt: d.attended_at,
    closedAt: d.closed_at,
    cancelledAt: d.cancelled_at,
    cancelReason: d.cancel_reason,
    relatedType: d.related_type,
    relatedRef: d.related_ref,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Start/end of the current ISO week (Mon–Sun) for ?this_week=true. */
function weekRange(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const start = new Date(d); start.setDate(d.getDate() - day);
  const end = new Date(start); end.setDate(start.getDate() + 7);
  return { start, end };
}

async function listMeetings(req, res) {
  try {
    const { status, client, this_week: thisWeek } = req.query || {};
    const where = activeRowWhere();
    if (status) where.status = status;
    const idx = await loadClientIndex();
    if (client) {
      const c = await loadClientByCode(client);
      where.client_id = c ? c.id : -1;
    }
    if (thisWeek === 'true' || thisWeek === '1') {
      const { start, end } = weekRange();
      where.scheduled_for = { [Op.gte]: start, [Op.lt]: end };
    }
    const rows = await BdMeeting.findAll({ where, order: [['scheduled_for', 'ASC'], ['requested_at', 'DESC']] });
    res.json(rows.map((r) => { const d = plain(r); return formatMeeting(d, clientChip(idx.get(Number(d.client_id)))); }));
  } catch (err) {
    console.error('bd.listMeetings error', err);
    res.status(500).json({ error: 'Failed to list meetings' });
  }
}

async function createMeeting(req, res) {
  try {
    const code = req.params.code || (req.body && req.body.clientCode);
    const client = await loadClientByCode(code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);
    const b = req.body || {};
    const profile = plain(await BdClientProfile.findOne({ where: activeRowWhere({ client_id: c.id }) }));
    const actor = actorFromReq(req);
    const origin = b.origin === 'customer' ? 'customer' : 'ei';
    // Outbound (EI) meetings can be born CONFIRMED if a slot is given; inbound starts REQUESTED.
    const status = b.status || (origin === 'ei' && b.scheduledFor ? 'confirmed' : 'requested');

    const row = await BdMeeting.create({
      client_id: c.id,
      origin,
      requested_at: new Date(),
      scheduled_for: b.scheduledFor || null,
      mode: b.mode || null,
      type: b.type || null,
      assignee_id: b.assigneeId != null && b.assigneeId !== '' ? Number(b.assigneeId) : (profile && profile.bd_poc_id) || actor.id,
      assignee_name: b.assigneeName || actor.name || null,
      attendees: Array.isArray(b.attendees) ? b.attendees : null,
      agenda: b.agenda || null,
      status,
      related_type: b.relatedType || null,
      related_ref: b.relatedRef || null,
    });
    await assignSequentialCode(row, 'MTG', 'code');
    const d = plain(row);
    await recordEvent(c.id, 'meeting', `Meeting ${d.code} ${status === 'confirmed' ? 'scheduled' : 'requested'}`, { body: [d.type, d.mode].filter(Boolean).join(' · ') || null, refType: 'Meeting', refId: d.code, actorId: actor.id, actorName: actor.name });

    const idx = await loadClientIndex();
    res.status(201).json(formatMeeting(d, clientChip(idx.get(Number(c.id)))));
  } catch (err) {
    console.error('bd.createMeeting error', err);
    res.status(500).json({ error: 'Failed to create meeting' });
  }
}

async function getMeeting(req, res) {
  try {
    const row = await BdMeeting.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Meeting not found' });
    const d = plain(row);
    const idx = await loadClientIndex();
    res.json(formatMeeting(d, clientChip(idx.get(Number(d.client_id)))));
  } catch (err) {
    console.error('bd.getMeeting error', err);
    res.status(500).json({ error: 'Failed to load meeting' });
  }
}

async function transitionMeeting(req, res) {
  try {
    const row = await BdMeeting.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Meeting not found' });
    const d = plain(row);
    const b = req.body || {};
    const actor = actorFromReq(req);
    const action = String(b.action || '').toLowerCase();
    const patch = {};
    let eventType = 'meeting';
    let eventTitle = null;

    if (action === 'confirm') {
      patch.status = 'confirmed';
      if (b.scheduledFor) patch.scheduled_for = b.scheduledFor;
      eventTitle = `Meeting ${d.code} confirmed`;
    } else if (action === 'reschedule') {
      if (!b.scheduledFor) return res.status(400).json({ error: 'New date/time is required' });
      patch.old_scheduled_for = d.scheduled_for;
      patch.scheduled_for = b.scheduledFor;
      patch.status = 'rescheduled';
      eventTitle = `Meeting ${d.code} rescheduled`;
    } else if (action === 'assign') {
      patch.assignee_id = b.assigneeId != null && b.assigneeId !== '' ? Number(b.assigneeId) : null;
      patch.assignee_name = b.assigneeName || null;
      if (Array.isArray(b.attendees)) patch.attendees = b.attendees;
      eventTitle = `Meeting ${d.code}: lead assigned`;
    } else if (action === 'attended') {
      patch.status = 'attended';
      patch.attended_at = new Date();
      eventTitle = `Meeting ${d.code} attended`;
    } else if (action === 'mom') {
      patch.mom = b.mom || null;
      if (Array.isArray(b.actionItems)) patch.action_items = b.actionItems;
      patch.status = 'mom_captured';
      eventTitle = `Meeting ${d.code}: MoM captured`;
      if (b.nextMeetingAt) {
        patch.next_meeting_at = b.nextMeetingAt;
        await recordEvent(d.client_id, 'next_meeting', `Next meeting scheduled (${d.code})`, { refType: 'Meeting', refId: d.code, actorId: actor.id, actorName: actor.name });
      }
    } else if (action === 'close') {
      patch.status = 'closed';
      patch.closed_at = new Date();
      eventTitle = `Meeting ${d.code} closed`;
    } else if (action === 'cancel') {
      patch.status = 'cancelled';
      patch.cancelled_at = new Date();
      patch.cancel_reason = b.reason || null;
      eventTitle = `Meeting ${d.code} cancelled`;
    } else if (action === 'status' && b.status) {
      patch.status = b.status;
      eventTitle = `Meeting ${d.code} → ${String(b.status).toUpperCase()}`;
    } else {
      return res.status(400).json({ error: 'Unknown or missing action' });
    }

    await row.update(patch);
    await recordEvent(d.client_id, eventType, eventTitle, { refType: 'Meeting', refId: d.code, actorId: actor.id, actorName: actor.name });
    const fresh = plain(row);
    const idx = await loadClientIndex();
    res.json(formatMeeting(fresh, clientChip(idx.get(Number(fresh.client_id)))));
  } catch (err) {
    console.error('bd.transitionMeeting error', err);
    res.status(500).json({ error: 'Failed to update meeting' });
  }
}

/** Cross-initiate a follow-up from a meeting (query | grievance | meeting). */
async function initiateFollowup(req, res) {
  try {
    const row = await BdMeeting.findOne({ where: activeRowWhere(queryIdWhere(req.params.id)) });
    if (!row) return res.status(404).json({ error: 'Meeting not found' });
    const d = plain(row);
    const b = req.body || {};
    const kind = String(b.kind || '').toLowerCase();
    req.params.code = String(d.client_id);
    req.body = { ...b, relatedType: 'Meeting', relatedRef: d.code };
    if (kind === 'query') return createQuery(req, res);
    if (kind === 'grievance') return createGrievance(req, res);
    if (kind === 'meeting') return createMeeting(req, res);
    return res.status(400).json({ error: 'kind must be query | grievance | meeting' });
  } catch (err) {
    console.error('bd.initiateFollowup error', err);
    res.status(500).json({ error: 'Failed to initiate follow-up' });
  }
}

module.exports = {
  // queries
  listQueries, createQuery, getQuery, transitionQuery,
  // grievances
  listGrievances, createGrievance, getGrievance, transitionGrievance,
  // meetings
  listMeetings, createMeeting, getMeeting, transitionMeeting, initiateFollowup,
};