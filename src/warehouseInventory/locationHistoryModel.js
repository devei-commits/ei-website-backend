/**
 * Warehouse Inventory Location History
 * Tracks internal moves (zone/rack changes) for traceability per RM/PM/PR.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class WarehouseInventoryLocationHistory extends Model {}

WarehouseInventoryLocationHistory.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    warehouse_inventory_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'warehouse_inventory', key: 'id' },
    },
    item_type: {
      type: DataTypes.STRING(10),
      allowNull: false,
    }, // 'RM' | 'PM' | 'PR'
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true },
    product_id: { type: DataTypes.INTEGER, allowNull: true },
    from_zone: { type: DataTypes.STRING(100), allowNull: true },
    from_rack: { type: DataTypes.STRING(100), allowNull: true },
    to_zone: { type: DataTypes.STRING(100), allowNull: true },
    to_rack: { type: DataTypes.STRING(100), allowNull: true },
    // Quantity delta associated with this movement (positive for inbound, negative for outbound)
    qty_delta: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    // Action type, e.g. GRN_IN, TRANSFER_OUT, MANUAL_ADJUST
    action_type: { type: DataTypes.STRING(30), allowNull: true },
    source_grn_id: { type: DataTypes.INTEGER, allowNull: true },
    source_mrn_id: { type: DataTypes.INTEGER, allowNull: true },
    moved_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    // Reserved change from BMR/BPR — only set when action_type is BMR_RESERVED or BPR_RESERVED
    reserved_delta: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    reserved_after: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    production_batch_id: { type: DataTypes.INTEGER, allowNull: true },
    batch_no: { type: DataTypes.STRING(50), allowNull: true },
    /** Same id on all RM/PM history rows for one dispensing PATCH — ties MU consumption to production_batches.mu_dispensing_bundles. */
    dispensing_bundle_id: { type: DataTypes.STRING(80), allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'WarehouseInventoryLocationHistory',
    tableName: 'warehouse_inventory_location_history',
    timestamps: false,
  }
);

module.exports = WarehouseInventoryLocationHistory;

