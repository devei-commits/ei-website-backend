const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');
dotenv.config();

const db = new Sequelize(process.env.DATABASE_URL, {
  pool: {
    max: 5,
    min: 0,
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
