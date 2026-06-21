/**
 * Default granted keys for the Manager role — masters + operational modules.
 */
const { Role } = require('../models/index');
const { saveRolePermissions } = require('./controller');

const { MASTERS_SUBMODULE_IDS, ASSIGN_STAGE_COLUMN_BY_KIND } = require('./mastersModuleDefinition');
const MASTER_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];
const ORDER_MANAGEMENT_SUBMODULES = [
  'sales-orders',
  'planning',
  'procurement',
  'warehouse-inventory',
  'production-bmr',
  'production-bpr',
  'production-transfer-yield',
  'fulfillment',
];
const ENQUIRY_SUBMODULES = ['enquiries', 'tickets'];

function submoduleKeys(moduleId, subModuleId, actions) {
  return actions.map((action) => `${moduleId}.${subModuleId}.action.${action}`);
}

function assignStageColumnKeys(moduleId, subModuleId, columnId) {
  return [`${moduleId}.${subModuleId}.column.${columnId}.edit`];
}

function buildManagerGrantedKeys() {
  const keys = ['dashboard.dashboard-overview.action.view'];

  for (const subModuleId of ORDER_MANAGEMENT_SUBMODULES) {
    keys.push(...submoduleKeys('order-management', subModuleId, ['view']));
  }
  for (const subModuleId of ENQUIRY_SUBMODULES) {
    keys.push(...submoduleKeys('enquiry-management', subModuleId, ['view']));
  }
  for (const subModuleId of MASTERS_SUBMODULE_IDS) {
    keys.push(...submoduleKeys('inventory', subModuleId, MASTER_ACTIONS));
  }
  for (const [kind, columnId] of Object.entries(ASSIGN_STAGE_COLUMN_BY_KIND)) {
    const subModuleId =
      kind === 'RM' ? 'raw-materials' : kind === 'PM' ? 'packaging' : 'bom';
    keys.push(...assignStageColumnKeys('inventory', subModuleId, columnId));
  }

  return [...new Set(keys)];
}

const MANAGER_ROLE_GRANTED = buildManagerGrantedKeys();

async function seedManagerRolePermissions() {
  const role = await Role.findOne({ where: { role_code: 'manager' } });
  if (!role) return { ok: false, reason: 'role_not_found' };
  await saveRolePermissions(role.role_id, MANAGER_ROLE_GRANTED);
  return { ok: true, role_id: role.role_id, granted: MANAGER_ROLE_GRANTED.length };
}

module.exports = {
  MANAGER_ROLE_GRANTED,
  seedManagerRolePermissions,
};
