/**
 * Junction model for role_permissions (role_id, permission_id).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class RolePermission extends Model {}

RolePermission.init(
  {
    role_id: { type: DataTypes.INTEGER, primaryKey: true,
      references: { model: 'roles', key: 'role_id' },
    },
    permission_id: { type: DataTypes.INTEGER, primaryKey: true,
      references: { model: 'permissions', key: 'permission_id' },
    },
  },
  {
    sequelize: db,
    modelName: 'RolePermission',
    tableName: 'role_permissions',
    timestamps: false,
  }
);

module.exports = RolePermission;
