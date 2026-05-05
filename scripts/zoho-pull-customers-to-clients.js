#!/usr/bin/env node
/**
 * Pull Zoho customer contacts and upsert into local `vendor_clients` (type='client').
 *
 * Usage: node scripts/zoho-pull-customers-to-clients.js [--dry-run] [--max-pages=N] [--limit=N] [--filter-by=...]
 */
require('dotenv').config();

const { Op, fn, col, where: sqlWhere } = require('sequelize');
const VendorClient = require('../src/vendorClient/models');
const { allocateNextEntityCode, linkOrCreateUserForClientVendorRow } = require('../src/vendorClient/userLink');
const { syncClientAddressesFromVendorData } = require('../src/addresses/clientAddressHelpers');
const { listAllContacts, getContactById, normalizeZohoContactId, getOrgId } = require('../src/services/zohoBooks');
const { mapZohoBooksContactToVendorFormFields } = require('../src/users/zohoContactSync');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');

function isZohoCustomer(row) {
  const t = String(row?.contact_type || '').trim().toLowerCase();
  if (t === 'customer') return true;
  const cs = String(row?.customer_sub_type || '').trim().toLowerCase();
  return !!cs;
}

function pickPrimaryContactPerson(row) {
  const arr = Array.isArray(row?.contact_persons) ? row.contact_persons : [];
  if (arr.length === 0) return null;
  return arr.find((p) => p && p.is_primary_contact === true) || arr[0];
}

function normalizeEmail(s) {
  const v = String(s || '').trim().toLowerCase();
  return v || '';
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
  return cpName || 'Client';
}

function categoryFromZoho(row) {
  const st = String(row?.customer_sub_type || '').trim().toLowerCase();
  if (st === 'dermatologist' || st === 'doctor') return 'Dermatologist';
  if (st === 'distributor') return 'Distributor';
  return 'Customer';
}

function toClientPayloadFromZoho(row, zohoId) {
  const addressesArray = Array.isArray(row?.addresses) ? row.addresses : [];
  // Zoho per-customer /addresses endpoint returns ordered array:
  // index 0 => shipping, index 1 => billing.
  const shipFromList = addressesArray[0] && typeof addressesArray[0] === 'object' ? addressesArray[0] : null;
  const billFromList = addressesArray[1] && typeof addressesArray[1] === 'object' ? addressesArray[1] : null;
  const shipObj = shipFromList || (row?.shipping_address && typeof row.shipping_address === 'object' ? row.shipping_address : null);
  const billObj =
    billFromList ||
    (row?.billing_address && typeof row.billing_address === 'object' ? row.billing_address : null) ||
    shipObj;

  const mapped = mapZohoBooksContactToVendorFormFields(row || {});
  const country = String(billObj?.country || shipObj?.country || mapped.country || '').trim() || null;
  const city = String(billObj?.city || shipObj?.city || '').trim() || null;
  const location = String(billObj?.state || shipObj?.state || mapped.state || '').trim() || null;
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
    billingAddressObject: billObj || undefined,
    shippingAddressObject: shipObj || undefined,
    notes: notes || '',
    setupCategory: categoryFromZoho(row),
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
    category: categoryFromZoho(row),
    status: String(row?.status || '').trim().toLowerCase() === 'inactive' ? 'inactive' : 'active',
    payment_terms: paymentTerms,
    notes,
    data: formData,
  };
}

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const allContacts = await listAllContacts({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const customers = allContacts.filter(isZohoCustomer);

  const summary = {
    organizationId: getOrgId(),
    pulledContacts: allContacts.length,
    customerContacts: customers.length,
    created: 0,
    updated: 0,
    linkedUser: 0,
    detailFetched: 0,
    detailFetchFailed: 0,
    skippedNoZohoId: 0,
    skippedNoEmail: 0,
    errors: 0,
  };

  for (const row of customers) {
    const zohoId = normalizeZohoContactId(row?.contact_id);
    if (!zohoId) {
      summary.skippedNoZohoId += 1;
      continue;
    }
    let effectiveRow = row;
    try {
      const detailed = await getContactById(zohoId);
      if (detailed && typeof detailed === 'object') {
        effectiveRow = { ...row, ...detailed };
        summary.detailFetched += 1;
      }
    } catch (e) {
      summary.detailFetchFailed += 1;
      console.warn('[zoho-pull-customers-to-clients] contact details fallback to list row:', e?.message || e, { zohoId });
    }

    const payload = toClientPayloadFromZoho(effectiveRow, zohoId);
    if (!payload.email) {
      summary.skippedNoEmail += 1;
      continue;
    }

    try {
      const existing = await VendorClient.findOne({
        where: {
          type: 'client',
          [Op.or]: [
            { zoho_id: zohoId },
            sqlWhere(fn('LOWER', col('email')), payload.email),
          ],
        },
      });

      let rowInstance = existing;
      if (!existing) {
        if (!opts.dryRun) {
          const code = await allocateNextEntityCode('client');
          rowInstance = await VendorClient.create({
            entity_code: code,
            type: 'client',
            ...payload,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
        summary.created += 1;
      } else {
        const prevData = existing.data && typeof existing.data === 'object' ? existing.data : {};
        const nextData = { ...prevData, ...(payload.data || {}) };
        if (!opts.dryRun) {
          await existing.update({
            zoho_id: payload.zoho_id,
            name: payload.name || existing.name,
            email: payload.email || existing.email,
            phone: payload.phone || existing.phone,
            location: payload.location || existing.location,
            country: payload.country || existing.country,
            city: payload.city || existing.city,
            category: payload.category || existing.category,
            status: payload.status || existing.status,
            payment_terms: payload.payment_terms || existing.payment_terms,
            notes: payload.notes || existing.notes,
            data: nextData,
            updated_at: new Date(),
          });
          rowInstance = await existing.reload();
        }
        summary.updated += 1;
      }

      if (!opts.dryRun && rowInstance && !rowInstance.user_id) {
        const linked = await linkOrCreateUserForClientVendorRow(rowInstance);
        if (linked && linked.user_id) summary.linkedUser += 1;
        if (linked && linked.user_id) {
          const plain = linked.get ? linked.get({ plain: true }) : linked;
          await syncClientAddressesFromVendorData(linked.user_id, plain.data || {});
        }
      } else if (!opts.dryRun && rowInstance && rowInstance.user_id) {
        const plain = rowInstance.get ? rowInstance.get({ plain: true }) : rowInstance;
        await syncClientAddressesFromVendorData(rowInstance.user_id, plain.data || {});
      }
    } catch (e) {
      summary.errors += 1;
      console.error('[zoho-pull-customers-to-clients] upsert error:', e?.message || e, {
        zohoId,
        email: payload.email,
      });
    }
  }

  console.log(JSON.stringify({ dryRun: !!opts.dryRun, limit: opts.limit ?? null, ...summary }, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-customers-to-clients]', e?.message || e);
  process.exit(1);
});

