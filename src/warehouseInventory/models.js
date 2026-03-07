/**
 * Warehouse Inventory — warehouse-specific data per RM/PM/PR.
 * One row per item (FK to raw_materials, pack_materials, or products).
 * Fields: Zone/Rack, WH Stock, ML1/ML2 Stock, Stock in Hand, Reserved, In Transit, Reorder PT, Avg/MO, QC Status.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class WarehouseInventory extends Model {}

WarehouseInventory.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    item_type: {
      type: DataTypes.STRING(10),
      allowNull: false,
    }, // 'RM' | 'PM' | 'PR'
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true, unique: true, references: { model: 'raw_materials', key: 'id' } },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true, unique: true, references: { model: 'pack_materials', key: 'id' } },
    product_id: { type: DataTypes.INTEGER, allowNull: true, unique: true, references: { model: 'products', key: 'product_id' } },
    zone: { type: DataTypes.STRING(100), allowNull: true },
    rack: { type: DataTypes.STRING(100), allowNull: true },
    wh_stock: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    wh_unit: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'KG' },
    ml1_stock: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    ml2_stock: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    stock_in_hand: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    reserved: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    in_transit: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    reorder_pt: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    avg_mo: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    qc_status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'In Stock' }, // In Stock | Low Stock | Critical | Out of Stock
    batch_number: { type: DataTypes.STRING(50), allowNull: true }, // e.g. WH-2026-RM-001, WH-2026-PM-001
    expiry_date: { type: DataTypes.DATEONLY, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'WarehouseInventory',
    tableName: 'warehouse_inventory',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = WarehouseInventory;
