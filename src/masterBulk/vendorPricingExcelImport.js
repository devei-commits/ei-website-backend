/**
 * POST /api/v1/items-list/import-vendor-pricing-excel
 * Workbook tabs (e.g. Bulk Raw Materials, Labels, Packaging - Primary) with columns:
 * SKU, Item Name, Category, Sub-Category, Primary Vendor, MOQ, Price/Unit
 * Matches RM/PM by zoho_sku_code then code; upserts items_list + item_list_vendor_rates + tiers.
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op } = require('sequelize');
const db = require('../../db');
const VendorClient = require('../vendorClient/models');
const { findRawMaterialByMasterSku, findPackMaterialByMasterSku } = require('../products/masterSkuLookup');
const {
  findOrCreateItemsListRow,
  upsertVendorRateAndTier,
} = require('../vendorClient/syncVendorItemsPriceList');
const redis = require('../cache/redis');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 50000;
const CHUNK_SIZE = 150;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/** Normalized worksheet name → RM | PM (lifecycle tabs from vendor pricing workbook). */
const SHEET_ITEM_TYPE = {
  'bulk raw materials': 'RM',
  'club items': 'RM',
  'solvents & carriers': 'RM',
  'pre-mixed based': 'RM',
  'labels': 'PM',
  'monocartons': 'PM',
  'other components': 'PM',
  'packaging - primary': 'PM',
  'packaging - secondary': 'PM',
  'shrink sleeves': 'PM',
  'stickers & kits': 'PM',
  // Legacy / alternate tab names still used in master imports
  'raw materials': 'RM',
  'fragrances': 'RM',
  'colors & pigments': 'RM',
  'primary packaging': 'PM',
  'shippers %cfb': 'PM',
  'shippers cfb': 'PM',
  'fitness & misc': 'PM',
  'fitments & misc': 'PM',
};

const HEADER_ALIASES = {
  sku: ['sku', 'item sku', 'item code', 'code', 'zoho sku'],
  itemName: ['item name', 'name', 'description', 'item description'],
  category: ['category'],
  subCategory: ['sub-category', 'sub category', 'subcategory'],
  primaryVendor: ['primary vendor', 'vendor', 'preferred vendor', 'supplier'],
  moq: ['moq', 'minimum order quantity', 'min order qty'],
  price: ['price/unit', 'price per unit', 'unit price', 'price', 'rate', 'purchase rate'],
};

function normalizeSheetName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function inferItemTypeFromSheetName(sheetName) {
  const n = normalizeSheetName(sheetName);
  if (SHEET_ITEM_TYPE[n]) return SHEET_ITEM_TYPE[n];
  if (
    n.includes('packaging') ||
    n.includes('label') ||
    n.includes('carton') ||
    n.includes('sleeve') ||
    n.includes('sticker') ||
    n.includes('kit') ||
    n.includes('component') ||
    n.includes('shipper')
  ) {
    return 'PM';
  }
  if (
    n.includes('raw') ||
    n.includes('solvent') ||
    n.includes('carrier') ||
    n.includes('bulk') ||
    n.includes('pre-mixed') ||
    n.includes('premixed') ||
    n.includes('club') ||
    n.includes('fragrance') ||
    n.includes('pigment')
  ) {
    return 'RM';
  }
  return null;
}

function cellToText(cell) {
  if (cell == null) return '';
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v).trim();
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (v.richText && Array.isArray(v.richText)) {
    return v.richText.map((r) => r.text || '').join('').trim();
  }
  if (v.text) return String(v.text).trim();
  if (v.result != null) return String(v.result).trim();
  if (v.hyperlink && v.text) return String(v.text).trim();
  return String(v).trim();
}

function normalizeHeaderLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 20, 30);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a || label.startsWith(`${a} `) || label.endsWith(` ${a}`))) {
          map[key] = c;
        }
      }
    }
    if (map.sku && (map.primaryVendor || map.price || map.category || map.subCategory)) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  const s = String(value).replace(/[,₹]/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseMoq(value) {
  if (value == null || value === '') return 1;
  const n = parseInt(String(value).replace(/,/g, '').trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * @returns {Array<{ sheet_name, excel_row, item_type, sku, item_name, category, sub_category, vendor_name, moq, price }>}
 */
function parseVendorPricingWorkbook(workbook) {
  const rows = [];
  const sheetsSkipped = [];

  for (const worksheet of workbook.worksheets || []) {
    const sheetName = worksheet.name;
    const itemType = inferItemTypeFromSheetName(sheetName);
    if (!itemType) {
      sheetsSkipped.push(sheetName);
      continue;
    }

    const header = detectColumnMap(worksheet);
    if (!header) {
      sheetsSkipped.push(`${sheetName} (no header row)`);
      continue;
    }

    const { headerRow, col } = header;
    const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;
    for (let r = headerRow + 1; r <= lastRow; r += 1) {
      const row = worksheet.getRow(r);
      const sku = col.sku ? cellToText(row.getCell(col.sku)) : '';
      const itemName = col.itemName ? cellToText(row.getCell(col.itemName)) : '';
      const vendorName = col.primaryVendor ? cellToText(row.getCell(col.primaryVendor)) : '';
      const moqRaw = col.moq ? row.getCell(col.moq).value : null;
      const priceRaw = col.price ? row.getCell(col.price).value : null;
      const category = col.category ? cellToText(row.getCell(col.category)) : '';
      const subCategory = col.subCategory ? cellToText(row.getCell(col.subCategory)) : '';

      if (!sku && !itemName && !vendorName) continue;

      rows.push({
        sheet_name: sheetName,
        excel_row: r,
        item_type: itemType,
        sku,
        item_name: itemName,
        category,
        sub_category: subCategory,
        vendor_name: vendorName,
        moq: parseMoq(moqRaw),
        price: parseMoney(priceRaw),
      });
    }
  }

  return { rows, sheetsSkipped };
}

async function findMasterBySku(itemType, sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  if (itemType === 'RM') {
    const rm = await findRawMaterialByMasterSku(t);
    return rm ? { kind: 'RM', id: rm.id, code: rm.code, name: rm.name } : null;
  }
  if (itemType === 'PM') {
    const pm = await findPackMaterialByMasterSku(t);
    return pm ? { kind: 'PM', id: pm.id, code: pm.code, name: pm.description || pm.code } : null;
  }
  return null;
}

async function findVendorByName(name, vendorCache) {
  const n = String(name || '').trim();
  if (!n) return null;
  const key = n.toLowerCase();
  if (vendorCache.has(key)) return vendorCache.get(key);

  const row = await VendorClient.findOne({
    where: { type: 'vendor', name: { [Op.iLike]: n } },
  });

  vendorCache.set(key, row || null);
  return row;
}

async function nextVendorEntityCode(transaction) {
  const prefix = 'EI-VEN-';
  const rows = await VendorClient.findAll({
    where: { entity_code: { [Op.like]: `${prefix}%` } },
    attributes: ['entity_code'],
    order: [['entity_code', 'DESC']],
    transaction,
  });
  let nextNum = 1;
  const numericPart = rows
    .map((r) => {
      const code = r.entity_code || r.get?.('entity_code');
      const match = String(code).replace(prefix, '').match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => !Number.isNaN(n));
  if (numericPart.length > 0) nextNum = Math.max(...numericPart) + 1;
  return `${prefix}${String(nextNum).padStart(5, '0')}`;
}

async function ensureVendorByName(name, { createMissing, vendorCache, transaction }) {
  const n = String(name || '').trim();
  if (!n) return { vendor: null, created: false };

  let vendor = await findVendorByName(n, vendorCache);
  if (vendor || !createMissing) return { vendor, created: false };

  const entity_code = await nextVendorEntityCode(transaction);
  vendor = await VendorClient.create(
    {
      entity_code,
      type: 'vendor',
      name: n,
      status: 'active',
      data: { vendorItems: [] },
    },
    { transaction }
  );
  vendorCache.set(n.toLowerCase(), vendor);
  return { vendor, created: true };
}

async function invalidatePricingCaches() {
  await Promise.all([
    redis.delByPattern('items-list:').catch(() => {}),
    redis.delByPattern('vendor-client:').catch(() => {}),
    redis.delByPattern('procurement:').catch(() => {}),
  ]);
}

/**
 * @param {Array<object>} rows
 * @param {{ createMissingVendors?: boolean, details?: boolean }} opts
 */
async function executeVendorPricingRows(rows, opts = {}) {
  const createMissingVendors = Boolean(opts.createMissingVendors);
  const details = Boolean(opts.details);
  const vendorCache = new Map();

  const summary = {
    synced: 0,
    skipped: 0,
    errors: 0,
    vendors_created: 0,
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
    if (!row.vendor_name) {
      summary.skipped += 1;
      if (details) summary.row_log.push({ ...logBase, action: 'skipped', reason: 'missing_primary_vendor' });
      continue;
    }
    if (row.price == null) {
      summary.skipped += 1;
      if (details) summary.row_log.push({ ...logBase, action: 'skipped', reason: 'missing_price' });
      continue;
    }

    const transaction = await db.transaction();
    try {
      const master = await findMasterBySku(row.item_type, row.sku);
      if (!master) {
        await transaction.rollback();
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

      const { vendor, created } = await ensureVendorByName(row.vendor_name, {
        createMissing: createMissingVendors,
        vendorCache,
        transaction,
      });
      if (!vendor) {
        await transaction.rollback();
        summary.skipped += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'skipped',
            reason: 'vendor_not_found',
            vendor: row.vendor_name,
          });
        }
        continue;
      }
      if (created) summary.vendors_created += 1;

      const listRow = await findOrCreateItemsListRow(master.kind, master.id, transaction);
      await upsertVendorRateAndTier(
        vendor.id,
        listRow.id,
        {
          itemCode: master.code,
          itemType: master.kind,
          itemName: row.item_name || master.name,
          unitPrice: row.price,
          moq: row.moq,
        },
        transaction
      );

      await transaction.commit();
      summary.synced += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'synced',
          vendor_id: vendor.id,
          vendor_name: vendor.name,
          master_code: master.code,
          items_list_id: listRow.id,
        });
      }
    } catch (err) {
      await transaction.rollback();
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

  if (summary.synced > 0 || summary.vendors_created > 0) {
    await invalidatePricingCaches();
  }

  return summary;
}

async function extractVendorPricingFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets?.length) {
    throw new Error('Workbook has no worksheets');
  }
  return parseVendorPricingWorkbook(workbook);
}

async function postVendorPricingExcelImport(req, res) {
  try {
    if (!req.user) return res.sendStatus(401);
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;
    const createMissingVendors =
      req.query.create_missing_vendors === '1' ||
      req.query.create_missing_vendors === 'true' ||
      req.body?.create_missing_vendors === true;

    let parsed;
    try {
      parsed = await extractVendorPricingFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('[vendor-pricing-excel] parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { rows, sheetsSkipped } = parsed;
    if (!rows.length) {
      return res.status(400).json({
        error:
          'No pricing rows found. Expected tabs like "Bulk Raw Materials", "Labels", etc. with header row containing SKU, Primary Vendor, MOQ, Price/Unit.',
        sheets_skipped: sheetsSkipped,
      });
    }
    if (rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
    }

    const aggregated = {
      synced: 0,
      skipped: 0,
      errors: 0,
      vendors_created: 0,
      row_log: [],
    };

    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const slice = rows.slice(offset, offset + CHUNK_SIZE);
      const part = await executeVendorPricingRows(slice, { createMissingVendors, details });
      aggregated.synced += part.synced;
      aggregated.skipped += part.skipped;
      aggregated.errors += part.errors;
      aggregated.vendors_created += part.vendors_created;
      if (details && part.row_log?.length) aggregated.row_log.push(...part.row_log);
    }

    return res.json({
      ok: true,
      rows_total: rows.length,
      sheets_skipped: sheetsSkipped,
      create_missing_vendors: createMissingVendors,
      summary: {
        rates_synced: aggregated.synced,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
        vendors_created: aggregated.vendors_created,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('[vendor-pricing-excel] import error', err);
    return res.status(500).json({ error: err.message || 'Vendor pricing import failed' });
  }
}

const uploadVendorPricingExcelMiddleware = multer({
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

function uploadVendorPricingExcelSafe(req, res, next) {
  uploadVendorPricingExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

module.exports = {
  uploadVendorPricingExcelSafe,
  postVendorPricingExcelImport,
  parseVendorPricingWorkbook,
  extractVendorPricingFromBuffer,
  inferItemTypeFromSheetName,
  normalizeSheetName,
  executeVendorPricingRows,
};
