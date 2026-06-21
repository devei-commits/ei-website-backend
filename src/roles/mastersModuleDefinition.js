/**
 * Masters (inventory module) — granular submodules and workflow steps for Role Management.
 * moduleId stays `inventory` for RBAC compatibility with routes and master approval auth.
 */

const defaultActions = { view: false, create: false, edit: false, delete: false, approve: false, export: false };

function col(id, name) {
  return { columnId: id, columnName: name, view: false, edit: false };
}

/** RM / PM / PR — draft → review → approval → active workflow */
function approvalMasterColumns(prefix) {
  return [
    col(`${prefix}-create`, 'Create master'),
    col(`${prefix}-edit`, 'Edit master record'),
    col(`${prefix}-delete`, 'Delete master'),
    col(`${prefix}-excel-import`, 'Excel import / bulk upload'),
    col(`${prefix}-assign-stages`, 'Assign approval stages'),
    col(`${prefix}-status-draft-review`, 'Draft → Under Review'),
    col(`${prefix}-status-review-approval`, 'Under Review → Under Approval'),
    col(`${prefix}-status-approval-active`, 'Under Approval → Active'),
    col(`${prefix}-reset`, 'Reset / bulk delete masters'),
  ];
}

/** Item groups, universal swap, price list — operational steps without approval workflow */
function simpleMasterColumns(prefix) {
  return [
    col(`${prefix}-list`, 'View list'),
    col(`${prefix}-create`, 'Create record'),
    col(`${prefix}-edit`, 'Edit record'),
    col(`${prefix}-delete`, 'Delete record'),
    col(`${prefix}-export`, 'Export data'),
  ];
}

function getMastersModuleDefinition() {
  return {
    moduleId: 'inventory',
    moduleName: 'Masters',
    icon: 'inventory',
    description: 'RM, PM, and PR registration, approval workflow, item groups, price lists, and universal swap',
    subModules: [
      {
        subModuleId: 'raw-materials',
        subModuleName: 'Raw Materials (RM)',
        actions: { ...defaultActions },
        columns: approvalMasterColumns('rm'),
      },
      {
        subModuleId: 'packaging',
        subModuleName: 'Packaging Materials (PM)',
        actions: { ...defaultActions },
        columns: approvalMasterColumns('pm'),
      },
      {
        subModuleId: 'bom',
        subModuleName: 'Products (PR)',
        actions: { ...defaultActions },
        columns: approvalMasterColumns('pr'),
      },
      {
        subModuleId: 'item-groups',
        subModuleName: 'Item Groups',
        actions: { ...defaultActions },
        columns: simpleMasterColumns('ig'),
      },
      {
        subModuleId: 'universal-swap',
        subModuleName: 'Universal Swap',
        actions: { ...defaultActions },
        columns: [
          col('swap-list', 'View swap history'),
          col('swap-apply', 'Apply universal swap'),
          col('swap-preview', 'Preview affected records'),
        ],
      },
      {
        subModuleId: 'price-list',
        subModuleName: 'Items List (Price List)',
        actions: { ...defaultActions },
        columns: simpleMasterColumns('pl'),
      },
    ],
  };
}

const MASTERS_SUBMODULE_IDS = getMastersModuleDefinition().subModules.map((s) => s.subModuleId);

/** Column id for "Assign approval stages" per master kind (matches approvalMasterColumns prefix). */
const ASSIGN_STAGE_COLUMN_BY_KIND = {
  RM: 'rm-assign-stages',
  PM: 'pm-assign-stages',
  PR: 'pr-assign-stages',
};

module.exports = {
  getMastersModuleDefinition,
  MASTERS_SUBMODULE_IDS,
  ASSIGN_STAGE_COLUMN_BY_KIND,
  approvalMasterColumns,
  simpleMasterColumns,
  col,
  defaultActions,
};
