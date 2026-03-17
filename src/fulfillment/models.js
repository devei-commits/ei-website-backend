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
        isIn: [['planned', 'in_production', 'partial', 'fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed']],
      },
    },
    so_value: { type: DataTypes.DECIMAL(14, 2), allowNull: true, defaultValue: 0 },
    ship_address: { type: DataTypes.TEXT, allowNull: true },
    payment_terms: { type: DataTypes.STRING(50), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    invoice_no: { type: DataTypes.STRING(100), allowNull: true },
    invoice_date: { type: DataTypes.DATEONLY, allowNull: true },
    awb_no: { type: DataTypes.STRING(100), allowNull: true },
    dispatch_date: { type: DataTypes.DATEONLY, allowNull: true },
    courier: { type: DataTypes.STRING(200), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
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
    product_name: { type: DataTypes.STRING(300), allowNull: false },
    pack: { type: DataTypes.STRING(100), allowNull: true },
    ordered_qty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rate: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    unit_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
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
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
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
    quantity_reserved: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
    unit: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'KG' },
    so_no: { type: DataTypes.STRING(50), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
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

module.exports = { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, Transporter, FulfillmentInvoice, ReservedBatchItem };
