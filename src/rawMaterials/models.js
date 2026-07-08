/**
 * Raw Materials model for Masters → Raw Materials dashboard.
 * Zoho Books: `zoho_id` is set on create via POST /items when Zoho is enabled (`zohoMasterItemSync`).
 * Table: raw_materials (code, name, inci, ..., zoho_id, zoho_sku_code, hsn_code, tax_pref, sales_purchase_account)
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
    /** Typical procurement lead (days) for this RM; Items List vendor rates override for quoted pricing. */
    lead_time_days: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    /** Staff user (userid) who may approve this master; admins bypass. */
    approval_assigned_user_id: { type: DataTypes.INTEGER, allowNull: true },
    approval_assigned_display_name: { type: DataTypes.STRING(255), allowNull: true },
    approval_stage_assignees: { type: DataTypes.JSON, allowNull: true },
    products: { type: DataTypes.JSON, allowNull: true }, // array of product codes e.g. ['PR-001','PR-002']
    group: { type: DataTypes.STRING(100), allowNull: true },
    zoho_id: { type: DataTypes.STRING(100), allowNull: true },
    /**
     * Zoho-mirrored SKU code. After a successful Zoho item sync this matches `item.sku` in Zoho Books.
     * Enforced UNIQUE (partial, where NOT NULL) at the DB level — see ensureSchemaPatches.
     * Nullable while a row is in pre-sync draft state.
     * Renamed from `sku` (May 2026) for cross-table clarity (RM/PM/PR all use `zoho_sku_code`).
     */
    zoho_sku_code: { type: DataTypes.STRING(100), allowNull: true },
    hsn_code: { type: DataTypes.STRING(50), allowNull: true },
    tax_pref: { type: DataTypes.STRING(50), allowNull: true },
    sales_purchase_account: { type: DataTypes.STRING(255), allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true }, // full form payload for create/edit (vendors, documents, tests, all scalars)
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    /** Soft-delete archive flag (`active` / `deleted`) — do not use for business lifecycle dropdown. */
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
    /** Sourcing/usage lifecycle: Active, Preferred, Conditional, Phase-out, Discontinued. */
    master_lifecycle_status: { type: DataTypes.STRING(50), allowNull: true },
    rm_owner: { type: DataTypes.STRING(255), allowNull: true },
    universal_swap_eligibility: { type: DataTypes.STRING(10), allowNull: true },
    functional_equivalents: { type: DataTypes.TEXT, allowNull: true },
    /** Once true, this item's own saved quality specs win over the category/sub-category rule (one-way). */
    quality_specs_locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
