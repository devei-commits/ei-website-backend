/**
 * Static module/submodule definitions for the admin dashboard Permission Matrix.
 * Same structure as admin-dashboard DEFAULT_MODULE_PERMISSIONS.
 * Dashboard consumes GET /roles/module-definitions to avoid duplicating the tree.
 */
const defaultGlobalSettings = {
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

const defaultActions = { view: false, create: false, edit: false, delete: false, approve: false, export: false };

function col(id, name) {
  return { columnId: id, columnName: name, view: false, edit: false };
}

const MODULE_DEFINITIONS = [
  {
    moduleId: 'dashboard',
    moduleName: 'Dashboard',
    icon: 'chart',
    description: 'Overview and analytics dashboard',
    subModules: [
      {
        subModuleId: 'dashboard-overview',
        subModuleName: 'Overview',
        actions: { ...defaultActions },
        columns: [
          col('stats-cards', 'Statistics Cards'),
          col('revenue-chart', 'Revenue Chart'),
          col('order-trends', 'Order Trends'),
          col('recent-activities', 'Recent Activities'),
        ],
      },
    ],
  },
  {
    moduleId: 'pis',
    moduleName: 'PIS (Product Information System)',
    icon: 'product',
    description: 'Product development and information management',
    subModules: [
      {
        subModuleId: 'pis-products',
        subModuleName: 'Products',
        actions: { ...defaultActions },
        columns: [
          col('pis-code', 'PIS Code'),
          col('product-name', 'Product Name'),
          col('category', 'Category'),
          col('client-name', 'Client Name'),
          col('formulation', 'Formulation Details'),
          col('ingredients', 'Active Ingredients'),
          col('stage', 'Development Stage'),
          col('status', 'Status'),
          col('created-date', 'Created Date'),
          col('updated-date', 'Updated Date'),
        ],
      },
      {
        subModuleId: 'pis-formulations',
        subModuleName: 'Formulations',
        actions: { ...defaultActions },
        columns: [
          col('formula-id', 'Formula ID'),
          col('formula-name', 'Formula Name'),
          col('ingredients-list', 'Ingredients List'),
          col('percentages', 'Percentages'),
          col('batch-size', 'Batch Size'),
          col('cost', 'Cost'),
        ],
      },
      {
        subModuleId: 'pis-stability',
        subModuleName: 'Stability Testing',
        actions: { ...defaultActions },
        columns: [
          col('test-id', 'Test ID'),
          col('product-batch', 'Product Batch'),
          col('test-parameters', 'Test Parameters'),
          col('results', 'Results'),
          col('test-date', 'Test Date'),
          col('expiry-prediction', 'Expiry Prediction'),
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
        actions: { ...defaultActions },
        columns: [
          col('so-create', 'Create SO'),
          col('so-validate', 'Validate SO'),
          col('so-approve', 'Approve SO'),
          col('so-release-planning', 'Release SO to Planning'),
        ],
      },
      {
        subModuleId: 'planning',
        subModuleName: 'Planning',
        actions: { ...defaultActions },
        columns: [
          col('demand-extraction', 'Demand Extraction'),
          col('availability-check', 'Availability Check'),
          col('batch-confirmation', 'Batch Confirmation'),
          col('planning-release', 'Release Planning Output'),
        ],
      },
      {
        subModuleId: 'procurement',
        subModuleName: 'Procurement',
        actions: { ...defaultActions },
        columns: [
          col('request', 'Requests'),
          col('quotation', 'Quotations'),
          col('draft-po', 'Draft PO'),
          col('issued-po', 'Issued PO'),
          col('grn', 'GRN / Inward'),
        ],
      },
      {
        subModuleId: 'warehouse-inventory',
        subModuleName: 'Warehouse / Inventory',
        actions: { ...defaultActions },
        columns: [
          col('reservation', 'Reservation'),
          col('dispensing-issue', 'Dispensing / Issue'),
          col('putaway-transfer', 'Putaway / Transfer'),
          col('inventory-adjustment', 'Inventory Adjustment'),
        ],
      },
      {
        subModuleId: 'production-bmr',
        subModuleName: 'Production - BMR',
        actions: { ...defaultActions },
        columns: [
          col('batch-schedule-confirm', 'Schedule / Confirm Batch'),
          col('rm-reservation', 'RM Reservation'),
          col('dispensing', 'Dispensing'),
          col('process-execution', 'Process Execution'),
          col('bmr-review-close', 'BMR Review / Close'),
        ],
      },
      {
        subModuleId: 'production-bpr',
        subModuleName: 'Production - BPR',
        actions: { ...defaultActions },
        columns: [
          col('bpr-initiate', 'Initiate BPR'),
          col('pm-issue', 'PM Issue'),
          col('packing-execution', 'Packing Execution'),
          col('bpr-reconciliation', 'BPR Reconciliation'),
          col('bpr-close', 'BPR Close'),
        ],
      },
      {
        subModuleId: 'production-transfer-yield',
        subModuleName: 'Production - Transfer / Yield',
        actions: { ...defaultActions },
        columns: [
          col('transfer-orders', 'Transfer Orders'),
          col('yield-report', 'Yield Report'),
        ],
      },
      {
        subModuleId: 'fulfillment',
        subModuleName: 'Fulfillment',
        actions: { ...defaultActions },
        columns: [
          col('fulfillment-create', 'Create Fulfillment'),
          col('allocation-pick-pack', 'Allocation / Pick-Pack'),
          col('dispatch-tracking', 'Dispatch / Tracking'),
          col('invoice-generate', 'Invoice Generation'),
          col('fulfillment-close', 'Fulfillment Closure'),
        ],
      },
    ],
  },
  {
    moduleId: 'inventory',
    moduleName: 'Inventory Management',
    icon: 'inventory',
    description: 'Stock and inventory control',
    subModules: [
      {
        subModuleId: 'raw-materials',
        subModuleName: 'Raw Materials',
        actions: { ...defaultActions },
        columns: [
          col('material-code', 'Material Code'),
          col('material-name', 'Material Name'),
          col('category', 'Category'),
          col('current-stock', 'Current Stock'),
          col('min-stock', 'Minimum Stock'),
          col('unit-price', 'Unit Price'),
          col('supplier', 'Supplier'),
          col('expiry-date', 'Expiry Date'),
        ],
      },
      {
        subModuleId: 'packaging',
        subModuleName: 'Packaging Materials',
        actions: { ...defaultActions },
        columns: [
          col('pkg-code', 'Package Code'),
          col('pkg-name', 'Package Name'),
          col('pkg-type', 'Package Type'),
          col('pkg-stock', 'Stock'),
          col('pkg-cost', 'Cost'),
        ],
      },
      {
        subModuleId: 'bom',
        subModuleName: 'Bill of Materials',
        actions: { ...defaultActions },
        columns: [
          col('bom-id', 'BOM ID'),
          col('product-name', 'Product Name'),
          col('components', 'Components'),
          col('quantities', 'Quantities'),
          col('total-cost', 'Total Cost'),
        ],
      },
    ],
  },
  {
    moduleId: 'vendor-client',
    moduleName: 'Vendors & Clients',
    icon: 'contacts',
    description: 'Vendor and client management',
    subModules: [
      {
        subModuleId: 'vendors',
        subModuleName: 'Vendors',
        actions: { ...defaultActions },
        columns: [
          col('vendor-id', 'Vendor ID'),
          col('vendor-name', 'Vendor Name'),
          col('contact-person', 'Contact Person'),
          col('email', 'Email'),
          col('phone', 'Phone'),
          col('address', 'Address'),
          col('gst-number', 'GST Number'),
          col('payment-terms', 'Payment Terms'),
          col('status', 'Status'),
        ],
      },
      {
        subModuleId: 'clients',
        subModuleName: 'Clients',
        actions: { ...defaultActions },
        columns: [
          col('client-id', 'Client ID'),
          col('client-name', 'Client Name'),
          col('company-name', 'Company Name'),
          col('email', 'Email'),
          col('phone', 'Phone'),
          col('billing-address', 'Billing Address'),
          col('shipping-address', 'Shipping Address'),
          col('credit-limit', 'Credit Limit'),
          col('outstanding', 'Outstanding'),
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
        actions: { ...defaultActions },
        columns: [
          col('user-id', 'User ID'),
          col('user-name', 'User Name'),
          col('email', 'Email'),
          col('role', 'Role'),
          col('department', 'Department'),
          col('phone', 'Phone'),
          col('status', 'Status'),
          col('last-login', 'Last Login'),
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
        actions: { ...defaultActions },
        columns: [
          col('role-id', 'Role ID'),
          col('role-name', 'Role Name'),
          col('role-level', 'Role Level'),
          col('description', 'Description'),
          col('users-count', 'Users Count'),
          col('status', 'Status'),
        ],
      },
      {
        subModuleId: 'permissions',
        subModuleName: 'Permissions Matrix',
        actions: { ...defaultActions },
        columns: [
          col('module-permissions', 'Module Permissions'),
          col('column-permissions', 'Column Permissions'),
        ],
      },
    ],
  },
  {
    moduleId: 'settings',
    moduleName: 'Settings',
    icon: 'settings',
    description: 'System configuration',
    subModules: [
      {
        subModuleId: 'general-settings',
        subModuleName: 'General Settings',
        actions: { ...defaultActions },
        columns: [
          col('company-info', 'Company Info'),
          col('preferences', 'Preferences'),
          col('notifications', 'Notifications'),
        ],
      },
      {
        subModuleId: 'system-settings',
        subModuleName: 'System Settings',
        actions: { ...defaultActions },
        columns: [
          col('email-config', 'Email Configuration'),
          col('backup', 'Backup Settings'),
          col('integrations', 'Integrations'),
        ],
      },
    ],
  },
];

function getModuleDefinitions() {
  return MODULE_DEFINITIONS;
}

function getDefaultGlobalSettings() {
  return { ...defaultGlobalSettings };
}

module.exports = {
  getModuleDefinitions,
  getDefaultGlobalSettings,
  MODULE_DEFINITIONS,
  defaultGlobalSettings,
};
