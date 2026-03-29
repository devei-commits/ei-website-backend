const RawMaterial = require('./models');
const { syncZohoItemForNewRawMaterial } = require('../services/zohoMasterItemSync');
const zohoEnv = require('../services/zohoEnv');
const { Op } = require('sequelize');
const { findConflictingMasterRow } = require('../lib/itemCodeUniqueness');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const { ReservedBatchItem } = require('../fulfillment/models');

/**
 * Parse numeric suffix from code after prefix (e.g. "EI-RM-ACT-00001" -> 1).
 */
function parseSuffix(code, prefix) {
  if (!code || !prefix || !String(code).startsWith(prefix)) return null;
  const rest = String(code).slice(prefix.length).replace(/^-+/, '');
  const num = parseInt(rest, 10);
  return Number.isNaN(num) ? null : num;
}

/** List-view only (no form_data). */
function formatRawMaterial(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    code: d.code,
    name: d.name,
    inci: d.inci,
    category: d.category,
    rm_type: d.rm_type,
    uom: d.uom,
    price_per_kg: d.price_per_kg != null ? Number(d.price_per_kg) : null,
    gst: d.gst != null ? Number(d.gst) : null,
    shelf: d.shelf,
    lead_time_days: d.lead_time_days != null ? Number(d.lead_time_days) : null,
    status: d.status,
    products: Array.isArray(d.products) ? d.products : [],
    group: d.group,
    zoho_id: d.zoho_id ?? null,
    sku: d.sku ?? null,
    hsn_code: d.hsn_code ?? null,
    tax_pref: d.tax_pref ?? null,
    sales_purchase_account: d.sales_purchase_account ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/** Full row for edit (includes form_data). */
function formatRawMaterialFull(row) {
  const base = formatRawMaterial(row);
  if (!base) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return { ...base, form_data: d.form_data ?? null };
}

/**
 * GET /api/v1/raw-materials — list all raw materials, optional ?search= for filter.
 * Search matches code, name, inci, category (case-insensitive).
 */
/**
 * GET /api/v1/raw-materials/next-code?prefix=EI-RM-ACT — next code for series (e.g. EI-RM-ACT-00002).
 */
async function getNextCode(req, res) {
  try {
    const prefix = req.query.prefix != null ? String(req.query.prefix).trim() : '';
    if (!prefix) {
      return res.status(400).json({ error: 'Query parameter "prefix" is required' });
    }
    const rows = await RawMaterial.findAll({
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
    console.error('getNextCode (RM) error', err);
    res.status(500).json({ error: 'Failed to get next code' });
  }
}

async function listRawMaterials(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const statusParam = req.query.status != null ? String(req.query.status).trim() : '';
    const where = {};

    if (search.length > 0) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [
        { code: like },
        { name: like },
        { inci: like },
        { category: like },
        { rm_type: like },
      ];
    }

    // Optional status filtering for list screens (e.g. active/inactive).
    // When status=all (or empty), the filter is ignored.
    if (statusParam.length > 0 && statusParam.toLowerCase() !== 'all') {
      where.status = statusParam.toLowerCase();
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

      const result = await RawMaterial.findAndCountAll({
        where,
        order: [['code', 'ASC']],
        limit,
        offset,
      });

      const listRows = result.rows.map(formatRawMaterial);
      return res.json({ rows: listRows, total: result.count, limit, offset });
    }

    const rows = await RawMaterial.findAll({
      where,
      order: [['code', 'ASC']],
    });
    const list = rows.map(formatRawMaterial);
    res.json(list);
  } catch (err) {
    console.error('listRawMaterials error', err);
    res.status(500).json({ error: 'Failed to list raw materials' });
  }
}

/**
 * GET /api/v1/raw-materials/:id — get one by id. Returns list-view + form_data for edit.
 */
async function getRawMaterialById(req, res) {
  try {
    const id = req.params.id;
    const row = await RawMaterial.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Raw material not found' });
    res.json(formatRawMaterialFull(row));
  } catch (err) {
    console.error('getRawMaterialById error', err);
    res.status(500).json({ error: 'Failed to get raw material' });
  }
}

/** Extract list-view fields + form_data from frontend form payload. omitGroupIfUnset: when true, do not set group if not in payload (so item-groups remains source of truth). */
function payloadToListFields(b, omitGroupIfUnset = false) {
  const fd = b.form_data || b;
  const hasGroup = fd.group !== undefined || b.group !== undefined;
  const listFields = {
    code: fd.rmSku ?? fd.code ?? '',
    name: fd.inciName ?? fd.tradeCommercialName ?? fd.name ?? '',
    inci: fd.inciName ?? fd.inci ?? '',
    category: fd.rmCategory ?? fd.category ?? null,
    rm_type: fd.rmType ?? fd.rm_type ?? null,
    uom: fd.primaryUom ?? fd.uom ?? null,
    price_per_kg: fd.price_per_kg ?? (fd.pricePerKg != null ? Number(fd.pricePerKg) : null),
    gst: fd.gst != null ? Number(fd.gst) : null,
    shelf: fd.shelfLife ?? fd.retestPeriod ?? fd.shelf ?? null,
    status: (fd.status && String(fd.status).toLowerCase() === 'inactive') ? 'inactive' : 'active',
    products: Array.isArray(fd.products) ? fd.products : [],
    ...(omitGroupIfUnset && !hasGroup ? {} : { group: fd.group ?? b.group ?? null }),
    zoho_id: fd.zoho_id ?? fd.zohoId ?? b.zoho_id ?? null,
    sku: fd.sku ?? fd.rmSku ?? fd.code ?? b.sku ?? null,
    hsn_code: fd.hsnCode ?? fd.hsn_code ?? b.hsn_code ?? null,
    tax_pref: fd.rmTaxPreference ?? fd.tax_pref ?? fd.taxPref ?? b.tax_pref ?? null,
    sales_purchase_account: fd.accountingCategory ?? fd.sales_purchase_account ?? fd.salesPurchaseAccount ?? b.sales_purchase_account ?? null,
  };
  const leadSrc = fd.leadTimeDays ?? fd.lead_time_days ?? b.lead_time_days;
  const includeLead =
    !omitGroupIfUnset ||
    fd.leadTimeDays !== undefined ||
    fd.lead_time_days !== undefined ||
    b.lead_time_days !== undefined;
  const leadPatch = includeLead
    ? {
        lead_time_days:
          leadSrc == null || leadSrc === ''
            ? null
            : (() => {
                const n = parseInt(String(leadSrc), 10);
                return Number.isFinite(n) && n >= 0 ? n : null;
              })(),
      }
    : {};
  const form_data = b.form_data !== undefined ? b.form_data : (typeof fd.rmSku !== 'undefined' || typeof fd.inciName !== 'undefined' ? fd : null);
  return { ...listFields, ...leadPatch, form_data };
}

/**
 * POST /api/v1/raw-materials — create. Body: full form payload (formData shape) or { form_data: {...} }.
 */
async function createRawMaterial(req, res) {
  try {
    const b = req.body || {};
    const fields = payloadToListFields(b);
    const codeTrim = fields.code != null ? String(fields.code).trim() : '';
    if (!codeTrim) {
      return res.status(400).json({ error: 'code or rmSku is required' });
    }
    fields.code = codeTrim;
    if (fields.sku != null && String(fields.sku).trim() !== '') {
      fields.sku = String(fields.sku).trim();
    } else {
      fields.sku = null;
    }
    const dup = await findConflictingMasterRow(RawMaterial, fields.code, fields.sku, null);
    if (dup) {
      return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
    }
    const row = await RawMaterial.create(fields);

    // Create a zero-stock warehouse inventory row so the RM appears in the warehouse immediately.
    await WarehouseInventory.findOrCreate({
      where: { item_type: 'RM', raw_material_id: row.id },
      defaults: {
        item_type: 'RM',
        raw_material_id: row.id,
        wh_stock: 0,
        wh_unit: row.uom || 'KG',
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

    const zoho = await syncZohoItemForNewRawMaterial(row, b);
    if (zoho.synced && zoho.itemId) {
      await row.update({ zoho_id: zoho.itemId });
    }
    await row.reload();
    const out = formatRawMaterialFull(row);
    if (zohoEnv.booksEnabled && zohoEnv.syncItems) {
      if (zoho.synced && zoho.itemId) {
        out.zoho_sync = { synced: true, item_id: zoho.itemId };
      } else if (
        zoho.error &&
        zoho.error !== 'zoho_disabled' &&
        zoho.error !== 'item_sync_disabled' &&
        zoho.error !== 'already_has_zoho_id'
      ) {
        out.zoho_sync = { synced: false, error: zoho.error };
      }
    }
    res.status(201).json(out);
  } catch (err) {
    console.error('createRawMaterial error', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
    }
    res.status(500).json({ error: err.message || 'Failed to create raw material' });
  }
}

/**
 * PUT /api/v1/raw-materials/:id — update. Body: full form payload or { form_data: {...} }.
 */
async function updateRawMaterial(req, res) {
  try {
    const row = await RawMaterial.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Raw material not found' });
    const b = req.body || {};
    const fields = payloadToListFields(b, true);
    const nextCode =
      fields.code != null && String(fields.code).trim() !== ''
        ? String(fields.code).trim()
        : String(row.code || '').trim();
    if (!nextCode) {
      return res.status(400).json({ error: 'code or rmSku is required' });
    }
    fields.code = nextCode;
    if (fields.sku !== undefined) {
      fields.sku =
        fields.sku == null || String(fields.sku).trim() === ''
          ? null
          : String(fields.sku).trim();
    }
    const nextSku = fields.sku !== undefined ? fields.sku : row.sku;
    const dup = await findConflictingMasterRow(RawMaterial, nextCode, nextSku, row.id);
    if (dup) {
      return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
    }
    await row.update(fields);
    res.json(formatRawMaterialFull(row));
  } catch (err) {
    console.error('updateRawMaterial error', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
    }
    res.status(500).json({ error: err.message || 'Failed to update raw material' });
  }
}

/**
 * DELETE /api/v1/raw-materials/:id — delete.
 */
async function deleteRawMaterial(req, res) {
  try {
    const row = await RawMaterial.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Raw material not found' });

    // warehouse_inventory has FK (raw_material_id -> raw_materials.id) which blocks the master-row delete.
    // Delete the dependent inventory row(s) (and location history) first so the raw material can be removed cleanly.
    const whInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: row.id } });
    if (whInv) {
      await WarehouseInventoryLocationHistory.destroy({ where: { warehouse_inventory_id: whInv.id } });
      await whInv.destroy(); // cascades to rack items via FK onDelete: CASCADE
    }

    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteRawMaterial error', err);
    const isFk =
      err &&
      (err.name === 'SequelizeForeignKeyConstraintError' ||
        err.name === 'SequelizeDatabaseError' ||
        err.original?.code === '23503');
    if (isFk) {
      return res.status(409).json({
        error:
          'Cannot delete raw material because it is referenced by other records (e.g. BOM / warehouse stock / batches). Remove dependencies first.',
        code: 'RM_DELETE_FK_CONSTRAINT',
      });
    }
    res.status(500).json({ error: err.message || 'Failed to delete raw material' });
  }
}

/**
 * GET /api/v1/raw-materials/:id/reserved-stock — actual (SIH), reserved (from SO/batches), available = actual - reserved.
 */
async function getReservedStock(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid raw material id' });
    const rm = await RawMaterial.findByPk(id);
    if (!rm) return res.status(404).json({ error: 'Raw material not found' });

    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: id } });
    const actual = wh && wh.stock_in_hand != null ? Number(wh.stock_in_hand) : 0;

    const rows = await ReservedBatchItem.findAll({
      where: { raw_material_id: id },
      attributes: ['quantity_reserved'],
    });
    const reserved = rows.reduce((sum, r) => sum + Number(r.quantity_reserved || 0), 0);
    const available = Math.max(0, actual - reserved);

    res.json({ actual, reserved, available, unit: rm.uom || 'KG' });
  } catch (err) {
    console.error('getReservedStock (RM) error', err);
    res.status(500).json({ error: 'Failed to get reserved stock' });
  }
}

module.exports = {
  listRawMaterials,
  getRawMaterialById,
  getNextCode,
  createRawMaterial,
  updateRawMaterial,
  deleteRawMaterial,
  getReservedStock,
  formatRawMaterial,
};
