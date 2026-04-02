const PackMaterial = require('./models');
const { syncZohoItemForNewPackMaterial } = require('../services/zohoMasterItemSync');
const zohoEnv = require('../services/zohoEnv');
const { Op } = require('sequelize');
const { findConflictingMasterRow } = require('../lib/itemCodeUniqueness');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
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

    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    const normalizeInt = (v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? null : n;
    };

    if (wantsPagination) {
      const limit = limitQ != null ? normalizeInt(limitQ) : 20;
      const offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }

      const result = await PackMaterial.findAndCountAll({
        where,
        order: [['code', 'ASC']],
        limit,
        offset,
      });

      const listRows = result.rows.map(formatPackMaterial);
      return res.json({ rows: listRows, total: result.count, limit, offset });
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
 * POST /api/v1/pack-materials/zoho-sync — Draft PM row + Zoho Books item (wizard step before full form submit).
 */
async function syncPmZoho(req, res) {
  try {
    const b = req.body || {};
    const fields = bodyToPackMaterial(b);
    const codeTrim = fields.code != null ? String(fields.code).trim() : '';
    if (!codeTrim) {
      return res.status(400).json({ error: 'code or itemCode is required' });
    }
    fields.code = codeTrim;
    if (fields.sku != null && String(fields.sku).trim() !== '') {
      fields.sku = String(fields.sku).trim();
    } else {
      fields.sku = null;
    }

    let row = await PackMaterial.findOne({ where: { code: codeTrim } });
    if (row) {
      const dupSku = await findConflictingMasterRow(PackMaterial, fields.code, fields.sku, row.id);
      if (dupSku) {
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }
      Object.keys(fields).forEach((key) => {
        if (fields[key] !== undefined) row.set(key, fields[key]);
      });
      if (b.form_data !== undefined) row.set('form_data', b.form_data);
      await row.save();
    } else {
      const dup = await findConflictingMasterRow(PackMaterial, fields.code, fields.sku, null);
      if (dup) {
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }
      row = await PackMaterial.create(fields);
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PM', pack_material_id: row.id },
        defaults: {
          item_type: 'PM',
          pack_material_id: row.id,
          wh_stock: 0,
          wh_unit: row.unit || 'PCS',
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: 0,
          reserved: 0,
          in_transit: 0,
          reorder_pt: 0,
          avg_mo: 0,
          qc_status: 'Out of Stock',
        },
      });
    }

    let zoho = await syncZohoItemForNewPackMaterial(row, b);
    if (zoho.error === 'already_has_zoho_id') {
      await row.reload();
      zoho = { synced: true, itemId: row.zoho_id };
    }
    if (zoho.synced && zoho.itemId) {
      await row.update({ zoho_id: zoho.itemId });
      await row.reload();
    }

    const plain = row.get({ plain: true });
    const zohoErr = zoho.error;
    let zoho_sync;
    if (zoho.synced && zoho.itemId) {
      zoho_sync = { synced: true };
    } else if (zohoErr === 'zoho_disabled' || zohoErr === 'item_sync_disabled') {
      zoho_sync = { synced: false, skipped: true, resolvedWithoutZoho: true, reason: zohoErr };
    } else if (
      zohoEnv.booksEnabled &&
      zohoEnv.syncItems &&
      zohoErr &&
      zohoErr !== 'already_has_zoho_id'
    ) {
      zoho_sync = { synced: false, error: zohoErr };
    } else {
      zoho_sync = { synced: false, skipped: true, resolvedWithoutZoho: true, reason: zohoErr || 'unknown' };
    }

    return res.status(200).json({
      pack_material_id: row.id,
      zoho_id: plain.zoho_id || null,
      zoho_sync,
    });
  } catch (err) {
    console.error('syncPmZoho error', err);
    return res.status(500).json({ error: err.message || 'Failed to sync pack material with Zoho' });
  }
}

/**
 * POST /api/v1/pack-materials — create pack material. Body: code/itemCode, description/name, type, level, etc.
 * Optional `pack_material_id` when the draft was created via POST /pack-materials/zoho-sync.
 */
async function createPackMaterial(req, res) {
  try {
    const b = req.body || {};
    const preIdRaw = b.pack_material_id ?? b.draft_pack_material_id;
    const preId = preIdRaw != null && preIdRaw !== '' ? parseInt(String(preIdRaw), 10) : NaN;

    if (!Number.isNaN(preId)) {
      const row = await PackMaterial.findByPk(preId);
      if (!row) {
        return res.status(404).json({ error: 'Draft pack material not found', code: 'PM_NOT_FOUND' });
      }
      const fields = bodyToPackMaterial(b);
      const codeTrim = fields.code != null ? String(fields.code).trim() : '';
      if (!codeTrim) {
        return res.status(400).json({ error: 'code or itemCode is required' });
      }
      if (String(row.code).trim() !== codeTrim) {
        return res.status(400).json({
          error: 'code must match the draft pack material from Zoho sync. Do not change the PM code after sync.',
          code: 'PM_CODE_MISMATCH',
        });
      }
      fields.code = codeTrim;
      if (fields.sku != null && String(fields.sku).trim() !== '') {
        fields.sku = String(fields.sku).trim();
      } else {
        fields.sku = null;
      }
      const nextSku = fields.sku !== undefined ? fields.sku : row.sku;
      const dup = await findConflictingMasterRow(PackMaterial, fields.code, nextSku, row.id);
      if (dup) {
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }
      Object.keys(fields).forEach((key) => {
        if (fields[key] !== undefined) row.set(key, fields[key]);
      });
      if (b.form_data !== undefined) row.set('form_data', b.form_data);
      await row.save();
      await row.reload();
      return res.status(200).json(formatPackMaterialFull(row));
    }

    const fields = bodyToPackMaterial(b);
    const codeTrim = fields.code != null ? String(fields.code).trim() : '';
    if (!codeTrim) {
      return res.status(400).json({ error: 'code or itemCode is required' });
    }
    fields.code = codeTrim;
    if (fields.sku != null && String(fields.sku).trim() !== '') {
      fields.sku = String(fields.sku).trim();
    } else {
      fields.sku = null;
    }
    const dup = await findConflictingMasterRow(PackMaterial, fields.code, fields.sku, null);
    if (dup) {
      return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
    }
    const row = await PackMaterial.create(fields);

    // Create a zero-stock warehouse inventory row so the PM appears in the warehouse immediately.
    await WarehouseInventory.findOrCreate({
      where: { item_type: 'PM', pack_material_id: row.id },
      defaults: {
        item_type: 'PM',
        pack_material_id: row.id,
        wh_stock: 0,
        wh_unit: row.unit || 'PCS',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'Out of Stock',
      },
    });

    const zoho = await syncZohoItemForNewPackMaterial(row, b);
    if (zoho.synced && zoho.itemId) {
      await row.update({ zoho_id: zoho.itemId });
    }
    await row.reload();
    const out = formatPackMaterialFull(row);
    if (
      zohoEnv.booksEnabled &&
      zohoEnv.syncItems &&
      zoho.error &&
      zoho.error !== 'zoho_disabled' &&
      zoho.error !== 'item_sync_disabled' &&
      zoho.error !== 'already_has_zoho_id'
    ) {
      out.zoho_sync = { synced: false, error: zoho.error };
    }
    res.status(201).json(out);
  } catch (err) {
    console.error('createPackMaterial error', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
    }
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
    const nextCode =
      fields.code !== undefined && String(fields.code).trim() !== ''
        ? String(fields.code).trim()
        : String(row.code || '').trim();
    if (!nextCode) {
      return res.status(400).json({ error: 'code or itemCode is required' });
    }
    let nextSku;
    if (fields.sku !== undefined) {
      nextSku =
        fields.sku == null || String(fields.sku).trim() === ''
          ? null
          : String(fields.sku).trim();
      fields.sku = nextSku;
    } else {
      nextSku = row.sku == null ? null : String(row.sku).trim() || null;
    }
    const dup = await findConflictingMasterRow(PackMaterial, nextCode, nextSku, row.id);
    if (dup) {
      return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
    }
    fields.code = nextCode;
    Object.keys(fields).forEach((key) => {
      if (fields[key] !== undefined) row.set(key, fields[key]);
    });
    if (b.form_data !== undefined) row.set('form_data', b.form_data);
    await row.save();
    res.json(formatPackMaterialFull(row));
  } catch (err) {
    console.error('updatePackMaterial error', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
    }
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

    // warehouse_inventory has FK (pack_material_id -> pack_materials.id) which blocks master-row delete.
    // Clean warehouse_inventory + location history first.
    const whInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: row.id } });
    if (whInv) {
      await WarehouseInventoryLocationHistory.destroy({ where: { warehouse_inventory_id: whInv.id } });
      await whInv.destroy(); // cascades to rack items via FK onDelete: CASCADE
    }

    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deletePackMaterial error', err);
    const isFk =
      err &&
      (err.name === 'SequelizeForeignKeyConstraintError' ||
        err.name === 'SequelizeDatabaseError' ||
        err.original?.code === '23503');
    if (isFk) {
      return res.status(409).json({
        error:
          'Cannot delete pack material because it is referenced by other records (e.g. BOM / warehouse stock / batches). Remove dependencies first.',
        code: 'PM_DELETE_FK_CONSTRAINT',
      });
    }
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
  syncPmZoho,
  createPackMaterial,
  updatePackMaterial,
  deletePackMaterial,
  getReservedStock,
  formatPackMaterial,
};
