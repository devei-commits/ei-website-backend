/**
 * Pack Materials model for Pack Materials dashboard (tubes, bottles, cartons, labels, closures).
 * Table: pack_materials
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class PackMaterial extends Model {}

PackMaterial.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    code: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    type: { type: DataTypes.STRING(100), allowNull: true },
    level: { type: DataTypes.STRING(50), allowNull: true },
    group: { type: DataTypes.STRING(100), allowNull: true },
    material: { type: DataTypes.STRING(255), allowNull: true },
    size_spec: { type: DataTypes.STRING(255), allowNull: true },
    price_per_pc: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    moq: { type: DataTypes.INTEGER, allowNull: true },
    lead_time_days: { type: DataTypes.INTEGER, allowNull: true },
    print_status: { type: DataTypes.STRING(100), allowNull: true },
    products: { type: DataTypes.JSON, allowNull: true }, // array of product codes e.g. ['PR-002']
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'PackMaterial',
    tableName: 'pack_materials',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = PackMaterial;
