#!/usr/bin/env node
/**
 * Pull Zoho Books customers and upsert them into local `users` table.
 *
 * Matching priority:
 * 1) users.zoho_contact_id == Zoho contact_id
 * 2) users.email == resolved email (fallback match, then attach zoho_contact_id)
 *
 * Usage:
 *   node scripts/zoho-pull-customers-to-users.js [--dry-run] [--max-pages=N] [--limit=N]
 *   node scripts/zoho-pull-customers-to-users.js --default-password="Temp@1234"
 *
 * Env:
 *   ZOHO_IMPORT_DEFAULT_PASSWORD   Optional, default: Temp@1234
 *   ZOHO_PULL_FILTER_BY            Optional pass-through to Zoho contacts list (usually leave empty)
 *   ZOHO_PULL_LIMIT                Same as --limit=N (max contact rows from Zoho before local filter)
 */

require('dotenv').config();

const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const db = require('../db');
const { User } = require('../src/users/models');
const {
  ensureClientVendorMasterForUser,
  syncLinkedVendorClientFromUser,
} = require('../src/vendorClient/userLink');
const { syncClientAddressesFromVendorData } = require('../src/addresses/clientAddressHelpers');
const { listAllContacts, normalizeZohoContactId, getOrgId, getContactById } = require('../src/services/zohoBooks');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');
const {
  evaluateRequiredFields,
  writeMissingFieldsReport,
  cleanOutputFile,
} = require('./lib/zoho-required-fields');

function parseExtraArgs(argv) {
  const dry = parseZohoPullArgs(argv);
  const passArg = argv.find((a) => String(a).startsWith('--default-password='));
  const defaultPassword = passArg
    ? String(passArg).slice('--default-password='.length)
    : String(process.env.ZOHO_IMPORT_DEFAULT_PASSWORD || 'Temp@1234');
  return { ...dry, defaultPassword };
}

function isZohoCustomer(row) {
  const t = String(row?.contact_type || '').trim().toLowerCase();
  if (t === 'customer') return true;
  const cs = String(row?.customer_sub_type || '').trim().toLowerCase();
  return cs.length > 0;
}

function pickPrimaryContactPerson(row) {
  const arr = Array.isArray(row?.contact_persons) ? row.contact_persons : [];
  if (arr.length === 0) return null;
  const primary = arr.find((p) => p && p.is_primary_contact === true);
  return primary || arr[0];
}

function normalizeEmail(s) {
  const v = String(s || '').trim().toLowerCase();
  return v || '';
}

function parseName(row) {
  const cp = pickPrimaryContactPerson(row);
  const cpFirst = String(cp?.first_name || '').trim();
  const cpLast = String(cp?.last_name || '').trim();
  const contactName = String(row?.contact_name || row?.company_name || '').trim();

  if (cpFirst || cpLast) {
    return {
      fname: cpFirst || (contactName ? contactName.split(/\s+/)[0] : 'Customer'),
      lname: cpLast || '',
      display_name: contactName || [cpFirst, cpLast].filter(Boolean).join(' ').trim(),
    };
  }

  const parts = contactName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { fname: 'Customer', lname: '', display_name: 'Customer' };
  }
  return {
    fname: parts[0],
    lname: parts.slice(1).join(' '),
    display_name: contactName,
  };
}

function resolveEmail(row) {
  const cp = pickPrimaryContactPerson(row);
  return normalizeEmail(cp?.email || row?.email || '');
}

function resolveMobile(row) {
  const cp = pickPrimaryContactPerson(row);
  const m = String(
    cp?.mobile ||
      cp?.phone ||
      row?.mobile ||
      row?.phone ||
      row?.landline ||
      row?.contact_number ||
      ''
  ).trim();
  return m || null;
}

function pickZohoAddressObject(row, type) {
  const addressesArray = Array.isArray(row?.addresses) ? row.addresses : [];
  const idx = type === 'shipping' ? 0 : 1;
  const fromList = addressesArray[idx] && typeof addressesArray[idx] === 'object' ? addressesArray[idx] : null;
  if (fromList) return fromList;
  if (type === 'shipping' && row?.shipping_address && typeof row.shipping_address === 'object') return row.shipping_address;
  if (type === 'billing' && row?.billing_address && typeof row.billing_address === 'object') return row.billing_address;
  return null;
}

function extractZohoAddressParts(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const line1 = String(obj.address || obj.street || obj.address_line1 || '').trim();
  const line2 = String(obj.street2 || obj.address_line2 || '').trim();
  const city = String(obj.city || obj.city_text || '').trim();
  const state = String(obj.state || obj.state_text || '').trim();
  const country = String(obj.country || obj.country_text || '').trim();
  const zip = String(obj.zip || obj.pincode || obj.postal_code || '').trim();
  const phone = String(obj.phone || obj.mobile || '').trim();

  const fallbackSingleLine = [line1, line2, city, state, zip, country].filter(Boolean).join(', ').trim();
  const addressLine1 = line1 || fallbackSingleLine || null;

  return {
    // keep original hint when present (Zoho may return address_type, etc.)
    address_type: obj.address_type != null ? String(obj.address_type).trim() || null : null,
    addressLine1,
    address_line1: addressLine1, // convenience key for downstream uses
    city_text: city || null,
    state_text: state || null,
    country_text: country || null,
    pincode: zip || null,
    phone: phone || null,
  };
}

function getAllZohoAddresses(row) {
  const addressesArray = Array.isArray(row?.addresses) ? row.addresses : [];
  return addressesArray
    .filter((a) => a && typeof a === 'object')
    .map((a, idx) => {
      const parts = extractZohoAddressParts(a);
      if (!parts) return null;
      return { index: idx, ...parts };
    })
    .filter(Boolean);
}

function getZohoShippingAddressParts(row) {
  return extractZohoAddressParts(pickZohoAddressObject(row, 'shipping'));
}

function getZohoBillingAddressParts(row) {
  return extractZohoAddressParts(pickZohoAddressObject(row, 'billing'));
}

function resolvePaymentTermsValue(row) {
  // Prefer label when present; fallback to payment_terms (days).
  const labelRaw = row?.payment_terms_label != null ? String(row.payment_terms_label).trim() : '';
  if (labelRaw) return labelRaw;

  const daysRaw = row?.payment_terms != null ? row.payment_terms : row?.paymentTerms;
  if (daysRaw === '' || daysRaw == null) return null;
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) return null;
  return String(days);
}

function normalizeText(v) {
  const s = String(v || '').trim();
  return s || null;
}

function deriveUserIdentityFromZoho(row) {
  const customerSubType = String(row?.customer_sub_type || '').trim().toLowerCase();
  const contactType = String(row?.contact_type || '').trim().toLowerCase();

  // Zoho Books usually has customer_sub_type as business / individual.
  // Keep customer as safe default unless explicit role-like markers are present.
  if (customerSubType === 'dermatologist' || customerSubType === 'doctor') {
    return { usertype: 'doctor', portal_signup_role: 'dermatologist' };
  }
  if (customerSubType === 'distributor') {
    return { usertype: 'customer', portal_signup_role: 'distributor' };
  }
  if (customerSubType === 'customer' || contactType === 'customer') {
    return { usertype: 'customer', portal_signup_role: 'customer' };
  }
  return { usertype: 'customer', portal_signup_role: 'customer' };
}

async function main() {
  const opts = parseExtraArgs(process.argv.slice(2));
  if (!opts.defaultPassword || String(opts.defaultPassword).length < 6) {
    throw new Error('default password must be at least 6 chars (use --default-password or ZOHO_IMPORT_DEFAULT_PASSWORD)');
  }

  // Ensure stale report is removed before we start exporting missing entries.
  await cleanOutputFile('exports/zoho-customers-missing-required-fields.json');

  const allContacts = await listAllContacts({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const customers = allContacts.filter(isZohoCustomer);

  const summaries = {
    organizationId: getOrgId(),
    pulledContacts: allContacts.length,
    customerContacts: customers.length,
    created: 0,
    updated: 0,
    skippedNoEmail: 0,
    skippedNoZohoId: 0,
    skippedMissingRequired: 0,
    errors: 0,
  };
  const missingRequiredCustomers = [];
  const requiredFieldsForCustomerImport = [
    { key: 'contact_id', getValue: (row) => normalizeZohoContactId(row?.contact_id) },
    {
      key: 'shipping_address_line1',
      getValue: (row) => getZohoShippingAddressParts(row)?.addressLine1,
    },
    {
      key: 'billing_address_line1',
      getValue: (row) => getZohoBillingAddressParts(row)?.addressLine1,
    },
    {
      key: 'payment_terms',
      getValue: (row) => resolvePaymentTermsValue(row),
    },
  ];

  const passwordHash = bcrypt.hashSync(String(opts.defaultPassword), 10);

  for (const row of customers) {
    let effectiveRow = row;
    const zohoId = normalizeZohoContactId(row?.contact_id);

    // Zoho list rows may not include full address objects; fetch details only when
    // both shipping & billing line1 are missing.
    if (zohoId) {
      const shippingParts = getZohoShippingAddressParts(effectiveRow);
      const billingParts = getZohoBillingAddressParts(effectiveRow);
      const needsAddressDetailFetch =
        (!shippingParts?.addressLine1 && !billingParts?.addressLine1) || !resolvePaymentTermsValue(effectiveRow);
      if (needsAddressDetailFetch) {
        try {
          const detailed = await getContactById(zohoId);
          if (detailed && typeof detailed === 'object') {
            effectiveRow = { ...effectiveRow, ...detailed };
          }
        } catch (e) {
          console.warn('[zoho-pull-customers-to-users] contact detail fetch failed (will use list row fallback):', e?.message || e, {
            zohoId,
          });
        }
      }
    }

    const missingFields = evaluateRequiredFields(effectiveRow, requiredFieldsForCustomerImport);
    if (missingFields.length > 0) {
      summaries.skippedMissingRequired += 1;
      const shippingParts = getZohoShippingAddressParts(effectiveRow);
      const billingParts = getZohoBillingAddressParts(effectiveRow);
      const allAddresses = getAllZohoAddresses(effectiveRow);
      const payment_terms_label = effectiveRow?.payment_terms_label != null ? String(effectiveRow.payment_terms_label).trim() : null;
      const payment_terms = effectiveRow?.payment_terms != null ? String(effectiveRow.payment_terms).trim() : null;
      missingRequiredCustomers.push({
        zoho_contact_id: normalizeZohoContactId(effectiveRow?.contact_id) || null,
        contact_name: String(effectiveRow?.contact_name || '').trim() || null,
        company_name: String(effectiveRow?.company_name || '').trim() || null,
        email: resolveEmail(effectiveRow) || null,
        contact_type: String(effectiveRow?.contact_type || '').trim() || null,
        customer_sub_type: String(effectiveRow?.customer_sub_type || '').trim() || null,
        shipping_address: shippingParts,
        billing_address: billingParts,
        addresses: allAddresses,
        payment_terms_label,
        payment_terms,
        missing_fields: missingFields,
      });
      // Intentionally do NOT skip import; we only export missing details for follow-up.
    }

    if (!zohoId) {
      summaries.skippedNoZohoId += 1;
      continue;
    }
    const email = resolveEmail(effectiveRow);
    if (!email) {
      summaries.skippedNoEmail += 1;
      continue;
    }

    const { fname, lname, display_name } = parseName(effectiveRow);
    const mobile = resolveMobile(effectiveRow);
    const identity = deriveUserIdentityFromZoho(effectiveRow);

    try {
      const where = {
        [Op.or]: [{ zoho_contact_id: zohoId }, { email }],
      };
      const existing = await User.findOne({ where });
      let savedUser = null;
      if (!existing) {
        if (!opts.dryRun) {
          savedUser = await User.create({
            fname: normalizeText(fname),
            lname: normalizeText(lname),
            display_name: normalizeText(display_name) || email,
            email,
            mobile,
            password: passwordHash,
            usertype: identity.usertype,
            portal_signup_role: identity.portal_signup_role,
            status: 'active',
            verify_status: 'verified',
            zoho_contact_id: zohoId,
            created_at: new Date(),
            updated_at: new Date(),
          });
          // Keep related Client Master in sync for portal/customer users.
          await ensureClientVendorMasterForUser(savedUser);
          await syncLinkedVendorClientFromUser(savedUser);

          // Create addresses directly from Zoho contact shipping/billing objects.
          try {
            const shippingObj = pickZohoAddressObject(effectiveRow, 'shipping');
            const billingObj = pickZohoAddressObject(effectiveRow, 'billing');
            const shipParts = getZohoShippingAddressParts(effectiveRow);
            const billParts = getZohoBillingAddressParts(effectiveRow);
            const addrData = {};
            if (shippingObj) addrData.shipping_address_object = shippingObj;
            else if (shipParts?.addressLine1) addrData.shipping_address = shipParts.addressLine1;
            if (billingObj) addrData.billing_address_object = billingObj;
            else if (billParts?.addressLine1) addrData.billing_address = billParts.addressLine1;
            if (Object.keys(addrData).length > 0) {
              await syncClientAddressesFromVendorData(savedUser.userid, addrData);
            }
          } catch (_e) {
            console.warn('[zoho-pull-customers-to-users] address sync failed for created user:', zohoId);
          }
        }
        summaries.created += 1;
        continue;
      }

      const updates = {
        zoho_contact_id: zohoId,
        fname: normalizeText(fname) || existing.fname || null,
        lname: normalizeText(lname) || existing.lname || null,
        display_name: normalizeText(display_name) || existing.display_name || existing.email,
        mobile: mobile || existing.mobile || null,
        usertype: existing.usertype || identity.usertype || 'customer',
        portal_signup_role: existing.portal_signup_role || identity.portal_signup_role || 'customer',
        verify_status: existing.verify_status || 'verified',
        updated_at: new Date(),
      };
      if (!opts.dryRun) {
        await existing.update(updates);
        savedUser = await existing.reload();
        // Keep related Client Master in sync for portal/customer users.
        await ensureClientVendorMasterForUser(savedUser);
        await syncLinkedVendorClientFromUser(savedUser);

        // Refresh addresses from Zoho contact details.
        try {
          const shippingObj = pickZohoAddressObject(effectiveRow, 'shipping');
          const billingObj = pickZohoAddressObject(effectiveRow, 'billing');
          const shipParts = getZohoShippingAddressParts(effectiveRow);
          const billParts = getZohoBillingAddressParts(effectiveRow);
          const addrData = {};
          if (shippingObj) addrData.shipping_address_object = shippingObj;
          else if (shipParts?.addressLine1) addrData.shipping_address = shipParts.addressLine1;
          if (billingObj) addrData.billing_address_object = billingObj;
          else if (billParts?.addressLine1) addrData.billing_address = billParts.addressLine1;
          if (Object.keys(addrData).length > 0) {
            await syncClientAddressesFromVendorData(savedUser.userid, addrData);
          }
        } catch (_e) {
          console.warn('[zoho-pull-customers-to-users] address sync failed for updated user:', zohoId);
        }
      }
      summaries.updated += 1;
    } catch (e) {
      summaries.errors += 1;
      console.error('[zoho-pull-customers-to-users] upsert error:', e?.message || e, {
        zohoId,
        email,
      });
    }
  }

  const missingReportPath = await writeMissingFieldsReport({
    outputPath: 'exports/zoho-customers-missing-required-fields.json',
    entity: 'zoho-customers-to-users',
    requiredFields: requiredFieldsForCustomerImport.map((f) => f.key),
    missingRecords: missingRequiredCustomers,
    meta: {
      organizationId: getOrgId(),
      pulledContacts: allContacts.length,
      customerContacts: customers.length,
      dryRun: !!opts.dryRun,
      limit: opts.limit ?? null,
    },
  });
  summaries.missingReportPath = missingReportPath;
  summaries.missingRequiredRecords = missingRequiredCustomers.length;

  console.log(JSON.stringify({ dryRun: !!opts.dryRun, limit: opts.limit ?? null, ...summaries }, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-customers-to-users]', e?.message || e);
  process.exit(1);
});

