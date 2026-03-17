/**
 * Universal Swap History — records each ingredient swap (from RM → to RM) with affected items.
 * Table: universal_swap_history
 * NOTE: affected_group_ids = item group ids, affected_bom_ids = PR BOM ids (for "PRs affected" popup in swap history).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class UniversalSwapHistory extends Model {}

UniversalSwapHistory.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    from_raw_material_id: { type: DataTypes.INTEGER, allowNull: false },
    to_raw_material_id: { type: DataTypes.INTEGER, allowNull: false },
    swap_ratio: { type: DataTypes.DECIMAL(10, 4), allowNull: true, defaultValue: 1 },
    reason: { type: DataTypes.TEXT, allowNull: true },
    approved_by: { type: DataTypes.STRING(255), allowNull: true },
    approved_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    affected_group_ids: { type: DataTypes.JSON, allowNull: true }, // [1, 2] item_groups ids
    affected_bom_ids: { type: DataTypes.JSON, allowNull: true }, // [10, 11] bom ids (PR formulas)
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'UniversalSwapHistory',
    tableName: 'universal_swap_history',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = UniversalSwapHistory;
