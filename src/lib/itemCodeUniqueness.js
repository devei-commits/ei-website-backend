const { Op } = require('sequelize');

/**
 * Distinct trimmed identifiers for duplicate checks (code + optional sku when different from code).
 */
function identifiersFromCodeAndSku(code, sku) {
  const c = code != null ? String(code).trim() : '';
  const s = sku != null ? String(sku).trim() : '';
  const ids = [];
  if (c) ids.push(c);
  if (s && s.toLowerCase() !== c.toLowerCase()) ids.push(s);
  return ids;
}

/** @param {object} Model Sequelize model (RawMaterial or PackMaterial) */
async function findConflictingMasterRow(Model, code, sku, excludeId) {
  const ids = identifiersFromCodeAndSku(code, sku);
  if (!ids.length) return null;
  const ors = [];
  for (const id of ids) {
    ors.push({ code: { [Op.iLike]: id } });
    ors.push({ sku: { [Op.iLike]: id } });
  }
  const inner = { [Op.or]: ors };
  const where =
    excludeId != null ? { [Op.and]: [{ id: { [Op.ne]: excludeId } }, inner] } : inner;
  return Model.findOne({ where });
}

module.exports = { identifiersFromCodeAndSku, findConflictingMasterRow };
