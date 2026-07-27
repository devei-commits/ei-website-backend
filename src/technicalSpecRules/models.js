/**
 * Technical Spec Rules — category / sub-category level TECHNICAL-spec (custom field) templates
 * for RM / PM / PR masters. These are the "TECH" module custom fields (Bulk density, CAS no,
 * dimensions, …) defined centrally per category so items of that category pull them live,
 * mirroring how Quality Spec Rules work (see ../qualitySpecRules/models.js).
 *
 * Rows here are MasterCustomFieldDef-shaped objects: { id, label, type, required?, options?, unit? }.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class TechnicalSpecRule extends Model {}

TechnicalSpecRule.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    /** 'RM' | 'PM' | 'PR' — technical specs are per material/product, not per PR clearance stage. */
    entity_type: { type: DataTypes.STRING(20), allowNull: false },
    category: { type: DataTypes.STRING(150), allowNull: false },
    /** '' = category-level rule (applies to every sub-category unless a more specific rule exists). */
    sub_category: { type: DataTypes.STRING(150), allowNull: false, defaultValue: '' },
    /** '' = no further refinement below sub_category. Requires sub_category to be set too. */
    sub_sub_category: { type: DataTypes.STRING(150), allowNull: false, defaultValue: '' },
    /** Array of MasterCustomFieldDef-shaped objects (id, label, type, required, options, unit). */
    rows: { type: DataTypes.JSON, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'TechnicalSpecRule',
    tableName: 'technical_spec_rules',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['entity_type', 'category', 'sub_category', 'sub_sub_category'],
        name: 'technical_spec_rules_scope_uniq',
      },
    ],
  }
);

module.exports = TechnicalSpecRule;
