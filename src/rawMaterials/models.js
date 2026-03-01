/**
 * Raw Materials model for Masters → Raw Materials dashboard.
 * Table: raw_materials (code, name, inci, category, rm_type, uom, price_per_kg, gst, shelf, status, products, group)
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class RawMaterial extends Model {}

RawMaterial.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    code: { type: DataTypes.STRING(100), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: true },
    inci: { type: DataTypes.STRING(255), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    rm_type: { type: DataTypes.STRING(50), allowNull: true },
    uom: { type: DataTypes.STRING(20), allowNull: true },
    price_per_kg: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    gst: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    shelf: { type: DataTypes.STRING(20), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    products: { type: DataTypes.JSON, allowNull: true }, // array of product codes e.g. ['PR-001','PR-002']
    group: { type: DataTypes.STRING(100), allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true }, // full form payload for create/edit (vendors, documents, tests, all scalars)
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'RawMaterial',
    tableName: 'raw_materials',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = RawMaterial;
