/**
 * Redis cache layer for cache-aside pattern (no external ioredis dependency).
 * Postgres remains source of truth.
 *
 * When REDIS_URL is unset or Redis is unavailable:
 * - get returns null
 * - set/del are no-ops
 * - delByPattern no-ops
 */

const net = require('net');
const { URL } = require('url');

let redisConfig = null; // { host, port, password? }
let lastRedisUrl = null;

function getRedisConfig() {
  const url = process.env.REDIS_URL;
  if (!url || url.trim() === '') return null;
  try {
    const u = new URL(url);
    // redis://host:port or rediss://... (password optional)
    const host = u.hostname;
    const port = u.port ? parseInt(u.port, 10) : 6379;
    const password = u.password ? u.password : null;
    if (!host || Number.isNaN(port)) return null;
    return { host, port, password };
  } catch {
    return null;
  }
}

function ensureConfig() {
  const currentUrl = process.env.REDIS_URL;
  if (redisConfig && lastRedisUrl === currentUrl) return redisConfig;
  lastRedisUrl = currentUrl;
  redisConfig = getRedisConfig();
  return redisConfig;
}

function respEncodeBulkString(s) {
  const str = s == null ? '' : String(s);
  return `$${Buffer.byteLength(str, 'utf8')}\r\n${str}\r\n`;
}

function respEncodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(respEncodeBulkString(a));
  return parts.join('');
}

function tryParseRESP(buffer) {
  if (!buffer || buffer.length < 1) return null;

  const prefix = String.fromCharCode(buffer[0]);
  const crlf = buffer.indexOf('\r\n', 1);
  if (crlf === -1) return null;

  if (prefix === '+') {
    return { value: buffer.slice(1, crlf).toString('utf8'), bytesRead: crlf + 2 };
  }
  if (prefix === '-') {
    // Error replies start with '-'
    return { value: null, bytesRead: crlf + 2, error: buffer.slice(1, crlf).toString('utf8') };
  }
  if (prefix === ':') {
    const numStr = buffer.slice(1, crlf).toString('utf8');
    const num = parseInt(numStr, 10);
    return { value: Number.isNaN(num) ? null : num, bytesRead: crlf + 2 };
  }
  if (prefix === '$') {
    const lenStr = buffer.slice(1, crlf).toString('utf8');
    const len = parseInt(lenStr, 10);
    if (len === -1) return { value: null, bytesRead: crlf + 2 };
    const needed = crlf + 2 + len + 2; // data + trailing CRLF
    if (buffer.length < needed) return null;
    const data = buffer.slice(crlf + 2, crlf + 2 + len).toString('utf8');
    return { value: data, bytesRead: needed };
  }
  if (prefix === '*') {
    const lenStr = buffer.slice(1, crlf).toString('utf8');
    const len = parseInt(lenStr, 10);
    if (len === -1) return { value: null, bytesRead: crlf + 2 };

    let offset = crlf + 2;
    const out = [];
    for (let i = 0; i < len; i++) {
      const parsed = tryParseRESP(buffer.slice(offset));
      if (parsed == null) return null;
      out.push(parsed.value);
      offset += parsed.bytesRead;
    }
    return { value: out, bytesRead: offset };
  }

  return null;
}

function sendRedisCommand(args) {
  const cfg = ensureConfig();
  if (!cfg) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    socket.setTimeout(2000);

    let buffer = Buffer.alloc(0);
    let resolved = false;

    const cleanup = () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = tryParseRESP(buffer);
      if (!parsed) return;

      if (resolved) return;
      resolved = true;

      if (parsed.error) {
        cleanup();
        reject(new Error(parsed.error));
        return;
      }

      cleanup();
      resolve(parsed.value);
    });

    socket.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    });
    socket.on('error', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    });

    // If a password is configured, authenticate first.
    const run = async () => {
      if (cfg.password) {
        // AUTH <password>
        const authCmd = respEncodeCommand(['AUTH', cfg.password]);
        socket.write(authCmd);
      }
      const cmd = respEncodeCommand(args);
      socket.write(cmd);
    };
    run().catch(() => {});
  });
}

/**
 * Get cached JSON value. Returns null on miss or when Redis is disabled/unavailable.
 * @param {string} key
 * @returns {Promise<object|array|null>}
 */
async function get(key) {
  try {
    const raw = await sendRedisCommand(['GET', key]);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (e) {
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
  try {
    const serialized = JSON.stringify(value);
    await sendRedisCommand(['SETEX', key, ttlSeconds, serialized]);
  } catch (err) {
    // No-op on cache errors
  }
}

/**
 * Delete one key. No-op when Redis is disabled/unavailable.
 * @param {string} key
 */
async function del(key) {
  try {
    await sendRedisCommand(['DEL', key]);
  } catch {
    // No-op on cache errors
  }
}

/**
 * Delete all keys matching prefix (e.g. 'warehouse-inventory:').
 * Uses SCAN to avoid blocking. No-op when Redis is disabled/unavailable.
 * @param {string} prefix
 */
async function delByPattern(prefix) {
  const cfg = ensureConfig();
  if (!cfg) return;
  try {
    let cursor = '0';
    do {
      const reply = await sendRedisCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 100]);
      if (!Array.isArray(reply) || reply.length < 2) return;
      const next = reply[0];
      const keys = reply[1];
      cursor = next;
      if (Array.isArray(keys) && keys.length > 0) {
        await sendRedisCommand(['DEL', ...keys]);
      }
    } while (String(cursor) !== '0');
  } catch {
    // No-op on cache errors
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
  getRedisConfig,
};

