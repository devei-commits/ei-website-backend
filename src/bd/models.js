/**
 * BD Management — owned models (Phase 1).
 *
 * BD does NOT own a client master — it reuses the existing VendorClient
 * (type='client'). These two tables enrich/annotate that master:
 *   - bd_client_profiles : BD-specific enrichment (tier, lifecycle, POC, etc.)
 *   - bd_events          : the History & Comments timeline store (§3B)
 *
 * NEW tables — db.sync({ alter: true }) (app.js) auto-creates them on boot.
 * Associations to VendorClient are declared here so this module stays
 * self-contained (no edits to src/models/index.js), mirroring src/clientHub.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const VendorClient = require('../vendorClient/models');

/* ── bd_client_profiles ──────────────────────────────────────────────────── */
class BdClientProfile extends Model {}
BdClientProfile.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: {
      type: DataTypes.INTEGER, allowNull: false, unique: true,
      references: { model: VendorClient, key: 'id' },
    },
    // Manual overrides — when null, the value is DERIVED from revenue / activity.
    tier: { type: DataTypes.STRING(20), allowNull: true },               // platinum|gold|silver|bronze
    tier_source: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'auto' }, // auto|manual
    bd_lifecycle: { type: DataTypes.STRING(20), allowNull: true },       // prospect|active|dormant|churn
    lifecycle_source: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'auto' },
    bd_poc_id: { type: DataTypes.INTEGER, allowNull: true },             // users.userid
    onboarded_date: { type: DataTypes.DATEONLY, allowNull: true },
    credit_limit: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    agreement_name: { type: DataTypes.STRING(255), allowNull: true },
    agreement_expires_on: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db, modelName: 'BdClientProfile', tableName: 'bd_client_profiles',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
  },
);

/* ── bd_events (History & Comments timeline) ─────────────────────────────── */
class BdEvent extends Model {}
BdEvent.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: {
      type: DataTypes.INTEGER, allowNull: false,
      references: { model: VendorClient, key: 'id' },
    },
    type: { type: DataTypes.STRING(40), allowNull: false },     // see constants/bd BdEventType
    title: { type: DataTypes.STRING(500), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: true },
    ref_type: { type: DataTypes.STRING(40), allowNull: true },  // Order|PIS|Meeting|Query|Grievance|...
    ref_id: { type: DataTypes.STRING(100), allowNull: true },
    actor_id: { type: DataTypes.INTEGER, allowNull: true },      // users.userid
    actor_name: { type: DataTypes.STRING(255), allowNull: true },
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' }, // auto|manual
    occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db, modelName: 'BdEvent', tableName: 'bd_events',
    timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
  },
);

/* ── shared audit / soft-delete columns (Phase 2 transaction tables) ─────── */
const auditCols = () => ({
  created_at: { type: DataTypes.DATE, allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
  deleted_at: { type: DataTypes.DATE, allowNull: true },
  lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
});
const txnOpts = (modelName, tableName) => ({
  sequelize: db, modelName, tableName,
  timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
});

/* ── bd_meetings (§3H) ───────────────────────────────────────────────────── */
class BdMeeting extends Model {}
BdMeeting.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    code: { type: DataTypes.STRING(30), allowNull: true },                 // MTG-YYYY-NNNN
    origin: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ei' },   // customer|ei
    requested_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    scheduled_for: { type: DataTypes.DATE, allowNull: true },
    old_scheduled_for: { type: DataTypes.DATE, allowNull: true },          // preserved on reschedule
    mode: { type: DataTypes.STRING(60), allowNull: true },
    type: { type: DataTypes.STRING(60), allowNull: true },
    assignee_id: { type: DataTypes.INTEGER, allowNull: true },             // users.userid (null = Open)
    assignee_name: { type: DataTypes.STRING(255), allowNull: true },
    attendees: { type: DataTypes.JSONB, allowNull: true },                 // [{name,role}]
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'requested' },
    agenda: { type: DataTypes.TEXT, allowNull: true },
    mom: { type: DataTypes.TEXT, allowNull: true },                        // minutes of meeting
    action_items: { type: DataTypes.JSONB, allowNull: true },             // [{text,owner,due}]
    next_meeting_at: { type: DataTypes.DATE, allowNull: true },
    attended_at: { type: DataTypes.DATE, allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    cancel_reason: { type: DataTypes.STRING(500), allowNull: true },
    related_type: { type: DataTypes.STRING(40), allowNull: true },
    related_ref: { type: DataTypes.STRING(100), allowNull: true },
    ...auditCols(),
  },
  txnOpts('BdMeeting', 'bd_meetings'),
);

/* ── bd_queries (§3F) ────────────────────────────────────────────────────── */
class BdQuery extends Model {}
BdQuery.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    code: { type: DataTypes.STRING(30), allowNull: true },                 // QRY-YYYY-NNNN
    origin: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'customer' }, // customer|ei
    related_type: { type: DataTypes.STRING(40), allowNull: true },         // Order|PIS|Invoice|SO|Product|Sample|Others
    related_ref: { type: DataTypes.STRING(100), allowNull: true },
    related_info: { type: DataTypes.STRING(500), allowNull: true },        // cached headline of linked entity
    subject: { type: DataTypes.STRING(500), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: false },
    assignee_id: { type: DataTypes.INTEGER, allowNull: true },
    assignee_name: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'open' },
    escalated_dept: { type: DataTypes.STRING(120), allowNull: true },
    escalated_to_id: { type: DataTypes.INTEGER, allowNull: true },
    escalated_to_name: { type: DataTypes.STRING(255), allowNull: true },
    escalation_note: { type: DataTypes.TEXT, allowNull: true },
    internal_reply: { type: DataTypes.TEXT, allowNull: true },             // escalation handler's reply
    response: { type: DataTypes.TEXT, allowNull: true },                   // response to client
    source_channel: { type: DataTypes.STRING(60), allowNull: true },      // Email|WhatsApp|Phone|…
    sla_target_hours: { type: DataTypes.INTEGER, allowNull: true },
    responded_at: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    ...auditCols(),
  },
  txnOpts('BdQuery', 'bd_queries'),
);

/* ── bd_grievances (§3G) — Query shape + severity/category/root-cause/CAPA ── */
class BdGrievance extends Model {}
BdGrievance.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    code: { type: DataTypes.STRING(30), allowNull: true },                 // GRV-YYYY-NNNN
    origin: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'customer' },
    related_type: { type: DataTypes.STRING(40), allowNull: true },
    related_ref: { type: DataTypes.STRING(100), allowNull: true },
    related_info: { type: DataTypes.STRING(500), allowNull: true },
    severity: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'medium' }, // low|medium|high|critical
    category: { type: DataTypes.STRING(120), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: false },
    assignee_id: { type: DataTypes.INTEGER, allowNull: true },
    assignee_name: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'open' },
    escalated_dept: { type: DataTypes.STRING(120), allowNull: true },
    escalated_to_id: { type: DataTypes.INTEGER, allowNull: true },
    escalated_to_name: { type: DataTypes.STRING(255), allowNull: true },
    escalation_note: { type: DataTypes.TEXT, allowNull: true },
    internal_reply: { type: DataTypes.TEXT, allowNull: true },
    root_cause: { type: DataTypes.TEXT, allowNull: true },                 // mandatory before RESOLVED
    corrective_action: { type: DataTypes.TEXT, allowNull: true },          // CAPA
    customer_confirmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    response: { type: DataTypes.TEXT, allowNull: true },
    source_channel: { type: DataTypes.STRING(60), allowNull: true },
    sla_target_hours: { type: DataTypes.INTEGER, allowNull: true },
    responded_at: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    ...auditCols(),
  },
  txnOpts('BdGrievance', 'bd_grievances'),
);

/* ── associations (additive; declared here, no master-file edits) ────────── */
VendorClient.hasOne(BdClientProfile, { foreignKey: 'client_id', as: 'bdProfile' });
BdClientProfile.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });

VendorClient.hasMany(BdEvent, { foreignKey: 'client_id', as: 'bdEvents' });
BdEvent.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });

for (const [Mdl, as] of [[BdMeeting, 'bdMeetings'], [BdQuery, 'bdQueries'], [BdGrievance, 'bdGrievances']]) {
  VendorClient.hasMany(Mdl, { foreignKey: 'client_id', as });
  Mdl.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });
}

module.exports = { BdClientProfile, BdEvent, BdMeeting, BdQuery, BdGrievance };
