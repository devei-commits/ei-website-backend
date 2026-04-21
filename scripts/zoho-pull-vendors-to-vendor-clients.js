#!/usr/bin/env node
/**
 * Pull Zoho vendor contacts and upsert into local `vendor_clients` (type='vendor').
 *
 * Usage: node scripts/zoho-pull-vendors-to-vendor-clients.js [--dry-run] [--max-pages=N] [--limit=N] [--filter-by=...]
 * `--limit=N` caps how many contact rows are fetched from Zoho (then filtered to vendors).
 */
require('dotenv').config();

const { Op, fn, col, where: sqlWhere } = require('sequelize');
const db = require('../db');
const VendorClient = require('../src/vendorClient/models');
const { allocateNextEntityCode } = require('../src/vendorClient/userLink');
const { listAllContacts, normalizeZohoContactId, getOrgId } = require('../src/services/zohoBooks');
const { mapZohoBooksContactToVendorFormFields } = require('../src/users/zohoContactSync');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');

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

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
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
  };

  for (const row of vendors) {
    const zohoId = normalizeZohoContactId(row?.contact_id);
    if (!zohoId) { summary.skippedNoZohoId += 1; continue; }
    const payload = toVendorPayloadFromZoho(row, zohoId);
    if (!payload.email) { summary.skippedNoEmail += 1; continue; }

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
        if (!opts.dryRun) {
          const code = await allocateNextEntityCode('vendor');
          await VendorClient.create({
            entity_code: code,
            type: 'vendor',
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
            category: existing.category || payload.category,
            status: existing.status || payload.status,
            payment_terms: payload.payment_terms || existing.payment_terms,
            notes: payload.notes || existing.notes,
            data: nextData,
            updated_at: new Date(),
          });
        }
        summary.updated += 1;
      }
    } catch (e) {
      summary.errors += 1;
      console.error('[zoho-pull-vendors-to-vendor-clients] upsert error:', e?.message || e, {
        zohoId,
        email: payload.email,
      });
    }
  }

  console.log(JSON.stringify({ dryRun: !!opts.dryRun, limit: opts.limit ?? null, ...summary }, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-vendors-to-vendor-clients]', e?.message || e);
  process.exit(1);
});
