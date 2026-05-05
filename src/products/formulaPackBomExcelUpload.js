/**
 * Worksheet "Packaging BOM": multi-composite rows grouped by Composite SKU.
 * Updates only boms.pm_lines — preserves sku_rm_lines, sku_bom_limit_*, rm_lines, process_steps.
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op, fn, col, where: sqlWhere } = require('sequelize');

const BOM = require('../bom/models');
const PackMaterial = require('../packMaterials/models');
const { findOrCreateProductForFormulaBom, applyPackSizeToProductAndBom } = require('./formulaBomProductResolve');

const PREFERRED_SHEET_NAME = 'Packaging BOM';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const uploadFormulaPackBomExcelMiddleware = multer({
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

function normalizeSheetName(s) {
  return normalizeHeader(s);
}

function pickPackagingSheet(workbook) {
  const sheets = workbook.worksheets || [];
  if (sheets.length === 0) return null;
  const exact = sheets.find((sh) => String(sh.name || '').trim() === PREFERRED_SHEET_NAME);
  if (exact) return exact;
  const exactNorm = sheets.find(
    (sh) => normalizeSheetName(sh.name) === normalizeSheetName(PREFERRED_SHEET_NAME)
  );
  if (exactNorm) return exactNorm;
  return (
    sheets.find((sh) => {
      const n = normalizeSheetName(sh.name);
      return n.includes('packaging') && n.includes('bom');
    }) || null
  );
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

function normalizePmUom(u) {
  const s = normalizeHeader(u);
  if (!s) return 'nos';
  if (
    s === 'nos' ||
    s === 'no' ||
    s === 'pcs' ||
    s === 'pc' ||
    s === 'piece' ||
    s === 'pieces' ||
    s === 'unit' ||
    s === 'units'
  ) {
    return 'nos';
  }
  return String(u || '').trim() || 'nos';
}

function detectPackagingHeaders(sheet) {
  const firstRow = sheet.getRow(1);
  const headers = [];
  firstRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell?.value ?? '').trim();
  });

  const map = {};
  headers.forEach((h, idx) => {
    if (!h) return;
    const norm = normalizeHeader(h);
    if (norm === 'composite sku' && map.composite_sku == null) map.composite_sku = idx;
    else if (norm === 'composite name' && map.composite_name == null) map.composite_name = idx;
    else if (
      (norm === 'volume in kg ltr' || norm === 'volume in kg litre' || norm === 'volume in kg liter') &&
      map.volume_kg_ltr == null
    ) {
      map.volume_kg_ltr = idx;
    } else if (norm === 'volume' && map.volume == null) {
      map.volume = idx;
    } else if ((norm === 'uom' || norm === 'unit' || norm === 'unit of measure') && map.uom == null) {
      map.uom = idx;
    } else if ((norm === 'sg' || norm === 'specific gravity') && map.sg == null) {
      map.sg = idx;
    } else if (norm === 'component sku' && map.component_sku == null) map.component_sku = idx;
    else if (norm === 'component name' && map.component_name == null) map.component_name = idx;
    else if (
      (norm === 'qty per unit' ||
        norm === 'qty per sku kg nos' ||
        norm === 'qty per sku' ||
        norm === 'quantity per unit') &&
      map.qty == null
    ) {
      map.qty = idx;
    }
  });

  return { headerMap: map, headers: headers.filter(Boolean) };
}

async function findPackMaterialByName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  const exact = await PackMaterial.findOne({
    where: sqlWhere(fn('lower', col('description')), lowered),
  });
  if (exact) return exact;
  return PackMaterial.findOne({
    where: { description: { [Op.iLike]: trimmed } },
  });
}

async function findPackMaterialByZohoSku(sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  let pm = await PackMaterial.findOne({ where: { zoho_sku_code: t } });
  if (pm) return pm;
  pm = await PackMaterial.findOne({ where: { zoho_sku_code: { [Op.iLike]: t } } });
  return pm || null;
}

async function resolvePackMaterial(componentSku, componentName) {
  const skuTrim = String(componentSku || '').trim();
  const nameTrim = String(componentName || '').trim();
  if (skuTrim) {
    const bySku = await findPackMaterialByZohoSku(skuTrim);
    if (bySku) return { pm: bySku };
  }
  if (nameTrim) {
    const byName = await findPackMaterialByName(nameTrim);
    if (byName) return { pm: byName };
  }
  return { pm: null };
}

async function parsePackagingSheetToRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = pickPackagingSheet(workbook);
  if (!sheet) {
    const err = new Error('Workbook has no "Packaging BOM" worksheet');
    err.code = 'MISSING_PACKAGING_SHEET';
    throw err;
  }

  const { headerMap: m, headers } = detectPackagingHeaders(sheet);
  const missing = [];
  if (m.composite_sku == null) missing.push('Composite SKU');
  if (m.component_sku == null) missing.push('Component SKU');
  if (m.component_name == null) missing.push('Component Name');
  if (m.qty == null) missing.push('Qty per Unit');
  if (m.uom == null) missing.push('UoM');
  if (missing.length > 0) {
    const err = new Error(`Missing required column(s): ${missing.join(', ')}. Found: ${headers.join(', ')}`);
    err.code = 'MISSING_COLUMNS';
    throw err;
  }

  const rows = [];
  const lastRow = sheet.actualRowCount || sheet.rowCount || 1;
  for (let rowNum = 2; rowNum <= lastRow; rowNum += 1) {
    const row = sheet.getRow(rowNum);
    const compositeSku = cellToText(row.getCell(m.composite_sku));
    const componentSku = cellToText(row.getCell(m.component_sku));
    const componentName = cellToText(row.getCell(m.component_name));
    const qty = cellToNumber(row.getCell(m.qty));
    const uomRaw = cellToText(row.getCell(m.uom));
    const volKgCell = m.volume_kg_ltr != null ? row.getCell(m.volume_kg_ltr) : null;
    const volCell = m.volume != null ? row.getCell(m.volume) : null;
    const sgCell = m.sg != null ? row.getCell(m.sg) : null;
    const compositeName = m.composite_name != null ? cellToText(row.getCell(m.composite_name)) : '';

    const limitQtyPrimary = volKgCell != null ? cellToNumber(volKgCell) : NaN;
    const limitQtyFallback = volCell != null ? cellToNumber(volCell) : NaN;

    if (!compositeSku && !componentSku && !componentName && !Number.isFinite(qty)) continue;

    rows.push({
      row_number: rowNum,
      composite_sku: compositeSku,
      composite_name: compositeName,
      component_sku: componentSku,
      component_name: componentName,
      qty: Number.isFinite(qty) ? qty : 0,
      uom_raw: uomRaw,
      limit_qty_vol_kg_ltr: Number.isFinite(limitQtyPrimary) ? limitQtyPrimary : null,
      limit_qty_volume: Number.isFinite(limitQtyFallback) ? limitQtyFallback : null,
      sg: sgCell != null ? cellToNumber(sgCell) : NaN,
    });
  }

  return { rows, sheet_name: sheet.name };
}

function groupRowsByCompositeSku(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.composite_sku || '').trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/**
 * @param {string} compositeSku
 * @param {Array<Record<string, unknown>>} groupRows
 */
async function processPackGroupForComposite(compositeSku, groupRows) {
  const first = groupRows[0];
  const compositeName = String(first?.composite_name ?? '').trim();

  const { product, created } = await findOrCreateProductForFormulaBom(compositeSku, compositeName);
  if (!product) {
    return {
      composite_sku: compositeSku,
      success: false,
      error: 'product_not_created',
      product_id: null,
      bom_id: null,
    };
  }

  if (!created && compositeName && String(product.product_name || '').trim() !== compositeName) {
    await product.update({ product_name: compositeName, updated_at: new Date() });
  }

  const productId = product.product_id;
  const pmLines = [];
  const unmatched = [];

  for (const gr of groupRows) {
    const lineUom = normalizePmUom(gr.uom_raw || first.uom_raw);
    const { pm } = await resolvePackMaterial(gr.component_sku, gr.component_name);

    const volPrimary =
      gr.limit_qty_vol_kg_ltr != null && Number.isFinite(gr.limit_qty_vol_kg_ltr)
        ? gr.limit_qty_vol_kg_ltr
        : null;
    const volFallback =
      gr.limit_qty_volume != null && Number.isFinite(gr.limit_qty_volume) ? gr.limit_qty_volume : null;
    const packVol = volPrimary != null ? volPrimary : volFallback;

    if (pm) {
      const line = {
        pm_code: pm.code || '',
        zoho_sku_code: pm.zoho_sku_code || String(gr.component_sku || '').trim() || null,
        description: pm.description || gr.component_name,
        pm_description: pm.description || gr.component_name,
        pack_material_id: pm.id,
        pack_type: pm.level || 'Primary',
        qty_per_unit: gr.qty,
        uom: lineUom,
      };
      if (packVol != null) line.pack_volume = packVol;
      if (Number.isFinite(gr.sg)) line.line_sg = gr.sg;
      pmLines.push(line);
    } else {
      unmatched.push({
        row_number: gr.row_number,
        component_sku: gr.component_sku,
        zoho_sku_code: String(gr.component_sku || '').trim() || null,
        component_name: gr.component_name,
        qty: gr.qty,
        uom: lineUom,
      });
      const line = {
        pm_code: '',
        zoho_sku_code: String(gr.component_sku || '').trim() || null,
        description: gr.component_name || '',
        pm_description: gr.component_name || '',
        pack_material_id: null,
        pack_type: 'Primary',
        qty_per_unit: gr.qty,
        uom: lineUom,
      };
      if (packVol != null) line.pack_volume = packVol;
      if (Number.isFinite(gr.sg)) line.line_sg = gr.sg;
      pmLines.push(line);
    }
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
      sku_rm_lines: [],
      sku_bom_limit_qty: null,
      sku_bom_limit_uom: null,
      pm_lines: pmLines,
      process_steps: [],
      created_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    await bom.update({
      pm_lines: pmLines,
      updated_at: new Date(),
    });
  }
  const packMeta = await applyPackSizeToProductAndBom({
    product,
    bom,
    groupFirstRow: first,
    now: new Date(),
  });

  return {
    composite_sku: compositeSku,
    success: true,
    product_id: productId,
    bom_id: bom.id,
    product_created: created,
    lines_written: pmLines.length,
    fill_size: packMeta.pack_size,
    pm_matched: pmLines.filter((l) => l.pack_material_id != null).length,
    pm_unmatched: pmLines.filter((l) => l.pack_material_id == null).length,
    unmatched,
  };
}

async function uploadFormulaPackBomExcel(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Excel file is required (multipart field "file")' });
    }

    let parsed;
    try {
      parsed = await parsePackagingSheetToRows(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'PARSE_ERROR' });
    }

    const groups = groupRowsByCompositeSku(parsed.rows);
    const results = [];
    const errors = [];

    for (const [compositeSku, groupRows] of groups.entries()) {
      try {
        const r = await processPackGroupForComposite(compositeSku, groupRows);
        results.push(r);
        if (!r.success) {
          errors.push({ composite_sku: compositeSku, error: r.error || 'update_failed' });
        }
      } catch (e) {
        console.error('formulaPackBom group error', compositeSku, e);
        errors.push({ composite_sku: compositeSku, error: e.message || 'update_failed' });
        results.push({
          composite_sku: compositeSku,
          success: false,
          error: e.message || 'update_failed',
          product_id: null,
          bom_id: null,
        });
      }
    }

    const okCount = results.filter((r) => r.success).length;
    return res.status(200).json({
      success: true,
      sheet_name: parsed.sheet_name,
      groups_processed: okCount,
      groups_total: groups.size,
      results,
      errors,
    });
  } catch (err) {
    console.error('uploadFormulaPackBomExcel error', err);
    return res.status(500).json({ error: err.message || 'Failed to import Excel' });
  }
}

async function processFormulaPackBomChunk(req, res) {
  try {
    const chunkIndex = req.body?.chunk_index;
    const chunkTotal = req.body?.chunk_total;
    const groups = req.body?.groups;

    if (!Array.isArray(groups)) {
      return res.status(400).json({ error: 'Body must include groups: [{ composite_sku, rows }]' });
    }

    const results = [];
    const errors = [];

    for (const g of groups) {
      const compositeSku = String(g?.composite_sku ?? '').trim();
      const groupRows = Array.isArray(g?.rows) ? g.rows : [];
      if (!compositeSku || groupRows.length === 0) continue;

      try {
        const r = await processPackGroupForComposite(compositeSku, groupRows);
        results.push(r);
        if (!r.success) {
          errors.push({ composite_sku: compositeSku, error: r.error || 'update_failed' });
        }
      } catch (e) {
        console.error('formulaPackBom chunk group error', compositeSku, e);
        errors.push({ composite_sku: compositeSku, error: e.message || 'update_failed' });
        results.push({
          composite_sku: compositeSku,
          success: false,
          error: e.message || 'update_failed',
          product_id: null,
          bom_id: null,
        });
      }
    }

    const okCount = results.filter((r) => r.success).length;
    return res.status(200).json({
      success: true,
      chunk_index: chunkIndex ?? null,
      chunk_total: chunkTotal ?? null,
      groups_in_chunk: results.length,
      groups_ok: okCount,
      results,
      errors,
    });
  } catch (err) {
    console.error('processFormulaPackBomChunk error', err);
    return res.status(500).json({ error: err.message || 'Chunk import failed' });
  }
}

module.exports = {
  uploadFormulaPackBomExcelMiddleware,
  uploadFormulaPackBomExcel,
  processFormulaPackBomChunk,
  processPackGroupForComposite,
};
