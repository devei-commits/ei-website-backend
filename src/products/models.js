const { DataTypes, Model } = require('sequelize');
const db = require('../../db');


class Product extends Model {}

Product.init(
  {
    product_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    status: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    availability: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    product_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    /**
     * Zoho-mirrored SKU code for the FG. After a successful Zoho item sync this matches `item.sku` in Zoho Books.
     * Enforced UNIQUE (partial, where NOT NULL) at the DB level — see ensureSchemaPatches.
     * Nullable while a row is in pre-sync draft state. Falls back to `product_code` when pushed to Zoho if blank.
     * Renamed from `product_sku` (May 2026) for cross-table clarity (RM/PM/PR all use `zoho_sku_code`).
     */
    zoho_sku_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    generic_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    brand_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    tax_rate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    },

    product_description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    incredients: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    how_to_use: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    mrp_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },

    buy_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },

    product_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    /** Customer-facing / storefront label; website customize flow shows this instead of product_name. */
    commercial_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    category: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    lifecycle_status: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    // PR Master / Product Registration fields (products-master UI)
    form: { type: DataTypes.STRING(100), allowNull: true },
    fill_size: { type: DataTypes.STRING(50), allowNull: true },
    batch_size_kg: { type: DataTypes.INTEGER, allowNull: true },
    /** Manufacturing / shipment lead (days) for this FG; multi-line orders use max(line leads) for expected delivery. */
    lead_time_days: { type: DataTypes.INTEGER, allowNull: true },
    shelf_life_months: { type: DataTypes.INTEGER, allowNull: true },
    version: { type: DataTypes.STRING(50), allowNull: true },
    license_cml: { type: DataTypes.STRING(100), allowNull: true },
    theoretical_yield_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    pao_months: { type: DataTypes.INTEGER, allowNull: true },
    manufacturing_location: { type: DataTypes.STRING(255), allowNull: true },
    equipment_vessel: { type: DataTypes.STRING(255), allowNull: true },
    storage_conditions: { type: DataTypes.TEXT, allowNull: true },
    approved_claims: { type: DataTypes.TEXT, allowNull: true },
    // Finished product specs (can also be on BOM)
    ph_range: { type: DataTypes.STRING(50), allowNull: true },
    viscosity_range: { type: DataTypes.STRING(100), allowNull: true },
    spf_pa_rating: { type: DataTypes.STRING(50), allowNull: true },
    appearance: { type: DataTypes.STRING(255), allowNull: true },
    odour: { type: DataTypes.STRING(255), allowNull: true },
    fill_weight_spec: { type: DataTypes.STRING(100), allowNull: true },
    stability_summary: { type: DataTypes.TEXT, allowNull: true },

    /** PR master: `temporary` (TPR… internal codes) vs `permanent` (PR…). Null = legacy rows before this field. */
    pr_record_type: { type: DataTypes.STRING(20), allowNull: true },

    /** Zoho Books API item.item_id after POST /items sync */
    zoho_item_id: { type: DataTypes.STRING(64), allowNull: true },

    approval_assigned_user_id: { type: DataTypes.INTEGER, allowNull: true },
    approval_assigned_display_name: { type: DataTypes.STRING(255), allowNull: true },
    approval_stage_assignees: { type: DataTypes.JSON, allowNull: true },
  },
  {
    sequelize: db,
    modelName: "Product",
    tableName: "products",   // adjust if table name differs
    timestamps: false,       // because you already store created_at manually
  }
);


// class Category extends Model {}
// Category.init({
//     id: {
//         type: DataTypes.INTEGER,
//         primaryKey: true,
//         autoIncrement: true
//     },
//     name: {
//         type: DataTypes.STRING,
//         allowNull: false,
//         unique: true
//     }
// }, {
//     sequelize: db,
//     modelName: 'category',
//     paranoid: true, // Soft delete
// });

// Product.belongsTo(Category);
// Category.hasMany(Product);

module.exports = { Product };