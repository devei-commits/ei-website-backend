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
  const uid = req?.user?.id ?? req?.user?.userid;
  if (uid != null && String(uid).trim() !== '') {
    return `u${uid}`;
  }
  const role = req?.user?.role ?? req?.user?.roleName ?? 'anon';
  return String(role || 'anon');
}

function getPathPart(req) {
  const originalUrl = req?.originalUrl ?? '';
  const pathNoQuery = originalUrl.split('?')[0];
  return pathNoQuery || req?.path || '';
}

/**
 * Redis cache-aside read middleware for GET endpoints.
 * - Key: namespace + path + query + auth scope.
 * - Writes invalidate via cacheInvalidationMiddleware / invalidateForModule.
 * - Browser must not cache separately (Cache-Control on HIT).
 */
function createCacheReadMiddleware({ namespace, ttlSeconds = 120 } = {}) {
  if (!namespace) throw new Error('createCacheReadMiddleware requires namespace');

  return async function cacheRead(req, res, next) {
    if (req.method !== 'GET') return next();

    const cacheKey = `${namespace}:v1:${getPathPart(req)}:${stableQueryString(req.query)}:auth:${getAuthScope(req)}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached != null) {
        res.set('Cache-Control', 'private, no-cache');
        res.set('X-Cache', 'HIT');
        res.json(cached);
        return;
      }
    } catch {
      // Degrade to DB on cache read errors.
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const okStatus = res.statusCode >= 200 && res.statusCode < 300;
        if (okStatus && body !== undefined) {
          redis.set(cacheKey, body, ttlSeconds).catch(() => {});
        }
      } catch {
        // ignore serialization/cache errors
      }
      res.set('X-Cache', 'MISS');
      return originalJson(body);
    };

    return next();
  };
}

module.exports = { createCacheReadMiddleware };
