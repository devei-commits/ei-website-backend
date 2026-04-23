const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

/**
 * Per–line item default zone/rack for warehouse storage vs production (MU) putaway.
 * Exactly one of raw_material_id / pack_material_id / product_id is set (enforced in controller).
 */
class ItemDedicatedFacilityLocation extends Model {}

ItemDedicatedFacilityLocation.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    item_key: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    raw_material_id: { type: DataTypes.INTEGER, allowNull: true },
    pack_material_id: { type: DataTypes.INTEGER, allowNull: true },
    product_id: { type: DataTypes.INTEGER, allowNull: true },
    wh_location_id: { type: DataTypes.INTEGER, allowNull: true },
    wh_rack_id: { type: DataTypes.INTEGER, allowNull: true },
    prod_location_id: { type: DataTypes.INTEGER, allowNull: true },
    prod_rack_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'ItemDedicatedFacilityLocation',
    tableName: 'item_dedicated_facility_locations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = ItemDedicatedFacilityLocation;
