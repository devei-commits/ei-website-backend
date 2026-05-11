/**
 * Match Raw / Pack masters from Excel "Component SKU" values against zoho_sku_code then internal code.
 */
const { Op } = require('sequelize');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

async function findRawMaterialByMasterSku(sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  let rm = await RawMaterial.findOne({ where: { zoho_sku_code: t } });
  if (rm) return rm;
  rm = await RawMaterial.findOne({ where: { zoho_sku_code: { [Op.iLike]: t } } });
  if (rm) return rm;
  rm = await RawMaterial.findOne({ where: { code: t } });
  if (rm) return rm;
  return RawMaterial.findOne({ where: { code: { [Op.iLike]: t } } });
}

async function findPackMaterialByMasterSku(sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  let pm = await PackMaterial.findOne({ where: { zoho_sku_code: t } });
  if (pm) return pm;
  pm = await PackMaterial.findOne({ where: { zoho_sku_code: { [Op.iLike]: t } } });
  if (pm) return pm;
  pm = await PackMaterial.findOne({ where: { code: t } });
  if (pm) return pm;
  return PackMaterial.findOne({ where: { code: { [Op.iLike]: t } } });
}

module.exports = {
  findRawMaterialByMasterSku,
  findPackMaterialByMasterSku,
};
