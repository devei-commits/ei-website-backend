/**
 * Quotation engine models. All tables auto-create via `db.sync({ alter: true })`
 * on boot (see app.js). Baseline rows are seeded idempotently by
 * seedQuotationDefaults.js.
 *
 * Soft-delete vs hard-delete decision:
 *   - quote_grades / saved_quotes carry lifecycle_status + deleted_at so the
 *     global registerActiveReadScopes() auto-excludes deleted rows.
 *   - Config tables with composite UNIQUE constraints (overheads, timeline
 *     rules) use HARD delete — a soft-deleted row would otherwise block
 *     re-creating the same (category, head) / (type, subtype, band) key.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

// ─────────────────────────────────────────────────────────────
// quote_grades — grade profiles (system 1/2/3 + admin custom)
// ─────────────────────────────────────────────────────────────
class QuoteGrade extends Model {}
QuoteGrade.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    /** 7 display labels e.g. ["500","1,000",...] */
    moq_labels: { type: DataTypes.JSON, allowNull: false },
    /** 7 numeric MOQ values e.g. [500,1000,...] */
    moq_values: { type: DataTypes.JSON, allowNull: false },
    /** 7 markup-on-cost fractions e.g. [0.70,0.65,...] */
    markups: { type: DataTypes.JSON, allowNull: false },
    /** When true PM cost is forced to zero (customer-supplied packaging). */
    zero_pm: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** 7 conversion-band entries: [{b:'1-1000', f:1.05}, ...] */
    bmap: { type: DataTypes.JSON, allowNull: false },
    /** Optional QC-days override for this grade (else quote_qc_rules is used). */
    qc_days: { type: DataTypes.INTEGER, allowNull: true },
    /** System grades (1/2/3) cannot be edited or deleted. */
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** Stable key used by quote_qc_rules / quote_dispatch_config lookups. */
    grade_ref: { type: DataTypes.STRING(50), allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db, modelName: 'QuoteGrade', tableName: 'quote_grades',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'quote_grades_grade_ref_uniq', fields: ['grade_ref'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_overheads — overhead heads × product category × 7 MOQ bands
// ─────────────────────────────────────────────────────────────
class QuoteOverhead extends Model {}
QuoteOverhead.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** 'all' | 'serum' | 'emulsion' | 'wash' | 'gel' | 'general' */
    product_category: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'all' },
    head_name: { type: DataTypes.STRING(100), allowNull: false },
    /** 7 ₹/unit values aligned to base MOQ scale [500..25000]. */
    band_values: { type: DataTypes.JSON, allowNull: false },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteOverhead', tableName: 'quote_overheads',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'quote_overhead_cat_head_uniq', fields: ['product_category', 'head_name'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_procurement_rules — RM category / PM material → lead days
// ─────────────────────────────────────────────────────────────
class QuoteProcurementRule extends Model {}
QuoteProcurementRule.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** 'RM' | 'PM' */
    material_type: { type: DataTypes.STRING(5), allowNull: false },
    /** RM category or PM material value; 'DEFAULT' is the fallback row. */
    category_or_material: { type: DataTypes.STRING(100), allowNull: false },
    individual_lead_days: { type: DataTypes.INTEGER, allowNull: false },
    /** Bulk/batch lead; null → same as individual. */
    batch_lead_days: { type: DataTypes.INTEGER, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteProcurementRule', tableName: 'quote_procurement_rules',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'quote_proc_type_key_uniq', fields: ['material_type', 'category_or_material'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_manufacturing_rules — product type × subtype × band → days
// ─────────────────────────────────────────────────────────────
class QuoteManufacturingRule extends Model {}
QuoteManufacturingRule.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** 'serum' | 'emulsion' | 'wash' | 'gel' | 'general' */
    product_type: { type: DataTypes.STRING(50), allowNull: false },
    /** '' = base rule for the type (NOT null — keeps composite UNIQUE effective). */
    product_subtype: { type: DataTypes.STRING(100), allowNull: false, defaultValue: '' },
    band_index: { type: DataTypes.INTEGER, allowNull: false },
    manufacturing_days: { type: DataTypes.INTEGER, allowNull: false },
    /** Total production cycle; null → equals manufacturing_days. */
    cycle_time_days: { type: DataTypes.INTEGER, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteManufacturingRule', tableName: 'quote_manufacturing_rules',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'quote_mfg_type_subtype_band_uniq', fields: ['product_type', 'product_subtype', 'band_index'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_qc_rules — grade_ref → QC days
// ─────────────────────────────────────────────────────────────
class QuoteQcRule extends Model {}
QuoteQcRule.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** 'system_1'|'system_2'|'system_3'|custom grade_ref|'default' */
    grade_ref: { type: DataTypes.STRING(50), allowNull: false },
    qc_days: { type: DataTypes.INTEGER, allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteQcRule', tableName: 'quote_qc_rules',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'quote_qc_grade_ref_uniq', fields: ['grade_ref'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_dispatch_config — grade_ref → dispatch days ('default' global)
// ─────────────────────────────────────────────────────────────
class QuoteDispatchConfig extends Model {}
QuoteDispatchConfig.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    grade_ref: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'default' },
    dispatch_days: { type: DataTypes.INTEGER, allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteDispatchConfig', tableName: 'quote_dispatch_config',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'quote_dispatch_grade_ref_uniq', fields: ['grade_ref'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// saved_quotes — persisted computed quotes
// ─────────────────────────────────────────────────────────────
class SavedQuote extends Model {}
SavedQuote.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    quote_ref: { type: DataTypes.STRING(40), allowNull: false },
    quote_name: { type: DataTypes.TEXT, allowNull: true },
    customer_name: { type: DataTypes.TEXT, allowNull: true },
    bom_id: { type: DataTypes.INTEGER, allowNull: true },
    bom_code: { type: DataTypes.TEXT, allowNull: true },
    /** Grade id (quote_grades.id) used to compute this quote. */
    grade: { type: DataTypes.INTEGER, allowNull: true },
    /** 'db' | 'adhoc' */
    mode: { type: DataTypes.STRING(10), allowNull: true },
    /** Original /calculate request config. */
    payload: { type: DataTypes.JSON, allowNull: true },
    /** Full pricing + timeline output (all 7 bands). */
    result: { type: DataTypes.JSON, allowNull: true },
    /** Snapshot of the mid-band sell price for list display. */
    headline_sell: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    headline_moq: { type: DataTypes.TEXT, allowNull: true },
    /** Lifecycle: draft → pending_approval → approved → sent → accepted/rejected. */
    status: { type: DataTypes.STRING(30), allowNull: true, defaultValue: 'draft' },
    /** Transition log: [{from,to,by,by_name,note,at}]. */
    status_history: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    notes: { type: DataTypes.TEXT, allowNull: true },
    gst_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 18 },
    valid_until: { type: DataTypes.DATEONLY, allowNull: true },
    client_id: { type: DataTypes.INTEGER, allowNull: true },
    prepared_by: { type: DataTypes.TEXT, allowNull: true },
    /** Set when an accepted quote is converted to a sales order. */
    sales_order_id: { type: DataTypes.INTEGER, allowNull: true },
    sales_order_ref: { type: DataTypes.STRING(100), allowNull: true },
    /** Revision lineage: v1=1; root_quote_id points to v1; superseded_by = newer version id. */
    version: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
    root_quote_id: { type: DataTypes.INTEGER, allowNull: true },
    superseded_by: { type: DataTypes.INTEGER, allowNull: true },
    /** 'full' | 'rm_only' | 'pm_only' */
    quote_type: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'full' },
    /** 'pre_production' | 'post_production' */
    quote_category: { type: DataTypes.STRING(30), allowNull: true, defaultValue: 'pre_production' },
    /** Free-text job / production run reference */
    job_ref: { type: DataTypes.TEXT, allowNull: true },
    /** For post_production quotes: id of the linked pre_production quote */
    pre_quote_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db, modelName: 'SavedQuote', tableName: 'saved_quotes',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'saved_quotes_quote_ref_uniq', fields: ['quote_ref'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_conversion_rates — filling conversion cost table (₹/unit)
// replaces hardcoded BT/TB/SR tables in pricing.js
// packaging_type='CONFIG', moq_band='mono_discount' is the mono discount row
// ─────────────────────────────────────────────────────────────
class QuoteConversionRate extends Model {}
QuoteConversionRate.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    packaging_type: { type: DataTypes.STRING(50), allowNull: false },
    moq_band:       { type: DataTypes.STRING(20), allowNull: false },
    volume_key:     { type: DataTypes.STRING(10), allowNull: false },
    rate:           { type: DataTypes.DECIMAL(8, 2), allowNull: false },
  },
  {
    sequelize: db, modelName: 'QuoteConversionRate', tableName: 'quote_conversion_rates',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'qcr_pkg_band_vol_uniq', fields: ['packaging_type', 'moq_band', 'volume_key'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_category_rates — per-RM-category wastage rates
// ─────────────────────────────────────────────────────────────
class QuoteCategoryRate extends Model {}
QuoteCategoryRate.init(
  {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    category:    { type: DataTypes.STRING(100), allowNull: false },
    wastage_pct: { type: DataTypes.DECIMAL(5, 2), defaultValue: 3.0 },
    notes:       { type: DataTypes.TEXT, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteCategoryRate', tableName: 'quote_category_rates',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, name: 'qcat_category_uniq', fields: ['category'] }],
  }
);

// ─────────────────────────────────────────────────────────────
// quote_actuals — post-production actual cost entry.
// Linked to a post-production saved_quote (post_quote_id) and
// optionally to the pre-production estimate (pre_quote_id).
// est_* fields snapshot the estimated values at entry time.
// ─────────────────────────────────────────────────────────────
class QuoteActuals extends Model {}
QuoteActuals.init(
  {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bom_code:        { type: DataTypes.STRING(100), allowNull: false },
    job_ref:         { type: DataTypes.TEXT, allowNull: true },
    pre_quote_id:    { type: DataTypes.INTEGER, allowNull: true },
    post_quote_id:   { type: DataTypes.INTEGER, allowNull: true },
    batch_size:      { type: DataTypes.INTEGER, allowNull: true },
    yield_pct:       { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    actual_rm:       { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    actual_pm:       { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    actual_conversion: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    actual_overhead: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    actual_total:    { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    est_rm:          { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    est_pm:          { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    est_conversion:  { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    est_overhead:    { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    est_total:       { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    notes:           { type: DataTypes.TEXT, allowNull: true },
    entered_by:      { type: DataTypes.INTEGER, allowNull: true },
    entered_by_name: { type: DataTypes.STRING(255), allowNull: true },
    created_at:      { type: DataTypes.DATE, allowNull: true },
    updated_at:      { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db, modelName: 'QuoteActuals', tableName: 'quote_actuals',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
  }
);

// ─────────────────────────────────────────────────────────────
// quote_emails — append-only email send log (stub for now)
// ─────────────────────────────────────────────────────────────
class QuoteEmail extends Model {}
QuoteEmail.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    quote_ref: { type: DataTypes.TEXT, allowNull: true },
    to_email: { type: DataTypes.TEXT, allowNull: false },
    cc_email: { type: DataTypes.TEXT, allowNull: true },
    subject: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'sent' },
    error: { type: DataTypes.TEXT, allowNull: true },
    message_id: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize: db, modelName: 'QuoteEmail', tableName: 'quote_emails', timestamps: true, createdAt: 'created_at', updatedAt: false }
);

// ─────────────────────────────────────────────────────────────
// quote_audit_log — append-only log of config mutations
// ─────────────────────────────────────────────────────────────
class QuoteAuditLog extends Model {}
QuoteAuditLog.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    entity_type: { type: DataTypes.STRING(40), allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    action: { type: DataTypes.STRING(20), allowNull: false },
    summary: { type: DataTypes.TEXT, allowNull: true },
    changed_by: { type: DataTypes.INTEGER, allowNull: true },
    changed_by_name: { type: DataTypes.STRING(255), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize: db, modelName: 'QuoteAuditLog', tableName: 'quote_audit_log', timestamps: true, createdAt: 'created_at', updatedAt: false }
);

module.exports = {
  QuoteGrade,
  QuoteOverhead,
  QuoteAuditLog,
  QuoteConversionRate,
  QuoteCategoryRate,
  QuoteProcurementRule,
  QuoteManufacturingRule,
  QuoteQcRule,
  QuoteDispatchConfig,
  SavedQuote,
  QuoteActuals,
  QuoteEmail,
};
