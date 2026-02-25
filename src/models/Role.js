/**
 * Role model. Maps to roles table (role_id, role_code, role_name, description, level, status).
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Role extends Model {}

Role.init(
  {
    role_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    role_code: { type: DataTypes.STRING(50), allowNull: false },
    role_name: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    level: { type: DataTypes.STRING(50), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'Role',
    tableName: 'roles',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Role;
