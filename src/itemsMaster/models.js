/**
 * Items Master: products composed of multiple BOMs, Raw Materials, Pack Materials.
 * Table: items_master — links are arrays (bom_ids, raw_material_ids, pack_material_ids).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class ItemMaster extends Model {}

ItemMaster.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(100), allowNull: false },
    name: { type: DataTypes.STRING(300), allowNull: true },
    type: { type: DataTypes.STRING(50), allowNull: true }, // e.g. 'product', 'bom', 'packaging', 'raw-material'
    status: { type: DataTypes.STRING(50), allowNull: true },
    bom_ids: { type: DataTypes.JSON, allowNull: true },      // [1, 2]
    raw_material_ids: { type: DataTypes.JSON, allowNull: true }, // [1, 2, 3]
    pack_material_ids: { type: DataTypes.JSON, allowNull: true }, // [1, 2]
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ItemMaster',
    tableName: 'items_master',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = ItemMaster;
