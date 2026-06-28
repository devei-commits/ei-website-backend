/**
 * Shipment Batch (SB) — Procurement spec §4A/§4B/§7.
 * A truckload: one SB carries 1+ child GRNs (sibling GRNs share the same SB#,
 * meaning they arrived on the same vehicle). Vehicle/driver/transporter details
 * live here (shared across all child GRNs). SB status is implied by the worst
 * child-GRN stage (spec §12 open-question 8), so it isn't stored.
 *
 * Table auto-creates via db.sync({ alter: true }) on boot (app.js).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const GoodsReceivedNote = require('./models');

class ShipmentBatch extends Model {}

ShipmentBatch.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(40), allowNull: true }, // SB-2026-XXXX (set post-insert from id)
    purchase_order_id: { type: DataTypes.INTEGER, allowNull: true },
    po_no: { type: DataTypes.STRING(100), allowNull: true },
    vendor: { type: DataTypes.STRING(300), allowNull: true },
    vehicle_no: { type: DataTypes.STRING(60), allowNull: true },
    driver_name: { type: DataTypes.STRING(200), allowNull: true },
    driver_phone: { type: DataTypes.STRING(40), allowNull: true },
    transporter: { type: DataTypes.STRING(200), allowNull: true },
    shipped_date: { type: DataTypes.DATEONLY, allowNull: true },
    vendor_invoice_no: { type: DataTypes.STRING(100), allowNull: true },
    expected_arrival: { type: DataTypes.DATEONLY, allowNull: true },
    total_qty: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    line_count: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'ShipmentBatch',
    tableName: 'shipment_batches',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

// Associations: SB 1—N GRN (sibling GRNs on the same truck).
ShipmentBatch.hasMany(GoodsReceivedNote, { foreignKey: 'shipment_batch_id', as: 'grns' });
GoodsReceivedNote.belongsTo(ShipmentBatch, { foreignKey: 'shipment_batch_id', as: 'shipmentBatch' });

module.exports = ShipmentBatch;
