const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Address extends Model {}

Address.init({
  address_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },

  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  address_type: {
    type: DataTypes.STRING, // billing / shipping / clinic / etc
    allowNull: true
  },

  is_default_shipping: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  is_default_billing: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  first_name: DataTypes.STRING,
  last_name: DataTypes.STRING,

  address_line1: {
    type: DataTypes.STRING,
    allowNull: false
  },

  address_line2: DataTypes.STRING,
  landmark: DataTypes.STRING,

  city_text: DataTypes.STRING,
  state_text: DataTypes.STRING,
  country_text: DataTypes.STRING,
  pincode: DataTypes.STRING,

  updated_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  phone: DataTypes.STRING,
  email: DataTypes.STRING

}, {
  sequelize: db,
  modelName: 'Address',
  tableName: 'addresses',

  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',

  paranoid: true,
  deletedAt: 'deleted_at'
});

module.exports = Address;
