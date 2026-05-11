/**
 * Mirror of PR registration behaviour: append PR product code to `raw_materials.products` / `pack_materials.products`
 * for every line that has raw_material_id / pack_material_id — used after Excel BOM imports.
 */
const { Op } = require('sequelize');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

function appendProductCodeToList(products, productCode) {
  const code = String(productCode || '').trim();
  if (!code) return Array.isArray(products) ? products : [];
  const list = Array.isArray(products) ? products.map(String) : [];
  if (list.includes(code)) return list;
  return [...list, code];
}

function productCodeForMasterLink(product) {
  const p = product && typeof product.get === 'function' ? product.get({ plain: true }) : product || {};
  const c = String(p.product_code || '').trim() || String(p.zoho_sku_code || '').trim();
  if (c) return c;
  const id = p.product_id;
  return id != null ? `PR-${id}` : '';
}

function collectRawMaterialIds(rm_lines, sku_rm_lines) {
  const ids = new Set();
  for (const arr of [rm_lines, sku_rm_lines]) {
    if (!Array.isArray(arr)) continue;
    for (const l of arr) {
      const id = l?.raw_material_id ?? l?.rawMaterialId;
      const n = id != null ? parseInt(String(id), 10) : NaN;
      if (!Number.isNaN(n)) ids.add(n);
    }
  }
  return [...ids];
}

function collectPackMaterialIds(pm_lines) {
  const ids = new Set();
  if (!Array.isArray(pm_lines)) return [];
  for (const l of pm_lines) {
    const id = l?.pack_material_id ?? l?.packMaterialId ?? l?.pm_id ?? l?.pmId;
    const n = id != null ? parseInt(String(id), 10) : NaN;
    if (!Number.isNaN(n)) ids.add(n);
  }
  return [...ids];
}

/**
 * @param {object} product — Sequelize instance or plain
 * @param {{ rm_lines?: unknown[]; sku_rm_lines?: unknown[]; pm_lines?: unknown[] }} lines
 * @param {{ transaction?: import('sequelize').Transaction; productCodeOverride?: string }} [options]
 */
async function linkMaterialMastersToProductCode(product, lines, options = {}) {
  const { transaction, productCodeOverride } = options;
  const productCodeForLink =
    String(productCodeOverride || '').trim() || productCodeForMasterLink(product);
  if (!productCodeForLink) return { linked_rm: 0, linked_pm: 0 };

  const rawMaterialIds = collectRawMaterialIds(lines.rm_lines, lines.sku_rm_lines);
  const packMaterialIds = collectPackMaterialIds(lines.pm_lines);

  const now = new Date();
  let linkedRm = 0;
  let linkedPm = 0;

  if (rawMaterialIds.length > 0) {
    const rms = await RawMaterial.findAll({
      where: { id: { [Op.in]: rawMaterialIds } },
      transaction,
    });
    for (const rm of rms) {
      const next = appendProductCodeToList(rm.products, productCodeForLink);
      const prevJson = JSON.stringify(Array.isArray(rm.products) ? rm.products : []);
      const nextJson = JSON.stringify(next);
      if (prevJson !== nextJson) {
        await rm.update({ products: next, updated_at: now }, { transaction });
        linkedRm += 1;
      }
    }
  }

  if (packMaterialIds.length > 0) {
    const pms = await PackMaterial.findAll({
      where: { id: { [Op.in]: packMaterialIds } },
      transaction,
    });
    for (const pm of pms) {
      const next = appendProductCodeToList(pm.products, productCodeForLink);
      const prevJson = JSON.stringify(Array.isArray(pm.products) ? pm.products : []);
      const nextJson = JSON.stringify(next);
      if (prevJson !== nextJson) {
        await pm.update({ products: next, updated_at: now }, { transaction });
        linkedPm += 1;
      }
    }
  }

  return { linked_rm: linkedRm, linked_pm: linkedPm };
}

/**
 * @param {object} product
 * @param {object} bom — Sequelize BOM instance or plain
 */
async function linkMaterialMastersToProductFromBomRow(product, bom, options = {}) {
  const plain = bom && typeof bom.get === 'function' ? bom.get({ plain: true }) : bom || {};
  return linkMaterialMastersToProductCode(
    product,
    {
      rm_lines: plain.rm_lines || [],
      sku_rm_lines: plain.sku_rm_lines || [],
      pm_lines: plain.pm_lines || [],
    },
    options
  );
}

module.exports = {
  appendProductCodeToList,
  productCodeForMasterLink,
  linkMaterialMastersToProductCode,
  linkMaterialMastersToProductFromBomRow,
};
