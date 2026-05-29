/**
 * Goods Received Note (GRN) — Inbound warehouse process.
 * Table columns align with Inbound UI: GRN No., PO No., Vendor, Type, Items, PO Value, Expected, Received, Assigned To, QC, Status.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class GoodsReceivedNote extends Model {}

GoodsReceivedNote.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    grn_no: { type: DataTypes.STRING(100), allowNull: false },
    purchase_order_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'purchase_orders', key: 'id' } },
    po_no: { type: DataTypes.STRING(100), allowNull: true },
    vendor: { type: DataTypes.STRING(300), allowNull: true },
    type: { type: DataTypes.STRING(10), allowNull: true }, // 'RM' | 'PM'
    items: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    po_value: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    expected_date: { type: DataTypes.DATEONLY, allowNull: true },
    received_date: { type: DataTypes.DATEONLY, allowNull: true },
    assigned_to: { type: DataTypes.STRING(200), allowNull: true },
    qc_status: { type: DataTypes.STRING(50), allowNull: true }, // Under test | Quality checked | Passed | Rejected
    qc_by: { type: DataTypes.STRING(200), allowNull: true }, // display name of user who performed QC
    status: { type: DataTypes.STRING(50), allowNull: true }, // GRN Complete | Under GRN | In Transit | On Hold | Delayed | Pending
    line_items: { type: DataTypes.JSON, allowNull: true },
    workflow_steps: { type: DataTypes.JSON, allowNull: true },
    invoice_no: { type: DataTypes.STRING(100), allowNull: true },
    invoice_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    grn_date: { type: DataTypes.DATEONLY, allowNull: true },
    no_of_boxes: { type: DataTypes.INTEGER, allowNull: true },
    units_per_box: { type: DataTypes.INTEGER, allowNull: true },
    /** When set, box 1..(n-1) use units_per_box; box n uses this count (partial last carton). */
    last_box_units: { type: DataTypes.INTEGER, allowNull: true },
    location_prefix: { type: DataTypes.STRING(50), allowNull: true },
    /** Storage zone label (required with rack before GRN Complete). */
    location_zone: { type: DataTypes.STRING(200), allowNull: true },
    grn_batch_mfg: { type: DataTypes.STRING(100), allowNull: true },
    expiry: { type: DataTypes.DATEONLY, allowNull: true },
    mfg_batch: { type: DataTypes.STRING(100), allowNull: true },
    generated_labels: { type: DataTypes.JSON, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'GoodsReceivedNote',
    tableName: 'goods_received_notes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = GoodsReceivedNote;
