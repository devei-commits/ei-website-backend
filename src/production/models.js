const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

/* ── Production Equipment ── */

class ProductionEquipment extends Model {}

ProductionEquipment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    equipment_id: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    category: { type: DataTypes.ENUM('manufacturing', 'filling', 'packaging'), allowNull: false },
    capacity: { type: DataTypes.INTEGER, allowNull: true },
    speed: { type: DataTypes.INTEGER, allowNull: true },
    type: { type: DataTypes.STRING(50), allowNull: false },
    homogenizer: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    process_types: { type: DataTypes.JSON, allowNull: true },
    compatible: { type: DataTypes.JSON, allowNull: true },
    supports: { type: DataTypes.JSON, allowNull: true },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'idle' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'ProductionEquipment',
    tableName: 'production_equipment',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

/* ── Production Batches (BMR / BPR) ── */

class ProductionBatch extends Model {}

ProductionBatch.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bmr_no: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    bpr_no: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    product_name: { type: DataTypes.STRING(300), allowNull: false },
    sku: { type: DataTypes.STRING(50), allowNull: false },
    so_no: { type: DataTypes.STRING(50), allowNull: true },
    order_qty: { type: DataTypes.INTEGER, allowNull: true },
    batch_size: { type: DataTypes.INTEGER, allowNull: true },
    batch_no: { type: DataTypes.STRING(20), allowNull: true },
    batch_index: { type: DataTypes.INTEGER, allowNull: true },
    total_batches: { type: DataTypes.INTEGER, allowNull: true },
    /** FK to planning_batches.id — batch-specific BOM copy (rm_lines, pm_lines) for this BMR. When set, BOM is always loaded from that row, not from product master. */
    planning_batch_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'planning_batches', key: 'id' },
      onDelete: 'SET NULL',
    },

    bmr_status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'draft',
      validate: { isIn: [['draft', 'batch_confirmed', 'rm_reserved', 'scheduled', 'rm_connected', 'dispensing', 'in_production', 'bulk_qc', 'qc_failed', 'cleared']] },
    },
    bpr_status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'draft',
      validate: { isIn: [['draft', 'pm_reserved', 'scheduled', 'pm_connected', 'pm_dispensing', 'filling', 'fill_qc', 'packaging', 'pack_qc', 'qc_failed', 'fg_ready']] },
    },
    color: { type: DataTypes.STRING(30), allowNull: true },
    process_type: { type: DataTypes.STRING(10), allowNull: true },
    homogenizer: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },

    main_vessel: { type: DataTypes.STRING(20), allowNull: true },
    supporting_tanks: { type: DataTypes.JSON, allowNull: true },
    filling_line: { type: DataTypes.STRING(20), allowNull: true },
    filling_type: { type: DataTypes.STRING(20), allowNull: true },
    packaging_line: { type: DataTypes.STRING(20), allowNull: true },
    monocarton: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    shrink: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },

    team_bmr: { type: DataTypes.JSON, allowNull: true },
    team_bpr: { type: DataTypes.JSON, allowNull: true },
    shift_lead_bmr: { type: DataTypes.STRING(20), allowNull: true },
    shift_lead_bpr: { type: DataTypes.STRING(20), allowNull: true },
    qc_officer_bmr: { type: DataTypes.STRING(20), allowNull: true },
    qc_officer_bpr: { type: DataTypes.STRING(20), allowNull: true },

    /** Manufacturing unit zone code (MTR receive) chosen at batch schedule — used by outbound MTR. */
    scheduled_mu_zone: { type: DataTypes.STRING(80), allowNull: true },
    /** Planning notes captured when scheduling (separate from batch remarks / QC). */
    schedule_remarks: { type: DataTypes.TEXT, allowNull: true },

    mfg_date: { type: DataTypes.DATEONLY, allowNull: true },
    fill_date: { type: DataTypes.DATEONLY, allowNull: true },
    pack_date: { type: DataTypes.DATEONLY, allowNull: true },
    fg_date: { type: DataTypes.DATEONLY, allowNull: true },
    rm_connect_date: { type: DataTypes.DATEONLY, allowNull: true },
    pm_connect_date: { type: DataTypes.DATEONLY, allowNull: true },

    rm_reserved: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    pm_reserved: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    rm_connected: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    pm_connected: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },

    dispensing_rm: { type: DataTypes.JSON, allowNull: true },
    dispensing_pm: { type: DataTypes.JSON, allowNull: true },

    /** Latest MU dispensing bundle id (from last PATCH that consumed RM/PM from ML1/ML2/WH). */
    mu_dispensing_bundle_id: { type: DataTypes.STRING(80), allowNull: true },
    /**
     * Audit trail: each entry { bundleId, at, procurementRequests: [{id, planningBatchId, status}], rm: [{code, qty}], pm: [{code, qty}] }
     * — RM + PM lines consumed in the same request share one bundleId; PRs = all procurement_requests for the plan (PE).
     */
    mu_dispensing_bundles: { type: DataTypes.JSON, allowNull: true },

    bulk_yield: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    fill_yield: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    fg_yield: { type: DataTypes.DECIMAL(12, 3), allowNull: true },

    bulk_batch_accepted: { type: DataTypes.BOOLEAN, allowNull: true },
    fill_batch_accepted: { type: DataTypes.BOOLEAN, allowNull: true },
    fg_batch_accepted: { type: DataTypes.BOOLEAN, allowNull: true },

    qc_specs: { type: DataTypes.JSON, allowNull: true },
    remarks: { type: DataTypes.TEXT, allowNull: true },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    /** Batch priority (LOW | MEDIUM | HIGH) — drives ordering in the Batches view. */
    priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MEDIUM' },
    /** Free-text need-by note shown to the Shift Lead (distinct from `remarks`, which also carries rework reasons). */
    need_by_note: { type: DataTypes.TEXT, allowNull: true },

    /** BMR/BPR document QA review (pending | approved) — gates Initiate Dispensing. Set via the quality-gated qa-approve endpoint. */
    bmr_qa_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    bmr_qa_approved_by: { type: DataTypes.STRING(120), allowNull: true },
    bmr_qa_reviewed_at: { type: DataTypes.DATE, allowNull: true },
    bpr_qa_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    bpr_qa_approved_by: { type: DataTypes.STRING(120), allowNull: true },
    bpr_qa_reviewed_at: { type: DataTypes.DATE, allowNull: true },

    /**
     * IPQA pre-production gate (checklist). Shape:
     * { verifications: { <key>: { status:'pass'|'fail', by, at } }, confirms: { <key>: { by, at } } }.
     * IPQA verifications gate "Start Production" (dispensing → in_production); production confirms are the
     * production lead's own pre-conditions. Missing key = pending.
     */
    pre_production_gate: { type: DataTypes.JSON, allowNull: true },

    compatible_vessels: { type: DataTypes.JSON, allowNull: true },
    compatible_fill_lines: { type: DataTypes.JSON, allowNull: true },
    compatible_pack_lines: { type: DataTypes.JSON, allowNull: true },

    /** Batch volume in liters (from BOM rm_lines: sum of quantity_kg/specific_gravity per RM). Used for vessel capacity checks. */
    required_volume_liters: { type: DataTypes.DECIMAL(10, 2), allowNull: true },

    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'ProductionBatch',
    tableName: 'production_batches',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = { ProductionEquipment, ProductionBatch };
