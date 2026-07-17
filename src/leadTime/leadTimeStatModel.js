/**
 * Lead-Time Stats cache (spec §10.4) — one row per (item, vendor) holding the avg ACTUAL lead time
 * computed from purchase history (PO issued → GRN completed). Recomputed on GRN posting and nightly;
 * consumers read from here for speed instead of scanning PO/GRN history live.
 *
 * Table auto-creates via db.sync({ alter: true }) on boot (app.js). `item_key` = `${item_type}:${itemId}:${vendor}`
 * carries the uniqueness (composite unique over nullable FK columns is unreliable in Postgres).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class LeadTimeStat extends Model {}

LeadTimeStat.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /** `${item_type}:${itemId}:${vendorKey}` — unique cache key. */
    item_key: { type: DataTypes.STRING(320), allowNull: false, unique: true },
    item_type: { type: DataTypes.STRING(4), allowNull: false }, // RM | PM
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true },
    /** Lower-cased vendor name (PO.vendor_name). */
    vendor_name: { type: DataTypes.STRING(300), allowNull: true },
    /** Winsorized mean of actual lead days; null when history is too thin (source limited/no-history). */
    avg_actual_days: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    p50: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    p90: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    /** % change of mean(last 3) vs mean(prior 3). */
    trend_pct: { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: 0 },
    /** true when trend_pct > +20% (spec §10.2 ↑ amber). */
    trend_up: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    sample_size: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    /** history | history-12m | limited | no-history */
    source: { type: DataTypes.STRING(20), allowNull: true },
    computed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'LeadTimeStat',
    tableName: 'lead_time_stats',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['item_key'] }],
  }
);

module.exports = LeadTimeStat;
