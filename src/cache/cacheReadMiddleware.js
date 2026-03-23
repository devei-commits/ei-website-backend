const redis = require('./redis');

function stableQueryString(query) {
  const q = query && typeof query === 'object' ? query : {};
  const keys = Object.keys(q).sort();
  if (keys.length === 0) return '';

  return keys
    .map((k) => {
      const v = q[k];
      if (Array.isArray(v)) {
        const normalized = v.map((x) => String(x)).sort().join(',');
        return `${encodeURIComponent(k)}=${encodeURIComponent(normalized)}`;
      }
      return `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : String(v))}`;
    })
    .join('&');
}

function getAuthScope(req) {
  // Optional auth scope: in practice we only vary by role/usertype for admin dashboard lists.
  const role = req?.user?.role ?? req?.user?.roleName ?? 'anon';
  return String(role || 'anon');
}

function getPathPart(req) {
  // Use originalUrl path without query to keep keys consistent.
  const originalUrl = req?.originalUrl ?? '';
  const pathNoQuery = originalUrl.split('?')[0];
  return pathNoQuery || req?.path || '';
}

/**
 * Redis cache-aside read middleware for GET endpoints.
 * - Key includes: namespace + path + stable query params + optional auth scope.
 * - Cache is set when res.json() is called with a 2xx status code.
 */
function createCacheReadMiddleware({ namespace, ttlSeconds = 120 } = {}) {
  if (!namespace) throw new Error('createCacheReadMiddleware requires namespace');

  return async function cacheRead(req, res, next) {
    if (req.method !== 'GET') return next();

    const cacheKey = `${namespace}:v1:${getPathPart(req)}:${stableQueryString(req.query)}:auth:${getAuthScope(req)}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached != null) {
        res.json(cached);
        return;
      }
    } catch {
      // Any cache read errors should degrade gracefully.
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const okStatus = res.statusCode >= 200 && res.statusCode < 300;
        if (okStatus && body !== undefined) {
          // Fire-and-forget; response must not be blocked by cache latency.
          redis.set(cacheKey, body, ttlSeconds).catch(() => {});
        }
      } catch {
        // ignore serialization/cache errors
      }
      return originalJson(body);
    };

    return next();
  };
}

module.exports = { createCacheReadMiddleware };

