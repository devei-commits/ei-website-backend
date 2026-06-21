/**
 * Systematic soft delete: DELETE APIs set deleted_at + lifecycle_status instead of hard DELETE.
 */
const { Op } = require('sequelize');
const { backendNow, stampForUpdate, stampLifecycleDeleted } = require('./backendTimestamps');

const LIFECYCLE_DELETED = 'deleted';
const LIFECYCLE_ACTIVE = 'active';

/**
 * @param {import('sequelize').Model} model
 */
function assertHasSoftDeleteColumns(model) {
  const attrs = model?.rawAttributes || {};
  if (!('deleted_at' in attrs)) {
    throw new Error(`Model ${model?.name || 'unknown'} missing deleted_at column`);
  }
  if (!('lifecycle_status' in attrs)) {
    throw new Error(`Model ${model?.name || 'unknown'} missing lifecycle_status column`);
  }
}

/**
 * Payload for soft-delete UPDATE.
 * @param {import('sequelize').Model} model
 */
function softDeletePayload(model) {
  const payload = {
    deleted_at: backendNow(),
    lifecycle_status: LIFECYCLE_DELETED,
  };
  stampForUpdate(payload, model);
  stampLifecycleDeleted(payload, model);
  return payload;
}

/**
 * Read filter: non-deleted rows with archive lifecycle_status = active.
 * @param {Record<string, unknown>} [extra]
 */
function hasWhereClauses(extra) {
  if (!extra || typeof extra !== 'object') return false;
  return Object.keys(extra).length > 0 || Object.getOwnPropertySymbols(extra).length > 0;
}

function activeRowWhere(extra = {}) {
  const active = {
    deleted_at: { [Op.is]: null },
    lifecycle_status: LIFECYCLE_ACTIVE,
  };
  if (!hasWhereClauses(extra)) return active;
  return { [Op.and]: [extra, active] };
}

/**
 * Products use lifecycle_status for registration workflow (Draft, etc.).
 * Exclude only soft-deleted rows (deleted_at set or lifecycle_status deleted).
 * @param {Record<string, unknown>} [extra]
 */
function productActiveWhere(extra = {}) {
  const active = {
    deleted_at: { [Op.is]: null },
    lifecycle_status: { [Op.ne]: LIFECYCLE_DELETED },
  };
  if (!hasWhereClauses(extra)) return active;
  return { [Op.and]: [extra, active] };
}

/** Only non-deleted active rows (for include.where). */
function activeOnlyWhere() {
  return {
    deleted_at: { [Op.is]: null },
    lifecycle_status: LIFECYCLE_ACTIVE,
  };
}

/**
 * @param {import('sequelize').Model} instance
 * @param {{ transaction?: import('sequelize').Transaction }} [opts]
 */
async function softDeleteInstance(instance, opts = {}) {
  const model = instance.constructor;
  assertHasSoftDeleteColumns(model);
  return instance.update(softDeletePayload(model), { transaction: opts.transaction });
}

/**
 * @param {import('sequelize').ModelStatic<any>} Model
 * @param {import('sequelize').WhereOptions} where
 * @param {{ transaction?: import('sequelize').Transaction }} [opts]
 * @returns {Promise<number>} affected row count
 */
async function softDeleteWhere(Model, where, opts = {}) {
  assertHasSoftDeleteColumns(Model);
  const [count] = await Model.update(softDeletePayload(Model), {
    where: activeRowWhere(where),
    transaction: opts.transaction,
  });
  return count;
}

/**
 * Load one row by primary key if not soft-deleted.
 * @param {import('sequelize').ModelStatic<any>} Model
 * @param {string|number} pk
 * @param {import('sequelize').FindOptions} [opts]
 */
async function findActiveByPk(Model, pk, opts = {}) {
  const key = Model.primaryKeyAttribute || 'id';
  const rowFilter =
    Model.tableName === 'products'
      ? productActiveWhere({ [key]: pk })
      : activeRowWhere({ [key]: pk });
  return Model.findOne({
    ...opts,
    where: rowFilter,
  });
}

module.exports = {
  LIFECYCLE_DELETED,
  LIFECYCLE_ACTIVE,
  assertHasSoftDeleteColumns,
  softDeletePayload,
  activeRowWhere,
  productActiveWhere,
  activeOnlyWhere,
  softDeleteInstance,
  softDeleteWhere,
  findActiveByPk,
};
