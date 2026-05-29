/**
 * Material / Stock Request Note (MRN) — manufacturing requests items from warehouse.
 * Line items reference raw_materials, pack_materials, or products.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class MaterialRequestNote extends Model {}

MaterialRequestNote.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    mrn_no: { type: DataTypes.STRING(100), allowNull: false },
    requested_by: { type: DataTypes.STRING(200), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'Pending' },
    assigned_picker: { type: DataTypes.STRING(200), allowNull: true },
    transfer_team: { type: DataTypes.STRING(200), allowNull: true },
    line_items: { type: DataTypes.JSON, allowNull: true },
    /** Outbound MTR: map line item id -> not_initiated | in_transit | received_at_mu | completed */
    line_transfer_status: { type: DataTypes.JSON, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    bmr_no: { type: DataTypes.STRING(50), allowNull: true },
    source: { type: DataTypes.STRING(20), allowNull: true },
    /** true = transfer from MU to Warehouse (inbound-from-MU); false/null = outbound (WH→MU). */
    is_inbound_from_mu: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    /** MU receive flow (mirrors GRN): received date, label params, generated QR labels. */
    received_at_mu: { type: DataTypes.DATE, allowNull: true },
    generated_labels: { type: DataTypes.JSON, allowNull: true },
    no_of_boxes: { type: DataTypes.INTEGER, allowNull: true },
    units_per_box: { type: DataTypes.INTEGER, allowNull: true },
    location_prefix: { type: DataTypes.STRING(100), allowNull: true },
    grn_batch_mfg: { type: DataTypes.STRING(100), allowNull: true },
    expiry: { type: DataTypes.DATEONLY, allowNull: true },
    mfg_batch: { type: DataTypes.STRING(100), allowNull: true },
    /** Outbound MTR (RM / PM): warehouse zone stock is picked from (set at Send MTR; not edited in WH). */
    wh_dispatch_zone: { type: DataTypes.STRING(100), allowNull: true },
    /** MU zone/rack when transfer is completed (for location history). */
    mu_receive_zone: { type: DataTypes.STRING(100), allowNull: true },
    mu_receive_rack: { type: DataTypes.STRING(100), allowNull: true },
    /** Outbound MTR logistics captured when warehouse initiates transfer. */
    logistics_tracking_no: { type: DataTypes.STRING(200), allowNull: true },
    logistics_transporter: { type: DataTypes.STRING(200), allowNull: true },
    logistics_dispatch_date: { type: DataTypes.DATEONLY, allowNull: true },
    logistics_eta_date: { type: DataTypes.DATEONLY, allowNull: true },
    logistics_vehicle_no: { type: DataTypes.STRING(100), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'MaterialRequestNote',
    tableName: 'material_request_notes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = MaterialRequestNote;
