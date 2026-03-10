/**
 * Material / Stock Request Note (MRN) — manufacturing requests items from warehouse.
 * Line items reference raw_materials, pack_materials, or products.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class MaterialRequestNote extends Model {}

MaterialRequestNote.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    mrn_no: { type: DataTypes.STRING(100), allowNull: false },
    requested_by: { type: DataTypes.STRING(200), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'Pending' },
    assigned_picker: { type: DataTypes.STRING(200), allowNull: true },
    transfer_team: { type: DataTypes.STRING(200), allowNull: true },
    line_items: { type: DataTypes.JSON, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    bmr_no: { type: DataTypes.STRING(50), allowNull: true },
    source: { type: DataTypes.STRING(20), allowNull: true },
    /** true = transfer from MU to Warehouse (inbound-from-MU); false/null = outbound (WH→MU). */
    is_inbound_from_mu: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'MaterialRequestNote',
    tableName: 'material_request_notes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = MaterialRequestNote;
