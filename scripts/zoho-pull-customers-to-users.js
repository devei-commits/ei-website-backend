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
const { listAllContacts, normalizeZohoContactId, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');

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
  const m = String(cp?.mobile || row?.mobile || cp?.phone || row?.phone || '').trim();
  return m || null;
}

async function main() {
  const opts = parseExtraArgs(process.argv.slice(2));
  if (!opts.defaultPassword || String(opts.defaultPassword).length < 6) {
    throw new Error('default password must be at least 6 chars (use --default-password or ZOHO_IMPORT_DEFAULT_PASSWORD)');
  }

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
    errors: 0,
  };

  const passwordHash = bcrypt.hashSync(String(opts.defaultPassword), 10);

  for (const row of customers) {
    const zohoId = normalizeZohoContactId(row?.contact_id);
    if (!zohoId) {
      summaries.skippedNoZohoId += 1;
      continue;
    }
    const email = resolveEmail(row);
    if (!email) {
      summaries.skippedNoEmail += 1;
      continue;
    }

    const { fname, lname, display_name } = parseName(row);
    const mobile = resolveMobile(row);

    try {
      const where = {
        [Op.or]: [{ zoho_contact_id: zohoId }, { email }],
      };
      const existing = await User.findOne({ where });
      if (!existing) {
        if (!opts.dryRun) {
          await User.create({
            fname: fname || null,
            lname: lname || null,
            display_name: display_name || email,
            email,
            mobile,
            password: passwordHash,
            usertype: 'customer',
            portal_signup_role: 'customer',
            status: 'active',
            verify_status: 'verified',
            zoho_contact_id: zohoId,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
        summaries.created += 1;
        continue;
      }

      const updates = {
        zoho_contact_id: zohoId,
        fname: existing.fname || fname || null,
        lname: existing.lname || lname || null,
        display_name: existing.display_name || display_name || existing.email,
        mobile: existing.mobile || mobile,
        usertype: existing.usertype || 'customer',
        portal_signup_role: existing.portal_signup_role || 'customer',
        updated_at: new Date(),
      };
      if (!opts.dryRun) {
        await existing.update(updates);
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

  console.log(JSON.stringify({ dryRun: !!opts.dryRun, limit: opts.limit ?? null, ...summaries }, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-customers-to-users]', e?.message || e);
  process.exit(1);
});

