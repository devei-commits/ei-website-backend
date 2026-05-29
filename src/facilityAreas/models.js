const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { WarehouseLocation } = require('../warehouseLocations/models');

class FacilityArea extends Model {}

FacilityArea.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    area_type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'warehouse' },
    icon: { type: DataTypes.STRING(20), allowNull: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    zoho_location_id: { type: DataTypes.STRING(32), allowNull: true, unique: true },
    zoho_meta: { type: DataTypes.JSONB, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'FacilityArea',
    tableName: 'facility_areas',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

FacilityArea.hasMany(WarehouseLocation, { foreignKey: 'area_id', as: 'zones' });
WarehouseLocation.belongsTo(FacilityArea, { foreignKey: 'area_id', as: 'area' });

module.exports = FacilityArea;
