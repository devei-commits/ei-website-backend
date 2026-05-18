/**
 * POST /api/v1/pack-materials/import-excel — multipart field `file` (.xlsx / .xlsm).
 * Parses workbooks with exceljs: multi-tab PM layout (same row/column layout as RM) or legacy "Item Reference".
 * Upserts run in chunks via executeItemReferenceBulkRows (packaging / pm_multi_sheet only).
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const { executeItemReferenceBulkRows, userAllows } = require('./itemReferenceBulkChunk');
const { detectWorksheetLayout, parseWorksheetDataRows, cellToText } = require('./masterExcelFlexibleParse');

const ITEM_REFERENCE_SHEET = 'Item Reference';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 50000;
const PM_EXCEL_IMPORT_CHUNK_SIZE = 200;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/** Tab names (case-insensitive, normalized spacing). "Shippers CFB" variant included if % is omitted in Excel. */
const PM_IMPORT_SHEET_NAMES_NORMALIZED = new Set([
  'primary packaging',
  'packaging - primary',
  'packaging - secondary',
  'labels',
  'monocartons',
  'shrink sleeves',
  'shippers %cfb',
  'shippers cfb',
  'fitness & misc',
  'other components',
  'stickers & kits',
]);

function normalizePmWorksheetTabName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isPmCategoryImportSheet(name) {
  const n = normalizePmWorksheetTabName(name);
  if (PM_IMPORT_SHEET_NAMES_NORMALIZED.has(n)) return true;
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
    return true;
  }
  return false;
}

function workbookHasPmCategoryTabs(workbook) {
  return (workbook.worksheets || []).some((w) => isPmCategoryImportSheet(w.name));
}

/**
 * Row 4 = headers A–M; data from row 5 (same as RM multi-sheet template).
 */
function parsePmMultiSheetWorkbook(workbook) {
  const rows = [];
  for (const worksheet of workbook.worksheets || []) {
    if (!isPmCategoryImportSheet(worksheet.name)) continue;
    const layout = detectWorksheetLayout(worksheet);
    if (!layout) continue;
    rows.push(
      ...parseWorksheetDataRows(worksheet, worksheet.name, layout, 'Packaging', 'pm_multi_sheet')
    );
  }
  return rows;
}

function parseLegacyItemReferenceSheetPackaging(workbook) {
  const sheet =
    workbook.getWorksheet(ITEM_REFERENCE_SHEET) ||
    (workbook.worksheets || []).find((w) => String(w.name).trim() === ITEM_REFERENCE_SHEET);
  if (!sheet) return { rows: [], rawMaterialRowsSkipped: 0 };
  const rows = [];
  let rawMaterialRowsSkipped = 0;
  const lastRow = sheet.actualRowCount || sheet.rowCount || 0;
  for (let r = 2; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    const sku = cellToText(row.getCell(1));
    const itemName = cellToText(row.getCell(2));
    const typeCell = cellToText(row.getCell(3));
    if (!sku && !itemName && !typeCell) continue;
    const tNorm = typeCell.toLowerCase().replace(/\s+/g, ' ');
    if (tNorm === 'raw material') {
      rawMaterialRowsSkipped += 1;
      continue;
    }
    if (tNorm !== 'packaging') continue;
    rows.push({
      excel_row: r,
      line_type: 'Packaging',
      zoho_sku_code: sku,
      description: itemName,
    });
  }
  return { rows, rawMaterialRowsSkipped };
}

async function extractPmRowsFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets || workbook.worksheets.length === 0) {
    throw new Error('Workbook has no worksheets');
  }

  if (workbookHasPmCategoryTabs(workbook)) {
    const rows = parsePmMultiSheetWorkbook(workbook);
    return { rows, format: 'multi_sheet', rawMaterialRowsSkipped: 0 };
  }

  const hasItemRef =
    workbook.getWorksheet(ITEM_REFERENCE_SHEET) != null ||
    (workbook.worksheets || []).some((w) => String(w.name).trim() === ITEM_REFERENCE_SHEET);
  if (!hasItemRef) {
    throw new Error(
      'No supported sheets found. Use tabs named Primary Packaging, Labels, Monocartons, Shrink Sleeves, Shippers %CFB (or Shippers CFB), and/or Fitness & Misc (headers row 4, data from row 5), or a legacy sheet named "Item Reference".'
    );
  }

  const { rows, rawMaterialRowsSkipped } = parseLegacyItemReferenceSheetPackaging(workbook);
  return { rows, format: 'item_reference', rawMaterialRowsSkipped };
}

async function postPmMasterExcelUpload(req, res) {
  try {
    const user = req.user;
    if (!user) return res.sendStatus(401);
    if (!userAllows(user, 'packaging-management')) {
      return res.status(403).json({ error: 'packaging-management access required' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    let extracted;
    try {
      extracted = await extractPmRowsFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('pmMasterExcel load/parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { rows, format, rawMaterialRowsSkipped } = extracted;

    if (!rows.length) {
      const hint =
        format === 'multi_sheet'
          ? 'No data rows found under PM category tabs (data should start on row 5).'
          : `No Packaging rows in "${ITEM_REFERENCE_SHEET}" (type column C, from row 2).`;
      return res.status(400).json({
        error: hint,
        format,
        raw_material_rows_skipped: rawMaterialRowsSkipped || 0,
      });
    }
    if (rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows` });
    }

    const chunkSize = PM_EXCEL_IMPORT_CHUNK_SIZE;
    const aggregated = {
      packaging_created: 0,
      packaging_updated: 0,
      skipped: 0,
      errors: 0,
      row_log: [],
    };
    let chunkIndex = 0;
    const chunkTotal = Math.max(1, Math.ceil(rows.length / chunkSize));

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const slice = rows.slice(offset, offset + chunkSize);
      const part = await executeItemReferenceBulkRows(slice, user, details);
      aggregated.packaging_created += part.packaging_created;
      aggregated.packaging_updated += part.packaging_updated;
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
      raw_material_rows_skipped: rawMaterialRowsSkipped || 0,
      rows_total: rows.length,
      chunk_size: chunkSize,
      chunks_processed: chunkTotal,
      summary: {
        packaging_created: aggregated.packaging_created,
        packaging_updated: aggregated.packaging_updated,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('postPmMasterExcelUpload error', err);
    return res.status(500).json({ error: err.message || 'Import failed' });
  }
}

const uploadPmMasterExcelMiddleware = multer({
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
  uploadPmMasterExcelMiddleware,
  postPmMasterExcelUpload,
  extractPmRowsFromBuffer,
};
