const redis = require('./redis');

function getRootModule(req) {
  // Examples:
  // - /api/v1/raw-materials/12 -> raw-materials
  // - /api/v1/grn/3 -> grn
  const path = req?.path ?? '';
  const withoutPrefix = path.replace(/^\/api\/v1\//, '');
  const parts = withoutPrefix.split('/').filter(Boolean);
  return parts[0] || '';
}

function getNamespacesToInvalidate(req) {
  const root = getRootModule(req);
  if (!root) return [];

  const namespaces = new Set();

  // Invalidate the root module itself for most writes.
  namespaces.add(root);

  // Cross-module cache dependencies (write root -> affected read namespaces).
  const dependencyMap = {
    // Website checkout write path; creates SO/Planning/Fulfillment/Production linkage.
    orders: ['fulfillment', 'planning-extracted', 'production', 'warehouse-inventory', 'sales-orders'],
    // SO edits can affect planning + downstream fulfillment scheduling.
    'sales-orders': ['planning-extracted', 'fulfillment', 'production', 'warehouse-inventory'],
    // Planning reserve/release changes warehouse availability and fulfillment readiness decisions.
    'planning-extracted': ['warehouse-inventory', 'fulfillment', 'production'],
    // Production status (BPR/BMR) directly changes fulfillment effective statuses.
    production: ['fulfillment', 'planning-extracted', 'warehouse-inventory'],
    // Fulfillment shipping/invoice actions can influence planning/inventory dashboards.
    fulfillment: ['planning-extracted', 'warehouse-inventory', 'production'],
    // Stock movement sources.
    'warehouse-inventory': ['planning-extracted', 'fulfillment'],
    grn: ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
    mrn: ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
    // Purchase and procurement impact inventory/planning availability.
    'purchase-orders': ['warehouse-inventory', 'planning-extracted', 'fulfillment', 'procurement'],
    'po-tracking': ['warehouse-inventory', 'planning-extracted', 'purchase-orders'],
    procurement: ['purchase-orders', 'warehouse-inventory', 'planning-extracted'],
    'procurement-quotations': ['purchase-orders', 'procurement'],
    // Master data used by planning/fulfillment APIs.
    products: ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
    'raw-materials': ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
    'pack-materials': ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
    'warehouse-locations': ['warehouse-inventory', 'planning-extracted', 'fulfillment'],
    // Vendor master drives downstream purchasing/items list pages.
    'vendor-client': ['items-list', 'purchase-orders', 'procurement'],
  };
  for (const ns of dependencyMap[root] || []) {
    namespaces.add(ns);
  }

  // Vendor master vendorItems sync updates items_list / item_list_vendor_rates (GET items-list/page).
  if (root === 'vendor-client') {
    namespaces.add('items-list');
  }

  return Array.from(namespaces);
}

function cacheInvalidationMiddleware(req, res, next) {
  const method = String(req?.method ?? '').toUpperCase();
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return next();

  const namespaces = getNamespacesToInvalidate(req);
  if (namespaces.length === 0) return next();

  res.on('finish', () => {
    // Only invalidate on success.
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    // Fire-and-forget: correctness beats freshness; failures should not break the write.
    Promise.all(
      namespaces.map((ns) => redis.delByPattern(`${ns}:`).catch(() => {}))
    ).catch(() => {});
  });

  return next();
}

module.exports = { cacheInvalidationMiddleware };

