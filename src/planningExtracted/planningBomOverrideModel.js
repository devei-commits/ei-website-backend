/**
 * Custom BOM per planning extracted row (SO line).
 * When user swaps/adds ingredients in Plan Batches for a specific SO, we store the overridden BOM here
 * instead of modifying the product's master BOM. One row per planning_extracted_id.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class PlanningBomOverride extends Model {}

PlanningBomOverride.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planning_extracted_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'planning_extracted', key: 'id' },
      onDelete: 'CASCADE',
    },
    rm_lines: { type: DataTypes.JSON, allowNull: true },
    pm_lines: { type: DataTypes.JSON, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'PlanningBomOverride',
    tableName: 'planning_bom_override',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = PlanningBomOverride;
