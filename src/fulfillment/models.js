const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

/* ── Fulfillment Orders ── */

class FulfillmentOrder extends Model {}

FulfillmentOrder.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    so_no: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    sales_order_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'sales_orders', key: 'id' },
      onDelete: 'SET NULL',
    },
    customer_name: { type: DataTypes.STRING(300), allowNull: false },
    customer_city: { type: DataTypes.STRING(200), allowNull: true },
    order_date: { type: DataTypes.DATEONLY, allowNull: true },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'normal' },
    so_status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'planned',
      validate: {
        isIn: [['planned', 'in_production', 'partial', 'fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed', 'cancelled']],
      },
    },
    /** True when so_status/commercial_status were set manually (cancel / manual-fulfill) and must NOT be recomputed from splits. */
    manual_status_override: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    so_value: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    ship_address: { type: DataTypes.TEXT, allowNull: true },
    /** Staged JSON (Items List shape) or legacy short text; VARCHAR widened for compact JSON. */
    payment_terms: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    /** Set when invoice is created via PATCH /invoice (no fulfillment_invoices row) */
    zoho_invoice_id: { type: DataTypes.STRING(64), allowNull: true },
    invoice_no: { type: DataTypes.STRING(100), allowNull: true },
    invoice_date: { type: DataTypes.DATEONLY, allowNull: true },
    awb_no: { type: DataTypes.STRING(100), allowNull: true },
    dispatch_date: { type: DataTypes.DATEONLY, allowNull: true },
    courier: { type: DataTypes.STRING(200), allowNull: true },
    /**
     * Commercial/business lifecycle status (separate from execution so_status).
     * Tracks the SO through approval + payment stages before production kicks off,
     * then auto-advances to partial_closed / closed based on shipped qty.
     * Values: draft | received | advance_pending | under_review | approved | partial_closed | closed | on_hold
     */
    commercial_status: {
      type: DataTypes.STRING(30),
      allowNull: true,
      defaultValue: 'received',
      validate: {
        isIn: [['draft', 'received', 'advance_pending', 'under_review', 'approved', 'partial_closed', 'closed', 'on_hold', 'cancelled']],
      },
    },
    /** Stores the commercial_status value to restore when leaving on_hold. */
    on_hold_previous_status: { type: DataTypes.STRING(30), allowNull: true },
    /** Full raw Excel import row(s) — every source column preserved verbatim: { header:{}, lines:[{}] }. */
    raw_import: { type: DataTypes.JSON, allowNull: true },
    /** FK to vendor_clients.id — stored for efficient dashboard grouping by client. */
    vendor_client_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'FulfillmentOrder',
    tableName: 'fulfillment_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Fulfillment Order Items ── */

class FulfillmentOrderItem extends Model {}

FulfillmentOrderItem.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    fulfillment_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'fulfillment_orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    item_no: { type: DataTypes.STRING(20), allowNull: true },
    sku: { type: DataTypes.STRING(50), allowNull: true },
    /** Cached from products.product_code at SO creation for fast dashboard joins. */
    product_code: { type: DataTypes.STRING(50), allowNull: true },
    product_name: { type: DataTypes.STRING(300), allowNull: false },
    pack: { type: DataTypes.STRING(100), allowNull: true },
    ordered_qty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rate: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    unit_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'FulfillmentOrderItem',
    tableName: 'fulfillment_order_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Fulfillment Batch Splits ── */

class FulfillmentBatchSplit extends Model {}

FulfillmentBatchSplit.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    fulfillment_order_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'fulfillment_order_items', key: 'id' },
      onDelete: 'CASCADE',
    },
    fulfillment_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'fulfillment_orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    production_batch_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'production_batches', key: 'id' },
      onDelete: 'SET NULL',
    },
    bmr_no: { type: DataTypes.STRING(50), allowNull: true },
    bpr_no: { type: DataTypes.STRING(50), allowNull: true },
    planned_qty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    fg_qty: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    fg_location: { type: DataTypes.STRING(50), allowNull: true },
    ff_status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'fg_pending',
      validate: {
        isIn: [['wip', 'fg_pending', 'bulk_qc', 'fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed']],
      },
    },
    picked_qty: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    picker_name: { type: DataTypes.STRING(200), allowNull: true },
    pick_date: { type: DataTypes.DATEONLY, allowNull: true },
    pick_slip_no: { type: DataTypes.STRING(50), allowNull: true },
    remarks: { type: DataTypes.TEXT, allowNull: true },
    invoice_no: { type: DataTypes.STRING(100), allowNull: true },
    awb_no: { type: DataTypes.STRING(100), allowNull: true },
    courier: { type: DataTypes.STRING(200), allowNull: true },
    dispatch_date: { type: DataTypes.DATEONLY, allowNull: true },
    eta_date: { type: DataTypes.DATEONLY, allowNull: true },
    delivery_date: { type: DataTypes.DATEONLY, allowNull: true },
    received_by: { type: DataTypes.STRING(200), allowNull: true },
    delivery_remarks: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'FulfillmentBatchSplit',
    tableName: 'fulfillment_batch_splits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Transporters ── */

class Transporter extends Model {}

Transporter.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    code: { type: DataTypes.STRING(50), allowNull: true, unique: true },
    contact_phone: { type: DataTypes.STRING(50), allowNull: true },
    contact_email: { type: DataTypes.STRING(255), allowNull: true },
    tracking_url: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'Transporter',
    tableName: 'transporters',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Fulfillment Invoices ── */

class FulfillmentInvoice extends Model {}

FulfillmentInvoice.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    invoice_no: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    fulfillment_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'fulfillment_orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    invoice_date: { type: DataTypes.DATEONLY, allowNull: true },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    prepared_by: { type: DataTypes.STRING(200), allowNull: true },
    transporter_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'transporters', key: 'id' },
      onDelete: 'SET NULL',
    },
    transporter_name: { type: DataTypes.STRING(200), allowNull: true },
    lr_awb_no: { type: DataTypes.STRING(100), allowNull: true },
    remarks: { type: DataTypes.TEXT, allowNull: true },
    subtotal: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    gst_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 18 },
    total_value: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'draft' },
    line_items: { type: DataTypes.JSON, allowNull: true },
    /** Zoho Books invoice_id after POST /invoices */
    zoho_invoice_id: { type: DataTypes.STRING(64), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'FulfillmentInvoice',
    tableName: 'fulfillment_invoices',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Associations ── */

FulfillmentOrder.hasMany(FulfillmentOrderItem, { as: 'items', foreignKey: 'fulfillment_order_id' });
FulfillmentOrderItem.belongsTo(FulfillmentOrder, { as: 'fulfillmentOrder', foreignKey: 'fulfillment_order_id' });

FulfillmentOrderItem.hasMany(FulfillmentBatchSplit, { as: 'batchSplits', foreignKey: 'fulfillment_order_item_id' });
FulfillmentBatchSplit.belongsTo(FulfillmentOrderItem, { as: 'orderItem', foreignKey: 'fulfillment_order_item_id' });

FulfillmentOrder.hasMany(FulfillmentBatchSplit, { as: 'allSplits', foreignKey: 'fulfillment_order_id' });
FulfillmentBatchSplit.belongsTo(FulfillmentOrder, { as: 'fulfillmentOrder', foreignKey: 'fulfillment_order_id' });

FulfillmentOrder.hasMany(FulfillmentInvoice, { as: 'invoices', foreignKey: 'fulfillment_order_id' });
FulfillmentInvoice.belongsTo(FulfillmentOrder, { as: 'fulfillmentOrder', foreignKey: 'fulfillment_order_id' });
FulfillmentInvoice.belongsTo(Transporter, { as: 'transporter', foreignKey: 'transporter_id' });

/* ── Reserved Batch Items (RM/PM reserved for SO/batch) ── */

class ReservedBatchItem extends Model {}

ReservedBatchItem.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    production_batch_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'production_batches', key: 'id' },
      onDelete: 'CASCADE',
    },
    fulfillment_order_item_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'fulfillment_order_items', key: 'id' },
      onDelete: 'CASCADE',
    },
    planning_extracted_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'planning_extracted', key: 'id' },
      onDelete: 'CASCADE',
    },
    raw_material_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'raw_materials', key: 'id' },
      onDelete: 'CASCADE',
    },
    pack_material_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'pack_materials', key: 'id' },
      onDelete: 'CASCADE',
    },
    quantity_reserved: { type: DataTypes.DECIMAL(28, 16), allowNull: false, defaultValue: 0 },
    unit: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'KG' },
    so_no: { type: DataTypes.STRING(50), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'ReservedBatchItem',
    tableName: 'reserved_batch_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Batch Stage Log ── */

class BatchStageLog extends Model {}

BatchStageLog.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    fulfillment_batch_split_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'fulfillment_batch_splits', key: 'id' },
      onDelete: 'CASCADE',
    },
    fulfillment_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'fulfillment_orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    stage: {
      type: DataTypes.STRING(30),
      allowNull: false,
      validate: { isIn: [['picking', 'invoiced', 'shipped', 'delivered']] },
    },
    started_at: { type: DataTypes.DATE, allowNull: false },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    actor_name: { type: DataTypes.STRING(200), allowNull: true },
    actor_user_id: { type: DataTypes.INTEGER, allowNull: true },
    /** Committed duration in business days (from sla_templates at stage start). */
    committed_days: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'BatchStageLog',
    tableName: 'fulfillment_batch_stage_logs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Fulfillment Comments ── */

class FulfillmentComment extends Model {}

FulfillmentComment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** 'so' or 'batch' */
    entity_type: { type: DataTypes.STRING(10), allowNull: false },
    /** ID of the SO (fulfillment_orders.id) or batch split (fulfillment_batch_splits.id). */
    entity_id: { type: DataTypes.INTEGER, allowNull: false },
    by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    by_user_name: { type: DataTypes.STRING(200), allowNull: true },
    text: { type: DataTypes.TEXT, allowNull: false },
    /** Array of { id, name } user objects tagged in this comment. */
    tagged_users: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    /** Array of { name, url } attachment references. */
    attachments: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    resolved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'FulfillmentComment',
    tableName: 'fulfillment_comments',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── SLA Templates ── */

class FulfillmentSlaTemplate extends Model {}

FulfillmentSlaTemplate.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** NULL = global default; set = product-specific override. */
    product_id: { type: DataTypes.INTEGER, allowNull: true },
    stage: {
      type: DataTypes.STRING(30),
      allowNull: false,
      validate: { isIn: [['picking', 'invoiced', 'shipped', 'delivered']] },
    },
    /** Committed duration in business days. */
    committed_days: { type: DataTypes.DECIMAL(5, 1), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'FulfillmentSlaTemplate',
    tableName: 'fulfillment_sla_templates',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── New Associations ── */

FulfillmentBatchSplit.hasMany(BatchStageLog, { as: 'stageLogs', foreignKey: 'fulfillment_batch_split_id' });
BatchStageLog.belongsTo(FulfillmentBatchSplit, { as: 'batchSplit', foreignKey: 'fulfillment_batch_split_id' });

module.exports = {
  FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit,
  Transporter, FulfillmentInvoice, ReservedBatchItem,
  BatchStageLog, FulfillmentComment, FulfillmentSlaTemplate,
};
