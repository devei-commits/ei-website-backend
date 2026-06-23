/**
 * POST /api/v1/items-list/import-master-categories-excel
 * Same workbook layout as vendor pricing (SKU, Category, Sub-Category per tab).
 * Updates RM/PM category, sub-category (group), and form_data — no vendor rates required.
 */
const multer = require('multer');
const { findRawMaterialByMasterSku, findPackMaterialByMasterSku } = require('../products/masterSkuLookup');
const { mapRmImportCategories, mapPmImportCategories } = require('./masterCategoryImportMap');
const {
  parseVendorPricingWorkbook,
  extractVendorPricingFromBuffer: extractWorkbookFromBuffer,
} = require('./vendorPricingExcelImport');
const redis = require('../cache/redis');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 50000;
const CHUNK_SIZE = 200;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

function mergeFormData(existing, patch) {
  const base =
    existing != null && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return { ...base, ...patch };
}

async function findMasterRow(itemType, sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  if (itemType === 'RM') {
    const rm = await findRawMaterialByMasterSku(t);
    return rm ? { kind: 'RM', row: rm } : null;
  }
  if (itemType === 'PM') {
    const pm = await findPackMaterialByMasterSku(t);
    return pm ? { kind: 'PM', row: pm } : null;
  }
  return null;
}

async function invalidateMasterCategoryCaches() {
  await Promise.all([
    redis.delByPattern('raw-materials:').catch(() => {}),
    redis.delByPattern('pack-materials:').catch(() => {}),
    redis.delByPattern('packaging:').catch(() => {}),
    redis.delByPattern('items-list:').catch(() => {}),
  ]);
}

/**
 * @param {Array<{ sheet_name, excel_row, item_type, sku, category, sub_category }>} rows
 * @param {{ details?: boolean }} opts
 */
async function executeMasterCategoryRows(rows, opts = {}) {
  const details = Boolean(opts.details);
  const summary = {
    rm_updated: 0,
    pm_updated: 0,
    skipped: 0,
    errors: 0,
    row_log: [],
  };

  for (const row of rows) {
    const logBase = {
      sheet: row.sheet_name,
      excel_row: row.excel_row,
      sku: row.sku,
      item_type: row.item_type,
    };

    if (!row.sku) {
      summary.skipped += 1;
      if (details) summary.row_log.push({ ...logBase, action: 'skipped', reason: 'missing_sku' });
      continue;
    }

    const cat = String(row.category || '').trim();
    const sub = String(row.sub_category || '').trim();
    if (!cat && !sub && !row.sheet_name) {
      summary.skipped += 1;
      if (details) summary.row_log.push({ ...logBase, action: 'skipped', reason: 'missing_category_columns' });
      continue;
    }

    try {
      const master = await findMasterRow(row.item_type, row.sku);
      if (!master) {
        summary.skipped += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'skipped',
            reason: `no_${row.item_type}_master_for_sku`,
          });
        }
        continue;
      }

      if (master.kind === 'RM') {
        const mapped = mapRmImportCategories({
          sheetName: row.sheet_name,
          categoryCol: cat,
          subCategoryCol: sub,
          code: row.sku,
        });
        await master.row.update({
          category: mapped.categoryDb,
          group: mapped.subCategory,
          form_data: mergeFormData(master.row.form_data, mapped.formDataPatch),
        });
        summary.rm_updated += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'updated',
            kind: 'RM',
            id: String(master.row.id),
            sub_category: mapped.subCategory,
            rm_category_key: mapped.rmCategoryKey,
          });
        }
      } else {
        const mapped = mapPmImportCategories({
          sheetName: row.sheet_name,
          categoryCol: cat,
          subCategoryCol: sub,
          code: row.sku,
        });
        await master.row.update({
          group: mapped.groupDb,
          material: mapped.materialDb,
          ...(mapped.levelDb ? { level: mapped.levelDb } : {}),
          form_data: mergeFormData(master.row.form_data, mapped.formDataPatch),
        });
        summary.pm_updated += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'updated',
            kind: 'PM',
            id: String(master.row.id),
            sub_category: mapped.subCategory,
            pm_category: mapped.pmCategory,
          });
        }
      }
    } catch (err) {
      summary.errors += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'error',
          reason: err.message || String(err),
        });
      }
    }
  }

  if (summary.rm_updated + summary.pm_updated > 0) {
    await invalidateMasterCategoryCaches();
  }

  return summary;
}

async function postMasterCategoriesExcelImport(req, res) {
  try {
    if (!req.user) return res.sendStatus(401);
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    let parsed;
    try {
      parsed = await extractWorkbookFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('[master-categories-excel] parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { rows, sheetsSkipped } = parsed;
    if (!rows.length) {
      return res.status(400).json({
        error:
          'No rows found. Use the same workbook as vendor pricing: tabs like Bulk Raw Materials, Labels, Packaging - Primary with SKU and Category / Sub-Category columns.',
        sheets_skipped: sheetsSkipped,
      });
    }
    if (rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
    }

    const aggregated = {
      rm_updated: 0,
      pm_updated: 0,
      skipped: 0,
      errors: 0,
      row_log: [],
    };

    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const slice = rows.slice(offset, offset + CHUNK_SIZE);
      const part = await executeMasterCategoryRows(slice, { details });
      aggregated.rm_updated += part.rm_updated;
      aggregated.pm_updated += part.pm_updated;
      aggregated.skipped += part.skipped;
      aggregated.errors += part.errors;
      if (details && part.row_log?.length) aggregated.row_log.push(...part.row_log);
    }

    return res.json({
      ok: true,
      rows_total: rows.length,
      sheets_skipped: sheetsSkipped,
      summary: {
        rm_updated: aggregated.rm_updated,
        pm_updated: aggregated.pm_updated,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('[master-categories-excel] import error', err);
    return res.status(500).json({ error: err.message || 'Category import failed' });
  }
}

const uploadMasterCategoriesExcelMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = String(file?.originalname || '').toLowerCase();
    const okName = name.endsWith('.xlsx') || name.endsWith('.xlsm');
    const okMime = !file?.mimetype || ALLOWED_MIME.has(file.mimetype);
    if (okName && okMime) return cb(null, true);
    cb(new Error('Only .xlsx / .xlsm files are accepted'));
  },
}).single('file');

function uploadMasterCategoriesExcelSafe(req, res, next) {
  uploadMasterCategoriesExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

module.exports = {
  uploadMasterCategoriesExcelSafe,
  postMasterCategoriesExcelImport,
  executeMasterCategoryRows,
  parseVendorPricingWorkbook,
};
