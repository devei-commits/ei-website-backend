const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');

class Newdevelopment extends Model {}

Newdevelopment.init({
  Newdevelopments_id: {
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
  application_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  condition_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fragrance_preference: {
    type: DataTypes.STRING,
    allowNull: true
  },
  ingredients_preference: {
    type: DataTypes.STRING,
    allowNull: true
  },
  ph_range: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_category: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  request_status: {
    type: DataTypes.STRING,
    defaultValue: 'Pending'
  },
  specifications: {
    type: DataTypes.JSON,
    allowNull: true
  },
  submitted_date: {
    type: DataTypes.STRING,
    allowNull: true
  },
  target_area: {
    type: DataTypes.STRING,
    allowNull: true
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
  modelName: 'Newdevelopment',
  tableName: 'newdevelopments',
  timestamps: false
});

// Associations
Newdevelopment.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(Newdevelopment, { foreignKey: 'user_id', as: 'newdevelopments' });

module.exports = Newdevelopment;
