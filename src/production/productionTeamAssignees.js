/**
 * Production team members — derived from user roles (no separate team table).
 * Eligible: Super Admin, Admin, Production / Manufacturing and Production.
 */
const { Op } = require('sequelize');
const { User } = require('../users/models');
const { Role, StaffProfile } = require('../roles/models');
const { activeRowWhere } = require('../lib/softDelete');
const { isPortalUsertype } = require('../users/internalStaff');

const ELIGIBLE_ROLE_CODES = new Set([
  'super_admin',
  'admin',
  'production',
  'manufacturing_and_production',
]);

const ELIGIBLE_LEGACY_USERTYPES = ['super_admin', 'admin', 'production'];

function isProductionTeamEligibleRole(roleCode, roleName) {
  const code = String(roleCode || '').trim().toLowerCase();
  const name = String(roleName || '').trim().toLowerCase();
  if (ELIGIBLE_ROLE_CODES.has(code)) return true;
  if (name === 'super admin' || name === 'admin' || name === 'production') return true;
  if (name === 'manufacturing and production') return true;
  return false;
}

const USER_DEPT_TO_PRODUCTION_DEPT = {
  manufacturing: 'Manufacturing',
  filling: 'Filling',
  packaging: 'Packaging',
  quality: 'Quality',
  production: 'Manufacturing',
};

function inferProductionDepartment(userDepartment, roleCode, roleName) {
  const raw = String(userDepartment || '').trim().toLowerCase();
  if (USER_DEPT_TO_PRODUCTION_DEPT[raw]) return USER_DEPT_TO_PRODUCTION_DEPT[raw];
  const code = String(roleCode || '').trim().toLowerCase();
  const name = String(roleName || '').trim().toLowerCase();
  if (code === 'super_admin' || code === 'admin' || name === 'super admin' || name === 'admin') {
    return 'Manufacturing';
  }
  return 'Manufacturing';
}

function displayNameForUser(user) {
  const d = user.get ? user.get({ plain: true }) : user;
  return (
    (d.display_name && String(d.display_name).trim())
    || [d.fname, d.lname].filter(Boolean).join(' ').trim()
    || d.email
    || `User ${d.userid}`
  );
}

function teamMemberFromUser(user, roleName, department) {
  const d = user.get ? user.get({ plain: true }) : user;
  return {
    id: `U${d.userid}`,
    userId: d.userid,
    name: displayNameForUser(user),
    role: roleName || d.usertype || 'Staff',
    dept: department,
    avail: true,
    _pk: null,
  };
}

function resolveUserRoleInfo(user, rolesByCode) {
  const plain = user.get ? user.get({ plain: true }) : user;
  const sp = plain.staffProfile;
  if (sp?.role) {
    const r = sp.role.get ? sp.role.get({ plain: true }) : sp.role;
    return {
      roleCode: r.role_code,
      roleName: r.role_name,
      department: sp.department ?? plain.department ?? null,
    };
  }
  const usertype = String(plain.usertype || '').trim().toLowerCase();
  const roleInfo = rolesByCode[usertype];
  return {
    roleCode: usertype,
    roleName: roleInfo?.role_name || plain.usertype,
    department: plain.department ?? null,
  };
}

async function listProductionTeamMembers() {
  const roles = await Role.findAll({
    where: activeRowWhere(),
    attributes: ['role_id', 'role_code', 'role_name'],
  });
  const rolesByCode = {};
  const eligibleRoleIds = [];
  for (const r of roles) {
    rolesByCode[r.role_code] = { role_id: r.role_id, role_name: r.role_name };
    if (isProductionTeamEligibleRole(r.role_code, r.role_name)) {
      eligibleRoleIds.push(r.role_id);
    }
  }

  const seen = new Set();
  const members = [];

  function tryAddUser(user) {
    const uid = user.userid;
    if (seen.has(uid)) return;
    if (isPortalUsertype(user.usertype)) return;
    if (String(user.status || 'active').toLowerCase() !== 'active') return;
    const info = resolveUserRoleInfo(user, rolesByCode);
    if (!isProductionTeamEligibleRole(info.roleCode, info.roleName)) return;
    seen.add(uid);
    members.push(
      teamMemberFromUser(
        user,
        info.roleName,
        inferProductionDepartment(info.department, info.roleCode, info.roleName),
      ),
    );
  }

  if (eligibleRoleIds.length > 0) {
    const profileUsers = await User.findAll({
      attributes: ['userid', 'fname', 'lname', 'display_name', 'email', 'department', 'usertype', 'status'],
      where: activeRowWhere(),
      include: [{
        model: StaffProfile,
        as: 'staffProfile',
        required: true,
        where: { role_id: { [Op.in]: eligibleRoleIds } },
        include: [{ model: Role, as: 'role', attributes: ['role_id', 'role_code', 'role_name'] }],
      }],
    });
    for (const u of profileUsers) tryAddUser(u);
  }

  const legacyUsers = await User.findAll({
    attributes: ['userid', 'fname', 'lname', 'display_name', 'email', 'department', 'usertype', 'status'],
    where: activeRowWhere({
      usertype: { [Op.in]: ELIGIBLE_LEGACY_USERTYPES },
    }),
  });
  for (const u of legacyUsers) tryAddUser(u);

  return members.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = {
  isProductionTeamEligibleRole,
  inferProductionDepartment,
  teamMemberFromUser,
  listProductionTeamMembers,
};
