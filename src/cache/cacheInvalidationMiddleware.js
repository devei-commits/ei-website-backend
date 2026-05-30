const redis = require('./redis');
const { getNamespacesForModule } = require('./invalidateCacheForModule');

function getRootModule(req) {
  const path = req?.path ?? '';
  const withoutPrefix = path.replace(/^\/api\/v1\//, '');
  const parts = withoutPrefix.split('/').filter(Boolean);
  return parts[0] || '';
}

function invalidateNamespaces(namespaces) {
  return Promise.all(namespaces.map((ns) => redis.delByPattern(`${ns}:`)));
}

function cacheInvalidationMiddleware(req, res, next) {
  const method = String(req?.method ?? '').toUpperCase();
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return next();

  const namespaces = getNamespacesForModule(getRootModule(req));
  if (namespaces.length === 0) return next();

  const bust = () => invalidateNamespaces(namespaces).catch(() => {});

  // Clear stale entries before the mutation so concurrent GETs read from DB, not pre-write cache.
  bust().finally(() => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        bust();
      }
    });
    next();
  });
}

module.exports = { cacheInvalidationMiddleware };
