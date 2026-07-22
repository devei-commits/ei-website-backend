const db = require('../../db');
const { Product } = require('./models');
const { productSchema, productUpdateSchema, categorySchema, categoryUpdateSchema } = require('./schemas');
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const BOM = require('../bom/models');
const PackMaterial = require('../packMaterials/models');
const SalesOrder = require('../salesOrders/models');
const WarehouseInventory = require('../warehouseInventory/models');
const VendorClient = require('../vendorClient/models');
const redisCache = require('../cache/redis');
const { syncZohoItemForNewProduct } = require('./zohoItemSync');
const zohoEnv = require('../services/zohoEnv');
const { deleteItem, findItemsBySku } = require('../services/zohoBooks');
const { toProductFields } = require('../services/zohoImportItemFields');
const { zohoSyncIsMandatoryFailure } = require('../services/zohoSyncHelpers');
const { compensateZohoItemIfAny } = require('../lib/zohoDbTransaction');
const {
  validateSkuBomTotals,
  countMeaningfulSkuRmLines,
  validateFormulaPctNotOver100,
} = require('../bom/skuBomMath');
const {
  softDeleteProductWithDependents,
  scrubProcurementJsonForDeletedProducts,
} = require('./destroyProductWithDependents');
const { productActiveWhere, softDeleteInstance } = require('../lib/softDelete');
const { resolveMasterApprovalStatus } = require('../lib/masterApprovalStatus');
const { preservePrApprovalOnWrite, resolveWritableMasterApprovalStatus } = require('../lib/masterApprovalAuth');
const {
  handleMasterApprovalPatch,
  prApprovalHooks,
} = require('../lib/masterApprovalPatchHandlers');
const { createMasterApprovalStatusHistoryHandler } = require('../lib/masterApprovalStatusHistory');
const {
  readApprovalStatusFromMasterRow,
  applyAutoAssignPrCreatorOnCreate,
  applyAutoAssignOnTouch,
} = require('../lib/masterApprovalAutoAssign');
const {
  readTrackApprovals,
  formatTrackApprovalsForApi,
  detectChangedSections,
  canActOnTrack,
  applyTrackAction,
  readTrackOwner,
  emptyTrackState,
  callerIdFromReq,
  TRACK_STAGE_KEY,
  TRACK_LABEL,
} = require('../lib/prTrackApproval');
const {
  readMasterApprovalStageAssignees,
  formatStageAssigneesForApi,
  buildStageSlotForUserId,
} = require('../lib/masterApprovalAssignee');
const { isPrivilegedRole } = require('../middleware/security');
const {
  hydratePrQualitySpecRowsBySectionFromBom,
  hydratePrQualityBulkSubSpecRowsByPathFromBom,
  hydratePrQualityFinalSubSpecRowsByPathFromBom,
  hydratePrQualityDispatchSubSpecRowsByPathFromBom,
  prQualitySpecBomColumnPatch,
} = require('./prQualitySpecStorage');
const {
  hydratePrFacilityLicencesFromBom,
  flattenPrFacilityLicencesForStorage,
} = require('./prFacilityLicenceStorage');
const { linkMaterialMastersToProductCode } = require('./linkMaterialMastersToProduct');
const { PR_QUALITY_SPEC_EDIT_KEYS, payloadHasQualitySpecEdits } = require('../qualitySpecRules/itemLock');
const {
  resolvePrQualitySpecCategory,
  resolvePrQualitySpecSubCategory,
  resolvePrSubSpecPath,
} = require('../qualitySpecRules/prCategoryResolve');
const { resolvePrEntityQualitySpecs } = require('../qualitySpecRules/resolveForItem');
const { normalizePmSubCategorySlug, pmLevelForSubCategorySlug } = require('../lib/pmSubCategoryRules');
const { nextNumericSuffixAfterMax } = require('../lib/nextNumericMasterCode');
const {
  resolveWebsiteClientId,
  attachClientPricingToProducts,
  attachClientPricingToProduct,
} = require('./clientPricing');

/** @param {Record<string, unknown>} b @param {{ defaultPermanent?: boolean }} [opts] @returns {'temporary'|'permanent'|null} */
function normalizePrRecordTypeFromBody(b, opts = {}) {
  const { defaultPermanent = false } = opts;
  const raw = b?.pr_record_type ?? b?.prRecordType ?? b?.record_type ?? b?.recordType;
  if (raw == null || raw === '') {
    return defaultPermanent ? 'permanent' : null;
  }
  const s = String(raw).trim().toLowerCase();
  if (['temporary', 'temp', 't'].includes(s)) return 'temporary';
  if (['permanent', 'perm', 'p'].includes(s)) return 'permanent';
  return defaultPermanent ? 'permanent' : null;
}

/**
 * @param {string} code
 * @param {'temporary'|'permanent'|null|undefined} recordType
 * @returns {string|null} error message
 */
function validatePrProductCodeForRecordType(code, recordType) {
  if (!recordType) return null;
  const c = String(code || '').trim();
  if (!c) return 'product_code is required';
  if (recordType === 'temporary') {
    if (!/^TPR/i.test(c)) {
      return 'Temporary PR records must use an internal product code starting with "TPR".';
    }
    return null;
  }
  if (recordType === 'permanent') {
    if (!/^PR/i.test(c)) {
      return 'Permanent PR records must use an internal product code starting with "PR".';
    }
    return null;
  }
  return null;
}

/**
 * Next internal PR code: TPR##### or PR##### (shared sequence space with boms.bom_code).
 * @param {'temporary'|'permanent'} recordType
 * @param {import('sequelize').Transaction} transaction
 */
async function allocateNextPrProductCode(recordType, transaction) {
  const sequelize = Product.sequelize;
  const dialect = sequelize.getDialect && sequelize.getDialect();
  if (dialect === 'postgres') {
    await sequelize.query('SELECT pg_advisory_xact_lock(98273503, 3)', { transaction });
  }
  const prefix = recordType === 'temporary' ? 'TPR' : 'PR';
  const re = recordType === 'temporary' ? /^TPR(\d{5})$/i : /^PR(\d{5})$/i;
  const like = `${prefix}%`;
  const [bomRows, prodRows] = await Promise.all([
    BOM.findAll({ attributes: ['bom_code'], where: { bom_code: { [Op.like]: like } }, transaction }),
    Product.findAll({ attributes: ['product_code'], where: { product_code: { [Op.like]: like } }, transaction }),
  ]);
  let max = 0;
  const bump = (raw) => {
    const m = String(raw || '').trim().match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  };
  for (const row of bomRows) bump(row.get ? row.get('bom_code') : row.bom_code);
  for (const row of prodRows) bump(row.get ? row.get('product_code') : row.product_code);
  const next = nextNumericSuffixAfterMax(max);
  return `${prefix}${String(next).padStart(5, '0')}`;
}

function normSkuLimitQty(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

function normSkuLimitUom(v) {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  return s || null;
}

function skuLimitQtyClose(a, b) {
  const na = normSkuLimitQty(a);
  const nb = normSkuLimitQty(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 1e-9;
}

function skuLimitUomClose(a, b) {
  return normSkuLimitUom(a) === normSkuLimitUom(b);
}

/** True when saving a PR master as Draft (formula/pack lines optional). */
function isPrDraftWrite(body, existingProduct) {
  const raw =
    body?.status ??
    body?.lifecycle_status ??
    (existingProduct
      ? existingProduct.status ?? existingProduct.lifecycle_status
      : null) ??
    'Draft';
  return String(raw).trim().toLowerCase() === 'draft';
}

/** At least one non-empty formula line (INCI / RM code / positive %). */
function countMeaningfulRmLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter((line) => {
    const inci = String(line?.inci_name ?? line?.inciName ?? '').trim();
    const code = String(line?.rm_code ?? line?.rmCode ?? '').trim();
    const groupId = line?.item_group_id ?? line?.itemGroupId;
    const hasGroup = groupId != null && String(groupId).trim() !== '' && !Number.isNaN(Number(groupId));
    const pctRaw = line?.pct_w_w ?? line?.pctWw ?? line?.pct;
    const pct =
      pctRaw != null && pctRaw !== ''
        ? parseFloat(String(pctRaw).replace(/[^\d.-]/g, ''))
        : NaN;
    const hasPct = !Number.isNaN(pct) && pct > 0;
    return Boolean(inci || code || hasGroup || hasPct);
  }).length;
}

/** At least one non-empty pack line (description / PM code). */
function countMeaningfulPmLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter((line) => {
    const desc = String(
      line?.description ?? line?.pm_description ?? line?.pmDescription ?? ''
    ).trim();
    const code = String(line?.pm_code ?? line?.pmCode ?? '').trim();
    return Boolean(desc || code);
  }).length;
}

function parseBomNotes(notes) {
  const result = {
    pr_qc_group: null,
    pr_sub_category: null,
    microbial_limits: null,
    spf_pa_rating: null,
    photostability: null,
    freeze_thaw_cycles: null,
    cosmos_natural_certification: null,
    dermatologically_tested: null,
    cruelty_free_vegan: null,
  };
  const text = String(notes || '').trim();
  if (!text) return result;
  const parts = text.split('|').map((p) => String(p || '').trim()).filter(Boolean);
  parts.forEach((part) => {
    const idx = part.indexOf(':');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (!value) return;
    if (key === 'qc group') result.pr_qc_group = value;
    if (key === 'pr sub-category') result.pr_sub_category = value;
    if (key === 'microbial limits') result.microbial_limits = value;
    if (key === 'spf/pa rating') result.spf_pa_rating = value;
    if (key === 'photostability') result.photostability = value;
    if (key === 'freeze-thaw cycles') result.freeze_thaw_cycles = value;
    if (key === 'cosmos / natural certification') result.cosmos_natural_certification = value;
    if (key === 'dermatologically tested') result.dermatologically_tested = value;
    if (key === 'cruelty free / vegan') result.cruelty_free_vegan = value;
  });
  return result;
}

const saveProduct = async (req, res) => {
  try {
    const { product_name } = req.body;

    if (!product_name) {
      return res.status(400).json({ error: "product_name is required" });
    }

    // check existing
    const existing = await Product.findOne({
      where: { product_name },
    });

    if (existing) {
      return res.status(409).json({ error: "Product already exists!" });
    }

    let zohoBooksItemToDelete = null;
    const t = await db.transaction();
    try {
      const product = await Product.create(
        {
          ...req.body,
          created_at: new Date(),
        },
        { transaction: t }
      );

      let zoho = await syncZohoItemForNewProduct(product, req.body);
      if (zoho.error === 'already_has_zoho_item_id') {
        await product.reload({ transaction: t });
        zoho = { synced: true, itemId: product.zoho_item_id };
      }
      const payload = product.get ? product.get({ plain: true }) : { ...product };
      if (zoho.synced && zoho.itemId) {
        // Mirror Zoho's persisted item.sku into zoho_sku_code so the canonical SKU
        // matches Zoho exactly (the column has a partial UNIQUE index).
        const updatePatch = { zoho_item_id: zoho.itemId };
        if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
        await product.update(updatePatch, { transaction: t });
        await product.reload({ transaction: t });
        zohoBooksItemToDelete = zoho.itemId;
        payload.zoho_item_id = zoho.itemId;
        if (updatePatch.zoho_sku_code) payload.zoho_sku_code = updatePatch.zoho_sku_code;
      } else if (zohoSyncIsMandatoryFailure(zoho)) {
        await t.rollback();
        await compensateZohoItemIfAny(null, zoho.itemId, deleteItem);
        const status = zoho.duplicate ? 409 : 502;
        return res.status(status).json({
          error: zoho.error || 'Zoho sync failed',
          code: zoho.duplicate ? 'ZOHO_ITEM_DUPLICATE' : 'ZOHO_SYNC_FAILED',
          zoho_sync: { synced: false, error: zoho.error, duplicate: !!zoho.duplicate },
        });
      } else if (
        zohoEnv.booksEnabled &&
        zohoEnv.syncItems &&
        zoho.error &&
        zoho.error !== 'zoho_disabled' &&
        zoho.error !== 'item_sync_disabled' &&
        zoho.error !== 'already_has_zoho_item_id'
      ) {
        payload.zoho_sync = { synced: false, error: zoho.error };
      }

      await t.commit();
      zohoBooksItemToDelete = null;
      return res.status(201).json(payload);
    } catch (inner) {
      await t.rollback();
      await compensateZohoItemIfAny(null, zohoBooksItemToDelete, deleteItem);
      if (inner && inner.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: inner.message });
      }
      console.error('saveProduct transaction error', inner);
      return res.status(500).json({ error: inner.message || 'Failed to create product' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/v1/products/zoho-import-by-sku — Import a product that already exists in Zoho Books
 * but is MISSING from our system. Body: { sku }. Fetches the Zoho item by exact SKU and creates
 * the PR row locally (mirrors zoho_item_id + zoho_sku_code). Never pushes back to Zoho.
 */
const importPrFromZohoBySku = async (req, res) => {
  try {
    const b = req.body || {};
    const sku = String(b.sku ?? b.zoho_sku_code ?? b.product_code ?? '').trim();
    if (!sku) {
      return res.status(400).json({ error: 'sku is required' });
    }

    let matches;
    try {
      matches = await findItemsBySku(sku);
    } catch (e) {
      console.error('importPrFromZohoBySku: Zoho lookup failed', e);
      return res.status(502).json({ error: e.message || 'Failed to query Zoho', code: 'ZOHO_LOOKUP_FAILED' });
    }
    if (!matches.length) {
      return res.status(404).json({ error: `No Zoho item found with SKU "${sku}"`, code: 'ZOHO_ITEM_NOT_FOUND' });
    }
    if (matches.length > 1) {
      return res
        .status(409)
        .json({ error: `Multiple Zoho items share SKU "${sku}"; resolve in Zoho first`, code: 'ZOHO_ITEM_AMBIGUOUS' });
    }

    const zf = toProductFields(matches[0]);
    const product_code = String(zf.product_code || zf.zoho_sku_code || '').trim();
    const product_name = String(zf.product_name || product_code || '').trim();
    if (!product_code) {
      return res.status(422).json({ error: 'Zoho item has no SKU to use as product_code', code: 'ZOHO_ITEM_NO_SKU' });
    }

    const existsCode = await Product.findOne({ where: { product_code } });
    if (existsCode) {
      return res.status(409).json({
        error: `A product with code "${product_code}" already exists`,
        code: 'MASTER_ALREADY_EXISTS',
        product_id: existsCode.product_id,
      });
    }
    if (zf.zoho_sku_code) {
      const skuTaken = await Product.findOne({ where: { zoho_sku_code: zf.zoho_sku_code } });
      if (skuTaken) {
        return res.status(409).json({
          error: `A product with SKU "${zf.zoho_sku_code}" already exists`,
          code: 'MASTER_ALREADY_EXISTS',
          product_id: skuTaken.product_id,
        });
      }
    }
    const nameTaken = await Product.findOne({ where: { product_name } });
    if (nameTaken) {
      return res.status(409).json({
        error: `Product name "${product_name}" is already in use`,
        code: 'PRODUCT_NAME_EXISTS',
        product_id: nameTaken.product_id,
      });
    }

    const approvalStatus = await resolveWritableMasterApprovalStatus(req, 'PR', undefined, { forCreate: true });
    const now = new Date();
    const productRow = {
      ...zf,
      product_name,
      product_code,
      status: approvalStatus,
      lifecycle_status: approvalStatus,
      created_at: now,
      updated_at: now,
    };
    await applyAutoAssignPrCreatorOnCreate(req, productRow);
    const product = await Product.create(productRow);

    return res.status(201).json({
      product_id: product.product_id,
      imported: true,
      source: 'zoho',
      zoho_item_id: product.zoho_item_id || null,
      product: product.get({ plain: true }),
    });
  } catch (err) {
    console.error('importPrFromZohoBySku error', err);
    return res.status(500).json({ error: err.message || 'Failed to import product from Zoho' });
  }
};

/**
 * POST /products/pr-zoho-sync — Create or update a draft `products` row and sync a Zoho Books item (PR wizard step 0).
 * Does not create BOM; final POST /products/pr-registration completes the wizard.
 */
const syncPrProductZoho = async (req, res) => {
  try {
    const b = req.body || {};
    const product_name = String(b.product_name ?? b.name ?? '').trim();
    const product_code = String(b.product_code ?? b.bomCode ?? '').trim();
    if (!product_name) return res.status(400).json({ error: 'product_name is required' });
    if (!product_code) return res.status(400).json({ error: 'product_code is required' });

    const mrpRaw = b.mrp_price ?? b.mrp;
    let mrp_price = null;
    if (mrpRaw != null && mrpRaw !== '') {
      const n = parseFloat(String(mrpRaw).replace(/[^\d.]/g, ''));
      if (!Number.isNaN(n)) mrp_price = n;
    }
    // Accept new `zoho_sku_code` field, fall back to legacy `product_sku` / `bomSku` for backward compat.
    const bomSku = String(b.zoho_sku_code ?? b.product_sku ?? b.bomSku ?? product_code).trim();
    const now = new Date();

    let createdNewProduct = false;
    let product = await Product.findOne({ where: { product_code } });

    const approvalStatus = await resolveWritableMasterApprovalStatus(req, 'PR', b.status ?? b.lifecycle_status, {
      existing: product?.status ?? product?.lifecycle_status,
      forCreate: !product,
    });
    const productRow = {
      product_name,
      product_code,
      zoho_sku_code: bomSku,
      generic_name: b.generic_name ?? b.category ?? null,
      brand_name: b.brand_name ?? b.client ?? null,
      category: b.category ?? null,
      status: approvalStatus,
      lifecycle_status: approvalStatus,
      form: b.form ?? b.type ?? null,
      product_description: b.product_description ?? b.description ?? null,
      storage_conditions: b.storage_conditions ?? null,
      mrp_price,
      updated_at: now,
    };

    if (product) {
      const nameTaken = await Product.findOne({ where: { product_name } });
      if (nameTaken && nameTaken.product_id !== product.product_id) {
        return res.status(409).json({
          error: `Product name "${product_name}" is already in use.`,
          code: 'PRODUCT_NAME_EXISTS',
        });
      }
      // SKU uniqueness pre-check: only when SKU differs from product_code (otherwise
      // the product_code lookup above already covered the same identifier).
      if (bomSku && bomSku !== product_code) {
        const skuTaken = await Product.findOne({ where: { zoho_sku_code: bomSku } });
        if (skuTaken && skuTaken.product_id !== product.product_id) {
          return res.status(409).json({
            error: `Product SKU "${bomSku}" is already in use.`,
            code: 'PRODUCT_SKU_EXISTS',
          });
        }
      }
      await product.update(
        await applyAutoAssignOnTouch(
          req,
          product,
          readApprovalStatusFromMasterRow('PR', product),
          productRow
        )
      );
    } else {
      const nameTaken = await Product.findOne({ where: { product_name } });
      if (nameTaken) {
        return res.status(409).json({
          error: `Product name "${product_name}" is already in use.`,
          code: 'PRODUCT_NAME_EXISTS',
        });
      }
      if (bomSku && bomSku !== product_code) {
        const skuTaken = await Product.findOne({ where: { zoho_sku_code: bomSku } });
        if (skuTaken) {
          return res.status(409).json({
            error: `Product SKU "${bomSku}" is already in use.`,
            code: 'PRODUCT_SKU_EXISTS',
          });
        }
      }
      await applyAutoAssignPrCreatorOnCreate(req, productRow);
      product = await Product.create({
        ...productRow,
        created_at: now,
      });
      createdNewProduct = true;
    }

    let zoho = await syncZohoItemForNewProduct(product, b);
    if (zoho.error === 'already_has_zoho_item_id') {
      await product.reload();
      zoho = { synced: true, itemId: product.zoho_item_id };
    }
    if (zoho.synced && zoho.itemId) {
      try {
        const updatePatch = { zoho_item_id: zoho.itemId, updated_at: now };
        if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
        await product.update(updatePatch);
        await product.reload();
      } catch (dbErr) {
        console.error('syncPrProductZoho: failed to save zoho_item_id, rolling back Zoho item', dbErr);
        await deleteItem(zoho.itemId).catch(() => {});
        if (createdNewProduct) await product.destroy();
        return res.status(500).json({ error: 'Failed to persist Zoho item id', code: 'ZOHO_ID_SAVE_FAILED' });
      }
    }

    if (zohoSyncIsMandatoryFailure(zoho)) {
      const status = zoho.duplicate ? 409 : 502;
      const errMsg = zoho.error || 'Zoho sync failed';
      const code = zoho.duplicate ? 'ZOHO_ITEM_DUPLICATE' : 'ZOHO_SYNC_FAILED';
      const zoho_sync = { synced: false, error: errMsg, duplicate: !!zoho.duplicate };
      if (createdNewProduct) {
        await product.destroy();
        return res.status(status).json({ error: errMsg, code, zoho_sync });
      }
      return res.status(status).json({
        error: errMsg,
        code,
        product_id: product.product_id,
        zoho_sync,
      });
    }

    const plain = product.get({ plain: true });
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
      zohoErr !== 'already_has_zoho_item_id'
    ) {
      zoho_sync = { synced: false, error: zohoErr };
    } else {
      zoho_sync = { synced: false, skipped: true, resolvedWithoutZoho: true, reason: zohoErr || 'unknown' };
    }

    return res.status(200).json({
      product_id: product.product_id,
      zoho_item_id: plain.zoho_item_id || null,
      zoho_sync,
    });
  } catch (err) {
    console.error('syncPrProductZoho error', err);
    return res.status(500).json({ error: err.message || 'Failed to sync with Zoho' });
  }
};

/**
 * POST /products/pr-registration — PR Master wizard: create `products` row + linked `boms` row.
 * Expects product_name; product_code optional (auto-allocated as TPR##### / PR##### when omitted).
 * Optional `product_id` when the draft row was created via POST /products/pr-zoho-sync (code must match draft).
 */
const createPRRegistration = async (req, res) => {
  try {
    const b = req.body || {};
    const product_name = String(b.product_name ?? b.name ?? '').trim();
    let product_code = String(b.product_code ?? b.bomCode ?? '').trim();
    if (!product_name) return res.status(400).json({ error: 'product_name is required' });

    const preProductIdRaw = b.product_id ?? b.draft_product_id;
    const preProductId =
      preProductIdRaw != null && preProductIdRaw !== ''
        ? parseInt(String(preProductIdRaw), 10)
        : NaN;
    const hasPreProduct = !Number.isNaN(preProductId);

    let preProduct = null;
    if (hasPreProduct) {
      preProduct = await Product.findByPk(preProductId);
      if (!preProduct) {
        return res.status(404).json({ error: 'Draft product not found', code: 'PRODUCT_NOT_FOUND' });
      }
      if (!product_code) {
        product_code = String(preProduct.product_code || '').trim();
      }
      if (String(preProduct.product_code).trim() !== product_code) {
        return res.status(400).json({
          error:
            'product_code must match the draft product from Zoho sync. Do not change the PR code after sync.',
          code: 'PRODUCT_CODE_MISMATCH',
        });
      }
    } else if (!product_code) {
      const recordTypeForAlloc = normalizePrRecordTypeFromBody(b, { defaultPermanent: true });
      try {
        product_code = await db.transaction(async (txn) =>
          allocateNextPrProductCode(recordTypeForAlloc, txn)
        );
      } catch (allocErr) {
        console.error('createPRRegistration allocate code', allocErr);
        return res.status(500).json({ error: allocErr.message || 'Failed to allocate PR product code' });
      }
    }

    if (!product_code) {
      return res.status(400).json({ error: 'product_code is required' });
    }

    const recordTypeExplicit = normalizePrRecordTypeFromBody(b, { defaultPermanent: false });
    const prRecordStored = hasPreProduct
      ? recordTypeExplicit ?? preProduct.pr_record_type ?? null
      : recordTypeExplicit ?? 'permanent';
    const recordTypeForRules = hasPreProduct ? null : recordTypeExplicit ?? 'permanent';
    const codeErr = validatePrProductCodeForRecordType(product_code, recordTypeForRules);
    if (codeErr) {
      return res.status(400).json({ error: codeErr, code: 'PR_CODE_RECORD_TYPE_MISMATCH' });
    }

    if (!hasPreProduct) {
      const existsCode = await Product.findOne({ where: { product_code } });
      if (existsCode) {
        return res.status(409).json({
          error: `Product code "${product_code}" is already registered. Pick another code or edit that product.`,
          code: 'PRODUCT_CODE_EXISTS',
        });
      }
    }

    const existsName = await Product.findOne({ where: { product_name } });
    if (existsName && (!preProduct || existsName.product_id !== preProduct.product_id)) {
      return res.status(409).json({
        error: `Product name "${product_name}" is already in use. Use a different name or edit the existing PR.`,
        code: 'PRODUCT_NAME_EXISTS',
      });
    }

    const now = new Date();
    // Accept new `zoho_sku_code` field, fall back to legacy `product_sku` / `bomSku` for backward compat.
    const bomSku = String(b.zoho_sku_code ?? b.product_sku ?? b.bomSku ?? product_code).trim();
    // SKU uniqueness pre-check: only when SKU differs from product_code (otherwise
    // the existsCode lookup above already covered the same identifier).
    if (bomSku && bomSku !== product_code) {
      const existsSku = await Product.findOne({ where: { zoho_sku_code: bomSku } });
      if (existsSku && (!preProduct || existsSku.product_id !== preProduct.product_id)) {
        return res.status(409).json({
          error: `Product SKU "${bomSku}" is already in use. Use a different SKU or edit the existing PR.`,
          code: 'PRODUCT_SKU_EXISTS',
        });
      }
    }
    const rm_lines = Array.isArray(b.rm_lines) ? b.rm_lines : (Array.isArray(b.rmLines) ? b.rmLines : []);
    const pm_lines = Array.isArray(b.pm_lines) ? b.pm_lines : (Array.isArray(b.pmLines) ? b.pmLines : []);
    const process_steps = Array.isArray(b.process_steps) ? b.process_steps : (Array.isArray(b.processSteps) ? b.processSteps : []);

    const isDraftSave = isPrDraftWrite(b, preProduct);

    if (!isDraftSave) {
      if (countMeaningfulRmLines(rm_lines) < 1) {
        return res.status(400).json({
          error:
            'At least one formula (RM) line is required. Add ingredients in Formula BOM before registering.',
          code: 'PR_MISSING_RM_LINES',
        });
      }
      const formulaPctV = validateFormulaPctNotOver100(rm_lines);
      if (!formulaPctV.ok) {
        return res.status(400).json({
          error: formulaPctV.error,
          code: formulaPctV.code,
        });
      }
      if (countMeaningfulPmLines(pm_lines) < 1) {
        return res.status(400).json({
          error:
            'At least one packaging (PM) line is required. Add pack components in Pack BOM before registering.',
          code: 'PR_MISSING_PM_LINES',
        });
      }
    } else {
      const formulaPctDraft = validateFormulaPctNotOver100(rm_lines);
      if (!formulaPctDraft.ok) {
        return res.status(400).json({
          error: formulaPctDraft.error,
          code: formulaPctDraft.code,
        });
      }
    }

    const skuRegLines = Array.isArray(b.sku_rm_lines) ? b.sku_rm_lines : [];
    if (!isDraftSave) {
      const skuRegV = validateSkuBomTotals({
        lines: skuRegLines,
        limitQty: b.sku_bom_limit_qty ?? b.skuBomLimitQty,
        limitUom: b.sku_bom_limit_uom ?? b.skuBomLimitUom,
      });
      if (!skuRegV.ok) {
        return res.status(400).json({ error: skuRegV.error, code: skuRegV.code });
      }
    }

    const mrpRaw = b.mrp_price ?? b.mrp;
    let mrp_price = null;
    if (mrpRaw != null && mrpRaw !== '') {
      const n = parseFloat(String(mrpRaw).replace(/[^\d.]/g, ''));
      if (!Number.isNaN(n)) mrp_price = n;
    }

    const zohoFromForm = (b.zoho_id ?? b.zohoId) != null && String(b.zoho_id ?? b.zohoId).trim() !== ''
      ? String(b.zoho_id ?? b.zohoId).trim()
      : null;

    const prApprovalStatus = await resolveWritableMasterApprovalStatus(req, 'PR', b.status ?? b.lifecycle_status, {
      existing: preProduct?.status ?? preProduct?.lifecycle_status,
      forCreate: !preProduct,
    });
    const productRow = {
      product_name,
      product_code,
      pr_record_type: prRecordStored,
      zoho_sku_code: bomSku,
      generic_name: b.generic_name ?? b.category ?? null,
      brand_name: b.brand_name ?? b.client ?? null,
      category: b.category ?? null,
      status: prApprovalStatus,
      lifecycle_status: prApprovalStatus,
      form: b.form ?? b.type ?? null,
      product_description: b.product_description ?? b.description ?? null,
      storage_conditions: b.storage_conditions ?? null,
      mrp_price,
      ph_range: b.ph_range ?? null,
      viscosity_range: b.viscosity_range ?? null,
      appearance: b.appearance ?? null,
      odour: b.odour ?? null,
      fill_weight_spec: b.fill_weight_spec ?? null,
      stability_summary: b.stability_summary ?? null,
      approved_claims: b.approved_claims ?? null,
      zoho_item_id: zohoFromForm || (preProduct && preProduct.zoho_item_id) || null,
      form_data:
        b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data)
          ? b.form_data
          : null,
      updated_at: now,
    };
    await applyAutoAssignPrCreatorOnCreate(req, productRow);

    const notesParts = [];
    if (b.pr_qc_group) notesParts.push(`QC Group: ${b.pr_qc_group}`);
    if (b.pr_sub_category) notesParts.push(`PR Sub-category: ${b.pr_sub_category}`);
    if (b.microbial_limits) notesParts.push(`Microbial Limits: ${b.microbial_limits}`);
    if (b.spf_pa_rating) notesParts.push(`SPF/PA Rating: ${b.spf_pa_rating}`);
    if (b.photostability) notesParts.push(`Photostability: ${b.photostability}`);
    if (b.freeze_thaw_cycles) notesParts.push(`Freeze-Thaw Cycles: ${b.freeze_thaw_cycles}`);
    if (b.cosmos_natural_certification) notesParts.push(`COSMOS / Natural Certification: ${b.cosmos_natural_certification}`);
    if (b.dermatologically_tested) notesParts.push(`Dermatologically Tested: ${b.dermatologically_tested}`);
    if (b.cruelty_free_vegan) notesParts.push(`Cruelty Free / Vegan: ${b.cruelty_free_vegan}`);
    const bomNotes = notesParts.length ? notesParts.join(' | ') : null;

    let zohoBooksItemToDelete = null;
    const t = await db.transaction();
    try {
      let product;
      if (preProduct) {
        const mergedRow = await applyAutoAssignOnTouch(
          req,
          preProduct,
          readApprovalStatusFromMasterRow('PR', preProduct),
          productRow
        );
        await preProduct.update({ ...mergedRow }, { transaction: t });
        product = preProduct;
      } else {
        product = await Product.create(
          { ...productRow, created_at: now },
          { transaction: t }
        );
      }

      await product.reload({ transaction: t });
      let zoho = await syncZohoItemForNewProduct(product, b);
      if (zoho.error === 'already_has_zoho_item_id') {
        await product.reload({ transaction: t });
        zoho = { synced: true, itemId: product.zoho_item_id };
      }
      if (zoho.synced && zoho.itemId) {
        const updatePatch = { zoho_item_id: zoho.itemId, updated_at: now };
        if (zoho.sku && String(zoho.sku).trim()) updatePatch.zoho_sku_code = String(zoho.sku).trim();
        await product.update(updatePatch, { transaction: t });
        await product.reload({ transaction: t });
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

      const productZohoId =
        product.zoho_item_id != null && String(product.zoho_item_id).trim() !== ''
          ? String(product.zoho_item_id).trim()
          : null;
      const prQsPatch = prQualitySpecBomColumnPatch(
        b.pr_quality_spec_rows_by_section ?? b.prQualitySpecRowsBySection,
        b.pr_quality_bulk_sub_spec_rows_by_path ?? b.prQualityBulkSubSpecRowsByPath,
        b.pr_quality_final_sub_spec_rows_by_path ?? b.prQualityFinalSubSpecRowsByPath,
        b.pr_quality_dispatch_sub_spec_rows_by_path ?? b.prQualityDispatchSubSpecRowsByPath
      );
      const prQsLockPatch = payloadHasQualitySpecEdits(b, PR_QUALITY_SPEC_EDIT_KEYS)
        ? { quality_specs_locked: true }
        : {};
      const bomRow = {
        bom_code: product_code,
        bom_sku: bomSku,
        zoho_id: b.zoho_id ?? b.zohoId ?? productZohoId ?? null,
        bom_tax_preference: b.bom_tax_preference ?? b.bomTaxPreference ?? null,
        bom_returnable: b.bom_returnable ?? b.bomReturnable ?? false,
        bom_associate_items: b.bom_associate_items ?? b.bomAssociateItems ?? null,
        bom_composite_item:
          b.bom_composite_item ?? b.bomCompositeItem ?? true,
        type: b.type ?? productRow.form ?? null,
        status: 'Draft',
        client: b.client ?? null,
        name: product_name,
        pack_size: (() => {
          const { formatSkuBomLimitAsPack } = require('../lib/skuBomPackSize');
          const lq =
            b.sku_bom_limit_qty != null && b.sku_bom_limit_qty !== ''
              ? b.sku_bom_limit_qty
              : b.skuBomLimitQty != null && b.skuBomLimitQty !== ''
                ? b.skuBomLimitQty
                : null;
          const lu = b.sku_bom_limit_uom ?? b.skuBomLimitUom ?? null;
          const pack = formatSkuBomLimitAsPack(lq, lu);
          return pack !== '0' ? pack : null;
        })(),
        site: b.site ?? null,
        category: productRow.category,
        ph_range: productRow.ph_range,
        regulatory: b.regulatory ?? b.applicable_regulation ?? null,
        description: b.desc ?? null,
        notes: bomNotes,
        spec_pack: b.pack_configuration ?? b.packConfiguration ?? null,
        spec_bulk: b.specific_gravity ?? b.specificGravity ?? null,
        stability_summary: productRow.stability_summary,
        ...prQsPatch,
        ...prQsLockPatch,
        pr_facility_licences: flattenPrFacilityLicencesForStorage(
          b.pr_facility_licences ?? b.prFacilityLicences
        ),
        rm_lines,
        sku_rm_lines: Array.isArray(b.sku_rm_lines) ? b.sku_rm_lines : [],
        sku_bom_limit_qty:
          b.sku_bom_limit_qty != null && b.sku_bom_limit_qty !== ''
            ? b.sku_bom_limit_qty
            : b.skuBomLimitQty != null && b.skuBomLimitQty !== ''
              ? b.skuBomLimitQty
              : null,
        sku_bom_limit_uom: (b.sku_bom_limit_uom ?? b.skuBomLimitUom) || null,
        pm_lines,
        process_steps,
        product_id: product.product_id,
        created_at: now,
        updated_at: now,
      };

      const existingBom = await BOM.findOne({
        where: { bom_code: product_code },
        transaction: t,
      });

      let bom;
      if (existingBom) {
        if (existingBom.product_id != null) {
          await t.rollback();
          await compensateZohoItemIfAny(null, zohoBooksItemToDelete, deleteItem);
          return res.status(409).json({
            error: `BOM code "${product_code}" is already linked to another product. Regenerate the PR code.`,
            code: 'BOM_CODE_LINKED',
          });
        }
        const { created_at: _c, ...bomUpdate } = bomRow;
        await existingBom.update(
          { ...bomUpdate, updated_at: now },
          { transaction: t }
        );
        bom = existingBom;
      } else {
        bom = await BOM.create(bomRow, { transaction: t });
      }

      // Link selected RM/PM master items to this product code for downstream usage/pricing.
      await linkMaterialMastersToProductCode(
        product,
        {
          rm_lines,
          sku_rm_lines: Array.isArray(b.sku_rm_lines) ? b.sku_rm_lines : [],
          pm_lines,
        },
        { transaction: t, productCodeOverride: product_code }
      );

      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PR', product_id: product.product_id },
        defaults: {
          item_type: 'PR',
          product_id: product.product_id,
          wh_stock: 0,
          wh_unit: 'PCS',
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

      await t.commit();
      zohoBooksItemToDelete = null;

      res.status(201).json({
        product: product.get({ plain: true }),
        bom: {
          id: String(bom.id),
          bom_code: bom.bom_code,
          product_id: bom.product_id,
        },
      });
    } catch (inner) {
      await t.rollback();
      await compensateZohoItemIfAny(null, zohoBooksItemToDelete, deleteItem);
      throw inner;
    }
  } catch (err) {
    console.error('createPRRegistration error', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      const paths = (err.errors || []).map((e) => e.path).filter(Boolean);
      const hint = paths.some((p) => String(p).includes('bom_code'))
        ? 'This PR/BOM code is already in use. Retry save or pick another code.'
        : 'A unique constraint failed (code or name may already exist).';
      return res.status(409).json({ error: hint, code: 'UNIQUE_VIOLATION', fields: paths });
    }
    res.status(500).json({ error: err.message || 'Failed to register PR product' });
  }
};

/** Format product for list: add rm_ingredients_count, pack_items_count, open_sos_count */
function formatProductForList(p) {
  const d = p.get ? p.get({ plain: true }) : p;
  return {
    ...d,
    pr_track_approvals: formatTrackApprovalsForApi(readTrackApprovals(d)),
    approval_stage_assignees: formatStageAssigneesForApi(readMasterApprovalStageAssignees(d)),
    internal_sku_code: d.product_code ?? null,
    zoho_sku_code: d.zoho_sku_code ?? null,
    rm_ingredients_count: p.rm_ingredients_count ?? null,
    pack_items_count: p.pack_items_count ?? null,
    open_sos_count: p.open_sos_count ?? null,
  };
}

const getAllProducts = async (req, res) => {
  try {
    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    const normalizeInt = (v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? null : n;
    };

    let products;
    let total = null;
    let limit = null;
    let offset = null;

    let productWhere = null;
    // Free-text search across product_code, zoho_sku_code, product_name, brand_name.
    // SKU search is the canonical "find a product by its Zoho-mirrored SKU" path.
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    let searchClause = null;
    if (search.length > 0) {
      const like = { [Op.iLike]: `%${search}%` };
      searchClause = {
        [Op.or]: [
          { product_code: like },
          { zoho_sku_code: like },
          { product_name: like },
          { brand_name: like },
        ],
      };
    }

    const vcIdRaw = req.query.vendor_client_id;
    if (vcIdRaw != null && String(vcIdRaw).trim() !== '') {
      const vcId = normalizeInt(vcIdRaw);
      if (vcId == null || vcId <= 0) {
        return res.status(400).json({ error: 'Invalid vendor_client_id' });
      }
      const vcRow = await VendorClient.findByPk(vcId);
      if (!vcRow) {
        return res.status(404).json({ error: 'Vendor/client not found' });
      }
      const vcPlain = vcRow.get ? vcRow.get({ plain: true }) : vcRow;
      if (String(vcPlain.type || '').toLowerCase() !== 'client') {
        return res.status(400).json({ error: 'vendor_client_id must refer to a client (Masters → Clients)' });
      }
      const clientName = String(vcPlain.name || '').trim();
      if (!clientName) {
        if (wantsPagination) {
          const lim = limitQ != null ? normalizeInt(limitQ) : 20;
          const off = offsetQ != null ? normalizeInt(offsetQ) : 0;
          if (lim == null || off == null || lim <= 0 || off < 0) {
            return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
          }
          return res.json({ rows: [], total: 0, limit: lim, offset: off });
        }
        return res.json([]);
      }
      const lower = clientName.toLowerCase();
      const brandMatch = sqlWhere(fn('LOWER', fn('TRIM', col('brand_name'))), lower);
      const boms = await BOM.findAll({
        attributes: ['product_id'],
        where: {
          product_id: { [Op.ne]: null },
          [Op.and]: [sqlWhere(fn('LOWER', fn('TRIM', col('client'))), lower)],
        },
      });
      const fromBom = [...new Set((boms || []).map((b) => b.product_id).filter(Boolean))];
      productWhere = {
        [Op.or]: fromBom.length
          ? [brandMatch, { product_id: { [Op.in]: fromBom } }]
          : [brandMatch],
      };
    }

    // Combine vendor_client_id filter with optional free-text search.
    if (searchClause) {
      productWhere = productWhere
        ? { [Op.and]: [productWhere, searchClause] }
        : searchClause;
    }

    productWhere = productWhere
      ? { [Op.and]: [productWhere, productActiveWhere()] }
      : productActiveWhere();

    if (wantsPagination) {
      limit = limitQ != null ? normalizeInt(limitQ) : 20;
      offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }

      const result = await Product.findAndCountAll({
        where: productWhere || undefined,
        order: [['product_code', 'ASC']],
        limit,
        offset,
      });
      products = result.rows;
      total = result.count;
    } else {
      products = await Product.findAll({
        where: productWhere || undefined,
        order: [['product_code', 'ASC']],
      });
    }

    const productCodes = products.map((p) => p.product_code).filter(Boolean);
    const productIds = products.map((p) => p.product_id);
    const productCodesSet = new Set(productCodes);

    const openStatuses = ['Draft', 'Submitted', 'Confirmed', 'Processing', 'Pending', 'In Progress'];
    const bomsPromise = productIds.length > 0
      ? BOM.findAll({ where: { product_id: { [Op.in]: productIds } } })
      : Promise.resolve([]);
    const packPromise = PackMaterial.findAll();
    const salesOrdersPromise = SalesOrder.findAll({
      where: { status: { [Op.in]: openStatuses } },
      attributes: ['id', 'order_id', 'customer_name', 'status', 'items'],
    }).catch(() => []);

    const [boms, allPack, salesOrders] = await Promise.all([bomsPromise, packPromise, salesOrdersPromise]);

    const bomsByProductId = {};
    boms.forEach((b) => {
      bomsByProductId[b.product_id] = b;
    });

    const packMaterialsByCode = {};
    allPack.forEach((pm) => {
      const prods = Array.isArray(pm.products) ? pm.products : [];
      prods.forEach((code) => {
        if (!productCodesSet.has(code)) return;
        if (!packMaterialsByCode[code]) packMaterialsByCode[code] = [];
        packMaterialsByCode[code].push(pm);
      });
    });

    let openSoCountByCode = {};
    salesOrders.forEach((so) => {
      const items = Array.isArray(so.items) ? so.items : [];
      items.forEach((line) => {
        const code = line.product_code || line.productCode;
        if (code && productCodesSet.has(code)) {
          openSoCountByCode[code] = (openSoCountByCode[code] || 0) + 1;
        }
      });
    });

    let list = products.map((p) => {
    const plain = p.get ? p.get({ plain: true }) : p;
    const bom = bomsByProductId[p.product_id];
    const parsedNotes = bom ? parseBomNotes(bom.notes) : parseBomNotes(null);
    const rmCount = bom && Array.isArray(bom.rm_lines) ? bom.rm_lines.length : 0;
    const packList = packMaterialsByCode[p.product_code] || [];
    const openSos = openSoCountByCode[p.product_code] || 0;
    return {
      ...plain,
      internal_sku_code: plain.product_code ?? null,
      zoho_sku_code: plain.zoho_sku_code ?? null,
      pr_sub_category: parsedNotes.pr_sub_category || null,
      skuBomLimitQty: bom && bom.sku_bom_limit_qty != null ? Number(bom.sku_bom_limit_qty) : null,
      skuBomLimitUom: bom && bom.sku_bom_limit_uom ? String(bom.sku_bom_limit_uom) : null,
      rm_ingredients_count: rmCount,
      pack_items_count: packList.length,
      open_sos_count: openSos,
    };
    });

    const catalogQtyRaw = req.query.quantity ?? req.query.qty;
    const catalogQty =
      catalogQtyRaw != null ? parseInt(String(catalogQtyRaw), 10) : 10;
    const catalogQuantity = Number.isFinite(catalogQty) && catalogQty > 0 ? catalogQty : 10;
    const websiteClientId = await resolveWebsiteClientId(req);
    if (websiteClientId) {
      list = await attachClientPricingToProducts(list, websiteClientId, catalogQuantity);
    }

    if (wantsPagination) {
      return res.json({ rows: list, total, limit, offset });
    }

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getProductById = async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    let plain = product.get ? product.get({ plain: true }) : product;
    const qtyRaw = req.query.quantity ?? req.query.qty;
    const qtyParsed = qtyRaw != null ? parseInt(String(qtyRaw), 10) : 10;
    const quantity = Number.isFinite(qtyParsed) && qtyParsed > 0 ? qtyParsed : 10;
    const websiteClientId = await resolveWebsiteClientId(req);
    if (websiteClientId) {
      plain = await attachClientPricingToProduct(plain, websiteClientId, quantity);
    }
    res.json(plain);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Full product detail for PR panel: overview, formula BOM, pack BOM, process steps, specs, open SOs */
const getProductDetail = async (req, res) => {
  try {
    const id = req.params.id;
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const plain = product.get ? product.get({ plain: true }) : product;

    const openStatuses = ['Draft', 'Submitted', 'Confirmed', 'Processing', 'Pending', 'In Progress'];
    const [bom, allPackForProduct, allOpenSo] = await Promise.all([
      BOM.findOne({ where: { product_id: id } }),
      PackMaterial.findAll(),
      SalesOrder.findAll({
        where: { status: { [Op.in]: openStatuses } },
        order: [['order_date', 'DESC']],
      }),
    ]);
    const rawRmLines = (bom && bom.rm_lines) ? bom.rm_lines : [];
    const { enrichStoredFormulaRmLine, isAquaQsStoredFormulaLine } = require('./aquaRmSku');
    let rmLinesDirty = false;
    const rmLines = await Promise.all(
      rawRmLines.map(async (line) => {
        if (!isAquaQsStoredFormulaLine(line)) return line;
        const enriched = await enrichStoredFormulaRmLine(line);
        if (
          String(enriched.inci_name || '') !== String(line.inci_name || line.inciName || '') ||
          String(enriched.rm_code || '') !== String(line.rm_code || line.rmCode || '')
        ) {
          rmLinesDirty = true;
        }
        return enriched;
      })
    );
    if (rmLinesDirty && bom) {
      await bom.update({ rm_lines: rmLines, updated_at: new Date() });
    }
    const pmLines = (bom && bom.pm_lines) ? bom.pm_lines : [];
    const processSteps = (bom && bom.process_steps) ? bom.process_steps : [];

    const phases = {};
    rmLines.forEach((line) => {
      const phase = line.phase || 'Other';
      if (!phases[phase]) phases[phase] = [];
      const lineSg = Number(line.specific_gravity ?? line.specificGravity);
      const itemGroupId = line.item_group_id ?? line.itemGroupId ?? null;
      const itemGroupName = line.item_group_name ?? line.itemGroupName ?? null;
      phases[phase].push({
        inci_name: line.inci_name || line.inciName || line.name,
        rm_code: line.rm_code || line.rmCode,
        raw_material_id: line.raw_material_id ?? line.rawMaterialId ?? null,
        pct_w_w: line.pct_w_w != null ? line.pct_w_w : (line.pctWw != null ? line.pctWw : line.pct),
        uom: line.uom || 'kg',
        ...(itemGroupId != null && !Number.isNaN(Number(itemGroupId))
          ? { item_group_id: Number(itemGroupId), item_group_name: itemGroupName ? String(itemGroupName) : null }
          : {}),
        ...(Number.isFinite(lineSg) && lineSg > 0 ? { specific_gravity: lineSg } : {}),
      });
    });
    const formulaBom = Object.entries(phases).map(([phaseName, ingredients]) => ({
      phase: phaseName,
      ingredients,
    }));

    const skuRmRaw = bom && bom.sku_rm_lines ? bom.sku_rm_lines : [];
    const skuRmList = Array.isArray(skuRmRaw) ? skuRmRaw : [];
    const skuBom = skuRmList.map((line, idx) => ({
      row_number: idx + 1,
      inci_name: line.inci_name || line.inciName || line.name || '',
      rm_code: line.rm_code || line.rmCode || '',
      zoho_sku_code: line.zoho_sku_code ?? null,
      raw_material_id: line.raw_material_id ?? line.rawMaterialId ?? null,
      qty_per_unit:
        line.qty_per_unit != null
          ? parseFloat(String(line.qty_per_unit).replace(/[^\d.-]/g, '')) || 0
          : line.qtyPerUnit != null
            ? parseFloat(String(line.qtyPerUnit).replace(/[^\d.-]/g, '')) || 0
            : 0,
      uom: line.uom || 'GM',
    }));
    const packMaterials = allPackForProduct.filter((pm) => {
      const prods = Array.isArray(pm.products) ? pm.products : [];
      return prods.includes(plain.product_code);
    });
    const packBomSource = pmLines.length > 0
      ? pmLines.map((row) => ({ ...row, pm_id: null }))
      : packMaterials.map((pm) => ({
          pm_id: pm.id,
          pm_code: pm.code,
          description: pm.description,
          pack_type: pm.level || 'Primary',
          qty_per_unit: 1,
          uom: 'pc/unit',
        }));
    if (pmLines.length > 0 && packMaterials.length > 0) {
      const codeToId = new Map(packMaterials.map((pm) => [pm.code, pm.id]));
      packBomSource.forEach((row) => {
        if (row.pm_id == null && row.pm_code) row.pm_id = codeToId.get(row.pm_code) ?? null;
      });
    }
    const packPmByCode = new Map(
      packMaterials.map((pm) => {
        const plainPm = pm.get ? pm.get({ plain: true }) : pm;
        return [String(plainPm.code || '').trim(), plainPm];
      })
    );
    const packBom = packBomSource.map((row, idx) => {
      const pmCode = String(row.pm_code || row.code || '').trim();
      const linkedPm = pmCode ? packPmByCode.get(pmCode) : null;
      const pmSkuFromRow = normalizePmSubCategorySlug(
        row.pm_sku_category || row.pmSkuCategory || ''
      );
      const pmSkuFromMaster = linkedPm
        ? normalizePmSubCategorySlug(linkedPm.group || linkedPm.material || '')
        : '';
      const pm_sku_category = pmSkuFromRow || pmSkuFromMaster || '';
      const subCategoryRaw =
        row.pm_sub_category ||
        row.optional_pm_sub_category ||
        row.optionalPmSubCategory ||
        '';
      const pm_sub_category =
        String(subCategoryRaw || '').trim() ||
        (linkedPm && String(linkedPm.material || '').trim() !== pm_sku_category
          ? String(linkedPm.material || '').trim()
          : '');
      const subSubRaw =
        row.pm_sub_sub_category ||
        row.optional_pm_sub_sub_category ||
        row.optionalPmSubSubCategory ||
        '';
      const linkedFd =
        linkedPm?.form_data && typeof linkedPm.form_data === 'object' ? linkedPm.form_data : {};
      const pm_sub_sub_category =
        String(subSubRaw || '').trim() ||
        String(linkedFd.optionalPmSubSubCategory || linkedFd.pm_sub_sub_category || '').trim() ||
        '';
      const pack_type =
        row.pack_type ||
        row.level ||
        (pm_sku_category ? pmLevelForSubCategorySlug(pm_sku_category) : '') ||
        (linkedPm ? linkedPm.level : '') ||
        'Primary';
      return {
        row_number: idx + 1,
        pm_id: row.pm_id ?? null,
        pack_material_id: row.pack_material_id ?? row.packMaterialId ?? row.pm_id ?? null,
        pm_description: row.pm_description || row.description,
        pm_code: pmCode,
        zoho_sku_code: row.zoho_sku_code ?? null,
        pm_sku_category,
        pm_sub_category,
        pm_sub_sub_category,
        pack_type,
        qty_per_unit: row.qty_per_unit != null ? row.qty_per_unit : row.qty != null ? row.qty : 1,
        uom: row.uom || 'pc/unit',
      };
    });

    const salesOrders = allOpenSo.filter((so) => {
      const items = Array.isArray(so.items) ? so.items : [];
      return items.some((l) => (l.product_code || l.productCode) === plain.product_code);
    }).slice(0, 20);
    const openSalesOrders = salesOrders.map((so) => {
      const d = so.get ? so.get({ plain: true }) : so;
      const items = Array.isArray(d.items) ? d.items : [];
      const line = items.find((l) => (l.product_code || l.productCode) === plain.product_code);
      const qty = line ? (line.quantity || line.qty || 0) : 0;
      return {
        order_id: d.order_id,
        customer_name: d.customer_name,
        quantity: qty,
        status: d.status,
      };
    });

    const parsedNotes = bom ? parseBomNotes(bom.notes) : parseBomNotes(null);
    const bomPlain = bom ? (bom.get ? bom.get({ plain: true }) : bom) : null;
    let pr_quality_spec_rows_by_section = hydratePrQualitySpecRowsBySectionFromBom(bomPlain);
    let pr_quality_bulk_sub_spec_rows_by_path = hydratePrQualityBulkSubSpecRowsByPathFromBom(bomPlain);
    let pr_quality_final_sub_spec_rows_by_path = hydratePrQualityFinalSubSpecRowsByPathFromBom(bomPlain);
    let pr_quality_dispatch_sub_spec_rows_by_path =
      hydratePrQualityDispatchSubSpecRowsByPathFromBom(bomPlain);
    const pr_facility_licences = hydratePrFacilityLicencesFromBom(bomPlain);

    // While unlocked, quality specs are live-resolved from the category/sub-category rule
    // instead of whatever (if anything) is stored on the BOM — once locked, the BOM's own
    // saved rows (already hydrated above) win.
    const prLocked = bomPlain ? bomPlain.quality_specs_locked === true : false;
    const prCategory = resolvePrQualitySpecCategory(plain.category, plain.product_code);
    if (!prLocked && prCategory) {
      const prSubCategory = resolvePrQualitySpecSubCategory(prCategory, parsedNotes.pr_sub_category || '');
      const subSpecPath = resolvePrSubSpecPath(prCategory, prSubCategory);
      const [bulk, final, dispatch] = await Promise.all([
        resolvePrEntityQualitySpecs('PR_BULK_CLEARANCE', prCategory, prSubCategory, subSpecPath),
        resolvePrEntityQualitySpecs('PR_FINAL_CLEARANCE', prCategory, prSubCategory, subSpecPath),
        resolvePrEntityQualitySpecs('PR_DISPATCH_SPECS', prCategory, prSubCategory, subSpecPath),
      ]);
      pr_quality_spec_rows_by_section = {
        bulkClearance: bulk.commonRows,
        finalClearance: final.commonRows,
        dispatchSpecs: dispatch.commonRows,
      };
      const pathKey = prSubCategory ? `${prCategory}::${prSubCategory}` : null;
      pr_quality_bulk_sub_spec_rows_by_path = pathKey ? { [pathKey]: bulk.subRows } : {};
      pr_quality_final_sub_spec_rows_by_path = pathKey ? { [pathKey]: final.subRows } : {};
      pr_quality_dispatch_sub_spec_rows_by_path = pathKey ? { [pathKey]: dispatch.subRows } : {};
    }
    res.json({
      ...plain,
      pr_quality_spec_rows_by_section,
      pr_quality_bulk_sub_spec_rows_by_path,
      pr_quality_final_sub_spec_rows_by_path,
      pr_quality_dispatch_sub_spec_rows_by_path,
      pr_facility_licences,
      quality_specs_locked: bomPlain ? (bomPlain.quality_specs_locked ?? false) : false,
      pr_track_approvals: formatTrackApprovalsForApi(readTrackApprovals(plain)),
      approval_stage_assignees: formatStageAssigneesForApi(readMasterApprovalStageAssignees(plain)),
      internal_sku_code: plain.product_code ?? null,
      zoho_sku_code: plain.zoho_sku_code ?? null,
      bom_composite_item: bom ? bom.bom_composite_item : null,
      bom_tax_preference: bom ? bom.bom_tax_preference : null,
      bom_returnable: bom ? bom.bom_returnable : null,
      bom_associate_items: bom ? bom.bom_associate_items : null,
      brand_client: bom ? (bom.client || plain.brand_name || null) : (plain.brand_name || null),
      applicable_regulation: bom ? (bom.regulatory || null) : null,
      claims_substantiation: bom ? (bom.description || null) : null,
      pr_qc_group: bom ? (parsedNotes.pr_qc_group || null) : null,
      pr_sub_category: bom ? (parsedNotes.pr_sub_category || null) : null,
      pack_configuration: bom ? (bom.spec_pack || null) : null,
      specific_gravity: bom ? (bom.spec_bulk || null) : null,
      microbial_limits: bom ? (parsedNotes.microbial_limits || null) : null,
      spf_pa_rating: bom ? (parsedNotes.spf_pa_rating || null) : null,
      photostability: bom ? (parsedNotes.photostability || null) : null,
      freeze_thaw_cycles: bom ? (parsedNotes.freeze_thaw_cycles || null) : null,
      cosmos_natural_certification: bom ? (parsedNotes.cosmos_natural_certification || null) : null,
      dermatologically_tested: bom ? (parsedNotes.dermatologically_tested || null) : null,
      cruelty_free_vegan: bom ? (parsedNotes.cruelty_free_vegan || null) : null,
      formulaBom,
      packBom,
      processSteps,
      skuBom,
      skuBomLimitQty: bom && bom.sku_bom_limit_qty != null ? Number(bom.sku_bom_limit_qty) : null,
      skuBomLimitUom: bom && bom.sku_bom_limit_uom ? String(bom.sku_bom_limit_uom) : null,
      openSalesOrders,
    });
  } catch (err) {
    console.error('getProductDetail error', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * The PR edit form always resends the full rm_lines/pm_lines/process_steps on every save, so a
 * pure value-diff against the stored BOM is unreliable — GET-side enrichment (live category
 * resolution, joined display fields) doesn't always round-trip byte-identical to what's actually
 * stored, which can flag a section as "changed" when the user never opened that tab. When the
 * frontend sends an explicit sections_touched flag (computed by diffing its own before/after
 * state in one consistent shape), trust that instead of re-deriving it from the payload.
 * @param {unknown} raw
 * @returns {{ rm: boolean, pm: boolean } | null}
 */
function readExplicitSectionsTouched(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.rm !== 'boolean' || typeof o.pm !== 'boolean') return null;
  return { rm: o.rm, pm: o.pm };
}

/**
 * A PR RM/PM section was edited. Auto-assign the editor to any OPEN owner slot for the changed
 * section(s), then reset BOTH approval tracks to Draft (the whole PR must be re-approved).
 * Assumes the caller has already passed the section-lock check.
 * @param {import('express').Request} req
 * @param {import('sequelize').Model} product
 * @param {{ rm: boolean, pm: boolean }} changed
 */
async function applyPrSectionChangeEffects(req, product, changed) {
  const stages = readMasterApprovalStageAssignees(product);
  const callerId = callerIdFromReq(req);

  // Editor takes ownership of an open slot for the section they changed — including admins, so
  // the RM/Pack assign cell always reflects who actually touched the section. Once claimed, only
  // that owner (or an admin) may edit it further (see the section-lock check in updateProduct).
  if (callerId) {
    for (const tk of ['rm', 'pm']) {
      if (!changed[tk]) continue;
      const slotKey = TRACK_STAGE_KEY[tk];
      if (!stages[slotKey] || !stages[slotKey].userId) {
        const slot = await buildStageSlotForUserId(callerId);
        if (slot) stages[slotKey] = slot;
      }
    }
  }

  const resetTracks = { rm: emptyTrackState(), pm: emptyTrackState() };
  await product.update({
    approval_stage_assignees: formatStageAssigneesForApi(stages),
    approval_assigned_user_id: stages.approver?.userId ?? null,
    approval_assigned_display_name: stages.approver?.displayName ?? null,
    pr_track_approvals: formatTrackApprovalsForApi(resetTracks),
    status: 'Draft',
    lifecycle_status: 'Draft',
    updated_at: new Date(),
  });
}

const updateProduct = async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (Number.isNaN(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const product = await Product.findByPk(productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const nextCode =
      req.body.product_code != null && String(req.body.product_code).trim() !== ''
        ? String(req.body.product_code).trim()
        : String(product.product_code || '').trim();
    const typeExplicitlySet =
      Object.prototype.hasOwnProperty.call(req.body, 'pr_record_type') ||
      Object.prototype.hasOwnProperty.call(req.body, 'prRecordType');
    const typeFromBody = typeExplicitlySet
      ? normalizePrRecordTypeFromBody(req.body, { defaultPermanent: false })
      : undefined;
    if (typeExplicitlySet) {
      const rawTr = req.body.pr_record_type ?? req.body.prRecordType;
      const isEmpty = rawTr == null || (typeof rawTr === 'string' && !String(rawTr).trim());
      if (!isEmpty && typeFromBody == null) {
        return res.status(400).json({
          error: 'Invalid pr_record_type. Use "temporary" or "permanent" (or null for legacy).',
          code: 'PR_RECORD_TYPE_INVALID',
        });
      }
    }
    const mergedType =
      typeFromBody !== undefined
        ? typeFromBody
        : product.pr_record_type != null
          ? String(product.pr_record_type).trim()
          : null;
    const mergedTypeNorm =
      mergedType && ['temporary', 'permanent'].includes(String(mergedType).toLowerCase())
        ? String(mergedType).toLowerCase()
        : null;
    const codeRuleErr = validatePrProductCodeForRecordType(nextCode, mergedTypeNorm);
    if (codeRuleErr) {
      return res.status(400).json({ error: codeRuleErr, code: 'PR_CODE_RECORD_TYPE_MISMATCH' });
    }

    // if product_name is being changed → check duplicate
    if (req.body.product_name) {
      const existing = await Product.findOne({
        where: {
          product_name: req.body.product_name,
          product_id: { [Op.ne]: productId },
        },
      });
      if (existing) {
        return res
          .status(409)
          .json({ error: "Product name already in use" });
      }
    }

    // if zoho_sku_code (or legacy product_sku) is being changed → check duplicate (partial UNIQUE).
    const incomingSku = req.body.zoho_sku_code != null ? req.body.zoho_sku_code : req.body.product_sku;
    if (incomingSku != null) {
      const skuTrim = String(incomingSku).trim();
      if (skuTrim) {
        const existing = await Product.findOne({
          where: {
            zoho_sku_code: skuTrim,
            product_id: { [Op.ne]: productId },
          },
        });
        if (existing) {
          return res
            .status(409)
            .json({ error: 'Product SKU already in use', code: 'PRODUCT_SKU_EXISTS' });
        }
      }
      // Normalize the body so the subsequent generic update writes to zoho_sku_code,
      // even if the caller used the legacy `product_sku` key.
      if (req.body.zoho_sku_code == null) {
        req.body.zoho_sku_code = skuTrim || null;
      }
      delete req.body.product_sku;
    }

    // Optional: update linked BOM (formula, pack, process, specs); create BOM if missing
    const bomPayload = req.body.bom;
    const isDraftSave = isPrDraftWrite(req.body, product);
    // PR dual-track: which owned section(s) this edit touches (drives lock + re-approval reset).
    let prSectionChange = { rm: false, pm: false };
    if (bomPayload && typeof bomPayload === 'object') {
      let bom = await BOM.findOne({ where: { product_id: productId } });
      const rmFromPayload = Array.isArray(bomPayload.rm_lines);
      const pmFromPayload = Array.isArray(bomPayload.pm_lines);

      // Determine which sections actually changed vs the stored BOM (compare BEFORE mutating it),
      // then enforce section ownership: a locked section may only be edited by its owner or an admin.
      // Prefer the frontend's own before/after diff when it sent one — see readExplicitSectionsTouched.
      const explicitTouched = readExplicitSectionsTouched(
        bomPayload.sections_touched ?? bomPayload.sectionsTouched
      );
      prSectionChange = explicitTouched
        ? explicitTouched
        : bom
          ? detectChangedSections(bomPayload, bom)
          : { rm: !!rmFromPayload, pm: !!pmFromPayload };
      if (req.user && !isPrivilegedRole(req.user)) {
        const callerId = callerIdFromReq(req);
        for (const tk of ['rm', 'pm']) {
          if (!prSectionChange[tk]) continue;
          const owner = readTrackOwner(product, tk);
          if (owner && owner.userId !== callerId) {
            return res.status(403).json({
              error: `The ${TRACK_LABEL[tk]} section is locked to ${owner.displayName}. Only they (or an admin) can change ${TRACK_LABEL[tk]} details.`,
              message: `The ${TRACK_LABEL[tk]} section is locked to ${owner.displayName}.`,
              code: 'PR_SECTION_LOCKED',
            });
          }
        }
      }

      if (!bom) {
        const nextRm = rmFromPayload ? bomPayload.rm_lines : [];
        const nextPm = pmFromPayload ? bomPayload.pm_lines : [];
        if (!isDraftSave && (countMeaningfulRmLines(nextRm) < 1 || countMeaningfulPmLines(nextPm) < 1)) {
          return res.status(400).json({
            error:
              'BOM must include at least one formula (RM) line and one packaging (PM) line.',
            code: 'BOM_MISSING_LINES',
          });
        }
        const formulaPctCreate = validateFormulaPctNotOver100(nextRm);
        if (!formulaPctCreate.ok) {
          return res.status(400).json({
            error: formulaPctCreate.error,
            code: formulaPctCreate.code,
          });
        }
        const nextSkuCreate = Array.isArray(bomPayload.sku_rm_lines) ? bomPayload.sku_rm_lines : [];
        if (!isDraftSave) {
          const skuCreateV = validateSkuBomTotals({
            lines: nextSkuCreate,
            limitQty: bomPayload.sku_bom_limit_qty ?? bomPayload.skuBomLimitQty,
            limitUom: bomPayload.sku_bom_limit_uom ?? bomPayload.skuBomLimitUom,
          });
          if (!skuCreateV.ok) {
            return res.status(400).json({ error: skuCreateV.error, code: skuCreateV.code });
          }
        }
        const productCode = (product && product.product_code) ? product.product_code : `PR-${productId}`;
        bom = await BOM.create({
          bom_code: `BOM-${productCode}`,
          name: product?.product_name || `Product ${productId}`,
          product_id: productId,
          type: 'FG',
          status: 'Draft',
          rm_lines: nextRm,
          sku_rm_lines: nextSkuCreate,
          sku_bom_limit_qty: bomPayload.sku_bom_limit_qty ?? bomPayload.skuBomLimitQty ?? null,
          sku_bom_limit_uom: bomPayload.sku_bom_limit_uom ?? bomPayload.skuBomLimitUom ?? null,
          pm_lines: nextPm,
          process_steps: Array.isArray(bomPayload.process_steps) ? bomPayload.process_steps : [],
          client: bomPayload.brand_client ?? bomPayload.brandClient ?? product.brand_name ?? null,
          regulatory: bomPayload.applicable_regulation ?? bomPayload.applicableRegulation ?? null,
          description: bomPayload.claims_substantiation ?? bomPayload.claimsSubstantiation ?? null,
          ph_range: bomPayload.ph_range ?? null,
          yield_pct: bomPayload.yield_pct ?? null,
          stability_summary: bomPayload.stability_summary ?? null,
          spec_pack: bomPayload.pack_configuration ?? bomPayload.packConfiguration ?? null,
          spec_bulk: bomPayload.specific_gravity ?? bomPayload.specificGravity ?? null,
          ...prQualitySpecBomColumnPatch(
            bomPayload.pr_quality_spec_rows_by_section ?? bomPayload.prQualitySpecRowsBySection,
            bomPayload.pr_quality_bulk_sub_spec_rows_by_path ?? bomPayload.prQualityBulkSubSpecRowsByPath,
            bomPayload.pr_quality_final_sub_spec_rows_by_path ?? bomPayload.prQualityFinalSubSpecRowsByPath,
            bomPayload.pr_quality_dispatch_sub_spec_rows_by_path ??
              bomPayload.prQualityDispatchSubSpecRowsByPath
          ),
          ...(payloadHasQualitySpecEdits(bomPayload, PR_QUALITY_SPEC_EDIT_KEYS)
            ? { quality_specs_locked: true }
            : {}),
          ...(payloadHasQualitySpecEdits(bomPayload, PR_QUALITY_SPEC_EDIT_KEYS)
            ? { quality_specs_locked: true }
            : {}),
          pr_facility_licences: flattenPrFacilityLicencesForStorage(
            bomPayload.pr_facility_licences ?? bomPayload.prFacilityLicences
          ),
          notes: (() => {
            const parts = [];
            const qc = String(bomPayload.pr_qc_group ?? bomPayload.prQcGroup ?? '').trim();
            const sub = String(bomPayload.pr_sub_category ?? bomPayload.prSubCategory ?? '').trim();
            const microbial = String(bomPayload.microbial_limits ?? bomPayload.microbialLimits ?? '').trim();
            const spf = String(bomPayload.spf_pa_rating ?? bomPayload.sppRating ?? '').trim();
            const photo = String(bomPayload.photostability ?? bomPayload.phototability ?? '').trim();
            const freeze = String(bomPayload.freeze_thaw_cycles ?? bomPayload.freezeThawCycles ?? '').trim();
            const cosmos = String(bomPayload.cosmos_natural_certification ?? bomPayload.cosmosNaturalCertification ?? '').trim();
            const derm = String(bomPayload.dermatologically_tested ?? bomPayload.dermatologicallyTested ?? '').trim();
            const cruelty = String(bomPayload.cruelty_free_vegan ?? bomPayload.crueltyFreeVegan ?? '').trim();
            if (qc) parts.push(`QC Group: ${qc}`);
            if (sub) parts.push(`PR Sub-category: ${sub}`);
            if (microbial) parts.push(`Microbial Limits: ${microbial}`);
            if (spf) parts.push(`SPF/PA Rating: ${spf}`);
            if (photo) parts.push(`Photostability: ${photo}`);
            if (freeze) parts.push(`Freeze-Thaw Cycles: ${freeze}`);
            if (cosmos) parts.push(`COSMOS / Natural Certification: ${cosmos}`);
            if (derm) parts.push(`Dermatologically Tested: ${derm}`);
            if (cruelty) parts.push(`Cruelty Free / Vegan: ${cruelty}`);
            return parts.length ? parts.join(' | ') : null;
          })(),
          bom_composite_item:
            bomPayload.bom_composite_item ?? bomPayload.bomCompositeItem ?? true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      } else {
        const mergedRm = rmFromPayload ? bomPayload.rm_lines : bom.rm_lines || [];
        const mergedPm = pmFromPayload ? bomPayload.pm_lines : bom.pm_lines || [];
        if (!isDraftSave && (rmFromPayload || pmFromPayload)) {
          if (countMeaningfulRmLines(mergedRm) < 1 || countMeaningfulPmLines(mergedPm) < 1) {
            return res.status(400).json({
              error:
                'BOM must keep at least one formula (RM) line and one packaging (PM) line.',
              code: 'BOM_MISSING_LINES',
            });
          }
          if (rmFromPayload) {
            const formulaPctUpd = validateFormulaPctNotOver100(mergedRm);
            if (!formulaPctUpd.ok) {
              return res.status(400).json({
                error: formulaPctUpd.error,
                code: formulaPctUpd.code,
              });
            }
          }
        } else if (isDraftSave && rmFromPayload) {
          const formulaPctDraft = validateFormulaPctNotOver100(mergedRm);
          if (!formulaPctDraft.ok) {
            return res.status(400).json({
              error: formulaPctDraft.error,
              code: formulaPctDraft.code,
            });
          }
        }
        const payloadSkuRm = Array.isArray(bomPayload.sku_rm_lines) ? bomPayload.sku_rm_lines : null;
        const meaningfulSkuInPayload = payloadSkuRm && countMeaningfulSkuRmLines(payloadSkuRm) > 0;

        const hasLqKey =
          Object.prototype.hasOwnProperty.call(bomPayload, 'sku_bom_limit_qty') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'skuBomLimitQty');
        const hasLuKey =
          Object.prototype.hasOwnProperty.call(bomPayload, 'sku_bom_limit_uom') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'skuBomLimitUom');

        const rawLQ = bomPayload.sku_bom_limit_qty ?? bomPayload.skuBomLimitQty;
        const rawLU = bomPayload.sku_bom_limit_uom ?? bomPayload.skuBomLimitUom;

        const limitQtyChanged = hasLqKey && !skuLimitQtyClose(rawLQ, bom.sku_bom_limit_qty);
        const limitUomChanged = hasLuKey && !skuLimitUomClose(rawLU, bom.sku_bom_limit_uom);

        const storedSkuLines = bom.sku_rm_lines || [];
        const meaningfulStoredSku = countMeaningfulSkuRmLines(storedSkuLines) > 0;

        const mustValidateSkuBom =
          !isDraftSave &&
          (meaningfulSkuInPayload ||
            ((limitQtyChanged || limitUomChanged) && meaningfulStoredSku));

        if (mustValidateSkuBom) {
          const nextSkuLines = meaningfulSkuInPayload ? payloadSkuRm : storedSkuLines;
          const nextLQ = hasLqKey ? rawLQ : bom.sku_bom_limit_qty;
          const nextLU = hasLuKey ? rawLU : bom.sku_bom_limit_uom;
          const skuUpdV = validateSkuBomTotals({
            lines: nextSkuLines,
            limitQty: nextLQ,
            limitUom: nextLU,
          });
          if (!skuUpdV.ok) {
            return res.status(400).json({ error: skuUpdV.error, code: skuUpdV.code });
          }
        }
        const bomUpdate = { updated_at: new Date() };
        if (rmFromPayload) bomUpdate.rm_lines = bomPayload.rm_lines;
        if (pmFromPayload) bomUpdate.pm_lines = bomPayload.pm_lines;
        if (Array.isArray(bomPayload.sku_rm_lines) && meaningfulSkuInPayload) {
          bomUpdate.sku_rm_lines = bomPayload.sku_rm_lines;
        }
        if (
          Object.prototype.hasOwnProperty.call(bomPayload, 'sku_bom_limit_qty') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'skuBomLimitQty')
        ) {
          bomUpdate.sku_bom_limit_qty = bomPayload.sku_bom_limit_qty ?? bomPayload.skuBomLimitQty ?? null;
        }
        if (
          Object.prototype.hasOwnProperty.call(bomPayload, 'sku_bom_limit_uom') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'skuBomLimitUom')
        ) {
          bomUpdate.sku_bom_limit_uom = bomPayload.sku_bom_limit_uom ?? bomPayload.skuBomLimitUom ?? null;
        }
        if (
          Object.prototype.hasOwnProperty.call(bomPayload, 'sku_bom_limit_qty') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'skuBomLimitQty') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'sku_bom_limit_uom') ||
          Object.prototype.hasOwnProperty.call(bomPayload, 'skuBomLimitUom')
        ) {
          const { formatSkuBomLimitAsPack } = require('../lib/skuBomPackSize');
          const lq = bomUpdate.sku_bom_limit_qty ?? bom.sku_bom_limit_qty;
          const lu = bomUpdate.sku_bom_limit_uom ?? bom.sku_bom_limit_uom;
          const pack = formatSkuBomLimitAsPack(lq, lu);
          bomUpdate.pack_size = pack !== '0' ? pack : null;
        }
        if (Array.isArray(bomPayload.process_steps)) bomUpdate.process_steps = bomPayload.process_steps;
        if (bomPayload.ph_range !== undefined) bomUpdate.ph_range = bomPayload.ph_range;
        if (bomPayload.brand_client !== undefined || bomPayload.brandClient !== undefined) {
          bomUpdate.client = bomPayload.brand_client ?? bomPayload.brandClient ?? null;
        }
        if (bomPayload.applicable_regulation !== undefined || bomPayload.applicableRegulation !== undefined) {
          bomUpdate.regulatory = bomPayload.applicable_regulation ?? bomPayload.applicableRegulation ?? null;
        }
        if (bomPayload.claims_substantiation !== undefined || bomPayload.claimsSubstantiation !== undefined) {
          bomUpdate.description = bomPayload.claims_substantiation ?? bomPayload.claimsSubstantiation ?? null;
        }
        if (bomPayload.yield_pct !== undefined) bomUpdate.yield_pct = bomPayload.yield_pct;
        if (bomPayload.stability_summary !== undefined) bomUpdate.stability_summary = bomPayload.stability_summary;
        if (bomPayload.pack_configuration !== undefined || bomPayload.packConfiguration !== undefined) {
          bomUpdate.spec_pack = bomPayload.pack_configuration ?? bomPayload.packConfiguration ?? null;
        }
        if (bomPayload.specific_gravity !== undefined || bomPayload.specificGravity !== undefined) {
          bomUpdate.spec_bulk = bomPayload.specific_gravity ?? bomPayload.specificGravity ?? null;
        }
        if (
          bomPayload.pr_sub_category !== undefined || bomPayload.prSubCategory !== undefined ||
          bomPayload.pr_qc_group !== undefined || bomPayload.prQcGroup !== undefined ||
          bomPayload.microbial_limits !== undefined || bomPayload.microbialLimits !== undefined ||
          bomPayload.spf_pa_rating !== undefined || bomPayload.sppRating !== undefined ||
          bomPayload.photostability !== undefined || bomPayload.phototability !== undefined ||
          bomPayload.freeze_thaw_cycles !== undefined || bomPayload.freezeThawCycles !== undefined ||
          bomPayload.cosmos_natural_certification !== undefined || bomPayload.cosmosNaturalCertification !== undefined ||
          bomPayload.dermatologically_tested !== undefined || bomPayload.dermatologicallyTested !== undefined ||
          bomPayload.cruelty_free_vegan !== undefined || bomPayload.crueltyFreeVegan !== undefined
        ) {
          const parsed = parseBomNotes(bom.notes);
          const subCat = String(bomPayload.pr_sub_category ?? bomPayload.prSubCategory ?? parsed.pr_sub_category ?? '').trim();
          const qcGroup = String(bomPayload.pr_qc_group ?? bomPayload.prQcGroup ?? parsed.pr_qc_group ?? '').trim();
          const microbial = String(bomPayload.microbial_limits ?? bomPayload.microbialLimits ?? parsed.microbial_limits ?? '').trim();
          const spf = String(bomPayload.spf_pa_rating ?? bomPayload.sppRating ?? parsed.spf_pa_rating ?? '').trim();
          const photo = String(bomPayload.photostability ?? bomPayload.phototability ?? parsed.photostability ?? '').trim();
          const freeze = String(bomPayload.freeze_thaw_cycles ?? bomPayload.freezeThawCycles ?? parsed.freeze_thaw_cycles ?? '').trim();
          const cosmos = String(bomPayload.cosmos_natural_certification ?? bomPayload.cosmosNaturalCertification ?? parsed.cosmos_natural_certification ?? '').trim();
          const derm = String(bomPayload.dermatologically_tested ?? bomPayload.dermatologicallyTested ?? parsed.dermatologically_tested ?? '').trim();
          const cruelty = String(bomPayload.cruelty_free_vegan ?? bomPayload.crueltyFreeVegan ?? parsed.cruelty_free_vegan ?? '').trim();
          const parts = [];
          if (qcGroup) parts.push(`QC Group: ${qcGroup}`);
          if (subCat) parts.push(`PR Sub-category: ${subCat}`);
          if (microbial) parts.push(`Microbial Limits: ${microbial}`);
          if (spf) parts.push(`SPF/PA Rating: ${spf}`);
          if (photo) parts.push(`Photostability: ${photo}`);
          if (freeze) parts.push(`Freeze-Thaw Cycles: ${freeze}`);
          if (cosmos) parts.push(`COSMOS / Natural Certification: ${cosmos}`);
          if (derm) parts.push(`Dermatologically Tested: ${derm}`);
          if (cruelty) parts.push(`Cruelty Free / Vegan: ${cruelty}`);
          bomUpdate.notes = parts.length ? parts.join(' | ') : null;
        }
        if (bomPayload.bom_composite_item !== undefined) {
          bomUpdate.bom_composite_item = !!bomPayload.bom_composite_item;
        } else if (bomPayload.bomCompositeItem !== undefined) {
          bomUpdate.bom_composite_item = !!bomPayload.bomCompositeItem;
        }
        if (
          bomPayload.pr_quality_spec_rows_by_section !== undefined ||
          bomPayload.prQualitySpecRowsBySection !== undefined
        ) {
          Object.assign(
            bomUpdate,
            prQualitySpecBomColumnPatch(
              bomPayload.pr_quality_spec_rows_by_section ?? bomPayload.prQualitySpecRowsBySection,
              bomPayload.pr_quality_bulk_sub_spec_rows_by_path ?? bomPayload.prQualityBulkSubSpecRowsByPath,
              bomPayload.pr_quality_final_sub_spec_rows_by_path ?? bomPayload.prQualityFinalSubSpecRowsByPath,
              bomPayload.pr_quality_dispatch_sub_spec_rows_by_path ??
                bomPayload.prQualityDispatchSubSpecRowsByPath
            )
          );
        }
        if (payloadHasQualitySpecEdits(bomPayload, PR_QUALITY_SPEC_EDIT_KEYS)) {
          bomUpdate.quality_specs_locked = true;
        }
        if (payloadHasQualitySpecEdits(bomPayload, PR_QUALITY_SPEC_EDIT_KEYS)) {
          bomUpdate.quality_specs_locked = true;
        }
        const facilityLicencesRaw =
          bomPayload.pr_facility_licences ??
          bomPayload.prFacilityLicences ??
          req.body.pr_facility_licences ??
          req.body.prFacilityLicences;
        if (facilityLicencesRaw !== undefined) {
          bomUpdate.pr_facility_licences =
            flattenPrFacilityLicencesForStorage(facilityLicencesRaw);
        }
        await bom.update(bomUpdate);
      }
    }

    // An RM/PM section changed → editor takes any open owner slot and BOTH approval tracks reset
    // to Draft (PR drops out of Active and must be re-approved by both teams).
    if (prSectionChange.rm || prSectionChange.pm) {
      await applyPrSectionChangeEffects(req, product, prSectionChange);
    }

    const body = { ...req.body };
    delete body.bom;
    if (body.brand_client !== undefined) {
      body.brand_name = body.brand_client;
    }
    delete body.pr_sub_category;
    delete body.pr_qc_group;
    delete body.pack_configuration;
    delete body.fill_size;
    delete body.packSize;
    delete body.specific_gravity;
    delete body.microbial_limits;
    delete body.spf_pa_rating;
    delete body.photostability;
    delete body.freeze_thaw_cycles;
    delete body.cosmos_natural_certification;
    delete body.dermatologically_tested;
    delete body.cruelty_free_vegan;
    delete body.brand_client;
    delete body.applicable_regulation;
    delete body.claims_substantiation;
    delete body.pr_facility_licences;

    await preservePrApprovalOnWrite(req, body, {
      status: product.status,
      lifecycle_status: product.lifecycle_status,
    });

    const mergedBody = await applyAutoAssignOnTouch(
      req,
      product,
      readApprovalStatusFromMasterRow('PR', product),
      body
    );

    await product.update({
      ...mergedBody,
      updated_at: new Date(),
    });

    return res.json(product);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const deleteProduct = async (req, res) => {
    try {
        const productId = parseInt(req.params.id, 10);
        if (Number.isNaN(productId)) return res.status(400).json({ error: 'Invalid product id' });

        const product = await Product.findByPk(productId);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        const resolvedProductId = product.product_id;

        await db.transaction(async (transaction) => {
          await softDeleteProductWithDependents(resolvedProductId, transaction);
          await scrubProcurementJsonForDeletedProducts([resolvedProductId], transaction);
        });

        // Invalidate cached product lists/details so the UI refreshes immediately.
        // Cache key pattern is built by createCacheReadMiddleware:
        //   products:v1:/api/v1/products:<stableQuery>:auth:<scope>
        await redisCache.delByPattern('products:v1:/api/v1/products:');

        res.status(204).send();
    } catch (err) {
        console.error('deleteProduct error', {
          productId: req?.params?.id,
          name: err?.name,
          message: err?.message,
          originalCode: err?.original?.code,
          originalDetail: err?.original?.detail,
        });
        const isFk =
          err &&
          (err.name === 'SequelizeForeignKeyConstraintError' ||
            err.name === 'SequelizeDatabaseError' ||
            err.original?.code === '23503');
        if (isFk) {
          return res.status(409).json({
            error:
              'Cannot delete product because it is referenced by other records (e.g. BOM / planning / batches). Remove dependencies first.',
            code: 'PR_DELETE_FK_CONSTRAINT',
          });
        }
        res.status(500).json({
          error: err?.message || 'Failed to delete product',
          name: err?.name,
          code: err?.original?.code,
        });
    }
};

const getCategory = async (req, res) => {
    try {
        const categories = await Category.findAll();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const saveCategory = async (req, res) => {
    try {
        const { error } = categorySchema.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({ errors: error.details.map(e => e.message) });
        }
        await Category.findOne({ where: { name: req.body.name } }).then(category => {
            if (category) {
                return res.status(400).json({ error: 'Category already exists!' });
            } else {
                Category.create(req.body).then(category => {
                    res.json(category);
                }).catch(err => {
                    return res.status(500).json({ error: err.message });
                });
            }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const getCategoryById = async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);
        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }
        res.json(category);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateCategory = async (req, res) => {
    try {
        const { error } = categoryUpdateSchema.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({ errors: error.details.map(e => e.message) });
        }
        const category = await Category.findByPk(req.params.id);
        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }
        const existing = await Category.findOne({
            where: { name: req.body.name, id: { [Op.ne]: req.params.id } }
        });
        if (existing) {
            return res.status(400).json({ error: 'Category name already in use' });
        }
        await category.update(req.body);
        res.json(category);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const deleteCategory = async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);
        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }
        await category.destroy();
        res.json({ message: 'Category deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * PATCH /api/v1/products/:id/approval-status — team workflow update for PR masters.
 */
/** Response payload for a PR after any approval-workflow change (dual-track shape). */
function formatPrApprovalResponse(product) {
  const d = product.get({ plain: true });
  const tracks = readTrackApprovals(product);
  return {
    product_id: d.product_id,
    product_code: d.product_code,
    product_name: d.product_name,
    status: d.status,
    lifecycle_status: d.lifecycle_status,
    pr_track_approvals: formatTrackApprovalsForApi(tracks),
    approval_stage_assignees: formatStageAssigneesForApi(readMasterApprovalStageAssignees(product)),
  };
}

const patchProductApprovalStatus = async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (Number.isNaN(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }
    const product = await Product.findOne({ where: productActiveWhere({ product_id: productId }) });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const body = req.body || {};
    const track = body.track != null ? String(body.track).trim().toLowerCase() : null;

    // Dual-track workflow: { track: 'rm'|'pm', action: 'send'|'approve'|'revert', note? }
    if (track) {
      if (track !== 'rm' && track !== 'pm') {
        return res.status(400).json({ error: 'track must be "rm" or "pm"', code: 'PR_TRACK_INVALID' });
      }
      const action = body.action != null ? String(body.action).trim().toLowerCase() : null;
      if (!['send', 'approve', 'revert'].includes(action)) {
        return res
          .status(400)
          .json({ error: 'action must be send, approve or revert', code: 'PR_TRACK_ACTION_INVALID' });
      }
      if (!(await canActOnTrack(req, product, track))) {
        const label = TRACK_LABEL[track];
        return res.status(403).json({
          error: `Only the assigned ${label} owner (or an admin) may ${action} the ${label} approval.`,
          message: `Only the assigned ${label} owner (or an admin) may ${action} the ${label} approval.`,
          code: 'MASTER_APPROVAL_FORBIDDEN',
        });
      }
      const note = body.note != null ? String(body.note).trim() || null : null;
      const result = await applyTrackAction({
        req,
        row: product,
        track,
        action,
        note,
        hooks: {
          readMasterId: (r) => r.get('product_id'),
          readMasterCode: (r) => r.get('product_code') ?? null,
        },
      });
      if (result.error) {
        return res.status(400).json({ error: result.error, code: result.code });
      }
      await product.reload();
      redisCache.delByPattern('products:').catch(() => {});
      return res.json(formatPrApprovalResponse(product));
    }

    // Assignee-only updates (assign RM/PM owner etc.) still flow through the shared handler.
    const ok = await handleMasterApprovalPatch(req, res, 'PR', product, prApprovalHooks());
    if (ok) {
      redisCache.delByPattern('products:').catch(() => {});
    }
  } catch (err) {
    console.error('patchProductApprovalStatus error', err);
    return res.status(500).json({ error: err.message || 'Failed to update approval status' });
  }
};

/**
 * PATCH /api/v1/products/:id/approval-track-claim — claim ownership of an open RM/PM section.
 * Catalogue-gated (same as editing the product), so any editor who starts touching an RM/PM
 * field immediately becomes that track's owner. No-op if already the owner; 409 if owned by
 * someone else. Does NOT reset approval tracks (no field change persisted yet).
 */
const claimProductApprovalTrack = async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (Number.isNaN(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }
    const track = req.body && req.body.track != null ? String(req.body.track).trim().toLowerCase() : null;
    if (track !== 'rm' && track !== 'pm') {
      return res.status(400).json({ error: 'track must be "rm" or "pm"', code: 'PR_TRACK_INVALID' });
    }
    const product = await Product.findOne({ where: productActiveWhere({ product_id: productId }) });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const callerId = callerIdFromReq(req);
    if (!callerId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const owner = readTrackOwner(product, track);
    if (owner && owner.userId !== callerId) {
      return res.status(409).json({
        error: `The ${TRACK_LABEL[track]} section is already owned by ${owner.displayName}.`,
        message: `The ${TRACK_LABEL[track]} section is already owned by ${owner.displayName}.`,
        code: 'PR_SECTION_LOCKED',
        ...formatPrApprovalResponse(product),
      });
    }
    if (!owner) {
      const stages = readMasterApprovalStageAssignees(product);
      const slot = await buildStageSlotForUserId(callerId);
      if (!slot) {
        return res.status(400).json({ error: 'Could not resolve current user' });
      }
      stages[TRACK_STAGE_KEY[track]] = slot;
      await product.update({
        approval_stage_assignees: formatStageAssigneesForApi(stages),
        approval_assigned_user_id: stages.approver?.userId ?? null,
        approval_assigned_display_name: stages.approver?.displayName ?? null,
        updated_at: new Date(),
      });
      redisCache.delByPattern('products:').catch(() => {});
    }
    return res.json(formatPrApprovalResponse(product));
  } catch (err) {
    console.error('claimProductApprovalTrack error', err);
    return res.status(500).json({ error: err.message || 'Failed to claim approval track' });
  }
};

const getProductApprovalStatusHistory = createMasterApprovalStatusHistoryHandler('PR', async (req) =>
  Product.findByPk(req.params.id)
);

module.exports = {
    saveProduct,
    syncPrProductZoho,
    importPrFromZohoBySku,
    createPRRegistration,
    getAllProducts,
    getProductById,
    getProductDetail,
    updateProduct,
    applyPrSectionChangeEffects,
    patchProductApprovalStatus,
    claimProductApprovalTrack,
    getProductApprovalStatusHistory,
    deleteProduct,
    getCategory,
    saveCategory,
    getCategoryById,
    updateCategory,
    deleteCategory,

};