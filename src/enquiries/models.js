const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');

class Enquiry extends Model {}

Enquiry.init({
  enquiry_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'userid'
    }
  },
  enquiry_type: {
    type: DataTypes.STRING,
    allowNull: true,
    // comment: 'One of: product, process, contact, quotation, other'
  },
  details: {
    type: DataTypes.JSON,
    allowNull: true,
    // comment: 'Type-specific fields: product (product_id, product_name, question, quantity), process (process_name, step, question), contact (subject, message, phone), quotation (product_interest, quantity, deadline, message), other (subject, description)'
  },
  status: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'open',
    // comment: 'e.g. open, in_progress, closed'
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  sequelize: db,
  modelName: 'Enquiry',
  tableName: 'enquiries',
  timestamps: false
});

Enquiry.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(Enquiry, { foreignKey: 'user_id', as: 'enquiries' });

module.exports = Enquiry;
