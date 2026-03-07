/**
 * Redis cache layer for cache-aside pattern. Postgres remains source of truth.
 * When REDIS_URL is unset or Redis is unavailable, get returns null and set/del are no-ops.
 */
const Redis = require('ioredis');

let client = null;
let clientReady = false;

function getClient() {
  if (client != null) return client;
  const url = process.env.REDIS_URL;
  if (!url || url.trim() === '') return null;
  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
    client.on('error', (err) => {
      console.warn('[cache] Redis error:', err.message);
    });
    client.on('connect', () => {
      clientReady = true;
    });
    return client;
  } catch (err) {
    console.warn('[cache] Redis init failed:', err.message);
    return null;
  }
}

/**
 * Get cached JSON value. Returns null on miss or when Redis is disabled/unavailable.
 * @param {string} key
 * @returns {Promise<object|array|null>}
 */
async function get(key) {
  const c = getClient();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Set cache with TTL. No-op when Redis is disabled/unavailable.
 * @param {string} key
 * @param {object|array} value - will be JSON.stringify'd
 * @param {number} ttlSeconds
 */
async function set(key, value, ttlSeconds = 60) {
  const c = getClient();
  if (!c) return;
  try {
    const serialized = JSON.stringify(value);
    await c.setex(key, ttlSeconds, serialized);
  } catch (err) {
    console.warn('[cache] Redis set failed:', err.message);
  }
}

/**
 * Delete one key. No-op when Redis is disabled/unavailable.
 * @param {string} key
 */
async function del(key) {
  const c = getClient();
  if (!c) return;
  try {
    await c.del(key);
  } catch (err) {
    console.warn('[cache] Redis del failed:', err.message);
  }
}

/**
 * Delete all keys matching prefix (e.g. 'warehouse-inventory:').
 * Uses SCAN to avoid blocking. No-op when Redis is disabled/unavailable.
 * @param {string} prefix
 */
async function delByPattern(prefix) {
  const c = getClient();
  if (!c) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await c.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await c.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    console.warn('[cache] Redis delByPattern failed:', err.message);
  }
}

/**
 * Get from cache or compute, set, and return. Reusable cache-aside for any controller.
 * @param {string} key - Cache key (e.g. 'products:list', 'raw-materials:list:all').
 * @param {number} ttlSeconds - TTL in seconds.
 * @param {() => Promise<object|array>} asyncFn - Function that returns the value to cache (e.g. DB query result).
 * @returns {Promise<object|array>} Cached or freshly computed value.
 */
async function getOrSet(key, ttlSeconds, asyncFn) {
  const cached = await get(key);
  if (cached != null) return cached;
  const value = await asyncFn();
  await set(key, value, ttlSeconds);
  return value;
}

module.exports = {
  get,
  set,
  del,
  delByPattern,
  getOrSet,
  getClient,
};
