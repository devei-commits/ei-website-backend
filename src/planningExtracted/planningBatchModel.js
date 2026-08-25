/**
 * Batch-specific BOM copy per planning extracted row.
 * When user confirms BOM or creates batches in Plan Batches, each batch gets its own row here
 * with batch_code (e.g. PE-5-B1, or BMR-2026-002-B1 when linked to production), and a copy of
 * the current BOM (from planning_bom_override or product BOM). If BOM is edited or swap/add
 * is done, that BOM is saved to the override and can be re-copied to batches on save.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class PlanningBatch extends Model {}

PlanningBatch.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planning_extracted_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'planning_extracted', key: 'id' },
      onDelete: 'CASCADE',
    },
    sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    batch_code: { type: DataTypes.STRING(64), allowNull: false },
    size_kg: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    rm_lines: { type: DataTypes.JSON, allowNull: true },
    pm_lines: { type: DataTypes.JSON, allowNull: true },
    /**
     * When this batch's own BOM copy was confirmed. Confirmation is per batch because each batch
     * carries its own rm_lines/pm_lines and they can diverge — a new batch starts unconfirmed even
     * if an earlier batch on the same planning row was signed off.
     */
    bom_confirmed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'PlanningBatch',
    tableName: 'planning_batches',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['planning_extracted_id', 'sequence'] },
      { fields: ['planning_extracted_id'] },
    ],
  }
);

module.exports = PlanningBatch;
