/**
 * Assignable internal team — warehouse, production, masters approver pickers.
 * Includes dashboard staff (admin / manager / staff roles), never portal customer/doctor.
 */
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { User } = require('./models');
const { StaffProfile, Role } = require('../models/index');
const { activeRowWhere } = require('../lib/softDelete');
const {
  PORTAL_USERTYPES,
  INTERNAL_STAFF_USERTYPES_FALLBACK,
  buildInternalStaffRolesWhere,
  isPortalUsertype,
} = require('./internalStaff');

/** Exclude portal accounts regardless of string casing in DB. */
function portalUsertypeExcludeClause() {
  return sqlWhere(fn('LOWER', col('usertype')), {
    [Op.notIn]: PORTAL_USERTYPES.map((t) => t.toLowerCase()),
  });
}

/** Legacy usertype allowlist (super_admin, admin, bd_manager, accounts_team). */
function legacyInternalUsertypeClause() {
  return sqlWhere(fn('LOWER', col('usertype')), {
    [Op.in]: INTERNAL_STAFF_USERTYPES_FALLBACK.map((t) => t.toLowerCase()),
  });
}

async function fetchStaffProfileUserIdsForInternalRoles() {
  const roles = await Role.findAll({
    where: activeRowWhere(buildInternalStaffRolesWhere()),
    attributes: ['role_id'],
  });
  const roleIds = roles.map((r) => r.role_id);
  if (roleIds.length === 0) return [];
  const profiles = await StaffProfile.findAll({
    where: { role_id: { [Op.in]: roleIds } },
    attributes: ['user_id'],
  });
  return profiles.map((p) => p.user_id);
}

/**
 * Sequelize WHERE: assignable internal staff only.
 * @param {object[]} [extraClauses]
 */
async function buildAssignableInternalStaffWhere(extraClauses = []) {
  const profileUserIds = await fetchStaffProfileUserIdsForInternalRoles();
  const identityOptions = [legacyInternalUsertypeClause()];
  if (profileUserIds.length > 0) {
    identityOptions.push({ userid: { [Op.in]: profileUserIds } });
  }
  return {
    [Op.and]: [
      portalUsertypeExcludeClause(),
      { [Op.or]: identityOptions },
      ...extraClauses,
    ],
  };
}

/**
 * @param {{ q?: string, limit?: number }} [opts]
 * @returns {Promise<import('./models').User[]>}
 */
async function listAssignableInternalStaffUsers(opts = {}) {
  const q = opts.q != null ? String(opts.q).trim() : '';
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const extraClauses = [];
  if (q.length > 0) {
    const like = { [Op.iLike]: `%${q}%` };
    extraClauses.push({
      [Op.or]: [
        { display_name: like },
        { email: like },
        { fname: like },
        { lname: like },
      ],
    });
  }
  const users = await User.findAll({
    attributes: ['userid', 'fname', 'lname', 'display_name', 'email', 'department', 'usertype', 'status'],
    where: activeRowWhere(await buildAssignableInternalStaffWhere(extraClauses)),
    order: [['display_name', 'ASC'], ['fname', 'ASC']],
    limit,
  });
  return users.filter((u) => !isPortalUsertype(u.usertype) && String(u.status || 'active').toLowerCase() === 'active');
}

function displayNameForAssignableUser(u) {
  const d = u.get ? u.get({ plain: true }) : u;
  return (
    (d.display_name && String(d.display_name).trim()) ||
    [d.fname, d.lname].filter(Boolean).join(' ').trim() ||
    d.email ||
    `User ${d.userid}`
  );
}

module.exports = {
  buildAssignableInternalStaffWhere,
  listAssignableInternalStaffUsers,
  displayNameForAssignableUser,
  portalUsertypeExcludeClause,
  legacyInternalUsertypeClause,
};
