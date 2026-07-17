/**
 * Application-layer timestamps for persistence.
 * All created/updated/deleted (and selected event) dates must be set from the Node process
 * via `new Date()`, never from DB functions (NOW(), CURRENT_TIMESTAMP, DataTypes.NOW defaults).
 */

const { backendNow: indiaBackendNow } = require('./indiaTime');

/** Current instant in the backend process (use instead of DB NOW()). */
function backendNow() {
  return indiaBackendNow();
}

/** Parse a value previously stored in the DB into a JS Date for API/logic (read path). */
function parseDbDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MANUAL_CREATED = ['created_at', 'createdAt'];
const MANUAL_UPDATED = ['updated_at', 'updatedAt'];
const MANUAL_DELETED = ['deleted_at', 'deletedAt'];
/** Event timestamps set by the server when a row is created (not user-entered calendar fields). */
const EVENT_ON_CREATE_IF_NULL = ['moved_at'];

function collectModelTimestampKeys(model) {
  const created = new Set(MANUAL_CREATED);
  const updated = new Set(MANUAL_UPDATED);
  const deleted = new Set(MANUAL_DELETED);
  const eventOnCreate = new Set(EVENT_ON_CREATE_IF_NULL);

  if (!model) {
    return { created, updated, deleted, eventOnCreate };
  }

  const attrs = model.rawAttributes || {};
  for (const key of MANUAL_CREATED) {
    if (key in attrs) created.add(key);
  }
  for (const key of MANUAL_UPDATED) {
    if (key in attrs) updated.add(key);
  }
  for (const key of MANUAL_DELETED) {
    if (key in attrs) deleted.add(key);
  }
  for (const key of EVENT_ON_CREATE_IF_NULL) {
    if (key in attrs) eventOnCreate.add(key);
  }

  if (model.options?.timestamps) {
    const ca = model.options.createdAt;
    const ua = model.options.updatedAt;
    const da = model.options.deletedAt;
    if (ca !== false && ca) created.add(ca);
    if (ua !== false && ua) updated.add(ua);
    if (model.options.paranoid && da !== false && da) deleted.add(da);
  }

  return { created, updated, deleted, eventOnCreate };
}

function isUnset(value) {
  return value == null;
}

function assignTimestampField(record, model, key, val, onlyWhenUnset) {
  if (!model?.rawAttributes?.[key]) return;
  if (typeof record.set === 'function') {
    if (!onlyWhenUnset || isUnset(record.get(key))) record.set(key, val);
    return;
  }
  if (!onlyWhenUnset || isUnset(record[key])) {
    record[key] = val;
  }
}

/**
 * Stamp plain object or Sequelize instance data for INSERT.
 */
function stampForCreate(record, model) {
  if (!record || !model) return;
  const now = backendNow();
  const { created, updated, eventOnCreate } = collectModelTimestampKeys(model);
  for (const key of created) assignTimestampField(record, model, key, now, true);
  for (const key of updated) assignTimestampField(record, model, key, now, true);
  for (const key of eventOnCreate) assignTimestampField(record, model, key, now, true);
  const lcAttr = model.rawAttributes?.lifecycle_status;
  if (lcAttr && lcAttr.defaultValue === 'active') {
    assignTimestampField(record, model, 'lifecycle_status', 'active', true);
  }
}

/**
 * Stamp plain object or Sequelize instance data for UPDATE.
 */
function stampForUpdate(record, model) {
  if (!record || !model) return;
  const now = backendNow();
  const { updated } = collectModelTimestampKeys(model);
  for (const key of updated) assignTimestampField(record, model, key, now, false);
}

/**
 * Stamp soft-delete column when destroying (paranoid or manual deleted_at).
 */
function stampForDelete(record, model) {
  if (!record || !model) return;
  const now = backendNow();
  const { deleted } = collectModelTimestampKeys(model);
  for (const key of deleted) assignTimestampField(record, model, key, now, false);
  stampLifecycleDeleted(record, model);
}

/**
 * Set lifecycle_status on soft-delete when the model has that column.
 */
function stampLifecycleDeleted(record, model) {
  if (!record || !model?.rawAttributes?.lifecycle_status) return;
  const val = 'deleted';
  if (typeof record.set === 'function') {
    record.set('lifecycle_status', val);
    return;
  }
  record.lifecycle_status = val;
}

function registerSequelizeTimestampHooks(sequelize) {
  // notNull event-on-create fields (e.g. moved_at) must be stamped BEFORE validation runs —
  // Sequelize validates notNull ahead of the beforeCreate hook, so relying on beforeCreate alone
  // makes those fields fail validation on .create(). Stamp them here (new records only, unset only).
  sequelize.addHook('beforeValidate', (instance) => {
    if (!instance || !instance.isNewRecord) return;
    const model = instance.constructor;
    const { eventOnCreate } = collectModelTimestampKeys(model);
    const now = backendNow();
    for (const key of eventOnCreate) assignTimestampField(instance, model, key, now, true);
  });

  sequelize.addHook('beforeCreate', (instance, options) => {
    stampForCreate(instance, instance?.constructor);
  });

  sequelize.addHook('beforeUpdate', (instance, options) => {
    stampForUpdate(instance, instance?.constructor);
  });

  sequelize.addHook('beforeDestroy', (instance, options) => {
    if (options?.force) return;
    stampForDelete(instance, instance?.constructor);
  });

  sequelize.addHook('beforeBulkCreate', (instances, options) => {
    const model = options?.model;
    for (const row of instances || []) {
      stampForCreate(row, row?.constructor || model);
    }
  });

  sequelize.addHook('beforeBulkUpdate', (options) => {
    const model = options?.model;
    if (!model) return;
    options.attributes = options.attributes || {};
    stampForUpdate(options.attributes, model);
  });
}

module.exports = {
  backendNow,
  parseDbDate,
  stampForCreate,
  stampForUpdate,
  stampForDelete,
  stampLifecycleDeleted,
  registerSequelizeTimestampHooks,
  collectModelTimestampKeys,
};
