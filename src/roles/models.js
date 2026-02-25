const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Role extends Model {}
Role.init({
  role_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  role_code: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
  },
  role_name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  level: {
    type: DataTypes.ENUM('admin', 'manager', 'staff', 'client'),
    allowNull: false,
    defaultValue: 'staff',
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    allowNull: false,
    defaultValue: 'active',
  },
  permissions_json: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Dashboard module/submodule permissions (option A)',
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  sequelize: db,
  modelName: 'Role',
  tableName: 'roles',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

class StaffProfile extends Model {}
StaffProfile.init({
  user_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
  },
  role_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  department: {
    type: DataTypes.ENUM('sales', 'rnd', 'quality_assurance', 'logistics', 'marketing', 'finance'),
    allowNull: true,
  },
  dep_level: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  sequelize: db,
  modelName: 'StaffProfile',
  tableName: 'staff_profiles',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

class Permission extends Model {}
Permission.init({
  permission_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  resource: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  action: {
    type: DataTypes.ENUM('view', 'create', 'edit', 'delete'),
    allowNull: false,
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  sequelize: db,
  modelName: 'Permission',
  tableName: 'permissions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

class RolePermission extends Model {}
RolePermission.init({
  role_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
  },
  permission_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
  },
}, {
  sequelize: db,
  modelName: 'RolePermission',
  tableName: 'role_permissions',
  timestamps: false,
});

module.exports = { Role, StaffProfile, Permission, RolePermission };
