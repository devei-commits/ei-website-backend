/**
 * Default module-definition tree and global settings.
 * Used when DB has no row yet, and for seeding module_definitions.
 */

const DEFAULT_GLOBAL_SETTINGS = {
  accessToAllModules: false,
  allowLogin: true,
  allowMultipleSessions: false,
  canChangePassword: true,
  enableAuditLog: false,
  canExportData: false,
  canImportData: false,
  canAccessReports: false,
  canAccessSettings: false,
  sessionTimeout: 30,
};

const MODULES = [
  {
    moduleId: 'dashboard',
    moduleName: 'Dashboard',
    icon: 'chart',
    description: 'Overview and analytics dashboard',
    subModules: [
      {
        subModuleId: 'dashboard-overview',
        subModuleName: 'Overview',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'stats-cards', columnName: 'Statistics Cards', view: false, edit: false },
          { columnId: 'revenue-chart', columnName: 'Revenue Chart', view: false, edit: false },
          { columnId: 'order-trends', columnName: 'Order Trends', view: false, edit: false },
          { columnId: 'recent-activities', columnName: 'Recent Activities', view: false, edit: false },
        ],
      },
    ],
  },
  {
    moduleId: 'user-management',
    moduleName: 'User Management',
    icon: 'users',
    description: 'User accounts and access',
    subModules: [
      {
        subModuleId: 'users',
        subModuleName: 'Users',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'user-id', columnName: 'User ID', view: false, edit: false },
          { columnId: 'user-name', columnName: 'User Name', view: false, edit: false },
          { columnId: 'email', columnName: 'Email', view: false, edit: false },
          { columnId: 'role', columnName: 'Role', view: false, edit: false },
          { columnId: 'department', columnName: 'Department', view: false, edit: false },
          { columnId: 'status', columnName: 'Status', view: false, edit: false },
          { columnId: 'last-login', columnName: 'Last Login', view: false, edit: false },
        ],
      },
    ],
  },
  {
    moduleId: 'role-management',
    moduleName: 'Role Management',
    icon: 'roles',
    description: 'Role configuration and permissions',
    subModules: [
      {
        subModuleId: 'roles',
        subModuleName: 'Roles',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'role-id', columnName: 'Role ID', view: false, edit: false },
          { columnId: 'role-name', columnName: 'Role Name', view: false, edit: false },
          { columnId: 'role-level', columnName: 'Role Level', view: false, edit: false },
          { columnId: 'description', columnName: 'Description', view: false, edit: false },
          { columnId: 'users-count', columnName: 'Users Count', view: false, edit: false },
          { columnId: 'status', columnName: 'Status', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'permissions',
        subModuleName: 'Permissions Matrix',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'module-permissions', columnName: 'Module Permissions', view: false, edit: false },
          { columnId: 'column-permissions', columnName: 'Column Permissions', view: false, edit: false },
        ],
      },
    ],
  },
  {
    moduleId: 'order-management',
    moduleName: 'Order Management',
    icon: 'order',
    description: 'Lifecycle permissions from SO to fulfillment closure',
    subModules: [
      {
        subModuleId: 'sales-orders',
        subModuleName: 'Sales Orders',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'so-create', columnName: 'Create SO', view: false, edit: false },
          { columnId: 'so-validate', columnName: 'Validate SO', view: false, edit: false },
          { columnId: 'so-approve', columnName: 'Approve SO', view: false, edit: false },
          { columnId: 'so-release-planning', columnName: 'Release SO to Planning', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'planning',
        subModuleName: 'Planning',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'demand-extraction', columnName: 'Demand Extraction', view: false, edit: false },
          { columnId: 'availability-check', columnName: 'Availability Check', view: false, edit: false },
          { columnId: 'batch-confirmation', columnName: 'Batch Confirmation', view: false, edit: false },
          { columnId: 'planning-release', columnName: 'Release Planning Output', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'procurement',
        subModuleName: 'Procurement',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'request', columnName: 'Requests', view: false, edit: false },
          { columnId: 'quotation', columnName: 'Quotations', view: false, edit: false },
          { columnId: 'draft-po', columnName: 'Draft PO', view: false, edit: false },
          { columnId: 'issued-po', columnName: 'Issued PO', view: false, edit: false },
          { columnId: 'grn', columnName: 'GRN / Inward', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'warehouse-inventory',
        subModuleName: 'Warehouse / Inventory',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'reservation', columnName: 'Reservation', view: false, edit: false },
          { columnId: 'dispensing-issue', columnName: 'Dispensing / Issue', view: false, edit: false },
          { columnId: 'putaway-transfer', columnName: 'Putaway / Transfer', view: false, edit: false },
          { columnId: 'inventory-adjustment', columnName: 'Inventory Adjustment', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'production-bmr',
        subModuleName: 'Production - BMR',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'batch-schedule-confirm', columnName: 'Schedule / Confirm Batch', view: false, edit: false },
          { columnId: 'rm-reservation', columnName: 'RM Reservation', view: false, edit: false },
          { columnId: 'dispensing', columnName: 'Dispensing', view: false, edit: false },
          { columnId: 'process-execution', columnName: 'Process Execution', view: false, edit: false },
          { columnId: 'bmr-review-close', columnName: 'BMR Review / Close', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'production-bpr',
        subModuleName: 'Production - BPR',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'bpr-initiate', columnName: 'Initiate BPR', view: false, edit: false },
          { columnId: 'pm-issue', columnName: 'PM Issue', view: false, edit: false },
          { columnId: 'packing-execution', columnName: 'Packing Execution', view: false, edit: false },
          { columnId: 'bpr-reconciliation', columnName: 'BPR Reconciliation', view: false, edit: false },
          { columnId: 'bpr-close', columnName: 'BPR Close', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'production-transfer-yield',
        subModuleName: 'Production - Transfer / Yield',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'transfer-orders', columnName: 'Transfer Orders', view: false, edit: false },
          { columnId: 'yield-report', columnName: 'Yield Report', view: false, edit: false },
        ],
      },
      {
        subModuleId: 'fulfillment',
        subModuleName: 'Fulfillment',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'fulfillment-create', columnName: 'Create Fulfillment', view: false, edit: false },
          { columnId: 'allocation-pick-pack', columnName: 'Allocation / Pick-Pack', view: false, edit: false },
          { columnId: 'dispatch-tracking', columnName: 'Dispatch / Tracking', view: false, edit: false },
          { columnId: 'invoice-generate', columnName: 'Invoice Generation', view: false, edit: false },
          { columnId: 'fulfillment-close', columnName: 'Fulfillment Closure', view: false, edit: false },
        ],
      },
    ],
  },
];

module.exports = {
  modules: MODULES,
  globalSettings: DEFAULT_GLOBAL_SETTINGS,
};
