const PackMaterial = require('./models');
const { Op } = require('sequelize');
const WarehouseInventory = require('../warehouseInventory/models');
const { ReservedBatchItem } = require('../fulfillment/models');

/**
 * Parse numeric suffix from code after prefix (e.g. "EI-PM-PRI-00001" -> 1, "EI-PM-BOX-001" -> 1).
 */
function parseSuffix(code, prefix) {
  if (!code || !prefix || !String(code).startsWith(prefix)) return null;
  const rest = String(code).slice(prefix.length).replace(/^-+/, '');
  const num = parseInt(rest, 10);
  return Number.isNaN(num) ? null : num;
}

function formatPackMaterial(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    code: d.code,
    description: d.description,
    type: d.type,
    level: d.level,
    group: d.group,
    material: d.material,
    size_spec: d.size_spec,
    price_per_pc: d.price_per_pc != null ? Number(d.price_per_pc) : null,
    moq: d.moq,
    lead_time_days: d.lead_time_days,
    print_status: d.print_status,
    products: Array.isArray(d.products) ? d.products : [],
    zoho_id: d.zoho_id ?? null,
    sku: d.sku ?? null,
    hsn_code: d.hsn_code ?? null,
    unit: d.unit ?? null,
    tax_pref: d.tax_pref ?? null,
    pkg_returnable: d.pkg_returnable ?? null,
    pkg_associate_items: d.pkg_associate_items ?? null,
    sales_purchase_account: d.sales_purchase_account ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

function formatPackMaterialFull(row) {
  const base = formatPackMaterial(row);
  if (!base) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return { ...base, form_data: d.form_data ?? null };
}

/**
 * GET /api/v1/pack-materials — list all pack materials, optional ?search= for filter.
 */
async function listPackMaterials(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const where = {};

    if (search.length > 0) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [
        { code: like },
        { description: like },
        { type: like },
        { level: like },
        { material: like },
        { size_spec: like },
        { print_status: like },
      ];
    }

    const rows = await PackMaterial.findAll({
      where,
      order: [['code', 'ASC']],
    });
    const list = rows.map(formatPackMaterial);
    res.json(list);
  } catch (err) {
    console.error('listPackMaterials error', err);
    res.status(500).json({ error: 'Failed to list pack materials' });
  }
}

/**
 * GET /api/v1/pack-materials/next-code?prefix=EI-PM-PRI — returns next code for series (e.g. EI-PM-PRI-00002).
 * Prefix must be given. Counts existing codes starting with prefix, takes max numeric suffix + 1, pads to 5 digits.
 */
async function getNextCode(req, res) {
  try {
    const prefix = req.query.prefix != null ? String(req.query.prefix).trim() : '';
    if (!prefix) {
      return res.status(400).json({ error: 'Query parameter "prefix" is required' });
    }
    const rows = await PackMaterial.findAll({
      attributes: ['code'],
      where: { code: { [Op.iLike]: `${prefix}%` } },
    });
    let maxNum = 0;
    for (const row of rows) {
      const code = row.get ? row.get('code') : row.code;
      const n = parseSuffix(code, prefix);
      if (n != null && n > maxNum) maxNum = n;
    }
    const nextNum = maxNum + 1;
    const nextCode = `${prefix}-${String(nextNum).padStart(5, '0')}`;
    res.json({ nextCode });
  } catch (err) {
    console.error('getNextCode error', err);
    res.status(500).json({ error: 'Failed to get next code' });
  }
}

/** Map request body (camelCase or snake_case) to pack_materials columns. */
function bodyToPackMaterial(b) {
  return {
    code: b.code ?? b.itemCode ?? '',
    description: b.description ?? b.name ?? null,
    type: b.type ?? b.itemCategory ?? null,
    level: b.level ?? null,
    group: b.group ?? null,
    material: b.material ?? b.matBody ?? null,
    size_spec: b.size_spec ?? b.specNominal ?? null,
    price_per_pc: b.price_per_pc != null ? Number(b.price_per_pc) : (b.pricePerPc != null ? Number(b.pricePerPc) : null),
    moq: b.moq != null ? Number(b.moq) : null,
    lead_time_days: b.lead_time_days != null ? Number(b.lead_time_days) : (b.leadTimeDays != null ? Number(b.leadTimeDays) : null),
    print_status: b.print_status ?? b.printStatus ?? null,
    products: Array.isArray(b.products) ? b.products : [],
    zoho_id: b.zoho_id ?? b.zohoId ?? null,
    sku: b.sku ?? b.pkgSku ?? b.code ?? b.itemCode ?? null,
    hsn_code: b.hsn_code ?? b.pkgHsn ?? b.hsnCode ?? null,
    unit: b.unit ?? b.pkgUnit ?? null,
    tax_pref: b.tax_pref ?? b.pkgTaxPreference ?? b.taxPref ?? null,
    pkg_returnable: b.pkg_returnable ?? b.pkgReturnable ?? null,
    pkg_associate_items: b.pkg_associate_items ?? b.pkgAssociateItems ?? b.associateItems ?? null,
    sales_purchase_account: b.sales_purchase_account ?? b.salesPurchaseAccount ?? null,
    ...(b.form_data !== undefined ? { form_data: b.form_data } : {}),
  };
}

/**
 * POST /api/v1/pack-materials — create pack material. Body: code/itemCode, description/name, type, level, etc.
 */
async function createPackMaterial(req, res) {
  try {
    const b = req.body || {};
    const fields = bodyToPackMaterial(b);
    if (!fields.code || !String(fields.code).trim()) {
      return res.status(400).json({ error: 'code or itemCode is required' });
    }
    const row = await PackMaterial.create(fields);
    res.status(201).json(formatPackMaterialFull(row));
  } catch (err) {
    console.error('createPackMaterial error', err);
    res.status(500).json({ error: err.message || 'Failed to create pack material' });
  }
}

/**
 * GET /api/v1/pack-materials/:id — get one by id for edit.
 */
async function getPackMaterialById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PackMaterial.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Pack material not found' });
    res.json(formatPackMaterialFull(row));
  } catch (err) {
    console.error('getPackMaterialById error', err);
    res.status(500).json({ error: 'Failed to get pack material' });
  }
}

/**
 * PUT /api/v1/pack-materials/:id — update pack material.
 */
async function updatePackMaterial(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PackMaterial.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Pack material not found' });
    const b = req.body || {};
    const fields = bodyToPackMaterial(b);
    Object.keys(fields).forEach((key) => {
      if (fields[key] !== undefined) row.set(key, fields[key]);
    });
    if (b.form_data !== undefined) row.set('form_data', b.form_data);
    await row.save();
    res.json(formatPackMaterialFull(row));
  } catch (err) {
    console.error('updatePackMaterial error', err);
    res.status(500).json({ error: err.message || 'Failed to update pack material' });
  }
}

/**
 * DELETE /api/v1/pack-materials/:id — delete pack material.
 */
async function deletePackMaterial(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PackMaterial.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Pack material not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deletePackMaterial error', err);
    res.status(500).json({ error: 'Failed to delete pack material' });
  }
}

/**
 * GET /api/v1/pack-materials/:id/reserved-stock — actual (SIH), reserved (from SO/batches), available = actual - reserved.
 */
async function getReservedStock(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid pack material id' });
    const pm = await PackMaterial.findByPk(id);
    if (!pm) return res.status(404).json({ error: 'Pack material not found' });

    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: id } });
    const actual = wh && wh.stock_in_hand != null ? Number(wh.stock_in_hand) : 0;

    const rows = await ReservedBatchItem.findAll({
      where: { pack_material_id: id },
      attributes: ['quantity_reserved'],
    });
    const reserved = rows.reduce((sum, r) => sum + Number(r.quantity_reserved || 0), 0);
    const available = Math.max(0, actual - reserved);

    res.json({ actual, reserved, available, unit: 'PCS' });
  } catch (err) {
    console.error('getReservedStock (PM) error', err);
    res.status(500).json({ error: 'Failed to get reserved stock' });
  }
}

module.exports = {
  listPackMaterials,
  getNextCode,
  getPackMaterialById,
  createPackMaterial,
  updatePackMaterial,
  deletePackMaterial,
  getReservedStock,
  formatPackMaterial,
};
