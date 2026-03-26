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

  // Vendor master vendorItems sync updates items_list / item_list_vendor_rates (GET items-list/page).
  if (root === 'vendor-client') {
    namespaces.add('items-list');
  }

  // Cross-domain invalidation:
  // - Warehouse inventory affects SIH and "items-involved"/planning availability.
  // - GRN/MRN completion applies stock changes into warehouse_inventory.
  if (['warehouse-inventory', 'grn', 'mrn', 'purchase-orders', 'production', 'fulfillment'].includes(root)) {
    namespaces.add('warehouse-inventory');
    namespaces.add('planning-extracted');
  }

  // - Planning writes adjust warehouse_inventory.reserved (reserve/release).
  if (root === 'planning-extracted') {
    namespaces.add('warehouse-inventory');
  }

  // - Warehouse location CRUD affects stored location mapping shown by warehouse screens.
  if (root === 'warehouse-locations') {
    namespaces.add('warehouse-inventory');
  }

  // - Products in PR flows impact warehouse-inventory "PR" rows.
  if (root === 'products') {
    namespaces.add('warehouse-inventory');
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

