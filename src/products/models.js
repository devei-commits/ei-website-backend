const { DataTypes, Model } = require('sequelize');
const db = require('../../db');


class Product extends Model {}

Product.init(
  {
    product_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    status: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    availability: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    product_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    product_sku: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    generic_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    brand_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    tax_rate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    },

    product_description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    mrp_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },

    buy_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },

    product_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    category: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    lifecycle_status: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize: db,
    modelName: "Product",
    tableName: "products",   // adjust if table name differs
    timestamps: false,       // because you already store created_at manually
  }
);


// class Category extends Model {}
// Category.init({
//     id: {
//         type: DataTypes.INTEGER,
//         primaryKey: true,
//         autoIncrement: true
//     },
//     name: {
//         type: DataTypes.STRING,
//         allowNull: false,
//         unique: true
//     }
// }, {
//     sequelize: db,
//     modelName: 'category',
//     paranoid: true, // Soft delete
// });

// Product.belongsTo(Category);
// Category.hasMany(Product);

module.exports = { Product };