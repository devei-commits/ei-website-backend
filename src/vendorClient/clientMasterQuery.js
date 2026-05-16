const { Op, fn, col, where } = require('sequelize');

/** Vendor entity codes must not appear in client-only lookups (Create SO, etc.). */
const VENDOR_ENTITY_CODE_PATTERN = 'EI-VEN-%';

/**
 * Sequelize WHERE for active client master rows only (excludes vendors and misclassified EI-VEN-* rows).
 * @param {object[]} [additionalClauses]
 * @returns {object}
 */
function buildActiveClientWhere(additionalClauses = []) {
  return {
    [Op.and]: [
      where(fn('LOWER', col('type')), 'client'),
      { status: 'active' },
      { entity_code: { [Op.notILike]: VENDOR_ENTITY_CODE_PATTERN } },
      ...additionalClauses,
    ],
  };
}

/**
 * Active client lookup by display name (case-insensitive exact match).
 * @param {string} customerName
 * @returns {object}
 */
function buildActiveClientWhereByName(customerName) {
  const trimmed = String(customerName || '').trim();
  return buildActiveClientWhere([{ name: { [Op.iLike]: trimmed } }]);
}

module.exports = {
  VENDOR_ENTITY_CODE_PATTERN,
  buildActiveClientWhere,
  buildActiveClientWhereByName,
};
