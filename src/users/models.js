const { DataTypes, Model } = require('sequelize');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const Address = require('../models/Addresses');

class User extends Model {
  generateToken() {
    return jwt.sign({ id: this.userid, role: this.usertype }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });
  }
}
User.init({
  userid: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },

  fname: {
    type: DataTypes.STRING,
    allowNull: true
  },

  lname: {
    type: DataTypes.STRING,
    allowNull: true
  },

  display_name: {
    type: DataTypes.STRING,
    allowNull: true
  },

  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },

  mobile: {
    type: DataTypes.STRING,
    allowNull: true
  },

  password: {
    type: DataTypes.STRING,
    allowNull: false
  },

  usertype: {
    type: DataTypes.STRING,
    allowNull: true
  },

  /** Website signup selection: customer | dermatologist | distributor (RBAC may map derma/dist to doctor). */
  portal_signup_role: {
    type: DataTypes.STRING(64),
    allowNull: true
  },

  department: {
    type: DataTypes.STRING,
    allowNull: true
  },

  status: {
    type: DataTypes.STRING,
    allowNull: true
  },

  doctor_id_legacy: {
    type: DataTypes.STRING,
    allowNull: true
  },

  verify_status: {
    type: DataTypes.STRING,
    allowNull: true
  },

  advance_payment: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: false
  },

  advance_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },

  /** Zoho Books API `contact.contact_id` (same customer record used for invoices, etc.). */
  zoho_contact_id: {
    type: DataTypes.STRING(64),
    allowNull: true
  },

  created_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  updated_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  deleted_at: {
    type: DataTypes.DATE,
    allowNull: true
  }

}, {
  sequelize: db,
  modelName: 'User',
  tableName: 'users',
  timestamps: false
});

class DoctorProfile extends Model {}

DoctorProfile.init({
  user_id: {
    type: DataTypes.INTEGER,
    primaryKey: true
  },

  doctor_id: DataTypes.STRING,
  clinic_name: DataTypes.STRING,
  clinic_address: DataTypes.TEXT,
  city: DataTypes.STRING,
  state: DataTypes.STRING,
  country: DataTypes.STRING,
  pincode: DataTypes.STRING

}, {
  sequelize: db,
  modelName: 'DoctorProfile',
  tableName: 'doctor_profiles',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

class RefreshToken extends Model { }
RefreshToken.init({
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    refreshToken: {
        type: DataTypes.STRING,
        allowNull: false
    }
}, {
    sequelize: db,
    modelName: 'refreshToken'
});

module.exports = { User, RefreshToken, DoctorProfile };
