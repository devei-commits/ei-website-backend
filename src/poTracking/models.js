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
    payment_transaction_no: { type: DataTypes.STRING(100), allowNull: true },
    payment_mode: { type: DataTypes.STRING(50), allowNull: true },
    payment_transaction_date: { type: DataTypes.DATEONLY, allowNull: true },
    vendor_confirmed_at: { type: DataTypes.DATEONLY, allowNull: true },
    vendor_confirmed_note: { type: DataTypes.STRING(500), allowNull: true },
    /** Send-to-Vendor channel (portal | email | whatsapp) — Flowchart Sub-flow F. */
    sent_channel: { type: DataTypes.STRING(50), allowNull: true },
    /** Vendor-acknowledgement SLA due date (po_released_at + 48h). */
    ack_sla_due_at: { type: DataTypes.DATEONLY, allowNull: true },
    /** Vendor rejected / could not fulfil (Flowchart SENT→REJECTED path). */
    vendor_rejected_at: { type: DataTypes.DATEONLY, allowNull: true },
    vendor_rejected_note: { type: DataTypes.STRING(500), allowNull: true },
    shipped_at: { type: DataTypes.DATEONLY, allowNull: true },
    shipped_note: { type: DataTypes.STRING(500), allowNull: true },
    order_tracking_ref: { type: DataTypes.STRING(200), allowNull: true },
    delivered_at: { type: DataTypes.DATEONLY, allowNull: true },
    delivered_note: { type: DataTypes.STRING(500), allowNull: true },
    under_grn_at: { type: DataTypes.DATEONLY, allowNull: true },
    under_grn_note: { type: DataTypes.STRING(500), allowNull: true },
    grn_complete_at: { type: DataTypes.DATEONLY, allowNull: true },
    grn_complete_note: { type: DataTypes.STRING(500), allowNull: true },
    /** Vendor invoice capture (Flowchart Sub-flow I · 3-way match). */
    invoice_no: { type: DataTypes.STRING(100), allowNull: true },
    invoice_date: { type: DataTypes.DATEONLY, allowNull: true },
    invoice_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    /** 3-way match result: unmatched | pass | variance | overridden. */
    match_status: { type: DataTypes.STRING(30), allowNull: true },
    matched_at: { type: DataTypes.DATE, allowNull: true },
    match_note: { type: DataTypes.STRING(1000), allowNull: true },
    /** Final (post-GRN) payment — distinct from advance_paid_at. */
    final_paid_at: { type: DataTypes.DATEONLY, allowNull: true },
    final_paid_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    /** PO closure. */
    closed_at: { type: DataTypes.DATE, allowNull: true },
    closed_note: { type: DataTypes.STRING(500), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
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
