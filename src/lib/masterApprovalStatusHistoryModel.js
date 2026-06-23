const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class MasterApprovalStatusHistory extends Model {}

MasterApprovalStatusHistory.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    master_kind: { type: DataTypes.STRING(4), allowNull: false },
    master_id: { type: DataTypes.INTEGER, allowNull: false },
    master_code: { type: DataTypes.STRING(120), allowNull: true },
    from_status: { type: DataTypes.STRING(64), allowNull: true },
    to_status: { type: DataTypes.STRING(64), allowNull: false },
    changed_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    changed_by_display_name: { type: DataTypes.STRING(255), allowNull: true },
    source: { type: DataTypes.STRING(64), allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize: db,
    modelName: 'MasterApprovalStatusHistory',
    tableName: 'master_approval_status_history',
    timestamps: false,
  }
);

module.exports = MasterApprovalStatusHistory;
