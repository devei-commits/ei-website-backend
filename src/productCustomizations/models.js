const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');
const { Product } = require('../products/models');

class ProductCustomization extends Model {}

ProductCustomization.init({
  customization_id: {
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
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: Product,
      key: 'product_id'
    }
  },
  category: {
    type: DataTypes.STRING,
    allowNull: true,
    // comment: 'Product category e.g. Sun Protectant'
  },
  formulation: {
    type: DataTypes.JSON,
    allowNull: true,
    // comment: 'Object mapping category keys to customization names e.g. { Active, Cleanser, Moisturizer, Others, Serum, ... }'
  },
  formulationSummary: {
    type: DataTypes.TEXT,
    allowNull: true,
    // comment: 'Human-readable summary of formulation choices'
  },
  care: {
    type: DataTypes.STRING,
    allowNull: true,
    // comment: 'Main tab e.g. SKIN CARE, HAIR CARE'
  },
  packagingType: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'standard',
    // comment: 'Packaging type e.g. standard'
  },
  packaging_image: {
    type: DataTypes.STRING,
    allowNull: true,
    // comment: 'URL or path to packaging image'
  },
  userNotes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  packaging: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'Pending'
  },
  assigned_bd_user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  assigned_bd_name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  assigned_bd_email: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  assigned_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  internal_notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  life_cycle_status: {
    type: DataTypes.STRING,
    defaultValue: 'active'
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
  modelName: 'ProductCustomization',
  tableName: 'product_customizations',
  timestamps: false
});

// Associations
ProductCustomization.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
ProductCustomization.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

User.hasMany(ProductCustomization, { foreignKey: 'user_id', as: 'productCustomizations' });
Product.hasMany(ProductCustomization, { foreignKey: 'product_id', as: 'customizations' });

module.exports = ProductCustomization;