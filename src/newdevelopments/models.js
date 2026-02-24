const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');

class Newdevelopment extends Model {}

Newdevelopment.init({
  product_id: {
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
  status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  customization: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sale: {
    type: DataTypes.STRING,
    allowNull: true
  },
  hsn_code: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_code: {
    type: DataTypes.STRING,
    allowNull: true
  },
  generic_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  brand_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  super_category: {
    type: DataTypes.STRING,
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
  label_claims: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  product_description_cust: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  product_description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  product_price: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  tax_rate: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: true
  },
  gst_input: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_cover_image: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_cover_image_customization: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_ingrediants: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  excepients: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  indications: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  usage: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  cautions: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  application_area: {
    type: DataTypes.STRING,
    allowNull: true
  },
  dosage_form_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  phrange: {
    type: DataTypes.STRING,
    allowNull: true
  },
  color: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fragrance: {
    type: DataTypes.STRING,
    allowNull: true
  },
  vascosity: {
    type: DataTypes.STRING,
    allowNull: true
  },
  other_specs: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  technology_used: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  recomendedproducts: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  packing_recommendations: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  batch_no: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sub_cat_char: {
    type: DataTypes.STRING,
    allowNull: true
  },
  grid_sub_cat: {
    type: DataTypes.STRING,
    allowNull: true
  },
  skin_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  product_specializations: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  usage_time: {
    type: DataTypes.STRING,
    allowNull: true
  },
  application_specifications: {
    type: DataTypes.TEXT,
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
