/**
 * Permission model. Maps to permissions table (permission_id, resource, action).
 * resource can be moduleId (e.g. "dashboard") or full key (e.g. "dashboard.dashboard-overview.action.view").
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Permission extends Model { }

Permission.init(
  {
    permission_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    resource: { type: DataTypes.STRING(255), allowNull: false },
    action: { type: DataTypes.STRING(50), allowNull: false },
  },
  {
    sequelize: db,
    modelName: 'Permission',
    tableName: 'permissions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Permission;
