const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const VendorClient = require('./models');
const { User } = require('../users/models');

/** Portal users that should have a client row in vendor_clients (Masters → Clients). */
const CLIENT_MASTER_USERTYPES = new Set(['customer', 'doctor']);

function displayNameFromUser(user) {
  const u = user.get ? user.get({ plain: true }) : user;
  if (u.display_name && String(u.display_name).trim()) return String(u.display_name).trim();
  const parts = [u.fname, u.lname].filter(Boolean);
  if (parts.length) return parts.join(' ').trim();
  return (u.email && String(u.email).trim()) || '';
}

/** Maps website signup / user row → Client Master category column + data.portalSignupRole */
function clientMasterCategoryFromUser(user, opts = {}) {
  const u = user.get ? user.get({ plain: true }) : user;
  const raw = String(
    opts.signupRole ?? u.portal_signup_role ?? ''
  )
    .trim()
    .toLowerCase();
  if (raw === 'customer') return { category: 'Customer', portalSignupRole: 'customer' };
  if (raw === 'dermatologist') return { category: 'Dermatologist', portalSignupRole: 'dermatologist' };
  if (raw === 'distributor') return { category: 'Distributor', portalSignupRole: 'distributor' };
  const ut = String(u.usertype || '').toLowerCase();
  if (ut === 'doctor') return { category: 'Professional', portalSignupRole: null };
  if (ut === 'customer') return { category: 'Customer', portalSignupRole: 'customer' };
  return { category: 'Customer', portalSignupRole: null };
}

async function allocateNextEntityCode(masterType, transaction) {
  const prefix = masterType === 'client' ? 'EI-CLI-' : 'EI-VEN-';
  const rows = await VendorClient.findAll({
    where: { entity_code: { [Op.like]: `${prefix}%` } },
    attributes: ['entity_code'],
    order: [['entity_code', 'DESC']],
    limit: 500,
    transaction,
  });
  let nextNum = 1;
  const numericPart = rows
    .map((r) => {
      const code = r.entity_code || r.get?.('entity_code');
      const match = String(code).replace(prefix, '').match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => !Number.isNaN(n));
  if (numericPart.length > 0) nextNum = Math.max(...numericPart) + 1;
  return `${prefix}${String(nextNum).padStart(5, '0')}`;
}

/**
 * Ensure a vendor_clients row (type client) exists and is linked to this user.
 * Links an existing unlinked client row with the same email when possible.
 *
 * @param {import('../users/models').User} user
 * @param {object} [opts]
 * @param {import('sequelize').Transaction} [opts.transaction]
 * @returns {Promise<import('./models')|null>}
 */
async function ensureClientVendorMasterForUser(user, opts = {}) {
  const { transaction } = opts;
  if (!user || user.userid == null) return null;
  const usertype = user.usertype || '';
  if (!CLIENT_MASTER_USERTYPES.has(usertype)) return null;

  const uid = user.userid;
  const emailNorm = (user.email || '').trim().toLowerCase();
  const { category: categoryLabel, portalSignupRole } = clientMasterCategoryFromUser(user, opts);

  let row = await VendorClient.findOne({ where: { user_id: uid }, transaction });
  if (row && row.type !== 'client') {
    return row;
  }

  if (!row && emailNorm) {
    row = await VendorClient.findOne({
      where: {
        type: 'client',
        user_id: null,
        [Op.and]: [sqlWhere(fn('LOWER', col('email')), emailNorm)],
      },
      transaction,
    });
  }

  const name = displayNameFromUser(user);
  const zohoFromUser = user.zoho_contact_id != null && String(user.zoho_contact_id).trim()
    ? String(user.zoho_contact_id).trim()
    : null;

  const dataMerge = (existingData) => {
    const base = existingData && typeof existingData === 'object' ? { ...existingData } : {};
    base.linkedFromUser = true;
    if (portalSignupRole) base.portalSignupRole = portalSignupRole;
    base.setupCategory = categoryLabel;
    return base;
  };

  if (row) {
    const updates = {
      user_id: uid,
      name: name || row.name,
      email: user.email || row.email,
      category: categoryLabel,
      data: dataMerge(row.data),
    };
    if (user.mobile !== undefined && user.mobile !== null && String(user.mobile).trim()) {
      updates.phone = user.mobile;
    }
    if (!row.zoho_id && zohoFromUser) {
      updates.zoho_id = zohoFromUser;
    }
    if (user.status === 'inactive' && row.status !== 'inactive') {
      updates.status = 'inactive';
    }
    await row.update(updates, { transaction });
    return row.reload({ transaction });
  }

  const entity_code = await allocateNextEntityCode('client', transaction);
  return VendorClient.create(
    {
      entity_code,
      type: 'client',
      user_id: uid,
      zoho_id: zohoFromUser,
      name: name || emailNorm || 'Client',
      email: user.email || null,
      phone: user.mobile || null,
      location: null,
      country: null,
      city: null,
      category: categoryLabel,
      status: user.status === 'inactive' ? 'inactive' : 'active',
      data: dataMerge(null),
    },
    { transaction }
  );
}

/**
 * Push name/email/phone/status from users → linked vendor_clients (any type).
 */
async function syncLinkedVendorClientFromUser(user, opts = {}) {
  const { transaction } = opts;
  if (!user || user.userid == null) return null;
  const row = await VendorClient.findOne({ where: { user_id: user.userid }, transaction });
  if (!row) return null;
  const name = displayNameFromUser(user);
  const updates = {};
  if (name) updates.name = name;
  if (user.email !== undefined) updates.email = user.email;
  if (user.mobile !== undefined) updates.phone = user.mobile;
  if (user.status === 'inactive') updates.status = 'inactive';
  if (Object.keys(updates).length === 0) return row;
  await row.update(updates, { transaction });
  return row.reload({ transaction });
}

/**
 * Reserve user_id for a vendor_client row; throws if user already linked elsewhere.
 * @param {number} userId
 * @param {number|null} [excludeVendorClientId] when updating existing row
 */
async function assertUserAvailableForVendorClientLink(userId, excludeVendorClientId, transaction) {
  const uid = parseInt(String(userId), 10);
  if (Number.isNaN(uid)) {
    const err = new Error('Invalid userId');
    err.status = 400;
    throw err;
  }
  const existing = await VendorClient.findOne({
    where: { user_id: uid },
    transaction,
  });
  if (existing && existing.id !== excludeVendorClientId) {
    const err = new Error('This user is already linked to another vendor/client master record');
    err.status = 409;
    throw err;
  }
}

/**
 * Masters → Users: for a client master row with email but no user_id, link an existing
 * portal user (customer/doctor) or create a customer user (random password; use reset flow).
 */
async function linkOrCreateUserForClientVendorRow(vcRow, opts = {}) {
  const { transaction } = opts;
  if (!vcRow || vcRow.type !== 'client') return vcRow;
  await vcRow.reload({ transaction });
  if (vcRow.user_id) return vcRow;

  const emailNorm = (vcRow.email || '').trim().toLowerCase();
  if (!emailNorm) return vcRow;

  let user = await User.findOne({ where: { email: emailNorm }, transaction });

  if (user) {
    if (!CLIENT_MASTER_USERTYPES.has(user.usertype)) {
      return vcRow;
    }
  } else {
    const randomPw = crypto.randomBytes(24).toString('base64url');
    const displayName = (vcRow.name && String(vcRow.name).trim()) || emailNorm;
    user = await User.create(
      {
        fname: null,
        lname: null,
        display_name: displayName,
        email: emailNorm,
        mobile: vcRow.phone || null,
        password: bcrypt.hashSync(randomPw, 10),
        usertype: 'customer',
        status: 'active',
        verify_status: 'verified',
      },
      { transaction }
    );
  }

  try {
    await assertUserAvailableForVendorClientLink(user.userid, vcRow.id, transaction);
  } catch (_e) {
    return vcRow;
  }

  await vcRow.update({ user_id: user.userid }, { transaction });
  await syncLinkedVendorClientFromUser(user, { transaction });
  return vcRow.reload({ transaction });
}

module.exports = {
  CLIENT_MASTER_USERTYPES,
  ensureClientVendorMasterForUser,
  syncLinkedVendorClientFromUser,
  assertUserAvailableForVendorClientLink,
  allocateNextEntityCode,
  displayNameFromUser,
  clientMasterCategoryFromUser,
  linkOrCreateUserForClientVendorRow,
};
