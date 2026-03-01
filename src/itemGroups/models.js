/**
 * Item Groups — groups of raw materials (RM) or pack materials (PM) for alternate sourcing.
 * Schema aligned with frontend ItemGroups page.
 * Table: item_groups
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class ItemGroup extends Model {}

ItemGroup.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(50), allowNull: false },
    icon: { type: DataTypes.STRING(20), allowNull: true },
    type: { type: DataTypes.STRING(10), allowNull: false }, // 'RM' | 'PM'
    name: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    purpose: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'Active' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    member_ids: { type: DataTypes.JSON, allowNull: true }, // [1,2,3] raw_material ids (RM) or pack_material ids (PM)
    proposed_alternates: { type: DataTypes.JSON, allowNull: true }, // [{ id, name, notes, status, ratio? }]
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ItemGroup',
    tableName: 'item_groups',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = ItemGroup;
