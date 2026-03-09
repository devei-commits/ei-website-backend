/**
 * Warehouse Locations & Rack Management.
 * warehouse_locations: zones (RM Store, Actives Store, etc.).
 * warehouse_racks: racks/bays per location (code, levels, slots).
 * warehouse_rack_items: junction — which warehouse_inventory items are stored in which rack.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class WarehouseLocation extends Model {}

WarehouseLocation.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    area_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'facility_areas', key: 'id' },
      onDelete: 'SET NULL',
    },
    code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    location_type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'warehouse' },
    zone_label: { type: DataTypes.STRING(50), allowNull: true },
    icon: { type: DataTypes.STRING(20), allowNull: true },
    area_sqm: { type: DataTypes.INTEGER, allowNull: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    utilisation_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'WarehouseLocation',
    tableName: 'warehouse_locations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

class WarehouseRack extends Model {}

WarehouseRack.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    location_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'warehouse_locations', key: 'id' },
      onDelete: 'CASCADE',
    },
    code: { type: DataTypes.STRING(50), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: true },
    description: { type: DataTypes.STRING(300), allowNull: true },
    levels: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 4 },
    slots_total: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 16 },
    utilisation_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'WarehouseRack',
    tableName: 'warehouse_racks',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

class WarehouseRackItem extends Model {}

WarehouseRackItem.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    rack_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'warehouse_racks', key: 'id' },
      onDelete: 'CASCADE',
    },
    warehouse_inventory_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'warehouse_inventory', key: 'id' },
      onDelete: 'CASCADE',
    },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'WarehouseRackItem',
    tableName: 'warehouse_rack_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

WarehouseLocation.hasMany(WarehouseRack, { foreignKey: 'location_id' });
WarehouseRack.belongsTo(WarehouseLocation, { foreignKey: 'location_id' });
WarehouseRack.hasMany(WarehouseRackItem, { foreignKey: 'rack_id' });
WarehouseRackItem.belongsTo(WarehouseRack, { foreignKey: 'rack_id' });

module.exports = { WarehouseLocation, WarehouseRack, WarehouseRackItem };
