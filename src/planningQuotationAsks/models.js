/**
 * Planning quotation asks — reminders for Procurement → Quotations only.
 * Does not create procurement_requests; planners create PRs manually after rates exist.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const PlanningExtracted = require('../planningExtracted/models');

class PlanningQuotationAsk extends Model {}

PlanningQuotationAsk.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planning_extracted_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'planning_extracted', key: 'id' },
    },
    item_type: { type: DataTypes.STRING(10), allowNull: false },
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true },
    item_code: { type: DataTypes.STRING(120), allowNull: true },
    item_name: { type: DataTypes.STRING(300), allowNull: true },
    quantity_requested: { type: DataTypes.DECIMAL(18, 6), allowNull: false },
    unit: { type: DataTypes.STRING(20), allowNull: true },
    vendor_hint: { type: DataTypes.STRING(300), allowNull: true },
    moq_hint: { type: DataTypes.DECIMAL(18, 6), allowNull: true },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    requested_by: { type: DataTypes.STRING(200), allowNull: true },
    fulfilled_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'PlanningQuotationAsk',
    tableName: 'planning_quotation_asks',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

PlanningQuotationAsk.belongsTo(PlanningExtracted, {
  foreignKey: 'planning_extracted_id',
  as: 'planningExtracted',
});
PlanningExtracted.hasMany(PlanningQuotationAsk, { foreignKey: 'planning_extracted_id' });

module.exports = PlanningQuotationAsk;
