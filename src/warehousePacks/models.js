/**
 * Warehouse pack inventory — one row per individual pack (packaging number) in stock.
 *
 * Materialized at GRN completion from the GRN's packaging list (source_documents.packaging)
 * + batch details + putaway location, so transfers can pick/split real packs instead of the
 * old typed quantities. The aggregate warehouse_inventory / warehouse_rack_items buckets stay
 * the source of truth for TOTAL qty; this table adds pack-level identity alongside them.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class WarehousePack extends Model {}

WarehousePack.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** Unique pack label, e.g. PKG-GRN-PO-26-0129-001 or PKG-SPLIT-<parent>-A1. */
    packaging_no: { type: DataTypes.STRING(160), allowNull: false, unique: true },
    /** Source GRN this pack was received on (null for split children created later). */
    grn_id: { type: DataTypes.INTEGER, allowNull: true },
    /** Index into the source GRN's Batch Details rows. */
    batch_index: { type: DataTypes.INTEGER, allowNull: true },
    item_type: { type: DataTypes.STRING(4), allowNull: true }, // RM | PM | PR
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true },
    product_id: { type: DataTypes.INTEGER, allowNull: true },
    zone: { type: DataTypes.STRING(200), allowNull: true },
    rack: { type: DataTypes.STRING(200), allowNull: true },
    vendor_batch: { type: DataTypes.STRING(160), allowNull: true },
    mfg_date: { type: DataTypes.DATEONLY, allowNull: true },
    exp_date: { type: DataTypes.DATEONLY, allowNull: true },
    qty: { type: DataTypes.DECIMAL(28, 16), allowNull: true, defaultValue: 0 },
    unit: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'KG' },
    /** available | picked | split | consumed */
    status: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'available' },
    /** When this is a split child, the pack it was split from. */
    parent_pack_id: { type: DataTypes.INTEGER, allowNull: true },
    /** Transfer (MRN) that picked/consumed this pack. */
    mrn_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'WarehousePack',
    tableName: 'warehouse_packs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = WarehousePack;
