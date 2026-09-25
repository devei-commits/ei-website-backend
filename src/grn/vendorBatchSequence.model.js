/**
 * Single-row-per-prefix atomic counter backing system-generated Vendor Batch Nos
 * (format B126-#####) pre-filled per batch row in the GRN "Batch Details" step.
 *
 * See allocateNextVendorBatchNos in src/grn/controller.js for how this row is incremented
 * atomically.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class VendorBatchSequence extends Model {}

VendorBatchSequence.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    prefix: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    last_value: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'VendorBatchSequence',
    tableName: 'vendor_batch_sequences',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = VendorBatchSequence;
