/**
 * Planning Extracted — PR-extracted tab: one row per SO line for planning team.
 * References sales_orders and products. Once an SO is created, its items appear here.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const SalesOrder = require('../salesOrders/models');
const { Product } = require('../products/models');

class PlanningExtracted extends Model {}

PlanningExtracted.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    sales_order_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'sales_orders', key: 'id' } },
    product_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'products', key: 'product_id' } },
    order_qty_display: { type: DataTypes.STRING(100), allowNull: true },
    total_kg_display: { type: DataTypes.STRING(100), allowNull: true },
    order_date: { type: DataTypes.DATEONLY, allowNull: true },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    batch_size_display: { type: DataTypes.STRING(100), allowNull: true },
    batches_required: { type: DataTypes.INTEGER, allowNull: true },
    bom_status: { type: DataTypes.STRING(80), allowNull: true },
    approved_by: { type: DataTypes.STRING(200), allowNull: true },
    raw_materials: { type: DataTypes.JSON, allowNull: true },
    packaging_materials: { type: DataTypes.JSON, allowNull: true },
    color: { type: DataTypes.STRING(50), allowNull: true },
    batch_count: { type: DataTypes.INTEGER, allowNull: true },
    batch_size_kg: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    planned_start_date: { type: DataTypes.DATEONLY, allowNull: true },
    production_line: { type: DataTypes.STRING(200), allowNull: true },
    bom_confirmed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'PlanningExtracted',
    tableName: 'planning_extracted',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

PlanningExtracted.belongsTo(SalesOrder, { foreignKey: 'sales_order_id', as: 'salesOrder' });
PlanningExtracted.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
SalesOrder.hasMany(PlanningExtracted, { foreignKey: 'sales_order_id' });
Product.hasMany(PlanningExtracted, { foreignKey: 'product_id' });

module.exports = PlanningExtracted;
