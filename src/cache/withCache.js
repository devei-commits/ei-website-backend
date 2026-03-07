/**
 * Reusable cache helpers per module. Use in any controller for cache-aside with minimal code.
 *
 * Usage in a controller:
 *   const cacheHelpers = require('../cache/withCache')('products', 60);
 *
 *   // List handler (key: products:list or products:list:querySuffix)
 *   const data = await cacheHelpers.getOrSetList(async () => { ... compute list ... });
 *   res.json(data);
 *
 *   // List with query (e.g. search) - pass suffix so same search is cached
 *   const data = await cacheHelpers.getOrSetList(async () => { ... }, search ? `search:${search}` : '');
 *
 *   // Get-by-id handler (key: products:123, TTL 300s)
 *   const data = await cacheHelpers.getOrSetOne(req.params.id, async () => { ... fetch one ... });
 *   res.json(data);
 *
 *   // After any create/update/delete in this module:
 *   await cacheHelpers.invalidate();
 */
const cache = require('./redis');

/**
 * @param {string} prefix - Key prefix for this module (e.g. 'products', 'raw-materials', 'bom', 'warehouse-locations').
 * @param {number} defaultTtl - Default TTL in seconds for list endpoints (e.g. 60). Get-by-id uses 300.
 * @returns {{ getOrSetList: (asyncFn: () => Promise<any>, querySuffix?: string) => Promise<any>, getOrSetOne: (id: string|number, asyncFn: () => Promise<any>, ttl?: number) => Promise<any>, invalidate: () => Promise<void> }}
 */
function createCacheHelpers(prefix, defaultTtl = 60) {
  const listTtl = defaultTtl;
  const oneTtl = 300;

  return {
    /**
     * Cache-aside for list endpoints. Key: prefix:list or prefix:list:querySuffix.
     * @param {() => Promise<object|array>} asyncFn - Returns the list payload to cache.
     * @param {string} [querySuffix] - Optional (e.g. search term) so different queries get different cache entries.
     */
    async getOrSetList(asyncFn, querySuffix = '') {
      const key = querySuffix ? `${prefix}:list:${querySuffix}` : `${prefix}:list`;
      return cache.getOrSet(key, listTtl, asyncFn);
    },

    /**
     * Cache-aside for get-by-id endpoints. Key: prefix:id. TTL 300s by default.
     * @param {string|number} id - Entity id.
     * @param {() => Promise<object>} asyncFn - Returns the entity to cache.
     * @param {number} [ttl] - Override TTL (default 300).
     */
    async getOrSetOne(id, asyncFn, ttl = oneTtl) {
      const key = `${prefix}:${id}`;
      return cache.getOrSet(key, ttl, asyncFn);
    },

    /** Invalidate all keys for this module (call after create/update/delete). */
    async invalidate() {
      await cache.delByPattern(`${prefix}:`);
    },
  };
}

module.exports = { createCacheHelpers };
