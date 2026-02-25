/**
 * Stores the full module-definition tree (modules + globalSettings) as JSON.
 * One row for the system; used to serve GET /roles/module-definitions filtered by user role.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class ModuleDefinition extends Model {}

ModuleDefinition.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'default' },
    definition_json: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: 'Full { modules: ModulePermission[], globalSettings: GlobalSettings }',
    },
  },
  {
    sequelize: db,
    modelName: 'ModuleDefinition',
    tableName: 'module_definitions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = ModuleDefinition;
