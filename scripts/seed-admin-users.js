#!/usr/bin/env node
require('dotenv').config();

const bcrypt = require('bcrypt');
const db = require('../db');
const { User } = require('../src/users/models');
const { Role, StaffProfile } = require('../src/roles/models');

const ROLE_SEED = [
  { role_code: 'super_admin', role_name: 'Super Admin', level: 'admin' },
  { role_code: 'admin', role_name: 'Admin', level: 'admin' },
];

/** EI team — password pattern EI@<local-part>, role super_admin */
const EI_SUPER_ADMIN_EMAILS = [
  'sweytha@estheticinsights.com',
  'sandeep@estheticinsights.com',
  'bindusree@estheticinsights.com',
  'bhaskar@estheticinsights.com',
  'shivavijayagiri@estheticinsights.com',
  'shivampathak@estheticinsights.com',
  'sravan@estheticinsights.com',
  'pavankalyan@estheticinsights.com',
  'sandepbysani@estheticinsights.com',
];

function capitalizeLocalPart(local) {
  const s = String(local || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function userFromEiEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  const local = normalized.split('@')[0];
  const display = capitalizeLocalPart(local);
  return {
    email: normalized,
    password: `EI@${local}`,
    fname: display,
    lname: '',
    display_name: display,
    mobile: null,
    usertype: 'super_admin',
    department: 'Administration',
  };
}

const ADMIN_USERS = [
  ...EI_SUPER_ADMIN_EMAILS.map(userFromEiEmail),
  {
    email: 'superadmin@example.com',
    password: 'SuperAdmin@123',
    fname: 'Super',
    lname: 'Admin',
    display_name: 'Super Admin',
    mobile: '+919876543201',
    usertype: 'super_admin',
    department: 'Administration',
  },
  {
    email: 'admin@example.com',
    password: 'Admin@123',
    fname: 'Admin',
    lname: 'User',
    display_name: 'Admin User',
    mobile: '+919876543202',
    usertype: 'admin',
    department: 'Administration',
  },
  {
    email: 'admin2@example.com',
    password: 'Admin2@123',
    fname: 'Vijay',
    lname: 'Kumar',
    display_name: 'Vijay Kumar',
    mobile: '+919876543204',
    usertype: 'admin',
    department: 'Administration',
  },
];

async function ensureRoles() {
  const out = {};
  for (const r of ROLE_SEED) {
    const [row] = await Role.findOrCreate({
      where: { role_code: r.role_code },
      defaults: {
        role_name: r.role_name,
        level: r.level,
        status: 'active',
      },
    });
    out[r.role_code] = row;
  }
  return out;
}

async function upsertAdminUser(u, rolesByCode) {
  const email = String(u.email).trim().toLowerCase();
  const now = new Date();
  const passwordHash = bcrypt.hashSync(String(u.password), 10);
  const role = rolesByCode[u.usertype];

  const existing = await User.findOne({ where: { email } });
  if (!existing) {
    const created = await User.create({
      fname: u.fname,
      lname: u.lname,
      display_name: u.display_name,
      email,
      mobile: u.mobile,
      password: passwordHash,
      usertype: u.usertype,
      department: u.department,
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 100,
      created_at: now,
      updated_at: now,
    });
    if (role) {
      await StaffProfile.upsert({
        user_id: created.userid,
        role_id: role.role_id,
        department: null,
        dep_level: null,
        created_at: now,
        updated_at: now,
      });
    }
    return { action: 'created', email };
  }

  await existing.update({
    fname: u.fname,
    lname: u.lname,
    display_name: u.display_name,
    mobile: u.mobile,
    password: passwordHash,
    usertype: u.usertype,
    department: u.department,
    status: 'active',
    verify_status: 'verified',
    updated_at: now,
  });

  if (role) {
    await StaffProfile.upsert({
      user_id: existing.userid,
      role_id: role.role_id,
      department: null,
      dep_level: null,
      created_at: now,
      updated_at: now,
    });
  }
  return { action: 'updated', email };
}

async function main() {
  await db.authenticate();
  const rolesByCode = await ensureRoles();
  const results = [];
  for (const u of ADMIN_USERS) {
    results.push(await upsertAdminUser(u, rolesByCode));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
  await db.close();
}

main().catch(async (e) => {
  console.error('[seed-admin-users]', e && e.message ? e.message : e);
  try {
    await db.close();
  } catch (_e) {}
  process.exit(1);
});

