/**
 * Pull Zoho vendor contacts and upsert into local `vendor_clients` (type='vendor').
 *
 * Core logic shared by:
 *  - the in-app "Import from Zoho" button (POST /api/v1/vendor-clients/import-zoho-vendors)
 *  - scripts/zoho-pull-vendors-to-vendor-clients.js (CLI/ops use, same upsert rules)
 */
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const VendorClient = require('./models');
const { allocateNextEntityCode } = require('./userLink');
const { listAllContacts, getContactById, normalizeZohoContactId, getOrgId } = require('../services/zohoBooks');
const { mapZohoBooksContactToVendorFormFields } = require('../users/zohoContactSync');

function isZohoVendor(row) {
  const t = String(row?.contact_type || '').trim().toLowerCase();
  if (t === 'vendor') return true;
  const vs = String(row?.vendor_sub_type || '').trim().toLowerCase();
  return !!vs;
}

function normalizeEmail(s) {
  const v = String(s || '').trim().toLowerCase();
  return v || '';
}

function pickPrimaryContactPerson(row) {
  const arr = Array.isArray(row?.contact_persons) ? row.contact_persons : [];
  if (arr.length === 0) return null;
  return arr.find((p) => p && p.is_primary_contact === true) || arr[0];
}

function resolveEmail(row) {
  const cp = pickPrimaryContactPerson(row);
  return normalizeEmail(cp?.email || row?.email || '');
}

function resolvePhone(row) {
  const cp = pickPrimaryContactPerson(row);
  const v = String(cp?.mobile || cp?.phone || row?.phone || row?.mobile || '').trim();
  return v || null;
}

function displayName(row) {
  const name = String(row?.contact_name || row?.company_name || '').trim();
  if (name) return name;
  const cp = pickPrimaryContactPerson(row);
  const cpName = [cp?.first_name, cp?.last_name].filter(Boolean).join(' ').trim();
  return cpName || 'Vendor';
}

function toVendorPayloadFromZoho(row, zohoId) {
  const mapped = mapZohoBooksContactToVendorFormFields(row || {});
  const country = String(row?.billing_address?.country || row?.shipping_address?.country || mapped.country || '').trim() || null;
  const city = String(row?.billing_address?.city || row?.shipping_address?.city || '').trim() || null;
  const location = String(row?.billing_address?.state || row?.shipping_address?.state || mapped.state || '').trim() || null;
  const notes = String(row?.notes || '').trim() || null;
  const paymentTerms = row?.payment_terms_label != null && String(row.payment_terms_label).trim()
    ? String(row.payment_terms_label).trim()
    : row?.payment_terms != null
      ? `NET ${String(row.payment_terms).trim()}`
      : null;

  const formData = {
    tradeName: mapped.tradeName || displayName(row),
    legalName: mapped.legalName || String(row?.company_name || '').trim() || displayName(row),
    primaryEmail: resolveEmail(row) || '',
    primaryPhone: resolvePhone(row) || '',
    website: mapped.website || '',
    gstin: mapped.gstin || '',
    pan: mapped.pan || '',
    billingAddress: mapped.billingAddress || '',
    shippingAddress: mapped.shippingAddress || mapped.billingAddress || '',
    notes: notes || '',
    setupCategory: 'Vendor',
    zohoId: zohoId || '',
  };

  return {
    zoho_id: zohoId,
    name: displayName(row),
    email: resolveEmail(row) || null,
    phone: resolvePhone(row),
    location,
    country,
    city,
    category: 'Vendor',
    status: 'active',
    payment_terms: paymentTerms,
    notes,
    data: formData,
  };
}

/**
 * Upsert one Zoho contact row into vendor_clients (matched by zoho_id first, then email).
 * Shared by the bulk pull and the single-vendor import (by Zoho ID or by name).
 * @returns {Promise<{ action: 'created'|'updated'|'skipped'|'error', reason?: string, vendor?: object }>}
 */
async function upsertOneZohoVendor(row, opts = {}) {
  const zohoId = normalizeZohoContactId(row?.contact_id);
  if (!zohoId) return { action: 'skipped', reason: 'no_zoho_id' };
  const payload = toVendorPayloadFromZoho(row, zohoId);
  if (!payload.email) return { action: 'skipped', reason: 'no_email' };

  try {
    const existing = await VendorClient.findOne({
      where: {
        type: 'vendor',
        [Op.or]: [
          { zoho_id: zohoId },
          sqlWhere(fn('LOWER', col('email')), payload.email),
        ],
      },
    });

    if (!existing) {
      if (opts.dryRun) return { action: 'created', vendor: { name: payload.name, email: payload.email } };
      const code = await allocateNextEntityCode('vendor');
      const created = await VendorClient.create({
        entity_code: code,
        type: 'vendor',
        ...payload,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return { action: 'created', vendor: { id: created.id, name: payload.name, email: payload.email } };
    }

    const prevData = existing.data && typeof existing.data === 'object' ? existing.data : {};
    const nextData = { ...prevData, ...(payload.data || {}) };
    if (opts.dryRun) return { action: 'updated', vendor: { name: payload.name, email: payload.email } };
    await existing.update({
      zoho_id: payload.zoho_id,
      name: payload.name || existing.name,
      email: payload.email || existing.email,
      phone: payload.phone || existing.phone,
      location: payload.location || existing.location,
      country: payload.country || existing.country,
      city: payload.city || existing.city,
      category: existing.category || payload.category,
      status: existing.status || payload.status,
      payment_terms: payload.payment_terms || existing.payment_terms,
      notes: payload.notes || existing.notes,
      data: nextData,
      updated_at: new Date(),
    });
    return { action: 'updated', vendor: { id: existing.id, name: payload.name, email: payload.email } };
  } catch (e) {
    console.error('[zohoVendorPull] upsert error:', e?.message || e, { zohoId, email: payload.email });
    return { action: 'error', reason: e?.message || String(e) };
  }
}

/**
 * @param {object} opts
 * @param {boolean} [opts.dryRun] - report counts only, write nothing
 * @param {string} [opts.filterBy] - Zoho contacts list filter_by param
 * @param {number} [opts.maxPages]
 * @param {number} [opts.limit] - caps how many contact rows are fetched from Zoho before filtering to vendors
 */
async function pullZohoVendorsIntoVendorClients(opts = {}) {
  const allContacts = await listAllContacts({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const vendors = allContacts.filter(isZohoVendor);

  const summary = {
    organizationId: getOrgId(),
    pulledContacts: allContacts.length,
    vendorContacts: vendors.length,
    created: 0,
    updated: 0,
    skippedNoZohoId: 0,
    skippedNoEmail: 0,
    errors: 0,
    createdVendors: [],
    updatedVendors: [],
  };

  for (const row of vendors) {
    const result = await upsertOneZohoVendor(row, opts);
    if (result.action === 'created') { summary.created += 1; if (result.vendor) summary.createdVendors.push(result.vendor); }
    else if (result.action === 'updated') { summary.updated += 1; if (result.vendor) summary.updatedVendors.push(result.vendor); }
    else if (result.action === 'error') summary.errors += 1;
    else if (result.reason === 'no_zoho_id') summary.skippedNoZohoId += 1;
    else if (result.reason === 'no_email') summary.skippedNoEmail += 1;
  }

  return summary;
}

/**
 * Import exactly one vendor from Zoho — by Zoho contact ID (exact, fastest) or by a name search.
 * A name search that matches more than one vendor contact does NOT guess: it returns the
 * candidates instead so the caller can re-invoke with the specific zohoId.
 * @param {{ zohoId?: string, search?: string, dryRun?: boolean }} opts
 * @returns {Promise<
 *   | { imported: true, action: 'created'|'updated', vendor: object }
 *   | { imported: false, reason: string, matches?: Array<{ zohoId: string, name: string, email: string }> }
 * >}
 */
async function importOneZohoVendor(opts = {}) {
  const zohoId = opts.zohoId ? normalizeZohoContactId(opts.zohoId) : null;
  const search = String(opts.search || '').trim();

  if (zohoId) {
    const row = await getContactById(zohoId);
    if (!row) return { imported: false, reason: 'not_found' };
    if (!isZohoVendor(row)) return { imported: false, reason: 'not_a_vendor' };
    const result = await upsertOneZohoVendor(row, { dryRun: opts.dryRun });
    if (result.action === 'created' || result.action === 'updated') {
      return { imported: true, action: result.action, vendor: result.vendor };
    }
    return { imported: false, reason: result.reason || 'skipped' };
  }

  if (!search) {
    const err = new Error('Provide either a Zoho ID or a name to search for.');
    err.statusCode = 400;
    throw err;
  }

  const found = await listAllContacts({ searchText: search, maxPages: 1, limit: 25 });
  const vendors = found.filter(isZohoVendor);
  if (vendors.length === 0) return { imported: false, reason: 'no_match' };

  if (vendors.length > 1) {
    return {
      imported: false,
      reason: 'multiple_matches',
      matches: vendors.map((row) => ({
        zohoId: normalizeZohoContactId(row?.contact_id) || '',
        name: displayName(row),
        email: resolveEmail(row) || '',
      })),
    };
  }

  const result = await upsertOneZohoVendor(vendors[0], { dryRun: opts.dryRun });
  if (result.action === 'created' || result.action === 'updated') {
    return { imported: true, action: result.action, vendor: result.vendor };
  }
  return { imported: false, reason: result.reason || 'skipped' };
}

module.exports = {
  pullZohoVendorsIntoVendorClients,
  importOneZohoVendor,
  // exported for the CLI script / tests
  isZohoVendor,
  toVendorPayloadFromZoho,
};
