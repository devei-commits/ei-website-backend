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

const db = new Sequelize(process.env.DATABASE_URL, {
  pool: {
    max: poolMax,
    min: poolMin,
    acquire: 120000,
    idle: 10000
  },
  logging: false,
  requestTimeout: 120000,
  dialectOptions: {
    connectTimeout: 120000,
  }
});

module.exports = db;
