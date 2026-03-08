/**
 * Procurement Requests — logged when Planning raises a PR for an order.
 * Links to planning_extracted (which references sales_orders by sales_order_id).
 * items JSON: array of { type: 'RM'|'PM'|'PR'|'FG', raw_material_id?, pack_material_id?, product_id?, quantity_requested, unit, line_notes?, required?, sih?, shortage? } — references raw_materials, pack_materials, products by ID.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const PlanningExtracted = require('../planningExtracted/models');

class ProcurementRequest extends Model {}

ProcurementRequest.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planning_extracted_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'planning_extracted', key: 'id' },
    },
    priority: { type: DataTypes.STRING(50), allowNull: true },
    required_by_date: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    items: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Array of { type, raw_material_id?, pack_material_id?, product_id?, quantity_requested, unit, line_notes?, required?, sih?, shortage?, code?, name? }',
    },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'Pending' },
    preferred_vendor: { type: DataTypes.STRING(300), allowNull: true },
    requested_by: { type: DataTypes.STRING(200), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ProcurementRequest',
    tableName: 'procurement_requests',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

ProcurementRequest.belongsTo(PlanningExtracted, { foreignKey: 'planning_extracted_id', as: 'planningExtracted' });
PlanningExtracted.hasMany(ProcurementRequest, { foreignKey: 'planning_extracted_id' });

module.exports = ProcurementRequest;
