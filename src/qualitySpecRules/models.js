/**
 * Quality Spec Rules — category / sub-category level quality-spec templates for RM/PM/PR masters.
 * Items resolve their quality specs from here until a user edits an item's own quality specs
 * (see `quality_specs_locked` on raw_materials/pack_materials/boms) — at that point the item's
 * saved rows take over permanently and stop tracking rule changes.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class QualitySpecRule extends Model {}

QualitySpecRule.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    /** 'RM' | 'PM' | 'PR_BULK_CLEARANCE' | 'PR_FINAL_CLEARANCE' | 'PR_DISPATCH_SPECS' */
    entity_type: { type: DataTypes.STRING(20), allowNull: false },
    category: { type: DataTypes.STRING(150), allowNull: false },
    /** '' = category-level rule (applies to every sub-category unless a more specific rule exists). */
    sub_category: { type: DataTypes.STRING(150), allowNull: false, defaultValue: '' },
    /** '' = no further refinement below sub_category. Requires sub_category to be set too. */
    sub_sub_category: { type: DataTypes.STRING(150), allowNull: false, defaultValue: '' },
    /** Array of QualitySpecTableRow-shaped objects (parameter, specLimit, method, mandatory, ...). */
    rows: { type: DataTypes.JSON, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'QualitySpecRule',
    tableName: 'quality_spec_rules',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['entity_type', 'category', 'sub_category', 'sub_sub_category'],
        name: 'quality_spec_rules_scope_uniq',
      },
    ],
  }
);

module.exports = QualitySpecRule;
