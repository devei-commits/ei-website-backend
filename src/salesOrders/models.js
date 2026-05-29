/**
 * Sales Orders — schema aligned with Create New Sales Order form.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class SalesOrder extends Model {}

SalesOrder.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.STRING(100), allowNull: false },
    customer_name: { type: DataTypes.STRING(300), allowNull: true },
    branch: { type: DataTypes.STRING(100), allowNull: true },
    order_date: { type: DataTypes.DATEONLY, allowNull: true },
    expected_shipment_date: { type: DataTypes.DATEONLY, allowNull: true },
    reference: { type: DataTypes.STRING(200), allowNull: true },
    payment_terms: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    order_status: { type: DataTypes.JSON, allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true },
    items: { type: DataTypes.JSON, allowNull: true },
    created_by: { type: DataTypes.STRING(200), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'SalesOrder',
    tableName: 'sales_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = SalesOrder;
