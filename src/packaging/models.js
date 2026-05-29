/**
 * Packaging model for Masters → Packaging dashboard.
 * Table: packaging (package_code, package_name, package_sku, bottom, cap_type, etc.)
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Packaging extends Model {}

Packaging.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    package_code: { type: DataTypes.STRING(100), allowNull: true },
    package_name: { type: DataTypes.STRING(255), allowNull: true },
    package_sku: { type: DataTypes.STRING(100), allowNull: true },
    bottom: { type: DataTypes.STRING(50), allowNull: true },
    cap_type: { type: DataTypes.STRING(50), allowNull: true },
    bottom_name: { type: DataTypes.STRING(100), allowNull: true },
    bottom_material: { type: DataTypes.STRING(50), allowNull: true },
    cap_name: { type: DataTypes.STRING(100), allowNull: true },
    cap_material: { type: DataTypes.STRING(50), allowNull: true },
    bottom_color: { type: DataTypes.STRING(50), allowNull: true },
    cap_color: { type: DataTypes.STRING(50), allowNull: true },
    bottom_weight: { type: DataTypes.STRING(50), allowNull: true },
    cap_weight: { type: DataTypes.STRING(50), allowNull: true },
    dispenser_volume: { type: DataTypes.STRING(50), allowNull: true },
    minimum_order_quantity: { type: DataTypes.STRING(50), allowNull: true },
    budget: { type: DataTypes.STRING(50), allowNull: true },
    comments: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'active' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'Packaging',
    tableName: 'packaging',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Packaging;
