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
// SSL only for AWS RDS (or explicit DB_SSL=true). Do not key off sslmode=require — local Docker/tunnels often have no SSL.
const useRdsSsl =
  process.env.DB_SSL === 'true' ||
  (process.env.DB_SSL !== 'false' && databaseUrl.includes('rds.amazonaws.com'));

const dialectOptions = {
  connectTimeout: 120000,
};

if (useRdsSsl) {
  // node-pg verifies the cert chain; psql with sslmode=require does not — required for AWS RDS.
  dialectOptions.ssl = {
    require: true,
    rejectUnauthorized: false,
  };
}

const db = new Sequelize(databaseUrl, {
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
