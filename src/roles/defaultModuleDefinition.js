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
    description: 'Order processing and tracking',
    subModules: [
      {
        subModuleId: 'orders-list',
        subModuleName: 'Orders List',
        actions: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
        columns: [
          { columnId: 'order-id', columnName: 'Order ID', view: false, edit: false },
          { columnId: 'company-name', columnName: 'Company Name', view: false, edit: false },
          { columnId: 'product-type', columnName: 'Product Type', view: false, edit: false },
          { columnId: 'quantity', columnName: 'Quantity', view: false, edit: false },
          { columnId: 'order-status', columnName: 'Order Status', view: false, edit: false },
          { columnId: 'payment-status', columnName: 'Payment Status', view: false, edit: false },
        ],
      },
    ],
  },
];

module.exports = {
  modules: MODULES,
  globalSettings: DEFAULT_GLOBAL_SETTINGS,
};
