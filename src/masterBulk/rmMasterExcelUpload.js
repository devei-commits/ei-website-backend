/**
 * POST /api/v1/raw-materials/import-excel — multipart field `file` (.xlsx / .xlsm).
 * Parses workbooks with exceljs (multi-tab RM layout or legacy "Item Reference" sheet),
 * then runs the same upserts as item-reference bulk (raw materials only from this route).
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const { executeItemReferenceBulkRows, userAllows } = require('./itemReferenceBulkChunk');
const {
  detectWorksheetLayout,
  detectRmFillWorkbookLayout,
  parseRmFillWorksheet,
  parseWorksheetDataRows,
  cellToText,
} = require('./masterExcelFlexibleParse');

const ITEM_REFERENCE_SHEET = 'Item Reference';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 50000;
/** Same ceiling as POST /item-reference-bulk-chunk — keeps DB work per batch bounded. */
const RM_EXCEL_IMPORT_CHUNK_SIZE = 200;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const RM_IMPORT_SHEET_NAMES_NORMALIZED = new Set([
  'raw materials',
  'fragrances',
  'colors & pigments',
  'club items',
  'bulk raw materials',
  'solvents & carriers',
  'pre-mixed based',
  'pre-mixed bases',
]);

function normalizeRmWorksheetTabName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isRmCategoryImportSheet(name) {
  const n = normalizeRmWorksheetTabName(name);
  if (RM_IMPORT_SHEET_NAMES_NORMALIZED.has(n)) return true;
  if (
    n.includes('bulk raw') ||
    n.includes('solvent') ||
    n.includes('carrier') ||
    n.includes('pre-mixed') ||
    n.includes('premixed') ||
    n.includes('fragrance') ||
    n.includes('pigment') ||
    (n.includes('color') && n.includes('pigment')) ||
    n.includes('club item') ||
    n.includes('raw material')
  ) {
    return true;
  }
  return false;
}

function workbookHasRmCategoryTabs(workbook) {
  return (workbook.worksheets || []).some((w) => isRmCategoryImportSheet(w.name));
}

function parseRmMultiSheetWorkbook(workbook) {
  const rows = [];
  for (const worksheet of workbook.worksheets || []) {
    if (!isRmCategoryImportSheet(worksheet.name)) continue;
    const fillLayout = detectRmFillWorkbookLayout(worksheet);
    if (fillLayout) {
      rows.push(...parseRmFillWorksheet(worksheet, fillLayout));
      continue;
    }
    const layout = detectWorksheetLayout(worksheet);
    if (!layout) continue;
    rows.push(
      ...parseWorksheetDataRows(worksheet, worksheet.name, layout, 'Raw Material', 'rm_multi_sheet')
    );
  }
  return rows;
}

function parseLegacyItemReferenceSheet(workbook) {
  const sheet =
    workbook.getWorksheet(ITEM_REFERENCE_SHEET) ||
    (workbook.worksheets || []).find((w) => String(w.name).trim() === ITEM_REFERENCE_SHEET);
  if (!sheet) return { rows: [], packagingRowsSkipped: 0 };
  const rows = [];
  let packagingRowsSkipped = 0;
  const lastRow = sheet.actualRowCount || sheet.rowCount || 0;
  for (let r = 2; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    const sku = cellToText(row.getCell(1));
    const itemName = cellToText(row.getCell(2));
    const typeCell = cellToText(row.getCell(3));
    if (!sku && !itemName && !typeCell) continue;
    const tNorm = typeCell.toLowerCase().replace(/\s+/g, ' ');
    if (tNorm === 'packaging') {
      packagingRowsSkipped += 1;
      continue;
    }
    if (tNorm !== 'raw material') continue;
    rows.push({
      excel_row: r,
      line_type: 'Raw Material',
      zoho_sku_code: sku,
      description: itemName,
    });
  }
  return { rows, packagingRowsSkipped };
}

async function extractRowsFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets || workbook.worksheets.length === 0) {
    throw new Error('Workbook has no worksheets');
  }

  if (workbookHasRmCategoryTabs(workbook)) {
    const rows = parseRmMultiSheetWorkbook(workbook);
    const format = rows.some((r) => r.import_profile === 'rm_raw_materials_worksheet')
      ? 'raw_materials_worksheet'
      : 'multi_sheet';
    return { rows, format, packagingRowsSkipped: 0 };
  }

  const hasItemRef =
    workbook.getWorksheet(ITEM_REFERENCE_SHEET) != null ||
    (workbook.worksheets || []).some((w) => String(w.name).trim() === ITEM_REFERENCE_SHEET);
  if (!hasItemRef) {
    throw new Error(
      'No supported sheets found. Use tabs named Raw Materials, Fragrances, Colors & Pigments, and/or Club Items (headers row 4, data from row 5), or a legacy sheet named "Item Reference".'
    );
  }

  const { rows, packagingRowsSkipped } = parseLegacyItemReferenceSheet(workbook);
  return { rows, format: 'item_reference', packagingRowsSkipped };
}

async function postRmMasterExcelUpload(req, res) {
  try {
    const user = req.user;
    if (!user) return res.sendStatus(401);
    if (!userAllows(user, 'raw-materials-management')) {
      return res.status(403).json({ error: 'raw-materials-management access required' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    let extracted;
    try {
      extracted = await extractRowsFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('rmMasterExcel load/parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { rows, format, packagingRowsSkipped } = extracted;

    if (!rows.length) {
      const hint =
        format === 'raw_materials_worksheet'
          ? 'No data rows in RM fill sheets (headers row 4, data from row 5: SKU, Item Name as INCI and trade name, Sub-Category, UOM, HSN, GST%). BOM Name column is ignored.'
          : format === 'multi_sheet'
            ? 'No data rows found under RM category tabs (data should start on row 5).'
            : `No Raw Material rows in "${ITEM_REFERENCE_SHEET}" (type column C, from row 2).`;
      return res.status(400).json({
        error: hint,
        format,
        packaging_rows_skipped: packagingRowsSkipped || 0,
      });
    }
    if (rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows` });
    }

    const chunkSize = RM_EXCEL_IMPORT_CHUNK_SIZE;
    const aggregated = {
      raw_created: 0,
      raw_updated: 0,
      skipped: 0,
      errors: 0,
      row_log: [],
    };
    let chunkIndex = 0;
    const chunkTotal = Math.max(1, Math.ceil(rows.length / chunkSize));

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const slice = rows.slice(offset, offset + chunkSize);
      const part = await executeItemReferenceBulkRows(slice, user, details);
      aggregated.raw_created += part.raw_created;
      aggregated.raw_updated += part.raw_updated;
      aggregated.skipped += part.skipped;
      aggregated.errors += part.errors;
      if (details && Array.isArray(part.row_log) && part.row_log.length) {
        aggregated.row_log.push(
          ...part.row_log.map((entry) => ({ ...entry, chunk_index: chunkIndex, chunk_total: chunkTotal }))
        );
      }
      chunkIndex += 1;
    }

    return res.json({
      ok: true,
      format,
      packaging_rows_skipped: packagingRowsSkipped || 0,
      rows_total: rows.length,
      chunk_size: chunkSize,
      chunks_processed: chunkTotal,
      summary: {
        raw_material_created: aggregated.raw_created,
        raw_material_updated: aggregated.raw_updated,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('postRmMasterExcelUpload error', err);
    return res.status(500).json({ error: err.message || 'Import failed' });
  }
}

const uploadRmMasterExcelMiddleware = multer({
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

module.exports = {
  uploadRmMasterExcelMiddleware,
  postRmMasterExcelUpload,
  extractRowsFromBuffer,
};
