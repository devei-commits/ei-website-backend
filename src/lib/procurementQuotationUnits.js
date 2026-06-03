/**
 * Normalize procurement quotation / PR line units to RM primary UoM.
 */
const RawMaterial = require('../rawMaterials/models');
const { normRmPrimaryUom, resolveProcurementLineUnit } = require('./rmUnitConversion');

async function buildRmUomById(rmIds) {
  const map = new Map();
  const ids = [...new Set((rmIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return map;
  const rows = await RawMaterial.findAll({
    where: { id: ids },
    attributes: ['id', 'uom'],
  });
  for (const r of rows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    map.set(Number(plain.id), normRmPrimaryUom(plain.uom));
  }
  return map;
}

/**
 * @param {object[]} items — quotation or PR lines
 */
async function normalizeProcurementQuotationItems(items) {
  if (!Array.isArray(items) || !items.length) return items;
  const rmIds = items
    .map((it) => (it.raw_material_id != null ? Number(it.raw_material_id) : NaN))
    .filter((id) => Number.isFinite(id) && id > 0);
  const rmUomById = await buildRmUomById(rmIds);
  return items.map((it) => {
    const uom = resolveProcurementLineUnit(it, rmUomById);
    return { ...it, unit: uom, uom };
  });
}

module.exports = {
  buildRmUomById,
  normalizeProcurementQuotationItems,
};
