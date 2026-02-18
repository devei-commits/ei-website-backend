const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Authentication extends Model {}

Authentication.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },

  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  phone: {
    type: DataTypes.STRING,
    allowNull: false
  },

  otp: {
    type: DataTypes.STRING,
    allowNull: false
  },

  expired: {
    type: DataTypes.DATE,
    allowNull: false
  },

  created: {
    type: DataTypes.DATE,
    allowNull: false
  }

}, {
  sequelize: db,
  modelName: 'Authentication',
  tableName: 'authentication',
  timestamps: false
});

module.exports = Authentication;
