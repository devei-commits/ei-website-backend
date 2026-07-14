/**
 * Maps abstract PO-approval roles (proc_head / cfo / qa_head / rnd_head) to the
 * real users.usertype values in this system. Admin & super_admin can act as any
 * role so an administrator is never locked out of the workflow.
 */
const { ROLE } = require('./poApprovalMatrix');

// usertypes that may act as each abstract role.
const ROLE_USERTYPES = {
  [ROLE.PROC_HEAD]: ['manager', 'bd_manager', 'admin', 'super_admin'],
  [ROLE.CFO]: ['accounts_team', 'admin', 'super_admin'],
  [ROLE.QA_HEAD]: ['manager', 'admin', 'super_admin'],
  [ROLE.RND_HEAD]: ['manager', 'admin', 'super_admin'],
};

// Always-allowed usertypes (act as any approver role).
const OMNI_USERTYPES = ['admin', 'super_admin'];

function normalizeUsertype(usertype) {
  return String(usertype || '').trim().toLowerCase();
}

/** True when a user's usertype may act as the given abstract approver role. */
function userCanActAs(usertype, requiredRole) {
  const ut = normalizeUsertype(usertype);
  if (!ut) return false;
  if (OMNI_USERTYPES.includes(ut)) return true;
  const allowed = ROLE_USERTYPES[requiredRole] || [];
  return allowed.includes(ut);
}

/** Human label for an abstract role (for messages / logs). */
function roleLabel(role) {
  switch (role) {
    case ROLE.PROC_HEAD: return 'Procurement Head';
    case ROLE.CFO: return 'CFO';
    case ROLE.QA_HEAD: return 'QA Head';
    case ROLE.RND_HEAD: return 'R&D Head';
    default: return String(role || '');
  }
}

module.exports = {
  ROLE_USERTYPES,
  OMNI_USERTYPES,
  userCanActAs,
  roleLabel,
};
