/**
 * BD Management controller — Phase 1 (Customer Tracker foundation).
 *
 * Endpoints:
 *   GET  /customers                  → tracker rows (rollups + derived tier/lifecycle)
 *   GET  /customers/:code            → customer detail (KPIs + account info)
 *   GET  /customers/:code/timeline   → History & Comments (stored + derived events)
 *   POST /customers/:code/events     → add a manual comment/event
 *   PUT  /customers/:code/profile    → set BD enrichment (tier/lifecycle/POC/…)
 *
 * Conventions mirror the codebase: bare-JSON responses (no envelope), snake→camel
 * formatRow, `id: String(...)`, `res.status(500).json({ error })` on failure.
 * Reads the VendorClient master + SalesOrder + ProductCustomization; owns only
 * bd_client_profiles + bd_events.
 */
const { activeRowWhere } = require('../lib/softDelete');
const VendorClient = require('../vendorClient/models');
const SalesOrder = require('../salesOrders/models');
const { BdClientProfile, BdEvent, BdQuery, BdGrievance, BdMeeting } = require('./models');
const {
  computeClientRollups, tierFromRevenue, lifecycleFromActivity,
  daysSince, normName, soValue, isInFlightPis, pisCreatedAt,
} = require('./rollups');

// Defensive requires — these modules' export shape varies (default vs named).
function pickModel(mod, ...names) {
  if (!mod) return null;
  if (typeof mod === 'function') return mod;
  for (const n of names) if (mod[n]) return mod[n];
  return mod.default || null;
}
let ProductCustomization = null;
let User = null;
try { ProductCustomization = pickModel(require('../productCustomizations/models'), 'ProductCustomization'); } catch (_) { /* optional */ }
try { User = pickModel(require('../users/models'), 'User', 'Users'); } catch (_) { /* optional */ }

/* ── helpers ─────────────────────────────────────────────────────────────── */
function plain(row) { return row && row.get ? row.get({ plain: true }) : row; }

/** Coerce a JSONB column that may arrive as a JSON string. */
function coerceObj(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch (_) { return {}; } }
  return {};
}

/** EI-CLI-00001 → C-001 (spec display form); falls back to entity_code. */
function displayCode(entityCode) {
  const m = String(entityCode || '').match(/(\d+)\s*$/);
  return m ? `C-${String(parseInt(m[1], 10)).padStart(3, '0')}` : (entityCode || '—');
}

function userName(u) {
  if (!u) return null;
  const d = plain(u);
  return d.display_name || [d.fname, d.lname].filter(Boolean).join(' ').trim() || d.email || `#${d.userid}`;
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

/** Load shared datasets used by both list and detail (best-effort, resilient). */
async function loadDatasets() {
  const [clients, salesOrders, profiles, queries, grievances, meetings] = await Promise.all([
    VendorClient.findAll({ where: activeRowWhere({ type: 'client' }), order: [['entity_code', 'ASC']] }),
    SalesOrder.findAll({ where: activeRowWhere() }),
    BdClientProfile.findAll({ where: activeRowWhere() }),
    BdQuery.findAll({ where: activeRowWhere() }),
    BdGrievance.findAll({ where: activeRowWhere() }),
    BdMeeting.findAll({ where: activeRowWhere() }),
  ]);
  // ProductCustomization has no guaranteed deleted_at column → query without soft-delete WHERE.
  let customizations = [];
  if (ProductCustomization) {
    try { customizations = await ProductCustomization.findAll(); } catch (e) { console.error('bd: PIS load failed', e.message); }
  }
  let users = [];
  if (User) {
    try { users = await User.findAll(); } catch (e) { console.error('bd: user load failed', e.message); }
  }
  return {
    clients: clients.map(plain),
    salesOrders: salesOrders.map(plain),
    customizations: customizations.map(plain),
    profiles: profiles.map(plain),
    queries: queries.map(plain),
    grievances: grievances.map(plain),
    meetings: meetings.map(plain),
    userById: new Map(users.map((u) => [Number(plain(u).userid), plain(u)])),
  };
}

/** Resolve tier + lifecycle, honoring manual profile overrides, else derive. */
function resolveTierLifecycle(profile, roll, client) {
  const tier = profile && profile.tier ? { value: profile.tier, source: 'manual' }
    : { value: tierFromRevenue(roll.revenue12m), source: 'auto' };
  const lifecycle = profile && profile.bd_lifecycle ? { value: profile.bd_lifecycle, source: 'manual' }
    : { value: lifecycleFromActivity(roll.daysSinceLastSO, roll.hasEverOrdered), source: 'auto' };
  return { tier, lifecycle };
}

/** Build a tracker row (the §3 grid contract). */
function formatTrackerRow(client, roll, profile, userById) {
  const { tier, lifecycle } = resolveTierLifecycle(profile, roll, client);
  const pocId = profile && profile.bd_poc_id != null ? profile.bd_poc_id : client.account_manager_id;
  const poc = pocId != null ? userById.get(Number(pocId)) : null;
  return {
    id: String(client.id),
    code: client.entity_code,
    displayCode: displayCode(client.entity_code),
    name: client.name,
    city: client.city || null,
    location: client.location || null,
    country: client.country || null,
    tier: tier.value,
    tierSource: tier.source,
    lifecycle: lifecycle.value,
    lifecycleSource: lifecycle.source,
    bdPoc: { id: pocId != null ? String(pocId) : null, name: userName(poc) },
    receivable: roll.receivable,
    overdue: roll.overdue,
    advances: roll.advances,
    revenue12m: roll.revenue12m,
    clv: roll.clv,
    orders: roll.orders,
    pis: roll.pis,
    queries: roll.queries,
    grievances: roll.grievances,
    nextMeeting: roll.nextMeeting,
    lastOrderDate: roll.lastOrderDate,
    daysSinceLastSO: roll.daysSinceLastSO,
  };
}

/* ── GET /customers ──────────────────────────────────────────────────────── */
async function listCustomers(req, res) {
  try {
    const ds = await loadDatasets();
    const rolls = computeClientRollups({
      clients: ds.clients, salesOrders: ds.salesOrders, customizations: ds.customizations,
      queries: ds.queries, grievances: ds.grievances, meetings: ds.meetings,
    });
    const profileByClient = new Map(ds.profiles.map((p) => [Number(p.client_id), p]));
    const rows = ds.clients.map((c) =>
      formatTrackerRow(c, rolls.get(c.id), profileByClient.get(Number(c.id)) || null, ds.userById));
    res.json(rows);
  } catch (err) {
    console.error('bd.listCustomers error', err);
    res.status(500).json({ error: 'Failed to list customers' });
  }
}

/* ── GET /customers/:code ────────────────────────────────────────────────── */
async function getCustomer(req, res) {
  try {
    const client = await loadClientByCode(req.params.code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);

    const ds = await loadDatasets();
    const rolls = computeClientRollups({
      clients: ds.clients, salesOrders: ds.salesOrders, customizations: ds.customizations,
      queries: ds.queries, grievances: ds.grievances, meetings: ds.meetings,
    });
    const roll = rolls.get(c.id) || { orders: { open: 0, ytd: 0, total: 0 }, pis: { inFlight: 0, total: 0 } };
    const profile = ds.profiles.find((p) => Number(p.client_id) === Number(c.id)) || null;
    const base = formatTrackerRow(c, roll, profile, ds.userById);

    const data = coerceObj(c.data);
    const contacts = Array.isArray(c.contacts) ? c.contacts : (Array.isArray(data.pocs) ? data.pocs : []);
    const primary = contacts[0] || null;
    const secondary = contacts[1] || null;
    const mapContact = (k) => (k ? {
      name: k.name || k.contactName || null,
      role: k.role || k.designation || null,
      email: k.email || null,
      phone: k.phone || k.mobile || null,
    } : null);

    // products customized breakdown (active = in-flight, dormant = closed)
    let pcTotal = 0; let pcActive = 0;
    for (const pc of ds.customizations) {
      if (Number(pc.user_id) !== Number(c.user_id) || c.user_id == null) continue;
      if (String(pc.lifecycle_status || '').toLowerCase() === 'deleted') continue;
      pcTotal += 1;
      if (isInFlightPis(pc)) pcActive += 1;
    }

    const onboarded = (profile && profile.onboarded_date) || c.since_year || c.created_at || null;
    res.json({
      ...base,
      legalEntity: c.name,
      gstin: data.gstin || data.gstIn || data.GSTIN || null,
      category: c.category || null,
      segment: c.segment || null,
      paymentTerms: c.payment_terms || null,
      creditLimit: profile && profile.credit_limit != null ? Number(profile.credit_limit) : null,
      onboardedDate: onboarded,
      daysAsActive: daysSince(typeof onboarded === 'string' ? onboarded : null),
      email: c.email || null,
      phone: c.phone || null,
      primaryContact: mapContact(primary),
      secondaryContact: mapContact(secondary),
      billingAddress: data.billingAddress || data.billing_address || c.location || null,
      shippingAddress: data.shippingAddress || data.shipping_address || null,
      agreement: profile && profile.agreement_name
        ? { name: profile.agreement_name, expiresOn: profile.agreement_expires_on || null }
        : null,
      productsCustomized: { total: pcTotal, active: pcActive, dormant: Math.max(0, pcTotal - pcActive) },
      notes: (profile && profile.notes) || c.notes || null,
    });
  } catch (err) {
    console.error('bd.getCustomer error', err);
    res.status(500).json({ error: 'Failed to load customer' });
  }
}

/* ── GET /customers/:code/timeline ───────────────────────────────────────── */
async function getTimeline(req, res) {
  try {
    const client = await loadClientByCode(req.params.code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);

    // Stored manual/auto events.
    const stored = await BdEvent.findAll({
      where: activeRowWhere({ client_id: c.id }),
      order: [['occurred_at', 'DESC']],
    });
    const events = stored.map((row) => {
      const d = plain(row);
      return {
        id: `ev-${d.id}`, clientId: String(c.id), type: d.type, title: d.title, body: d.body,
        refType: d.ref_type, refId: d.ref_id, actor: d.actor_name, source: d.source,
        occurredAt: d.occurred_at,
      };
    });

    // Derived (read-only) events so the timeline is populated before manual entries.
    const sos = await SalesOrder.findAll({ where: activeRowWhere() });
    for (const row of sos) {
      const so = plain(row);
      if (normName(so.customer_name) !== normName(c.name)) continue;
      if (!so.order_date) continue;
      events.push({
        id: `so-${so.id}`, clientId: String(c.id), type: 'order',
        title: `Order ${so.order_id || ''}`.trim(),
        body: `Value ₹${soValue(so.items).toLocaleString('en-IN')}`,
        refType: 'Order', refId: so.order_id || String(so.id), actor: null, source: 'auto',
        occurredAt: so.order_date,
      });
    }
    if (ProductCustomization && c.user_id != null) {
      try {
        const pcs = await ProductCustomization.findAll({ where: { user_id: c.user_id } });
        for (const row of pcs) {
          const pc = plain(row);
          if (String(pc.lifecycle_status || '').toLowerCase() === 'deleted') continue;
          const at = pisCreatedAt(pc);
          if (!at) continue;
          events.push({
            id: `pis-${pc.customization_id || pc.id}`, clientId: String(c.id), type: 'pis',
            title: `PIS ${pc.category || ''}`.trim() || 'PIS listed',
            body: pc.formulationSummary || null,
            refType: 'PIS', refId: String(pc.customization_id || pc.id), actor: null, source: 'auto',
            occurredAt: at,
          });
        }
      } catch (e) { console.error('bd.getTimeline PIS error', e.message); }
    }

    events.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    res.json(events);
  } catch (err) {
    console.error('bd.getTimeline error', err);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
}

/* ── POST /customers/:code/events ────────────────────────────────────────── */
async function addEvent(req, res) {
  try {
    const client = await loadClientByCode(req.params.code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);
    const { type, title, body, refType, refId } = req.body || {};
    if (!title && !body) return res.status(400).json({ error: 'title or body is required' });
    const actor = actorFromReq(req);
    const row = await BdEvent.create({
      client_id: c.id,
      type: type || 'comment',
      title: title || 'Comment',
      body: body || null,
      ref_type: refType || null,
      ref_id: refId || null,
      actor_id: actor.id,
      actor_name: actor.name,
      source: 'manual',
      occurred_at: new Date(),
    });
    const d = plain(row);
    res.status(201).json({
      id: `ev-${d.id}`, clientId: String(c.id), type: d.type, title: d.title, body: d.body,
      refType: d.ref_type, refId: d.ref_id, actor: d.actor_name, source: d.source, occurredAt: d.occurred_at,
    });
  } catch (err) {
    console.error('bd.addEvent error', err);
    res.status(500).json({ error: 'Failed to add event' });
  }
}

/* ── PUT /customers/:code/profile ────────────────────────────────────────── */
async function updateProfile(req, res) {
  try {
    const client = await loadClientByCode(req.params.code);
    if (!client) return res.status(404).json({ error: 'Customer not found' });
    const c = plain(client);
    const b = req.body || {};

    const [profile] = await BdClientProfile.findOrCreate({
      where: { client_id: c.id },
      defaults: { client_id: c.id },
    });

    const patch = {};
    if ('tier' in b) { patch.tier = b.tier || null; patch.tier_source = b.tier ? 'manual' : 'auto'; }
    if ('lifecycle' in b) { patch.bd_lifecycle = b.lifecycle || null; patch.lifecycle_source = b.lifecycle ? 'manual' : 'auto'; }
    if ('bdPocId' in b) patch.bd_poc_id = b.bdPocId != null && b.bdPocId !== '' ? Number(b.bdPocId) : null;
    if ('onboardedDate' in b) patch.onboarded_date = b.onboardedDate || null;
    if ('creditLimit' in b) patch.credit_limit = b.creditLimit != null && b.creditLimit !== '' ? Number(b.creditLimit) : null;
    if ('agreementName' in b) patch.agreement_name = b.agreementName || null;
    if ('agreementExpiresOn' in b) patch.agreement_expires_on = b.agreementExpiresOn || null;
    if ('notes' in b) patch.notes = b.notes || null;

    await profile.update(patch);

    // Record lifecycle/tier changes on the timeline (auditable).
    const actor = actorFromReq(req);
    if ('tier' in b && b.tier) {
      await BdEvent.create({ client_id: c.id, type: 'tier_changed', title: `Tier set to ${String(b.tier).toUpperCase()}`, actor_id: actor.id, actor_name: actor.name, source: 'manual', occurred_at: new Date() });
    }
    if ('bdPocId' in b) {
      await BdEvent.create({ client_id: c.id, type: 'poc_reassigned', title: 'BD POC reassigned', actor_id: actor.id, actor_name: actor.name, source: 'manual', occurred_at: new Date() });
    }

    // Return refreshed detail.
    req.params.code = c.entity_code;
    return getCustomer(req, res);
  } catch (err) {
    console.error('bd.updateProfile error', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
}

module.exports = { listCustomers, getCustomer, getTimeline, addEvent, updateProfile };
