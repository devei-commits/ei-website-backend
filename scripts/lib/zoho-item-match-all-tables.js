/**
 * Match a Zoho item to products / raw_materials / pack_materials (any table).
 */
const { Op } = require('sequelize');

function buildItemWhere(target, zid, sku, name) {
  const clauses = [];
  if (target === 'products') {
    if (zid) clauses.push({ zoho_item_id: zid });
    if (sku) clauses.push({ zoho_sku_code: sku }, { product_code: sku });
    if (name) clauses.push({ product_name: { [Op.iLike]: name } });
  } else if (target === 'raw_materials') {
    if (zid) clauses.push({ zoho_id: zid });
    if (sku) clauses.push({ code: sku }, { zoho_sku_code: sku });
    if (name) clauses.push({ name: { [Op.iLike]: name } });
  } else if (target === 'pack_materials') {
    if (zid) clauses.push({ zoho_id: zid });
    if (sku) clauses.push({ code: sku }, { zoho_sku_code: sku });
    if (name) clauses.push({ description: { [Op.iLike]: name } });
  }
  return clauses.length ? { [Op.or]: clauses } : null;
}

const TABLE_SPECS = [
  { target: 'products', zohoField: 'zoho_item_id' },
  { target: 'raw_materials', zohoField: 'zoho_id' },
  { target: 'pack_materials', zohoField: 'zoho_id' },
];

async function findItemRowInTable(target, Model, zid, sku, name) {
  const where = buildItemWhere(target, zid, sku, name);
  if (!where) return null;
  return Model.findOne({ where });
}

/**
 * Search all master tables. Optional preferTarget tries that table first (e.g. from Zoho cf_category).
 */
async function findItemAcrossAllTables(models, { zid, sku, name, preferTarget = null }) {
  const order = preferTarget
    ? [
        ...TABLE_SPECS.filter((s) => s.target === preferTarget),
        ...TABLE_SPECS.filter((s) => s.target !== preferTarget),
      ]
    : TABLE_SPECS;

  for (const spec of order) {
    const Model = models[spec.target];
    if (!Model) continue;
    const row = await findItemRowInTable(spec.target, Model, zid, sku, name);
    if (row) {
      return { ...spec, row, matchedBy: spec.target };
    }
  }
  return null;
}

function itemLocalSnapshot(target, row) {
  if (target === 'products') {
    return {
      localId: row.product_id,
      code: row.product_code,
      zoho_sku_code: row.zoho_sku_code,
      name: row.product_name,
      existingZohoId: row.zoho_item_id,
    };
  }
  return {
    localId: row.id,
    code: row.code,
    zoho_sku_code: row.zoho_sku_code,
    name: target === 'pack_materials' ? row.description : row.name,
    existingZohoId: row.zoho_id,
  };
}

module.exports = {
  buildItemWhere,
  findItemRowInTable,
  findItemAcrossAllTables,
  itemLocalSnapshot,
  TABLE_SPECS,
};
