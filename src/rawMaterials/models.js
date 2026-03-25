/**
 * Raw Materials model for Masters → Raw Materials dashboard.
 * Zoho Books: `zoho_id` is set on create via POST /items when Zoho is enabled (`zohoMasterItemSync`).
 * Table: raw_materials (code, name, inci, ..., zoho_id, sku, hsn_code, tax_pref, sales_purchase_account)
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class RawMaterial extends Model {}

RawMaterial.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    code: { type: DataTypes.STRING(100), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: true },
    inci: { type: DataTypes.STRING(255), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    rm_type: { type: DataTypes.STRING(50), allowNull: true },
    uom: { type: DataTypes.STRING(20), allowNull: true },
    price_per_kg: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    gst: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    shelf: { type: DataTypes.STRING(20), allowNull: true },
    /** Specific gravity vs water for vessel volume: volume_L = quantity_kg / specific_gravity. Default 1 if null. */
    specific_gravity: { type: DataTypes.DECIMAL(5, 3), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    products: { type: DataTypes.JSON, allowNull: true }, // array of product codes e.g. ['PR-001','PR-002']
    group: { type: DataTypes.STRING(100), allowNull: true },
    zoho_id: { type: DataTypes.STRING(100), allowNull: true },
    sku: { type: DataTypes.STRING(100), allowNull: true },
    hsn_code: { type: DataTypes.STRING(50), allowNull: true },
    tax_pref: { type: DataTypes.STRING(50), allowNull: true },
    sales_purchase_account: { type: DataTypes.STRING(255), allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true }, // full form payload for create/edit (vendors, documents, tests, all scalars)
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'RawMaterial',
    tableName: 'raw_materials',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = RawMaterial;
