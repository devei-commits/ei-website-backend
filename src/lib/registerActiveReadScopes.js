/**
 * Default read scope: only rows with lifecycle_status = 'active' and deleted_at IS NULL.
 * Applied to every Sequelize model that uses archive lifecycle (defaultValue: 'active').
 * Products are special: lifecycle_status holds registration state; filter excludes 'deleted' only.
 */
const { activeRowWhere, productActiveWhere } = require('./softDelete');

/**
 * @param {import('sequelize').Sequelize} sequelize
 */
function registerActiveReadScopes(sequelize) {
  if (!sequelize?.models) return;

  for (const Model of Object.values(sequelize.models)) {
    const lcAttr = Model.rawAttributes?.lifecycle_status;
    const hasDeletedAt = Boolean(Model.rawAttributes?.deleted_at);
    if (!lcAttr || !hasDeletedAt) continue;

    if (Model.tableName === 'products') {
      Model.addScope('defaultScope', { where: productActiveWhere() }, { override: true });
      continue;
    }

    if (lcAttr.defaultValue === 'active') {
      Model.addScope('defaultScope', { where: activeRowWhere() }, { override: true });
    }
  }
}

module.exports = { registerActiveReadScopes };
