const redis = require('./redis');

/** Write root module → GET cache namespaces that must be cleared (see cacheInvalidationMiddleware). */
const dependencyMap = {
  orders: ['fulfillment', 'planning-extracted', 'production', 'warehouse-inventory', 'sales-orders', 'dashboard'],
  enquiries: ['dashboard'],
  users: ['dashboard'],
  'sales-orders': ['planning-extracted', 'fulfillment', 'production', 'warehouse-inventory'],
  'planning-extracted': ['warehouse-inventory', 'fulfillment', 'production'],
  production: ['fulfillment', 'planning-extracted', 'warehouse-inventory'],
  fulfillment: ['planning-extracted', 'warehouse-inventory', 'production'],
  'warehouse-inventory': ['planning-extracted', 'fulfillment'],
  grn: ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
  mrn: ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
  'purchase-orders': ['warehouse-inventory', 'planning-extracted', 'fulfillment', 'procurement'],
  'po-tracking': ['warehouse-inventory', 'planning-extracted', 'purchase-orders'],
  procurement: ['purchase-orders', 'warehouse-inventory', 'planning-extracted'],
  'procurement-quotations': ['purchase-orders', 'procurement'],
  products: ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
  'raw-materials': ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
  'pack-materials': ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
  'warehouse-locations': ['warehouse-inventory', 'planning-extracted', 'fulfillment', 'facility-areas'],
  'vendor-client': ['items-list', 'purchase-orders', 'procurement'],
};

/**
 * @param {string} root - First path segment after /api/v1/ (e.g. sales-orders).
 * @returns {string[]}
 */
function getNamespacesForModule(root) {
  if (!root) return [];
  const namespaces = new Set([root]);
  for (const dep of dependencyMap[root] || []) {
    namespaces.add(dep);
  }
  if (root === 'vendor-client') {
    namespaces.add('items-list');
  }
  return Array.from(namespaces);
}

/**
 * Clear Redis read caches for a module and its dependent namespaces.
 * @param {string} root
 */
async function invalidateForModule(root) {
  const namespaces = getNamespacesForModule(root);
  if (namespaces.length === 0) return;
  await Promise.all(namespaces.map((ns) => redis.delByPattern(`${ns}:`)));
}

module.exports = {
  dependencyMap,
  getNamespacesForModule,
  invalidateForModule,
};
