/**
 * Purchase Orders — schema aligned with Create New Purchase Order form.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class PurchaseOrder extends Model {}

PurchaseOrder.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.STRING(100), allowNull: false },
    vendor_name: { type: DataTypes.STRING(300), allowNull: true },
    branch: { type: DataTypes.STRING(100), allowNull: true },
    order_date: { type: DataTypes.DATEONLY, allowNull: true },
    expected_shipment_date: { type: DataTypes.DATEONLY, allowNull: true },
    reference: { type: DataTypes.STRING(200), allowNull: true },
    payment_terms: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    order_status: { type: DataTypes.JSON, allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true },
    items: { type: DataTypes.JSON, allowNull: true },
    /** Zoho Books purchaseorder_id after POST /purchaseorders */
    zoho_purchase_order_id: { type: DataTypes.STRING(100), allowNull: true },
    /** Zoho Books bill_id after POST /bills (vendor purchase invoice) */
    zoho_bill_id: { type: DataTypes.STRING(100), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'PurchaseOrder',
    tableName: 'purchase_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = PurchaseOrder;
