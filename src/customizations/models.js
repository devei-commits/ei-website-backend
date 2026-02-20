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
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Product,
      key: 'product_id'
    }
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'userid'
    }
  },
  formulation: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  packaging: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  product_category: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sub_category: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sub_sub_category: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_sku: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  application_area: {
    type: DataTypes.STRING,
    allowNull: true
  },
  skin_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fragrance: {
    type: DataTypes.STRING,
    allowNull: true
  },
  color: {
    type: DataTypes.STRING,
    allowNull: true
  },
  ph_range: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'Pending'
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