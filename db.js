const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');
dotenv.config();

const rawMax = Number(process.env.DB_POOL_MAX || 10);
const poolMax = Math.max(
  2,
  Math.min(50, Number.isFinite(rawMax) ? rawMax : 10)
);
const rawMin = Number(process.env.DB_POOL_MIN || 0);
const poolMin = Math.max(
  0,
  Math.min(poolMax, Number.isFinite(rawMin) ? rawMin : 0)
);

const databaseUrl = process.env.DATABASE_URL || '';
const useRdsSsl =
  process.env.DB_SSL === 'true' ||
  (process.env.DB_SSL !== 'false' && databaseUrl.includes('rds.amazonaws.com'));

/**
 * Sequelize assigns pg-connection-string.parse(url) into dialectOptions, which overwrites
 * our ssl settings. `sslmode=require` becomes `ssl: {}` and Node verifies the RDS cert chain.
 */
function resolveSequelizeDatabaseUrl(rawUrl, needsSsl) {
  if (!rawUrl || !needsSsl) {
    return rawUrl;
  }
  try {
    const parsed = new URL(rawUrl.replace(/^postgresql:/i, 'postgres:'));
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('ssl');
    const query = parsed.searchParams.toString();
    parsed.search = query ? `?${query}` : '';
    return parsed.toString().replace(/^postgres:/i, 'postgresql:');
  } catch {
    return rawUrl
      .replace(/([?&])sslmode=[^&]*&?/g, '$1')
      .replace(/([?&])ssl=[^&]*&?/g, '$1')
      .replace(/[?&]$/, '');
  }
}

const sequelizeDatabaseUrl = resolveSequelizeDatabaseUrl(databaseUrl, useRdsSsl);

const dialectOptions = {
  connectTimeout: 120000,
};

if (useRdsSsl) {
  dialectOptions.ssl = {
    rejectUnauthorized: false,
  };
}

const db = new Sequelize(sequelizeDatabaseUrl, {
  pool: {
    max: poolMax,
    min: poolMin,
    acquire: 120000,
    idle: 10000,
  },
  logging: false,
  requestTimeout: 120000,
  dialectOptions,
});

const { registerSequelizeTimestampHooks } = require('./src/lib/backendTimestamps');
registerSequelizeTimestampHooks(db);

module.exports = db;
