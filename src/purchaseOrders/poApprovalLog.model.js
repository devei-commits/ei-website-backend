/**
 * PO Approval Log — append-only audit trail of every approval-stage transition
 * for a purchase order (submit / forward / approve / request-changes / reject).
 * Table auto-creates via db.sync({ alter: true }) on boot (app.js).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const PurchaseOrder = require('./models');

class PoApprovalLog extends Model {}

PoApprovalLog.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    purchase_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'purchase_orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    /** submit_review | forward | approve | request_changes | reject */
    action: { type: DataTypes.STRING(40), allowNull: false },
    from_status: { type: DataTypes.STRING(40), allowNull: true },
    to_status: { type: DataTypes.STRING(40), allowNull: true },
    /** Abstract role required for this step (matrix) at the time of the action. */
    required_role: { type: DataTypes.STRING(30), allowNull: true },
    po_type: { type: DataTypes.STRING(30), allowNull: true },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    actor_id: { type: DataTypes.INTEGER, allowNull: true },
    actor_name: { type: DataTypes.STRING(200), allowNull: true },
    /** Acting usertype (manager / admin / accounts_team ...). */
    actor_role: { type: DataTypes.STRING(50), allowNull: true },
    note: { type: DataTypes.STRING(1000), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'PoApprovalLog',
    tableName: 'po_approval_log',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

PoApprovalLog.belongsTo(PurchaseOrder, { foreignKey: 'purchase_order_id', as: 'purchaseOrder' });

module.exports = PoApprovalLog;
