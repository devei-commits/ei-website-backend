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
    description: 'Order processing and tracking',
    subModules: [
      {
        subModuleId: 'orders-list',
        subModuleName: 'Orders List',
        actions: { ...defaultActions },
        columns: [
          col('order-id', 'Order ID'),
          col('company-name', 'Company Name'),
          col('product-type', 'Product Type'),
          col('quantity', 'Quantity'),
          col('total-amount', 'Total Amount'),
          col('priority', 'Priority'),
          col('order-date', 'Order Date'),
          col('delivery-date', 'Delivery Date'),
          col('order-status', 'Order Status'),
          col('payment-status', 'Payment Status'),
        ],
      },
      {
        subModuleId: 'order-hub',
        subModuleName: 'Order Hub',
        actions: { ...defaultActions },
        columns: [
          col('hub-dashboard', 'Hub Dashboard'),
          col('pending-orders', 'Pending Orders'),
          col('processing-orders', 'Processing Orders'),
          col('completed-orders', 'Completed Orders'),
        ],
      },
      {
        subModuleId: 'goods-receiving',
        subModuleName: 'Goods Receiving',
        actions: { ...defaultActions },
        columns: [
          col('grn-number', 'GRN Number'),
          col('item-name', 'Item Name'),
          col('ordered-qty', 'Ordered Quantity'),
          col('received-qty', 'Received Quantity'),
          col('unit', 'Unit'),
          col('condition', 'Condition'),
          col('notes', 'Notes'),
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
