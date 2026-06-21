const { Op } = require('sequelize');

/** Portal / external users — not managed in User Management. */
const PORTAL_USERTYPES = ['customer', 'doctor'];

/** Default internal roles when roles table is unavailable. */
const INTERNAL_STAFF_USERTYPES_FALLBACK = [
  'super_admin',
  'admin',
  'manager',
  'bd_manager',
  'accounts_team',
];

function normalizeUsertype(usertype) {
  return String(usertype || '').trim().toLowerCase();
}

function isPortalUsertype(usertype) {
  return PORTAL_USERTYPES.includes(normalizeUsertype(usertype));
}

function isInternalStaffUsertype(usertype) {
  const t = normalizeUsertype(usertype);
  return Boolean(t) && !isPortalUsertype(t);
}

/**
 * Sequelize WHERE for internal team users only (excludes customer/doctor portal accounts).
 * @param {object[]} [additionalClauses]
 */
function buildInternalStaffWhere(additionalClauses = []) {
  return {
    [Op.and]: [
      { usertype: { [Op.notIn]: PORTAL_USERTYPES } },
      ...additionalClauses,
    ],
  };
}

/** Roles assignable when creating/editing staff in User Management. */
function buildInternalStaffRolesWhere() {
  return {
    [Op.and]: [
      { role_code: { [Op.notIn]: PORTAL_USERTYPES } },
      { level: { [Op.ne]: 'client' } },
    ],
  };
}

module.exports = {
  PORTAL_USERTYPES,
  INTERNAL_STAFF_USERTYPES_FALLBACK,
  normalizeUsertype,
  isPortalUsertype,
  isInternalStaffUsertype,
  buildInternalStaffWhere,
  buildInternalStaffRolesWhere,
};
