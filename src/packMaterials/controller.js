const db = require('../../db');
const { softDeleteInstance, softDeleteWhere, activeRowWhere } = require('../lib/softDelete');
const PackMaterial = require('./models');
const { syncZohoItemForNewPackMaterial } = require('../services/zohoMasterItemSync');
const zohoEnv = require('../services/zohoEnv');
const { deleteItem } = require('../services/zohoBooks');
const { zohoSyncIsMandatoryFailure } = require('../services/zohoSyncHelpers');
const { compensateZohoItemIfAny } = require('../lib/zohoDbTransaction');
const { Op } = require('sequelize');
const { findConflictingMasterRow } = require('../lib/itemCodeUniqueness');
const { parseMasterProductsFromPayload } = require('../lib/parseMasterProductsFromPayload');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const { ReservedBatchItem } = require('../fulfillment/models');
const { resetPackMaterialsMasterData } = require('../masters/resetMaterialMasters');
const redis = require('../cache/redis');
const { nextNumericCode, nextNumericSuffixAfterMax } = require('../lib/nextNumericMasterCode');
const {
  normalizePmSubCategorySlug,
  pmSkuSeriesKey,
  pmLevelForSubCategorySlug,
} = require('../lib/pmSubCategoryRules');
const { PM_CANONICAL_UNIT } = require('../warehouseInventory/whUnitDefaults');

/** All PM stock is counted in pieces (aligned with planning, production, warehouse). */
function canonicalPmUnit() {
  return PM_CANONICAL_UNIT;
}

async function syncPmWarehouseInventoryUnit(packMaterialId, transaction) {
  if (packMaterialId == null) return;
  await WarehouseInventory.update(
    { wh_unit: PM_CANONICAL_UNIT },
    {
      where: { item_type: 'PM', pack_material_id: packMaterialId },
      ...(transaction ? { transaction } : {}),
    },
  );
}

/** Canonical PM categories (PPM / SPM / TPM). Internal code: 4… / 5L… / 5M… / 5O… / 6T… / 6A… */
function getPmSubCategoryNormalized(b) {
  const fd =
    b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data) ? b.form_data : null;
  const fromGroup = String(b.group ?? '').trim();
  const slugFromGroup = normalizePmSubCategorySlug(fromGroup);
  if (slugFromGroup) return slugFromGroup;
  const fromPmSkuCategory = String(fd?.pmSkuCategory ?? '').trim();
  const slugFromPm = normalizePmSubCategorySlug(fromPmSkuCategory);
  if (slugFromPm) return slugFromPm;
  const raw = String(fd?.subCategory ?? b.subCategory ?? '').trim();
  return normalizePmSubCategorySlug(raw) || raw.toLowerCase();
}

/** @returns {{ regex: RegExp, like: string, build: (n: number) => string } | null} */
function pmSkuSeriesForSubCategory(subLower) {
  const seriesKey = pmSkuSeriesKey(subLower);
  if (seriesKey === 'primary') {
    return {
      regex: /^4(\d{5})$/,
      like: '4%',
      build: (n) => `4${String(n).padStart(5, '0')}`,
    };
  }
  if (seriesKey === 'monocarton') {
    return {
      regex: /^5M(\d{5})$/,
      like: '5M%',
      build: (n) => `5M${String(n).padStart(5, '0')}`,
    };
  }
  if (seriesKey === 'labels') {
    return {
      regex: /^5[Ll](\d{5})$/,
      like: '5L%',
      build: (n) => `5L${String(n).padStart(5, '0')}`,
    };
  }
  if (seriesKey === 'other-secondary') {
    return {
      regex: /^5O(\d{5})$/i,
      like: '5O%',
      build: (n) => `5O${String(n).padStart(5, '0')}`,
    };
  }
  if (seriesKey === 'tertiary') {
    return {
      regex: /^6T(\d{5})$/i,
      like: '6T%',
      build: (n) => `6T${String(n).padStart(5, '0')}`,
    };
  }
  if (seriesKey === 'ancillary') {
    return {
      regex: /^6A(\d{5})$/i,
      like: '6A%',
      build: (n) => `6A${String(n).padStart(5, '0')}`,
    };
  }
  return null;
}

/**
 * Internal `code` must match the PM category SKU series prefix.
 * @returns {string|null} error message or null
 */
function validatePmCodeForSubCategory(code, b) {
  const sub = getPmSubCategoryNormalized(b);
  const seriesKey = pmSkuSeriesKey(sub);
  if (!pmSkuSeriesForSubCategory(sub)) return null;
  const c = String(code || '').trim();
  if (seriesKey === 'primary' && !c.startsWith('4')) {
    return 'Internal PM code must start with "4" for PPM — Primary.';
  }
  if (seriesKey === 'monocarton' && !/^5M/i.test(c)) {
    return 'Internal PM code must start with "5M" for SPM — Monocartons.';
  }
  if (seriesKey === 'labels' && !/^5[Ll]/.test(c)) {
    return 'Internal PM code must start with "5L" for SPM — Labels.';
  }
  if (seriesKey === 'other-secondary' && !/^5O/i.test(c)) {
    return 'Internal PM code must start with "5O" for SPM — Other Secondary.';
  }
  if (seriesKey === 'tertiary' && !/^6T/i.test(c)) {
    return 'Internal PM code must start with "6T" for TPM — Tertiary.';
  }
  if (seriesKey === 'ancillary' && !/^6A/i.test(c)) {
    return 'Internal PM code must start with "6A" for TPM — Ancillary.';
  }
  return null;
}

/**
 * Next internal PM code for Primary / Monocarton / Labels.
 * @returns {Promise<{ code: string, seriesKey: string }|{ error: string }>}
 */
async function allocateNextPmInternalCode(b, { transaction }) {
  const sub = getPmSubCategoryNormalized(b);
  const series = pmSkuSeriesForSubCategory(sub);
  if (!series) {
    return {
      error:
        'Select a PM category (PPM, SPM Labels/Monocartons/Other Secondary, or TPM Tertiary/Ancillary) so an internal code can be assigned on save, or send an explicit code.',
    };
  }
  const sequelize = PackMaterial.sequelize;
  const dialect = sequelize.getDialect && sequelize.getDialect();
  if (dialect === 'postgres') {
    await sequelize.query('SELECT pg_advisory_xact_lock(98273502, 2)', { transaction });
  }
  const seriesKey = pmSkuSeriesKey(sub);
  const codeWhere =
    seriesKey === 'labels'
      ? { [Op.or]: [{ code: { [Op.like]: '5L%' } }, { code: { [Op.like]: '5l%' } }] }
      : { code: { [Op.like]: series.like } };
  const rows = await PackMaterial.findAll({
    attributes: ['code'],
    where: codeWhere,
    transaction,
  });
  let max = 0;
  for (const row of rows) {
    const codeStr = row.get ? row.get('code') : row.code;
    const m = String(codeStr || '').match(series.regex);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const code = series.build(nextNumericSuffixAfterMax(max));
  return { code, seriesKey: sub };
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
    zoho_sku_code: d.zoho_sku_code ?? null,
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
              { description: like },
              { type: like },
              { level: like },
              { material: like },
              { size_spec: like },
              { print_status: like },
            ],
          },
        ],
      };
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
 * GET /api/v1/pack-materials/next-code — next numeric code only (e.g. 00002). Query prefix is ignored (legacy).
 */
async function getNextCode(req, res) {
  try {
    const rows = await PackMaterial.findAll({ attributes: ['code'] });
    const codes = rows.map((row) => (row.get ? row.get('code') : row.code));
    const nextCode = nextNumericCode(codes, 5);
    res.json({ nextCode });
  } catch (err) {
    console.error('getNextCode error', err);
    res.status(500).json({ error: 'Failed to get next code' });
  }
}

/** Map request body (camelCase or snake_case) to pack_materials columns. */
function bodyToPackMaterial(b, preserveUnsetProducts = false) {
  const fd = b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data) ? b.form_data : {};
  const subRaw = fd.subCategory ?? b.subCategory ?? b.group ?? fd.pmSkuCategory ?? '';
  const subSlug = normalizePmSubCategorySlug(subRaw) || String(subRaw || '').trim().toLowerCase();
  const levelFromSub = subSlug ? pmLevelForSubCategorySlug(subSlug) : null;
  const levelExplicit = b.level ?? fd.level ?? null;
  const products = parseMasterProductsFromPayload(b, { preserveWhenUnset: preserveUnsetProducts });
  const base = {
    code: b.code ?? b.itemCode ?? '',
    description: fd.tradeCommercialName ?? b.description ?? b.name ?? null,
    type: b.type ?? b.itemCategory ?? null,
    level: levelExplicit || levelFromSub || null,
    group: subSlug || subRaw || null,
    material: b.pmCategory ?? b.material ?? b.matBody ?? b.subCategory ?? b.group ?? null,
    size_spec: b.size_spec ?? b.specNominal ?? null,
    price_per_pc: b.price_per_pc != null ? Number(b.price_per_pc) : (b.pricePerPc != null ? Number(b.pricePerPc) : null),
    moq: b.moq != null ? Number(b.moq) : null,
    lead_time_days: b.lead_time_days != null ? Number(b.lead_time_days) : (b.leadTimeDays != null ? Number(b.leadTimeDays) : null),
    print_status: b.print_status ?? b.printStatus ?? null,
    zoho_id: b.zoho_id ?? b.zohoId ?? null,
    // Accept both the new `zoho_sku_code` field and legacy `sku` (backward compat).
    zoho_sku_code:
      b.zoho_sku_code ?? b.zohoSkuCode ??
      b.sku ?? b.pkgSku ?? b.code ?? b.itemCode ?? null,
    hsn_code: b.hsn_code ?? b.pkgHsn ?? b.hsnCode ?? null,
    unit: canonicalPmUnit(),
    tax_pref: b.tax_pref ?? b.pkgTaxPreference ?? b.taxPref ?? null,
    pkg_returnable: b.pkg_returnable ?? b.pkgReturnable ?? null,
    pkg_associate_items: b.pkg_associate_items ?? b.pkgAssociateItems ?? b.associateItems ?? null,
    sales_purchase_account: b.sales_purchase_account ?? b.salesPurchaseAccount ?? null,
    ...(b.form_data !== undefined ? { form_data: b.form_data } : {}),
  };
  if (products !== undefined) {
    base.products = products;
  }
  return base;
}

async function destroyPackMaterialDraft(row) {
  if (!row) return;
  const whInv = await WarehouseInventory.findOne({
    where: activeRowWhere({ item_type: 'PM', pack_material_id: row.id }),
  });
  if (whInv) await softDeleteInstance(whInv);
  await softDeleteInstance(row);
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
    if (fields.zoho_sku_code != null && String(fields.zoho_sku_code).trim() !== '') {
      fields.zoho_sku_code = String(fields.zoho_sku_code).trim();
    } else {
      fields.zoho_sku_code = null;
    }

    let createdNewRow = false;
    let row = await PackMaterial.findOne({ where: { code: codeTrim } });
    if (row) {
      const dupSku = await findConflictingMasterRow(PackMaterial, fields.code, fields.zoho_sku_code, row.id);
      if (dupSku) {
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }
      Object.keys(fields).forEach((key) => {
        if (fields[key] !== undefined) row.set(key, fields[key]);
      });
      if (b.form_data !== undefined) row.set('form_data', b.form_data);
      await row.save();
      await syncPmWarehouseInventoryUnit(row.id);
    } else {
      const dup = await findConflictingMasterRow(PackMaterial, fields.code, fields.zoho_sku_code, null);
      if (dup) {
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }
      row = await PackMaterial.create(fields);
      createdNewRow = true;
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PM', pack_material_id: row.id },
        defaults: {
          item_type: 'PM',
          pack_material_id: row.id,
          wh_stock: 0,
          wh_unit: PM_CANONICAL_UNIT,
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
      try {
        // Mirror Zoho's persisted item.sku into the local row so the canonical SKU
        // matches Zoho exactly (the column has a partial UNIQUE index).
        const updatePatch = { zoho_id: zoho.itemId };
        if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
        await row.update(updatePatch);
        await row.reload();
      } catch (dbErr) {
        console.error('syncPmZoho: failed to save zoho_id, rolling back Zoho item', dbErr);
        await deleteItem(zoho.itemId).catch(() => {});
        if (createdNewRow) await destroyPackMaterialDraft(row);
        return res.status(500).json({ error: 'Failed to persist Zoho item id', code: 'ZOHO_ID_SAVE_FAILED' });
      }
    }

    if (zohoSyncIsMandatoryFailure(zoho)) {
      const status = zoho.duplicate ? 409 : 502;
      const errMsg = zoho.error || 'Zoho sync failed';
      const code = zoho.duplicate ? 'ZOHO_ITEM_DUPLICATE' : 'ZOHO_SYNC_FAILED';
      const zoho_sync = { synced: false, error: errMsg, duplicate: !!zoho.duplicate };
      if (createdNewRow) {
        await destroyPackMaterialDraft(row);
        return res.status(status).json({ error: errMsg, code, zoho_sync });
      }
      return res.status(status).json({
        error: errMsg,
        code,
        pack_material_id: row.id,
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
      const existingRow = await PackMaterial.findByPk(preId);
      if (!existingRow) {
        return res.status(404).json({ error: 'Draft pack material not found', code: 'PM_NOT_FOUND' });
      }
      const fields = bodyToPackMaterial(b);
      const codeTrim = fields.code != null ? String(fields.code).trim() : '';
      if (!codeTrim) {
        return res.status(400).json({ error: 'code or itemCode is required' });
      }
      if (String(existingRow.code).trim() !== codeTrim) {
        return res.status(400).json({
          error: 'code must match the existing pack material row when pack_material_id is sent.',
          code: 'PM_CODE_MISMATCH',
        });
      }
      fields.code = codeTrim;
      if (fields.zoho_sku_code != null && String(fields.zoho_sku_code).trim() !== '') {
        fields.zoho_sku_code = String(fields.zoho_sku_code).trim();
      } else {
        fields.zoho_sku_code = null;
      }
      const nextSku = fields.zoho_sku_code !== undefined ? fields.zoho_sku_code : existingRow.zoho_sku_code;
      const dup = await findConflictingMasterRow(PackMaterial, fields.code, nextSku, existingRow.id);
      if (dup) {
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }

      const exPlain = existingRow.get({ plain: true });
      const exFd =
        exPlain.form_data != null && typeof exPlain.form_data === 'object' && !Array.isArray(exPlain.form_data)
          ? exPlain.form_data
          : {};
      const bodyFd = b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data) ? b.form_data : {};
      const mergedForRule = {
        ...b,
        group: fields.group !== undefined && fields.group != null && String(fields.group).trim() !== ''
          ? fields.group
          : exPlain.group,
        form_data: { ...exFd, ...bodyFd },
      };
      const pmSkuErr = validatePmCodeForSubCategory(codeTrim, mergedForRule);
      if (pmSkuErr) {
        return res.status(400).json({ error: pmSkuErr });
      }

      let zohoBooksItemToDelete = null;
      const t = await db.transaction();
      try {
        Object.keys(fields).forEach((key) => {
          if (fields[key] !== undefined) existingRow.set(key, fields[key]);
        });
        if (b.form_data !== undefined) existingRow.set('form_data', b.form_data);
        await existingRow.save({ transaction: t });
        await existingRow.reload({ transaction: t });

        let zoho = await syncZohoItemForNewPackMaterial(existingRow, b);
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
        const out = formatPackMaterialFull(existingRow);
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
      const fields = bodyToPackMaterial(b);
      let codeTrim = fields.code != null ? String(fields.code).trim() : '';
      if (!codeTrim) {
        const alloc = await allocateNextPmInternalCode(b, { transaction: t });
        if (alloc.error) {
          await t.rollback();
          return res.status(400).json({ error: alloc.error });
        }
        fields.code = alloc.code;
        codeTrim = alloc.code;
        if (fields.form_data != null && typeof fields.form_data === 'object' && !Array.isArray(fields.form_data)) {
          fields.form_data = { ...fields.form_data, itemCode: alloc.code };
        }
      } else {
        const errSku = validatePmCodeForSubCategory(codeTrim, b);
        if (errSku) {
          await t.rollback();
          return res.status(400).json({ error: errSku });
        }
        fields.code = codeTrim;
      }
      if (fields.zoho_sku_code != null && String(fields.zoho_sku_code).trim() !== '') {
        fields.zoho_sku_code = String(fields.zoho_sku_code).trim();
      } else {
        fields.zoho_sku_code = null;
      }
      const dupCheck = await findConflictingMasterRow(PackMaterial, fields.code, fields.zoho_sku_code, null);
      if (dupCheck) {
        await t.rollback();
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }

      const row = await PackMaterial.create(fields, { transaction: t });
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PM', pack_material_id: row.id },
        defaults: {
          item_type: 'PM',
          pack_material_id: row.id,
          wh_stock: 0,
          wh_unit: PM_CANONICAL_UNIT,
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

      let zoho = await syncZohoItemForNewPackMaterial(row, b);
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

      const out = formatPackMaterialFull(row);
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
        return res.status(409).json({ error: 'A pack material with this code or SKU already exists' });
      }
      console.error('createPackMaterial transaction error', inner);
      return res.status(500).json({ error: inner.message || 'Failed to create pack material' });
    }
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
    const fields = bodyToPackMaterial(b, true);
    const nextCode = String(row.code || '').trim();
    if (!nextCode) {
      return res.status(400).json({ error: 'Existing pack material has no internal code' });
    }
    fields.code = nextCode;
    delete fields.zoho_sku_code;
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
    const row = await PackMaterial.findOne({ where: activeRowWhere({ id }) });
    if (!row) return res.status(404).json({ error: 'Pack material not found' });

    const whInv = await WarehouseInventory.findOne({
      where: activeRowWhere({ item_type: 'PM', pack_material_id: row.id }),
    });
    if (whInv) {
      await softDeleteWhere(WarehouseInventoryLocationHistory, { warehouse_inventory_id: whInv.id });
      await softDeleteInstance(whInv);
    }

    await softDeleteInstance(row);
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

/**
 * POST /api/v1/pack-materials/reset-all — delete every pack material and clean dependent rows (destructive).
 * Body: { "confirm": "RESET_ALL_PACK_MATERIALS" }
 */
async function resetAllPackMaterials(req, res) {
  const confirm = req.body && req.body.confirm != null ? String(req.body.confirm) : '';
  if (confirm !== 'RESET_ALL_PACK_MATERIALS') {
    return res.status(400).json({
      error: 'Confirmation required: POST JSON body { "confirm": "RESET_ALL_PACK_MATERIALS" }.',
    });
  }
  const t = await db.transaction();
  try {
    const stats = await resetPackMaterialsMasterData(t);
    await t.commit();
    Promise.all([
      redis.delByPattern('pack-materials:').catch(() => {}),
      redis.delByPattern('warehouse-inventory:').catch(() => {}),
      redis.delByPattern('planning-extracted:').catch(() => {}),
      redis.delByPattern('fulfillment:').catch(() => {}),
      redis.delByPattern('items-list:').catch(() => {}),
      redis.delByPattern('procurement:').catch(() => {}),
    ]).catch(() => {});
    res.json({
      ok: true,
      deletedPackMaterials: stats.deletedPackMaterials,
      message: 'All pack materials and dependent master data were removed.',
    });
  } catch (err) {
    await t.rollback();
    console.error('resetAllPackMaterials error', err);
    res.status(500).json({ error: err.message || 'Failed to reset pack materials' });
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
  resetAllPackMaterials,
  formatPackMaterial,
};
