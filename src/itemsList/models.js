/**
 * Items List: vendor-specific pricing view over Raw Materials and Pack Materials.
 * - items_list: one row per "item" in the list (FK to raw_materials or pack_materials).
 * - item_list_vendor_rates: vendor rate per item (default_rate, default_moq).
 * - item_list_tiers: MOQ breakpoints (moq_min, moq_max, price_per_unit) per vendor rate.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class ItemsList extends Model {}

ItemsList.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    type: { type: DataTypes.STRING(10), allowNull: false }, // 'RM' | 'PM'
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'Active' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ItemsList',
    tableName: 'items_list',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

class ItemListVendorRate extends Model {}

ItemListVendorRate.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    items_list_id: { type: DataTypes.INTEGER, allowNull: false },
    vendor_id: { type: DataTypes.INTEGER, allowNull: false },
    default_rate: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    default_moq: { type: DataTypes.INTEGER, allowNull: true },
    currency: { type: DataTypes.STRING(10), allowNull: true, defaultValue: 'INR' },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'active' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ItemListVendorRate',
    tableName: 'item_list_vendor_rates',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

class ItemListTier extends Model {}

ItemListTier.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    item_list_vendor_rate_id: { type: DataTypes.INTEGER, allowNull: false },
    moq_min: { type: DataTypes.INTEGER, allowNull: false },
    moq_max: { type: DataTypes.INTEGER, allowNull: true },
    price_per_unit: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    valid_till: { type: DataTypes.DATEONLY, allowNull: true },
    note: { type: DataTypes.STRING(500), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ItemListTier',
    tableName: 'item_list_tiers',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

// Associations (no require loop: RawMaterial, PackMaterial, VendorClient used by controller)
ItemsList.hasMany(ItemListVendorRate, { foreignKey: 'items_list_id' });
ItemListVendorRate.belongsTo(ItemsList, { foreignKey: 'items_list_id' });
ItemListVendorRate.hasMany(ItemListTier, { foreignKey: 'item_list_vendor_rate_id' });
ItemListTier.belongsTo(ItemListVendorRate, { foreignKey: 'item_list_vendor_rate_id' });

module.exports = { ItemsList, ItemListVendorRate, ItemListTier };
