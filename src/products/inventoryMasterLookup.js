/**
 * Resolve RM / PM / PR masters for Zoho Inventory Summary Excel (item_id + sku).
 */
const { Op } = require('sequelize');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('./models');
const { findRawMaterialByMasterSku, findPackMaterialByMasterSku } = require('./masterSkuLookup');

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

async function findRawMaterialByZohoItemId(itemId) {
  const t = String(itemId || '').trim();
  if (!t) return null;
  let rm = await RawMaterial.findOne({ where: { zoho_id: t } });
  if (rm) return rm;
  return RawMaterial.findOne({ where: { zoho_id: { [Op.iLike]: t } } });
}

async function findPackMaterialByZohoItemId(itemId) {
  const t = String(itemId || '').trim();
  if (!t) return null;
  let pm = await PackMaterial.findOne({ where: { zoho_id: t } });
  if (pm) return pm;
  return PackMaterial.findOne({ where: { zoho_id: { [Op.iLike]: t } } });
}

async function findProductByZohoItemId(itemId) {
  const t = String(itemId || '').trim();
  if (!t) return null;
  let pr = await Product.findOne({ where: { zoho_item_id: t } });
  if (pr) return pr;
  return Product.findOne({ where: { zoho_item_id: { [Op.iLike]: t } } });
}

async function findProductByMasterSku(sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  let pr = await Product.findOne({ where: { zoho_sku_code: t } });
  if (pr) return pr;
  pr = await Product.findOne({ where: { zoho_sku_code: { [Op.iLike]: t } } });
  if (pr) return pr;
  pr = await Product.findOne({ where: { product_code: t } });
  if (pr) return pr;
  return Product.findOne({ where: { product_code: { [Op.iLike]: t } } });
}

/**
 * Search RM, PM, PR by Zoho item_id. Returns all matches (normally one).
 * @returns {Array<{ kind: 'RM'|'PM'|'PR', row: object }>}
 */
async function findAllMastersByZohoItemId(itemId) {
  const [rm, pm, pr] = await Promise.all([
    findRawMaterialByZohoItemId(itemId),
    findPackMaterialByZohoItemId(itemId),
    findProductByZohoItemId(itemId),
  ]);
  const out = [];
  if (rm) out.push({ kind: 'RM', row: plain(rm) });
  if (pm) out.push({ kind: 'PM', row: plain(pm) });
  if (pr) out.push({ kind: 'PR', row: plain(pr) });
  return out;
}

/**
 * Search RM, PM, PR by SKU / internal code.
 * @returns {Array<{ kind: 'RM'|'PM'|'PR', row: object }>}
 */
async function findAllMastersBySku(sku) {
  const [rm, pm, pr] = await Promise.all([
    findRawMaterialByMasterSku(sku),
    findPackMaterialByMasterSku(sku),
    findProductByMasterSku(sku),
  ]);
  const out = [];
  if (rm) out.push({ kind: 'RM', row: plain(rm) });
  if (pm) out.push({ kind: 'PM', row: plain(pm) });
  if (pr) out.push({ kind: 'PR', row: plain(pr) });
  return out;
}

/**
 * Prefer Zoho item_id when present; otherwise match by sku across RM/PM/PR.
 * @returns {{ kind: 'RM'|'PM'|'PR', row: object, matchBy: string }|{ ambiguous: Array, matchBy: string }|null}
 */
async function resolveInventoryMaster({ zohoItemId, sku }) {
  const zohoId = String(zohoItemId || '').trim();
  const skuTrim = String(sku || '').trim();

  if (zohoId) {
    const byId = await findAllMastersByZohoItemId(zohoId);
    if (byId.length === 1) return { ...byId[0], matchBy: 'zoho_item_id' };
    if (byId.length > 1) return { ambiguous: byId, matchBy: 'zoho_item_id' };
  }

  if (skuTrim) {
    const bySku = await findAllMastersBySku(skuTrim);
    if (bySku.length === 1) return { ...bySku[0], matchBy: 'sku' };
    if (bySku.length > 1) return { ambiguous: bySku, matchBy: 'sku' };
  }

  return null;
}

function masterCode(kind, row) {
  if (kind === 'RM') return row.code || '';
  if (kind === 'PM') return row.code || '';
  return row.product_code || row.zoho_sku_code || '';
}

function masterSourceId(kind, row) {
  if (kind === 'PR') return row.product_id;
  return row.id;
}

function masterWhUnit(kind, row) {
  if (kind === 'RM') {
    const u = row.uom != null ? String(row.uom).trim() : '';
    return u || 'KG';
  }
  if (kind === 'PM') {
    const u = row.unit != null ? String(row.unit).trim() : '';
    return u || 'PCS';
  }
  return 'PCS';
}

module.exports = {
  findAllMastersByZohoItemId,
  findAllMastersBySku,
  resolveInventoryMaster,
  masterCode,
  masterSourceId,
  masterWhUnit,
};
