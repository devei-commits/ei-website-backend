const db = require('../../db');
const { softDeleteInstance, softDeleteWhere, activeRowWhere } = require('../lib/softDelete');
const RawMaterial = require('./models');
const { syncZohoItemForNewRawMaterial } = require('../services/zohoMasterItemSync');
const zohoEnv = require('../services/zohoEnv');
const { deleteItem } = require('../services/zohoBooks');
const { zohoSyncIsMandatoryFailure } = require('../services/zohoSyncHelpers');
const { compensateZohoItemIfAny } = require('../lib/zohoDbTransaction');
const { Op } = require('sequelize');
const { findConflictingMasterRow } = require('../lib/itemCodeUniqueness');
const {
  CLUB_ITEMS_SKU_PREFIX,
  acquireRmCodeAllocationLock,
  allocateUniqueCodeFromMax,
  maxRmClubNumericSuffix,
  maxRmDigitSeriesNumericSuffix,
} = require('../lib/rmSkuCodeAllocation');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const { ReservedBatchItem } = require('../fulfillment/models');
const { resetRawMaterialsMasterData } = require('../masters/resetMaterialMasters');
const redis = require('../cache/redis');
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
    specific_gravity: d.specific_gravity != null ? Number(d.specific_gravity) : null,
    price_per_kg: d.price_per_kg != null ? Number(d.price_per_kg) : null,
    gst: d.gst != null ? Number(d.gst) : null,
    shelf: d.shelf,
    lead_time_days: d.lead_time_days != null ? Number(d.lead_time_days) : null,
    status: d.status,
    products: Array.isArray(d.products) ? d.products : [],
    group: d.group,
    zoho_id: d.zoho_id ?? null,
    zoho_sku_code: d.zoho_sku_code ?? null,
    hsn_code: d.hsn_code ?? null,
    tax_pref: d.tax_pref ?? null,
    sales_purchase_account: d.sales_purchase_account ?? null,
    master_lifecycle_status: d.master_lifecycle_status ?? null,
    rm_owner: d.rm_owner ?? null,
    universal_swap_eligibility: d.universal_swap_eligibility ?? null,
    functional_equivalents: d.functional_equivalents ?? null,
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

/** Canonical RM sub-categories (must match EI-Admin). Raw/Fragrance/Colors: digit + 6 digits (7 total); Club items: CLUB + 5 digits. */
const RM_DIGIT_SERIES_NUMERIC_SUFFIX_LEN = 6;
const RM_CLUB_NUMERIC_SUFFIX_LEN = 5;
const RM_SUB_CATEGORY_TO_SKU_LEADING_DIGIT = new Map(
  Object.entries({
    'bulk raw materials': '1',
    'raw material': '1',
    'raw materials': '1',
    'solvents & carriers': '1',
    'pre-mixed bases': '1',
    'pre-mixed based': '1',
    fragrance: '2',
    fragrances: '2',
    'colors & pigments': '3',
  })
);

function isClubItemsRmSubCategoryLabel(label) {
  const k = String(label || '').trim().toLowerCase();
  return k === 'club items' || k === 'club item';
}

function normalizeRmSubCategoryLabel(b) {
  const fd =
    b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data)
      ? b.form_data
      : b;
  return String(fd.subCategory ?? b.subCategory ?? '').trim().toLowerCase();
}

/** Leading digit 1|2|3 for digit-series sub-categories only (not Club items). */
function leadingDigitFromRmSubCategoryBody(b) {
  const k = normalizeRmSubCategoryLabel(b);
  if (isClubItemsRmSubCategoryLabel(k)) return null;
  return RM_SUB_CATEGORY_TO_SKU_LEADING_DIGIT.get(k) || null;
}

/**
 * When sub-category is canonical, internal `code` must start with 1/2/3 or CLUB (Club items).
 * @returns {string|null} error message or null if OK / rule does not apply
 */
function validateInternalRmCodeForSubCategory(code, b) {
  const c = String(code || '').trim();
  const sub = normalizeRmSubCategoryLabel(b);
  if (isClubItemsRmSubCategoryLabel(sub)) {
    if (!c.toUpperCase().startsWith(CLUB_ITEMS_SKU_PREFIX)) {
      return `Internal RM code (SKU) must start with "${CLUB_ITEMS_SKU_PREFIX}" for Club items.`;
    }
    return null;
  }
  const digit = leadingDigitFromRmSubCategoryBody(b);
  if (!digit) return null;
  if (!c.startsWith(digit)) {
    return `Internal RM code (SKU) must start with "${digit}" for the selected RM sub-category.`;
  }
  return null;
}

/**
 * Allocate next internal RM code from RM sub-category.
 * @returns {Promise<{ code: string, seriesPrefix: string }|{ error: string }>}
 */
async function allocateNextRmSkuCode(b, { transaction }) {
  const sequelize = RawMaterial.sequelize;
  await acquireRmCodeAllocationLock(sequelize, transaction);

  const sub = normalizeRmSubCategoryLabel(b);
  if (isClubItemsRmSubCategoryLabel(sub)) {
    const prefix = CLUB_ITEMS_SKU_PREFIX;
    return allocateUniqueCodeFromMax(
      (opts) => maxRmClubNumericSuffix(opts),
      (suffix) => `${prefix}${String(suffix).padStart(RM_CLUB_NUMERIC_SUFFIX_LEN, '0')}`,
      prefix,
      { transaction }
    );
  }

  const digit = leadingDigitFromRmSubCategoryBody(b);
  if (!digit) {
    return {
      error:
        'Select RM Sub-Category (Bulk raw materials, Fragrance(s), Colors & Pigments, or Club items) so an internal code can be assigned on save.',
    };
  }
  return allocateUniqueCodeFromMax(
    (opts) => maxRmDigitSeriesNumericSuffix(digit, opts),
    (suffix) => `${digit}${String(suffix).padStart(RM_DIGIT_SERIES_NUMERIC_SUFFIX_LEN, '0')}`,
    digit,
    { transaction }
  );
}

async function listRawMaterials(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const statusParam = req.query.status != null ? String(req.query.status).trim() : '';
    let where = activeRowWhere();

    if (search.length > 0) {
      const like = { [Op.iLike]: `%${search}%` };
      where = {
        [Op.and]: [
          where,
          {
            [Op.or]: [
              { code: like },
              { zoho_sku_code: like },
              { name: like },
              { inci: like },
              { category: like },
              { rm_type: like },
            ],
          },
        ],
      };
    }

    // Optional status filtering for list screens (e.g. active/inactive).
    // When status=all (or empty), the filter is ignored.
    if (statusParam.length > 0 && statusParam.toLowerCase() !== 'all') {
      where = { [Op.and]: [where, { status: statusParam.toLowerCase() }] };
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
    name: fd.tradeCommercialName ?? fd.name ?? '',
    inci: fd.inciName ?? fd.inci ?? '',
    category: fd.rmCategory ?? fd.category ?? fd.subCategory ?? fd.group ?? null,
    rm_type: fd.rmType ?? fd.rm_type ?? null,
    uom: fd.primaryUom ?? fd.uom ?? null,
    price_per_kg: fd.price_per_kg ?? (fd.pricePerKg != null ? Number(fd.pricePerKg) : null),
    gst: fd.gst != null ? Number(fd.gst) : null,
    shelf: fd.shelfLife ?? fd.retestPeriod ?? fd.shelf ?? null,
    status: (fd.status && String(fd.status).toLowerCase() === 'inactive') ? 'inactive' : 'active',
    products: Array.isArray(fd.products) ? fd.products : [],
    ...(omitGroupIfUnset && !hasGroup
      ? {}
      : { group: fd.subCategory ?? fd.group ?? b.group ?? b.subCategory ?? null }),
    zoho_id: fd.zoho_id ?? fd.zohoId ?? b.zoho_id ?? null,
    // Accept both the new `zoho_sku_code` field and legacy `sku` (backward compat).
    zoho_sku_code:
      fd.zoho_sku_code ?? fd.zohoSkuCode ?? b.zoho_sku_code ?? b.zohoSkuCode ??
      fd.sku ?? fd.rmSku ?? fd.code ?? b.sku ?? null,
    hsn_code: fd.hsnCode ?? fd.hsn_code ?? b.hsn_code ?? null,
    tax_pref: fd.rmTaxPreference ?? fd.tax_pref ?? fd.taxPref ?? b.tax_pref ?? null,
    sales_purchase_account: fd.accountingCategory ?? fd.sales_purchase_account ?? fd.salesPurchaseAccount ?? b.sales_purchase_account ?? null,
    specific_gravity: (() => {
      const src = fd.specificGravity ?? fd.specific_gravity ?? b.specific_gravity;
      if (src == null || src === '') return b.specific_gravity ?? null;
      const n = Number(src);
      return Number.isFinite(n) && n > 0 ? n : b.specific_gravity ?? null;
    })(),
    master_lifecycle_status:
      fd.masterLifecycleStatus ??
      fd.master_lifecycle_status ??
      b.master_lifecycle_status ??
      'Active',
    rm_owner: fd.rmOwner ?? fd.rm_owner ?? b.rm_owner ?? null,
    universal_swap_eligibility: (() => {
      const v = String(fd.universalSwapEligibility ?? fd.universal_swap_eligibility ?? '').trim();
      if (v === 'Yes' || v === 'No') return v;
      return b.universal_swap_eligibility ?? null;
    })(),
    functional_equivalents:
      fd.functionalEquivalents ?? fd.functional_equivalents ?? b.functional_equivalents ?? null,
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

async function destroyRawMaterialDraft(row) {
  if (!row) return;
  const whInv = await WarehouseInventory.findOne({
    where: activeRowWhere({ item_type: 'RM', raw_material_id: row.id }),
  });
  if (whInv) await softDeleteInstance(whInv);
  await softDeleteInstance(row);
}

/**
 * POST /api/v1/raw-materials/zoho-sync — Draft RM row + Zoho Books item (wizard step before full form submit).
 */
async function syncRmZoho(req, res) {
  try {
    const b = req.body || {};
    const fields = payloadToListFields(b);
    const codeTrim = fields.code != null ? String(fields.code).trim() : '';
    if (!codeTrim) {
      return res.status(400).json({ error: 'code or rmSku is required' });
    }
    fields.code = codeTrim;
    if (fields.zoho_sku_code != null && String(fields.zoho_sku_code).trim() !== '') {
      fields.zoho_sku_code = String(fields.zoho_sku_code).trim();
    } else {
      fields.zoho_sku_code = null;
    }

    let createdNewRow = false;
    let row = await RawMaterial.findOne({ where: { code: codeTrim } });
    if (row) {
      const dupSku = await findConflictingMasterRow(RawMaterial, fields.code, fields.zoho_sku_code, row.id);
      if (dupSku) {
        return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
      }
      await row.update(fields);
    } else {
      const dup = await findConflictingMasterRow(RawMaterial, fields.code, fields.zoho_sku_code, null);
      if (dup) {
        return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
      }
      row = await RawMaterial.create(fields);
      createdNewRow = true;
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
    }

    let zoho = await syncZohoItemForNewRawMaterial(row, b);
    if (zoho.error === 'already_has_zoho_id') {
      await row.reload();
      zoho = { synced: true, itemId: row.zoho_id };
    }
    if (zoho.synced && zoho.itemId) {
      try {
        // Mirror Zoho's persisted item.sku into the local row so the canonical SKU
        // matches Zoho exactly (the column has a partial UNIQUE index).
        const updatePatch = { zoho_id: zoho.itemId };
        if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
        await row.update(updatePatch);
        await row.reload();
      } catch (dbErr) {
        console.error('syncRmZoho: failed to save zoho_id, rolling back Zoho item', dbErr);
        await deleteItem(zoho.itemId).catch(() => {});
        if (createdNewRow) await destroyRawMaterialDraft(row);
        return res.status(500).json({ error: 'Failed to persist Zoho item id', code: 'ZOHO_ID_SAVE_FAILED' });
      }
    }

    if (zohoSyncIsMandatoryFailure(zoho)) {
      const status = zoho.duplicate ? 409 : 502;
      const errMsg = zoho.error || 'Zoho sync failed';
      const code = zoho.duplicate ? 'ZOHO_ITEM_DUPLICATE' : 'ZOHO_SYNC_FAILED';
      const zoho_sync = { synced: false, error: errMsg, duplicate: !!zoho.duplicate };
      if (createdNewRow) {
        await destroyRawMaterialDraft(row);
        return res.status(status).json({ error: errMsg, code, zoho_sync });
      }
      return res.status(status).json({
        error: errMsg,
        code,
        raw_material_id: row.id,
        zoho_sync,
      });
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
      raw_material_id: row.id,
      zoho_id: plain.zoho_id || null,
      zoho_sync,
    });
  } catch (err) {
    console.error('syncRmZoho error', err);
    return res.status(500).json({ error: err.message || 'Failed to sync raw material with Zoho' });
  }
}

/**
 * POST /api/v1/raw-materials — create. Body: full form payload (formData shape) or { form_data: {...} }.
 * Optional `raw_material_id` when the draft was created via POST /raw-materials/zoho-sync.
 */
async function createRawMaterial(req, res) {
  try {
    const b = req.body || {};
    const preIdRaw = b.raw_material_id ?? b.draft_raw_material_id;
    const preId = preIdRaw != null && preIdRaw !== '' ? parseInt(String(preIdRaw), 10) : NaN;

    if (!Number.isNaN(preId)) {
      const existingRow = await RawMaterial.findByPk(preId);
      if (!existingRow) {
        return res.status(404).json({ error: 'Draft raw material not found', code: 'RM_NOT_FOUND' });
      }
      const fields = payloadToListFields(b);
      const codeTrim = fields.code != null ? String(fields.code).trim() : '';
      if (!codeTrim) {
        return res.status(400).json({ error: 'code or rmSku is required' });
      }
      if (String(existingRow.code).trim() !== codeTrim) {
        return res.status(400).json({
          error: 'code must match the existing raw material row when raw_material_id is sent.',
          code: 'RM_CODE_MISMATCH',
        });
      }
      fields.code = codeTrim;
      if (fields.zoho_sku_code != null && String(fields.zoho_sku_code).trim() !== '') {
        fields.zoho_sku_code = String(fields.zoho_sku_code).trim();
      } else {
        fields.zoho_sku_code = null;
      }
      const nextSku = fields.zoho_sku_code !== undefined ? fields.zoho_sku_code : existingRow.zoho_sku_code;
      const dup = await findConflictingMasterRow(RawMaterial, fields.code, nextSku, existingRow.id);
      if (dup) {
        return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
      }

      const draftRowFd =
        existingRow.form_data != null && typeof existingRow.form_data === 'object' && !Array.isArray(existingRow.form_data)
          ? existingRow.form_data
          : {};
      const draftBodyFd = b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data) ? b.form_data : {};
      const draftMergedForSkuRule = { ...b, form_data: { ...draftRowFd, ...draftBodyFd } };
      const draftSkuRuleErr = validateInternalRmCodeForSubCategory(codeTrim, draftMergedForSkuRule);
      if (draftSkuRuleErr) {
        return res.status(400).json({ error: draftSkuRuleErr });
      }

      let zohoBooksItemToDelete = null;
      const t = await db.transaction();
      try {
        await existingRow.update(fields, { transaction: t });
        await existingRow.reload({ transaction: t });
        let zoho = await syncZohoItemForNewRawMaterial(existingRow, b);
        if (zoho.error === 'already_has_zoho_id') {
          await existingRow.reload({ transaction: t });
          zoho = { synced: true, itemId: existingRow.zoho_id };
        }
        if (zoho.synced && zoho.itemId) {
          const updatePatch = { zoho_id: zoho.itemId };
          if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
          await existingRow.update(updatePatch, { transaction: t });
          await existingRow.reload({ transaction: t });
          zohoBooksItemToDelete = zoho.itemId;
        } else if (zohoSyncIsMandatoryFailure(zoho)) {
          await t.rollback();
          await compensateZohoItemIfAny(null, zoho.itemId, deleteItem);
          const status = zoho.duplicate ? 409 : 502;
          return res.status(status).json({
            error: zoho.error || 'Zoho sync failed',
            code: zoho.duplicate ? 'ZOHO_ITEM_DUPLICATE' : 'ZOHO_SYNC_FAILED',
            zoho_sync: { synced: false, error: zoho.error, duplicate: !!zoho.duplicate },
          });
        }
        await t.commit();
        zohoBooksItemToDelete = null;
        const out = formatRawMaterialFull(existingRow);
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
        return res.status(200).json(out);
      } catch (inner) {
        await t.rollback();
        await compensateZohoItemIfAny(null, zohoBooksItemToDelete, deleteItem);
        throw inner;
      }
    }

    let zohoBooksItemToDelete = null;
    const t = await db.transaction();
    try {
      const fields = payloadToListFields(b);
      let codeTrim = fields.code != null ? String(fields.code).trim() : '';
      if (!codeTrim) {
        const alloc = await allocateNextRmSkuCode(b, { transaction: t });
        if (alloc.error) {
          await t.rollback();
          return res.status(400).json({ error: alloc.error });
        }
        fields.code = alloc.code;
        codeTrim = alloc.code;
        if (fields.form_data && typeof fields.form_data === 'object' && !Array.isArray(fields.form_data)) {
          fields.form_data = {
            ...fields.form_data,
            rmSku: alloc.code,
            seriesPrefix: alloc.seriesPrefix,
          };
        }
      } else {
        fields.code = codeTrim;
        const skuRuleErr = validateInternalRmCodeForSubCategory(codeTrim, b);
        if (skuRuleErr) {
          await t.rollback();
          return res.status(400).json({ error: skuRuleErr });
        }
      }
      if (fields.zoho_sku_code != null && String(fields.zoho_sku_code).trim() !== '') {
        fields.zoho_sku_code = String(fields.zoho_sku_code).trim();
      } else {
        fields.zoho_sku_code = null;
      }
      const dupCheck = await findConflictingMasterRow(RawMaterial, fields.code, fields.zoho_sku_code, null);
      if (dupCheck) {
        await t.rollback();
        return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
      }

      const row = await RawMaterial.create(fields, { transaction: t });
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
        transaction: t,
      });

      let zoho = await syncZohoItemForNewRawMaterial(row, b);
      if (zoho.error === 'already_has_zoho_id') {
        await row.reload({ transaction: t });
        zoho = { synced: true, itemId: row.zoho_id };
      }
      if (zoho.synced && zoho.itemId) {
        const updatePatch = { zoho_id: zoho.itemId };
        if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
        await row.update(updatePatch, { transaction: t });
        await row.reload({ transaction: t });
        zohoBooksItemToDelete = zoho.itemId;
      } else if (zohoSyncIsMandatoryFailure(zoho)) {
        await t.rollback();
        await compensateZohoItemIfAny(null, zoho.itemId, deleteItem);
        const status = zoho.duplicate ? 409 : 502;
        return res.status(status).json({
          error: zoho.error || 'Zoho sync failed',
          code: zoho.duplicate ? 'ZOHO_ITEM_DUPLICATE' : 'ZOHO_SYNC_FAILED',
          zoho_sync: { synced: false, error: zoho.error, duplicate: !!zoho.duplicate },
        });
      }

      await t.commit();
      zohoBooksItemToDelete = null;

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
      return res.status(201).json(out);
    } catch (inner) {
      await t.rollback();
      await compensateZohoItemIfAny(null, zohoBooksItemToDelete, deleteItem);
      if (inner.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: 'A raw material with this code or SKU already exists' });
      }
      console.error('createRawMaterial transaction error', inner);
      return res.status(500).json({ error: inner.message || 'Failed to create raw material' });
    }
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
    const nextCode = String(row.code || '').trim();
    if (!nextCode) {
      return res.status(400).json({ error: 'Existing raw material has no internal code' });
    }
    fields.code = nextCode;
    delete fields.zoho_sku_code;
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
    const row = await RawMaterial.findOne({ where: activeRowWhere({ id: req.params.id }) });
    if (!row) return res.status(404).json({ error: 'Raw material not found' });

    const whInv = await WarehouseInventory.findOne({
      where: activeRowWhere({ item_type: 'RM', raw_material_id: row.id }),
    });
    if (whInv) {
      await softDeleteWhere(WarehouseInventoryLocationHistory, { warehouse_inventory_id: whInv.id });
      await softDeleteInstance(whInv);
    }

    await softDeleteInstance(row);
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

/**
 * POST /api/v1/raw-materials/reset-all — delete every raw material and clean dependent rows (destructive).
 * Body: { "confirm": "RESET_ALL_RAW_MATERIALS" }
 */
async function resetAllRawMaterials(req, res) {
  const confirm = req.body && req.body.confirm != null ? String(req.body.confirm) : '';
  if (confirm !== 'RESET_ALL_RAW_MATERIALS') {
    return res.status(400).json({
      error: 'Confirmation required: POST JSON body { "confirm": "RESET_ALL_RAW_MATERIALS" }.',
    });
  }
  const t = await db.transaction();
  try {
    const stats = await resetRawMaterialsMasterData(t);
    await t.commit();
    Promise.all([
      redis.delByPattern('raw-materials:').catch(() => {}),
      redis.delByPattern('warehouse-inventory:').catch(() => {}),
      redis.delByPattern('planning-extracted:').catch(() => {}),
      redis.delByPattern('fulfillment:').catch(() => {}),
      redis.delByPattern('items-list:').catch(() => {}),
      redis.delByPattern('procurement:').catch(() => {}),
    ]).catch(() => {});
    res.json({
      ok: true,
      deletedRawMaterials: stats.deletedRawMaterials,
      message: 'All raw materials and dependent master data were removed.',
    });
  } catch (err) {
    await t.rollback();
    console.error('resetAllRawMaterials error', err);
    res.status(500).json({ error: err.message || 'Failed to reset raw materials' });
  }
}

module.exports = {
  listRawMaterials,
  getRawMaterialById,
  syncRmZoho,
  createRawMaterial,
  updateRawMaterial,
  deleteRawMaterial,
  getReservedStock,
  resetAllRawMaterials,
  formatRawMaterial,
};
