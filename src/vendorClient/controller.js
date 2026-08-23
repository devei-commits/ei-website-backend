const db = require('../../db');
const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const VendorClient = require('./models');
const { Op } = require('sequelize');
const {
  syncZohoContactForVendorClient,
  buildZohoContactPayloadFromVendorClient,
  mapZohoBooksContactToVendorFormFields,
} = require('../users/zohoContactSync');
const zohoEnv = require('../services/zohoEnv');
const { createContact } = require('../services/zohoBooks');
const {
  assertUserAvailableForVendorClientLink,
  syncLinkedVendorClientFromUser,
  linkOrCreateUserForClientVendorRow,
  allocateNextEntityCode,
} = require('./userLink');
const { User } = require('../users/models');
const {
  syncVendorMasterItemsToPriceList,
  deleteAllVendorPriceListRates,
} = require('./syncVendorItemsPriceList');
const { syncClientAddressesFromVendorData } = require('../addresses/clientAddressHelpers');

/**
 * vendor-client `data` JSONB is expected to be an object, but in practice
 * it can sometimes arrive/land as a JSON string (or null) and then nested
 * fields like `vendorItems` disappear. Coerce safely here.
 */
function coerceDataObject(maybeJson) {
  if (maybeJson == null) return {};
  if (typeof maybeJson === 'object') return maybeJson;
  if (typeof maybeJson === 'string') {
    const s = maybeJson.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** If shipping is blank but billing is set, persist shipping same as billing (camel + snake keys). */
function normalizeDataShippingFromBilling(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  const bill =
    (out.billingAddress != null && String(out.billingAddress).trim()) ||
    (out.billing_address != null && String(out.billing_address).trim()) ||
    '';
  const ship =
    (out.shippingAddress != null && String(out.shippingAddress).trim()) ||
    (out.shipping_address != null && String(out.shipping_address).trim()) ||
    '';
  if (bill && !ship) {
    out.shippingAddress = bill;
    out.shipping_address = bill;
  }
  return out;
}

function attachZohoVendorClientSync(out, zohoResult) {
  if (!zohoEnv.booksEnabled || !zohoResult) return;
  if (zohoResult.synced && zohoResult.contactId) {
    out.zoho_sync = { synced: true, contact_id: zohoResult.contactId };
  } else if (
    zohoResult.error &&
    zohoResult.error !== 'zoho_disabled' &&
    zohoResult.error !== 'vendor_contact_sync_disabled' &&
    zohoResult.error !== 'client_contact_sync_disabled'
  ) {
    out.zoho_sync = { synced: false, error: zohoResult.error };
  }
}

function attachPriceListSync(out, priceSync) {
  if (!priceSync) return;
  out.priceListSync = {
    synced: priceSync.synced,
    removed: priceSync.removed,
    skipped: priceSync.skipped,
  };
}

/** Vendor create/update must sync to Zoho Books before commit when integration is enabled. */
function isZohoVendorSyncRequired(type) {
  return type === 'vendor' && zohoEnv.booksEnabled && zohoEnv.syncVendorContacts;
}

/**
 * Create Zoho Books contact and persist zoho_id on the row inside the caller's transaction.
 * Throws when sync is required and Zoho returns no contact id.
 * @param {*} row - Sequelize VendorClient instance
 * @param {import('sequelize').Transaction} transaction
 */
async function applyZohoContactSyncInTransaction(row, transaction) {
  if (row.zoho_id) {
    return { synced: true, contactId: row.zoho_id, skipped: false };
  }
  const zohoResult = await syncZohoContactForVendorClient(row);
  if (zohoResult.synced && zohoResult.contactId) {
    await row.update({ zoho_id: zohoResult.contactId }, { transaction });
    return { ...zohoResult, skipped: false };
  }
  if (
    zohoResult.error === 'zoho_disabled' ||
    zohoResult.error === 'vendor_contact_sync_disabled' ||
    zohoResult.error === 'client_contact_sync_disabled'
  ) {
    return { ...zohoResult, skipped: true };
  }
  const msg =
    zohoResult.error === 'zoho_missing_contact_id'
      ? 'Zoho did not return a contact id'
      : zohoResult.error || 'Zoho contact sync failed';
  const err = new Error(msg);
  err.status = 502;
  err.code = 'ZOHO_SYNC_FAILED';
  throw err;
}

function formatRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const data = coerceDataObject(d.data);
  return {
    id: String(d.id),
    type: d.type,
    entityCode: d.entity_code || '',
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
    userId: d.user_id != null ? String(d.user_id) : null,
  };
}

async function listVendorClients(req, res) {
  try {
    const typeFilter = req.query.type; // 'vendor' | 'client'
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const statusFilter = req.query.status != null ? String(req.query.status).trim() : '';
    const categoryFilter = req.query.category != null ? String(req.query.category).trim() : '';
    const wantsPagination = req.query.limit != null || req.query.offset != null;

    const filters = {};
    if (typeFilter === 'vendor' || typeFilter === 'client') filters.type = typeFilter;
    if (statusFilter && statusFilter !== 'all') filters.status = statusFilter;
    if (categoryFilter && categoryFilter !== 'all') filters.category = categoryFilter;
    if (search) {
      filters[Op.or] = [
        { entity_code: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { location: { [Op.iLike]: `%${search}%` } },
        { country: { [Op.iLike]: `%${search}%` } },
        { category: { [Op.iLike]: `%${search}%` } },
      ];
    }
    const where = activeRowWhere(filters);

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
/**
 * POST /vendor-client/sync-zoho — create Zoho Books vendor contact from draft form (no DB row).
 * Returns zohoId + mappedFields to hydrate the UI. Idempotent when zohoId is already present.
 */
async function syncZohoVendorDraft(req, res) {
  try {
    if (!zohoEnv.booksEnabled) {
      return res.status(503).json({ error: 'Zoho Books integration is disabled' });
    }
    if (!zohoEnv.syncVendorContacts) {
      return res.status(503).json({ error: 'Vendor Zoho contact sync is disabled' });
    }

    const body = req.body || {};
    const dataObj = coerceDataObject(body.data);
    const zohoIdExisting = body.zohoId ?? body.zoho_id ?? dataObj.zohoId ?? dataObj.zoho_id;
    if (zohoIdExisting != null && String(zohoIdExisting).trim() !== '') {
      return res.json({
        zohoId: String(zohoIdExisting).trim(),
        mappedFields: {},
        alreadySynced: true,
      });
    }

    const payload = bodyToPayload(body, 'vendor');
    if (!payload.entity_code || !String(payload.entity_code).trim()) {
      payload.entity_code = await allocateNextEntityCode('vendor');
    }
    if (!payload.email || !String(payload.email).trim()) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!payload.phone || !String(payload.phone).trim()) {
      return res.status(400).json({ error: 'phone is required' });
    }
    if (!payload.name || !String(payload.name).trim()) {
      return res.status(400).json({ error: 'name (trade or legal) is required' });
    }

    const data = coerceDataObject(payload.data);
    if (data.shippingAddress && !data.shipping_address) data.shipping_address = data.shippingAddress;
    if (data.billingAddress && !data.billing_address) data.billing_address = data.billingAddress;
    payload.data = data;

    const synthetic = {
      id: 0,
      type: 'vendor',
      entity_code: String(payload.entity_code).trim(),
      name: String(payload.name).trim(),
      email: String(payload.email).trim(),
      phone: String(payload.phone).trim(),
      location: payload.location != null ? String(payload.location).trim() : '',
      country: payload.country != null ? String(payload.country).trim() : '',
      city: payload.city != null ? String(payload.city).trim() : '',
      payment_terms: payload.payment_terms,
      data,
      contacts: [],
    };

    const zohoJson = buildZohoContactPayloadFromVendorClient(synthetic);
    const { contactId, raw } = await createContact(zohoJson);
    if (!contactId) {
      return res.status(502).json({ error: 'Zoho did not return a contact id' });
    }
    const zohoContact = raw && raw.contact ? raw.contact : {};
    const mappedFields = mapZohoBooksContactToVendorFormFields(zohoContact);

    return res.json({
      zohoId: contactId,
      mappedFields,
      zoho_sync: { synced: true, contact_id: contactId },
    });
  } catch (err) {
    console.error('syncZohoVendorDraft error', err);
    const msg = err && err.message ? String(err.message) : 'Zoho sync failed';
    const code = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 502;
    res.status(code >= 400 ? code : 502).json({ error: msg });
  }
}

/**
 * POST /vendor-clients/import-zoho-vendors — bulk-pull every vendor contact from Zoho Books and
 * upsert into vendor_clients (type='vendor'), keyed by zoho_id first, then email. Matches
 * scripts/zoho-pull-vendors-to-vendor-clients.js (same shared upsert logic), exposed here as an
 * on-demand "Import from Zoho" action instead of a CLI-only script.
 */
async function importZohoVendors(req, res) {
  try {
    // Deliberately not gated behind zohoEnv.booksEnabled/syncVendorContacts — those flags govern
    // the automatic push-sync integration (e.g. syncing a new vendor draft out to Zoho). This is a
    // manual, on-demand pull the other direction, and should work even when auto-sync is off. If
    // Zoho credentials genuinely aren't configured, getAccessToken() below fails with its own
    // specific error instead of a blanket "disabled" one.
    const { pullZohoVendorsIntoVendorClients } = require('./zohoVendorPull');
    const q = req.query || {};
    const dryRun = String(q.dryRun ?? '').trim().toLowerCase() === 'true';
    const limit = q.limit != null && String(q.limit).trim() !== '' ? parseInt(String(q.limit), 10) : undefined;
    const maxPages = q.maxPages != null && String(q.maxPages).trim() !== '' ? parseInt(String(q.maxPages), 10) : undefined;
    const summary = await pullZohoVendorsIntoVendorClients({
      dryRun,
      filterBy: q.filterBy,
      maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ dryRun, ...summary });
  } catch (err) {
    console.error('importZohoVendors error', err);
    const msg = err && err.message ? String(err.message) : 'Zoho vendor import failed';
    const code = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 502;
    res.status(code >= 400 ? code : 502).json({ error: msg });
  }
}

/**
 * POST /vendor-clients/import-zoho-vendor — import exactly one vendor from Zoho, by Zoho contact
 * ID (exact) or by a name search. Alternative to importZohoVendors' full pull, for adding/refreshing
 * a single vendor on demand. A name search matching more than one contact returns the candidates
 * instead of guessing — the client re-calls with the chosen zohoId.
 */
async function importZohoVendor(req, res) {
  try {
    // See importZohoVendors — same reasoning, not gated behind the auto-sync flags.
    const { importOneZohoVendor } = require('./zohoVendorPull');
    const body = req.body || {};
    const zohoId = body.zohoId != null ? String(body.zohoId).trim() : '';
    const search = body.search != null ? String(body.search).trim() : '';
    if (!zohoId && !search) {
      return res.status(400).json({ error: 'Provide either zohoId or search (vendor name).' });
    }
    const result = await importOneZohoVendor({ zohoId: zohoId || undefined, search: search || undefined });
    res.json(result);
  } catch (err) {
    console.error('importZohoVendor error', err);
    const msg = err && err.message ? String(err.message) : 'Zoho vendor import failed';
    const code = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 502;
    res.status(code >= 400 ? code : 502).json({ error: msg });
  }
}

async function getNextCode(req, res) {
  try {
    const type = (req.query.type || '').toLowerCase() === 'client' ? 'client' : 'vendor';
    const nextCode = await allocateNextEntityCode(type);
    res.json({ nextCode });
  } catch (err) {
    console.error('getNextCode error', err);
    res.status(500).json({ error: 'Failed to generate next code' });
  }
}

function bodyToPayload(body, type) {
  const data = normalizeDataShippingFromBilling(coerceDataObject(body.data));
  let user_id = undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'userId') || Object.prototype.hasOwnProperty.call(body, 'user_id')) {
    const raw = body.userId !== undefined ? body.userId : body.user_id;
    if (raw === null || raw === '') user_id = null;
    else {
      const n = parseInt(String(raw), 10);
      user_id = Number.isNaN(n) ? undefined : n;
    }
  }
  // Every field below stays `undefined` (never `null`) when the caller didn't send it — updateVendorClient's
  // `if (payload.field !== undefined)` guards rely on that to leave untouched fields alone. A trailing
  // `?? null` here used to make every partial update wipe whatever it omitted (e.g. an edit that only
  // changes `name` would null out entity_code, category, notes, ...). create-only defaults (status,
  // entity_code) are applied explicitly at the createVendorClient call site instead, not here.
  return {
    entity_code: body.entityCode ?? data.entityCode,
    type: type || body.type || 'vendor',
    zoho_id: body.zohoId ?? body.zoho_id ?? data.zohoId ?? data.zoho_id,
    name: body.name ?? data.tradeName ?? data.legalName,
    email: body.email ?? data.primaryEmail,
    phone: body.phone ?? data.primaryPhone,
    location: body.location ?? data.state,
    country: body.country ?? data.country,
    city: body.city,
    category: body.category ?? data.setupCategory,
    status: body.status,
    payment_terms: body.paymentTerms ?? data.paymentTerms,
    notes: body.notes ?? data.notes,
    rating: body.rating != null ? body.rating : undefined,
    moq: body.moq,
    lead_time: body.leadTime,
    data,
    user_id,
  };
}

async function createVendorClient(req, res) {
  try {
    const body = req.body || {};
    const type = (body.type || 'vendor').toLowerCase() === 'client' ? 'client' : 'vendor';
    const payload = bodyToPayload(body, type);

    let linkedUserId = null;
    if (payload.user_id !== undefined && payload.user_id != null && !Number.isNaN(payload.user_id)) {
      try {
        await assertUserAvailableForVendorClientLink(payload.user_id, null);
      } catch (e) {
        const status = e.status || 500;
        return res.status(status).json({ error: e.message || 'Invalid user link' });
      }
      const u = await User.findByPk(payload.user_id, { attributes: ['userid'] });
      if (!u) return res.status(400).json({ error: 'userId not found' });
      linkedUserId = payload.user_id;
    }

    let priceSync = null;
    let zohoResult = null;
    let row;
    const t = await db.transaction();
    try {
      let entityCode =
        payload.entity_code && String(payload.entity_code).trim()
          ? String(payload.entity_code).trim()
          : '';
      if (!entityCode) {
        entityCode = await allocateNextEntityCode(type, t);
      }
      const existing = await VendorClient.findOne({
        where: { entity_code: entityCode },
        transaction: t,
      });
      if (existing) {
        const err = new Error('An entry with this code already exists');
        err.status = 400;
        throw err;
      }

      row = await VendorClient.create(
        {
          entity_code: entityCode,
          type: payload.type,
          zoho_id: payload.zoho_id || null,
          user_id: linkedUserId,
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
          location: payload.location,
          country: payload.country,
          city: payload.city,
          category: payload.category,
          status: payload.status ?? 'pending',
          payment_terms: payload.payment_terms,
          notes: payload.notes,
          rating: payload.rating,
          moq: payload.moq,
          lead_time: payload.lead_time,
          data: payload.data,
        },
        { transaction: t }
      );
      if (row.type === 'vendor') {
        priceSync = await syncVendorMasterItemsToPriceList({
          vendorId: row.id,
          previousVendorItems: [],
          nextVendorItems: payload.data?.vendorItems,
          transaction: t,
        });
      }
      if (row.type === 'vendor' && isZohoVendorSyncRequired(row.type)) {
        zohoResult = await applyZohoContactSyncInTransaction(row, t);
      }
      await t.commit();
    } catch (txErr) {
      await t.rollback();
      throw txErr;
    }

    await row.reload();

    if (linkedUserId) {
      const u = await User.findByPk(linkedUserId);
      if (u) await syncLinkedVendorClientFromUser(u).catch(() => {});
    }
    console.log('[vendor-client] Created', type, 'id=', row.id, 'entity_code=', row.entity_code);
    if (row.type === 'client' && !row.zoho_id) {
      zohoResult = await syncZohoContactForVendorClient(row);
      if (zohoResult.synced && zohoResult.contactId) {
        await row.update({ zoho_id: zohoResult.contactId });
        await row.reload();
      }
    }
    if (row.type === 'client' && !row.user_id) {
      await linkOrCreateUserForClientVendorRow(row);
      await row.reload();
    }
    if (row.type === 'client' && row.user_id) {
      const d = coerceDataObject(row.data);
      if (d.shipping_address || d.shippingAddress || d.billing_address || d.billingAddress) {
        await syncClientAddressesFromVendorData(row.user_id, d);
      }
    }
    const out = formatRow(row);
    attachZohoVendorClientSync(out, zohoResult);
    attachPriceListSync(out, priceSync);
    res.status(201).json(out);
  } catch (err) {
    console.error('createVendorClient error', err);
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message || 'Invalid request' });
    }
    if (err && err.code === 'ZOHO_SYNC_FAILED') {
      return res.status(err.status || 502).json({
        error: err.message || 'Zoho contact sync failed',
        code: err.code,
      });
    }
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

    const previousData = coerceDataObject(row.data);
    const previousVendorItems =
      previousData && Array.isArray(previousData.vendorItems)
        ? JSON.parse(JSON.stringify(previousData.vendorItems))
        : [];

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
    // Only overwrite the JSON blob when the client actually sends a `data` field.
    // This prevents partial updates (e.g. status-only) from wiping `vendorItems`.
    if (Object.prototype.hasOwnProperty.call(body, 'data')) row.data = payload.data;

    if (payload.user_id !== undefined) {
      if (payload.user_id === null) {
        row.user_id = null;
      } else {
        try {
          await assertUserAvailableForVendorClientLink(payload.user_id, row.id);
        } catch (e) {
          return res.status(e.status || 500).json({ error: e.message || 'Invalid user link' });
        }
        const u = await User.findByPk(payload.user_id, { attributes: ['userid'] });
        if (!u) return res.status(400).json({ error: 'userId not found' });
        row.user_id = payload.user_id;
      }
    }

    let priceSync = null;
    let zohoResult = null;
    const t = await db.transaction();
    try {
      await row.save({ transaction: t });
      if (row.type === 'vendor') {
        priceSync = await syncVendorMasterItemsToPriceList({
          vendorId: row.id,
          previousVendorItems,
          nextVendorItems: coerceDataObject(row.data)?.vendorItems,
          transaction: t,
        });
      }
      if (row.type === 'vendor' && isZohoVendorSyncRequired(row.type) && !row.zoho_id) {
        zohoResult = await applyZohoContactSyncInTransaction(row, t);
      }
      await t.commit();
    } catch (txErr) {
      await t.rollback();
      throw txErr;
    }

    await row.reload();

    if (row.user_id) {
      const u = await User.findByPk(row.user_id);
      if (u) await syncLinkedVendorClientFromUser(u).catch(() => {});
    }
    if (row.type === 'client' && !row.user_id) {
      await linkOrCreateUserForClientVendorRow(row);
      await row.reload();
    }
    if (row.type === 'client' && row.user_id) {
      const d = coerceDataObject(row.data);
      if (d.shipping_address || d.shippingAddress || d.billing_address || d.billingAddress) {
        await syncClientAddressesFromVendorData(row.user_id, d);
      }
    }
    if (row.type === 'client' && !row.zoho_id) {
      zohoResult = await syncZohoContactForVendorClient(row);
      if (zohoResult.synced && zohoResult.contactId) {
        await row.update({ zoho_id: zohoResult.contactId });
        await row.reload();
      }
    }
    const out = formatRow(row);
    attachZohoVendorClientSync(out, zohoResult);
    attachPriceListSync(out, priceSync);
    res.json(out);
  } catch (err) {
    console.error('updateVendorClient error', err);
    if (err && err.code === 'ZOHO_SYNC_FAILED') {
      return res.status(err.status || 502).json({
        error: err.message || 'Zoho contact sync failed',
        code: err.code,
      });
    }
    res.status(500).json({ error: 'Failed to update vendor/client' });
  }
}

async function deleteVendorClient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await VendorClient.findOne({ where: activeRowWhere({ id }) });
    if (!existing) return res.status(404).json({ error: 'Vendor/Client not found' });

    const t = await db.transaction();
    try {
      if (existing.type === 'vendor') {
        await deleteAllVendorPriceListRates(id, t);
      }
      await softDeleteInstance(existing, { transaction: t });
      await t.commit();
    } catch (txErr) {
      await t.rollback();
      throw txErr;
    }
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
  syncZohoVendorDraft,
  importZohoVendors,
  importZohoVendor,
  createVendorClient,
  updateVendorClient,
  deleteVendorClient,
};
