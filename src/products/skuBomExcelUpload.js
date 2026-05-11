/**
 * POST /api/v1/products/:id/sku-bom/upload-excel — import SKU BOM + Pack BOM from an Excel file.
 *
 * Workbook format (first sheet, first row = headers — case-insensitive match):
 *   - "Composite SKU"            (ignored if present)
 *   - "Component SKU" / "SKU Code" / "Item SKU" — match raw_materials / pack_materials by zoho_sku_code or code
 *   - "Component Name"           → material name (fallback RM/PM lookup)
 *   - "Type"                     → "Raw Material" or "Packaging"
 *   - "Qty per SKU (kg/nos)"     → numeric quantity per 1 finished unit
 *   - "UOM"                      → kg / gm for RM; nos for PM
 *
 * Flow:
 *   1. Parse with exceljs (first sheet, header row = 1).
 *   2. Match Component SKU (if present) against masters' zoho_sku_code then code; else match Component Name
 *      against raw_materials.{inci|name} or pack_materials.description (case-insensitive).
 *   3. Persist to the product's linked BOM:
 *        - sku_rm_lines (Raw Material rows)
 *        - pm_lines     (Packaging rows)
 *      Existing lines for the BOM are REPLACED.
 *   4. Respond with parsed rows, matched/unmatched counts, and updated line arrays.
 *
 * Validation of `sum(sku_rm_lines.qty) == sku_bom_limit_*` is intentionally skipped here
 * so partial / draft imports succeed. The product detail panel surfaces this validation
 * to the user on their next manual save.
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const db = require('../../db');
const { OrderItem } = require('../orders/models');
const redisCache = require('../cache/redis');
const {
  destroyProductWithDependents,
  scrubProcurementJsonForDeletedProducts,
  reconcileItemMasterBomIdsRemovingBomIds,
} = require('./destroyProductWithDependents');

const { Product } = require('./models');
const BOM = require('../bom/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { findRawMaterialByMasterSku, findPackMaterialByMasterSku } = require('./masterSkuLookup');
const { linkMaterialMastersToProductFromBomRow } = require('./linkMaterialMastersToProduct');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const uploadSkuBomExcelMiddleware = multer({
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

function normalizeHeader(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s_\-.]+/g, ' ')
    .replace(/[()/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns { headerMap: { field: colIndex }, headers: string[] } for the first row. */
function detectHeaders(sheet) {
  const firstRow = sheet.getRow(1);
  const headers = [];
  firstRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell?.value ?? '').trim();
  });

  const map = {};
  headers.forEach((h, idx) => {
    if (!h) return;
    const norm = normalizeHeader(h);
    if (!norm) return;
    if (norm === 'component name' || norm === 'name' || norm === 'material name') {
      map.name = idx;
    } else if (
      norm === 'component sku' ||
      norm === 'component sku code' ||
      norm === 'item sku' ||
      norm === 'material sku' ||
      norm === 'sku code'
    ) {
      if (map.component_sku == null) map.component_sku = idx;
    } else if (norm === 'type' || norm === 'material type') {
      map.type = idx;
    } else if (
      norm === 'qty per sku kg nos' ||
      norm === 'qty per sku' ||
      norm === 'quantity per sku' ||
      norm === 'qty' ||
      norm === 'quantity' ||
      norm === 'qty per unit'
    ) {
      map.qty = idx;
    } else if (norm === 'uom' || norm === 'unit' || norm === 'unit of measure') {
      map.uom = idx;
    }
  });

  return { headerMap: map, headers: headers.filter(Boolean) };
}

function cellToText(cell) {
  if (cell == null) return '';
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v).trim();
  }
  if (v.richText && Array.isArray(v.richText)) {
    return v.richText.map((r) => r.text || '').join('').trim();
  }
  if (v.text) return String(v.text).trim();
  if (v.result != null) return String(v.result).trim();
  if (v.hyperlink && v.text) return String(v.text).trim();
  return String(v).trim();
}

function cellToNumber(cell) {
  const raw = cellToText(cell);
  if (!raw) return NaN;
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  if (!cleaned) return NaN;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function classifyType(raw) {
  const s = normalizeHeader(raw);
  if (!s) return null;
  if (
    s.includes('pack') ||
    s === 'pm' ||
    s === 'pack material' ||
    s === 'packing' ||
    s === 'packing material'
  ) {
    return 'pack';
  }
  if (
    s.includes('raw') ||
    s === 'rm' ||
    s === 'raw material' ||
    s === 'ingredient' ||
    s === 'bulk'
  ) {
    return 'raw';
  }
  return null;
}

function normalizeRmUom(_u) {
  return 'KG';
}

function normalizePmUom(_u) {
  return 'PCS';
}

async function findRawMaterialByName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  const row = await RawMaterial.findOne({
    where: {
      [Op.or]: [
        sqlWhere(fn('lower', col('inci')), lowered),
        sqlWhere(fn('lower', col('name')), lowered),
      ],
    },
  });
  if (row) return row;
  const loose = await RawMaterial.findOne({
    where: {
      [Op.or]: [
        { inci: { [Op.iLike]: trimmed } },
        { name: { [Op.iLike]: trimmed } },
      ],
    },
  });
  return loose || null;
}

async function findPackMaterialByName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  const exact = await PackMaterial.findOne({
    where: sqlWhere(fn('lower', col('description')), lowered),
  });
  if (exact) return exact;
  return await PackMaterial.findOne({
    where: { description: { [Op.iLike]: trimmed } },
  });
}

async function parseWorkbookBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const err = new Error('Workbook has no worksheets');
    err.code = 'EMPTY_WORKBOOK';
    throw err;
  }
  const { headerMap, headers } = detectHeaders(sheet);
  const missing = [];
  if (headerMap.name == null && headerMap.component_sku == null) {
    missing.push('Component Name (or Component SKU / SKU Code)');
  }
  if (headerMap.type == null) missing.push('Type');
  if (headerMap.qty == null) missing.push('Qty per SKU');
  if (headerMap.uom == null) missing.push('UOM');
  if (missing.length > 0) {
    const err = new Error(
      `Missing required column(s): ${missing.join(', ')}. Found headers: ${headers.join(', ')}`
    );
    err.code = 'MISSING_COLUMNS';
    throw err;
  }

  const parsed = [];
  const lastRow = sheet.actualRowCount || sheet.rowCount || 1;
  for (let rowNum = 2; rowNum <= lastRow; rowNum += 1) {
    const row = sheet.getRow(rowNum);
    const nameCell = headerMap.name != null ? row.getCell(headerMap.name) : null;
    const typeCell = row.getCell(headerMap.type);
    const qtyCell = row.getCell(headerMap.qty);
    const uomCell = row.getCell(headerMap.uom);
    const skuCell = headerMap.component_sku != null ? row.getCell(headerMap.component_sku) : null;
    const name = nameCell ? cellToText(nameCell) : '';
    const componentSku = skuCell ? cellToText(skuCell) : '';
    const typeRaw = cellToText(typeCell);
    const qty = cellToNumber(qtyCell);
    const uomRaw = cellToText(uomCell);
    if (!name && !componentSku && !typeRaw && !Number.isFinite(qty) && !uomRaw) continue;
    parsed.push({
      row_number: rowNum,
      component_name: name,
      component_sku: componentSku,
      type_raw: typeRaw,
      kind: classifyType(typeRaw),
      qty: Number.isFinite(qty) ? qty : 0,
      uom_raw: uomRaw,
      sheet_name: sheet.name,
    });
  }
  return { rows: parsed, sheet_name: sheet.name };
}

async function uploadSkuBomExcel(req, res) {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isFinite(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Excel file is required (multipart field "file")' });
    }

    const product = await Product.findByPk(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    let parsed;
    try {
      parsed = await parseWorkbookBuffer(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'PARSE_ERROR' });
    }

    const skuRmLines = [];
    const pmLines = [];
    const unmatched = [];
    const skippedUnknownType = [];

    for (const r of parsed.rows) {
      if (!r.component_name && !String(r.component_sku || '').trim()) continue;

      if (r.kind === 'raw') {
        const skuTrim = String(r.component_sku || '').trim();
        let rm = skuTrim ? await findRawMaterialByMasterSku(skuTrim) : null;
        if (!rm && r.component_name) rm = await findRawMaterialByName(r.component_name);
        const uom = normalizeRmUom(r.uom_raw);
        if (rm) {
          skuRmLines.push({
            inci_name: rm.inci || rm.name || r.component_name,
            rm_code: rm.code || '',
            zoho_sku_code: rm.zoho_sku_code || null,
            raw_material_id: rm.id,
            qty_per_unit: r.qty,
            uom,
          });
        } else {
          unmatched.push({
            row_number: r.row_number,
            type: 'Raw Material',
            component_name: r.component_name,
            qty: r.qty,
            uom,
          });
          skuRmLines.push({
            inci_name: r.component_name,
            rm_code: '',
            zoho_sku_code: null,
            raw_material_id: null,
            qty_per_unit: r.qty,
            uom,
          });
        }
        continue;
      }

      if (r.kind === 'pack') {
        const skuTrim = String(r.component_sku || '').trim();
        let pm = skuTrim ? await findPackMaterialByMasterSku(skuTrim) : null;
        if (!pm && r.component_name) pm = await findPackMaterialByName(r.component_name);
        const uom = normalizePmUom(r.uom_raw);
        if (pm) {
          pmLines.push({
            pm_code: pm.code || '',
            zoho_sku_code: pm.zoho_sku_code || null,
            description: pm.description || r.component_name,
            pm_description: pm.description || r.component_name,
            pack_material_id: pm.id,
            pack_type: pm.level || 'Primary',
            qty_per_unit: r.qty,
            uom,
          });
        } else {
          unmatched.push({
            row_number: r.row_number,
            type: 'Packaging',
            component_name: r.component_name,
            qty: r.qty,
            uom,
          });
          pmLines.push({
            pm_code: '',
            zoho_sku_code: null,
            description: r.component_name,
            pm_description: r.component_name,
            pack_material_id: null,
            pack_type: 'Primary',
            qty_per_unit: r.qty,
            uom,
          });
        }
        continue;
      }

      skippedUnknownType.push({
        row_number: r.row_number,
        type_raw: r.type_raw,
        component_name: r.component_name,
      });
    }

    let bom = await BOM.findOne({ where: { product_id: productId } });
    if (!bom) {
      const productCode = product.product_code ? product.product_code : `PR-${productId}`;
      bom = await BOM.create({
        bom_code: `BOM-${productCode}`,
        name: product.product_name || `Product ${productId}`,
        product_id: productId,
        type: 'FG',
        status: 'Draft',
        rm_lines: [],
        sku_rm_lines: skuRmLines,
        pm_lines: pmLines,
        process_steps: [],
        created_at: new Date(),
        updated_at: new Date(),
      });
    } else {
      await bom.update({
        sku_rm_lines: skuRmLines,
        pm_lines: pmLines,
        updated_at: new Date(),
      });
    }

    await bom.reload();
    await product.reload();
    await linkMaterialMastersToProductFromBomRow(product, bom);

    return res.status(200).json({
      success: true,
      product_id: productId,
      bom_id: bom.id,
      sheet_name: parsed.sheet_name,
      summary: {
        total_rows: parsed.rows.length,
        sku_rm_count: skuRmLines.length,
        sku_rm_matched: skuRmLines.filter((r) => r.raw_material_id != null).length,
        sku_rm_unmatched: skuRmLines.filter((r) => r.raw_material_id == null).length,
        pm_count: pmLines.length,
        pm_matched: pmLines.filter((r) => r.pack_material_id != null).length,
        pm_unmatched: pmLines.filter((r) => r.pack_material_id == null).length,
        skipped_unknown_type: skippedUnknownType.length,
      },
      unmatched,
      skipped_unknown_type: skippedUnknownType,
      sku_rm_lines: skuRmLines,
      pm_lines: pmLines,
    });
  } catch (err) {
    console.error('uploadSkuBomExcel error', err);
    return res.status(500).json({ error: err.message || 'Failed to import Excel' });
  }
}

/**
 * POST /api/v1/products/:id/sku-bom/clear
 * Remove per-unit SKU RM lines and Pack BOM lines so a fresh Excel import can run.
 * Does not change formula (% w/w) rm_lines or process_steps.
 */
async function clearSkuBomForReimport(req, res) {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isFinite(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const product = await Product.findByPk(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const bom = await BOM.findOne({ where: { product_id: productId } });
    if (!bom) {
      return res.status(200).json({
        success: true,
        product_id: productId,
        bom_id: null,
        message: 'No BOM exists for this product yet; nothing to clear.',
      });
    }

    await bom.update({
      sku_rm_lines: [],
      pm_lines: [],
      sku_bom_limit_qty: null,
      sku_bom_limit_uom: null,
      updated_at: new Date(),
    });

    return res.status(200).json({
      success: true,
      product_id: productId,
      bom_id: bom.id,
      message:
        'SKU BOM and Pack BOM lines cleared. Formula BOM and process steps were not changed. You can upload Excel again.',
    });
  } catch (err) {
    console.error('clearSkuBomForReimport error', err);
    return res.status(500).json({ error: err.message || 'Failed to clear SKU BOM' });
  }
}

/**
 * POST /api/v1/products/:id/bom/full-reset
 * Clear all BOM line JSON (formula %, SKU RM, pack, process) and net limits, plus BOM/product pack hints
 * so Formula BOM + SKU Excel imports can run on a clean slate for this PR.
 * Does not delete the product or BOM row, and does not clear overview/spec scalar fields except
 * product.fill_size and product.product_code (internal code).
 */
async function clearPrBomFullForExcelReimport(req, res) {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isFinite(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const product = await Product.findByPk(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const bom = await BOM.findOne({ where: { product_id: productId } });
    const now = new Date();

    if (bom) {
      await bom.update({
        rm_lines: [],
        sku_rm_lines: [],
        pm_lines: [],
        process_steps: [],
        sku_bom_limit_qty: null,
        sku_bom_limit_uom: null,
        pack_size: null,
        updated_at: now,
      });
    }

    await product.update({
      fill_size: null,
      product_code: null,
      updated_at: now,
    });

    return res.status(200).json({
      success: true,
      product_id: productId,
      bom_id: bom ? bom.id : null,
      message: bom
        ? 'All BOM lines (formula, SKU RM, pack, process), net limits, and pack size were cleared; product fill size and internal product code were cleared. Re-import from Excel or edit the PR.'
        : 'Product fill size and internal product code cleared. No BOM row existed yet.',
    });
  } catch (err) {
    console.error('clearPrBomFullForExcelReimport error', err);
    return res.status(500).json({ error: err.message || 'Failed to reset PR BOM' });
  }
}

/** User must send this exact string in JSON body { "confirm": "..." } — prevents accidental mass wipe. */
const ALL_PR_BOM_RESET_CONFIRM = 'RESET_ALL_PR_BOM_DATA';

/**
 * POST /api/v1/products/bom/full-reset-all
 * Destructive: removes every PR / catalogue product that is linked from `boms.product_id`, deletes all
 * `boms` rows (including orphans), and scrubs procurement JSON lines that referenced those products.
 * Same dependent cleanup as DELETE /products/:id (inventory, planning, customizations, items_list PR rows).
 * Blocked when ecommerce order lines still reference any of those products.
 * Body: { "confirm": "RESET_ALL_PR_BOM_DATA" }
 */
async function clearAllPrBomForExcelReimport(req, res) {
  try {
    const confirm = String(req.body?.confirm ?? '').trim();
    if (confirm !== ALL_PR_BOM_RESET_CONFIRM) {
      return res.status(400).json({
        error: `Confirmation required. Send JSON body: { "confirm": "${ALL_PR_BOM_RESET_CONFIRM}" }`,
        code: 'CONFIRM_REQUIRED',
      });
    }

    const bomRows = await BOM.findAll({ attributes: ['id', 'product_id'], raw: true });
    const allBomIds = bomRows.map((r) => r.id);
    const productIds = [...new Set(bomRows.map((r) => r.product_id).filter((id) => id != null))];

    if (productIds.length > 0) {
      const orderLineCount = await OrderItem.count({
        where: { product_id: { [Op.in]: productIds } },
      });
      if (orderLineCount > 0) {
        return res.status(409).json({
          error: `Cannot remove PR masters: ${orderLineCount} order line(s) still reference these catalogue products. Remove or change those orders first.`,
          code: 'PR_RESET_BLOCKED_BY_ORDERS',
          order_items: orderLineCount,
        });
      }
    }

    await db.transaction(async (transaction) => {
      await reconcileItemMasterBomIdsRemovingBomIds(allBomIds, transaction);
      for (const pid of productIds) {
        await destroyProductWithDependents(pid, transaction);
      }
      await BOM.destroy({ where: {}, transaction });
      if (productIds.length > 0) {
        await scrubProcurementJsonForDeletedProducts(productIds, transaction);
      }
    });

    await redisCache.delByPattern('products:v1:/api/v1/products:').catch(() => {});

    return res.status(200).json({
      success: true,
      products_deleted: productIds.length,
      boms_removed: allBomIds.length,
      message: `Removed ${productIds.length} PR product(s) and ${allBomIds.length} BOM row(s) from the database. Raw and pack material masters were not changed.`,
    });
  } catch (err) {
    console.error('clearAllPrBomForExcelReimport error', err);
    return res.status(500).json({ error: err.message || 'Failed to reset all PR BOM data' });
  }
}

module.exports = {
  uploadSkuBomExcelMiddleware,
  uploadSkuBomExcel,
  clearSkuBomForReimport,
  clearPrBomFullForExcelReimport,
  clearAllPrBomForExcelReimport,
  ALL_PR_BOM_RESET_CONFIRM,
};
