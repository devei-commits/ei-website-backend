/**
 * PO Tracking — one row per purchase order, tracks all status stages.
 * Linked to purchase_orders. Used by Issued POs tab for itemized tracking.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const PurchaseOrder = require('../purchaseOrders/models');

class PoTracking extends Model {}

PoTracking.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    purchase_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'purchase_orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    po_released_at: { type: DataTypes.DATEONLY, allowNull: true },
    po_released_note: { type: DataTypes.STRING(500), allowNull: true },
    advance_paid_at: { type: DataTypes.DATEONLY, allowNull: true },
    advance_paid_note: { type: DataTypes.STRING(500), allowNull: true },
    vendor_confirmed_at: { type: DataTypes.DATEONLY, allowNull: true },
    vendor_confirmed_note: { type: DataTypes.STRING(500), allowNull: true },
    shipped_at: { type: DataTypes.DATEONLY, allowNull: true },
    shipped_note: { type: DataTypes.STRING(500), allowNull: true },
    order_tracking_ref: { type: DataTypes.STRING(200), allowNull: true },
    delivered_at: { type: DataTypes.DATEONLY, allowNull: true },
    delivered_note: { type: DataTypes.STRING(500), allowNull: true },
    under_grn_at: { type: DataTypes.DATEONLY, allowNull: true },
    under_grn_note: { type: DataTypes.STRING(500), allowNull: true },
    grn_complete_at: { type: DataTypes.DATEONLY, allowNull: true },
    grn_complete_note: { type: DataTypes.STRING(500), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'PoTracking',
    tableName: 'po_tracking',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

PoTracking.belongsTo(PurchaseOrder, { foreignKey: 'purchase_order_id', as: 'purchaseOrder' });

module.exports = PoTracking;
