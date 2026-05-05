/**
 * POST /api/v1/products/formula-rm-bom/upload-excel
 * Worksheet "Formula BOM - RM per KG-LTR" (or fuzzy match): multi-composite SKU rows,
 * updates only boms.sku_rm_lines, sku_bom_limit_qty, sku_bom_limit_uom — preserves pm_lines, rm_lines, process_steps.
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op, fn, col, where: sqlWhere } = require('sequelize');

const BOM = require('../bom/models');
const RawMaterial = require('../rawMaterials/models');
const { findOrCreateProductForFormulaBom, applyPackSizeToProductAndBom } = require('./formulaBomProductResolve');

const PREFERRED_SHEET_NAME = 'Formula BOM - RM per KG-LTR';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const uploadFormulaRmBomExcelMiddleware = multer({
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

function pickFormulaSheet(workbook) {
  const sheets = workbook.worksheets || [];
  if (sheets.length === 0) return null;
  const exact = sheets.find((sh) => String(sh.name || '').trim() === PREFERRED_SHEET_NAME);
  if (exact) return exact;
  const exactNorm = sheets.find((sh) => normalizeSheetName(sh.name) === normalizeSheetName(PREFERRED_SHEET_NAME));
  if (exactNorm) return exactNorm;
  return (
    sheets.find((sh) => {
      const n = normalizeSheetName(sh.name);
      return n.includes('formula') && n.includes('bom');
    }) || sheets[0]
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

function normalizeRmUom(u) {
  const s = normalizeHeader(u);
  if (!s) return 'GM';
  if (s === 'kg' || s === 'kgs' || s === 'kilogram' || s === 'kilograms') return 'KG';
  if (s === 'gm' || s === 'g' || s === 'gram' || s === 'grams') return 'GM';
  if (s === 'ml' || s === 'millilitre' || s === 'milliliter' || s === 'millilitres') return 'ML';
  if (s === 'l' || s === 'lt' || s === 'ltr' || s === 'litre' || s === 'liter') return 'L';
  return String(u || '').trim().toUpperCase() || 'GM';
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
  return RawMaterial.findOne({
    where: {
      [Op.or]: [
        { inci: { [Op.iLike]: trimmed } },
        { name: { [Op.iLike]: trimmed } },
      ],
    },
  });
}

async function findRawMaterialByZohoSku(sku) {
  const t = String(sku || '').trim();
  if (!t) return null;
  let rm = await RawMaterial.findOne({ where: { zoho_sku_code: t } });
  if (rm) return rm;
  rm = await RawMaterial.findOne({ where: { zoho_sku_code: { [Op.iLike]: t } } });
  return rm || null;
}

async function resolveRawMaterial(componentSku, componentName) {
  const skuTrim = String(componentSku || '').trim();
  const nameTrim = String(componentName || '').trim();
  if (skuTrim) {
    const bySku = await findRawMaterialByZohoSku(skuTrim);
    if (bySku) return { rm: bySku };
  }
  if (nameTrim) {
    const byName = await findRawMaterialByName(nameTrim);
    if (byName) return { rm: byName };
  }
  return { rm: null };
}

/**
 * Map header labels to 1-based column indices. First wins for qty (duplicate columns).
 */
function detectFormulaRmHeaders(sheet) {
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

async function parseWorkbookToRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = pickFormulaSheet(workbook);
  if (!sheet) {
    const err = new Error('Workbook has no worksheets');
    err.code = 'EMPTY_WORKBOOK';
    throw err;
  }

  const { headerMap: m, headers } = detectFormulaRmHeaders(sheet);
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
 * @param {Array<Record<string, unknown>>} groupRows rows from parseWorkbookToRows (same shape)
 * @param {boolean} applySg
 */
async function processRmGroupForComposite(compositeSku, groupRows, applySg) {
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
  const limitQty =
    first.limit_qty_vol_kg_ltr != null && Number.isFinite(first.limit_qty_vol_kg_ltr)
      ? first.limit_qty_vol_kg_ltr
      : first.limit_qty_volume != null && Number.isFinite(first.limit_qty_volume)
        ? first.limit_qty_volume
        : null;
  const limitUom = normalizeRmUom(first.uom_raw);

  const skuRmLines = [];
  const unmatched = [];
  let sgUpdated = 0;

  for (const gr of groupRows) {
    const lineUom = normalizeRmUom(gr.uom_raw || first.uom_raw);
    const { rm } = await resolveRawMaterial(gr.component_sku, gr.component_name);

    if (rm) {
      skuRmLines.push({
        inci_name: rm.inci || rm.name || gr.component_name,
        rm_code: rm.code || '',
        raw_material_id: rm.id,
        qty_per_unit: gr.qty,
        uom: lineUom,
      });

      if (applySg && Number.isFinite(gr.sg) && rm.id != null) {
        await RawMaterial.update({ specific_gravity: gr.sg }, { where: { id: rm.id } });
        sgUpdated += 1;
      }
    } else {
      unmatched.push({
        row_number: gr.row_number,
        component_sku: gr.component_sku,
        component_name: gr.component_name,
        qty: gr.qty,
        uom: lineUom,
      });
      skuRmLines.push({
        inci_name: gr.component_name || '',
        rm_code: '',
        raw_material_id: null,
        qty_per_unit: gr.qty,
        uom: lineUom,
      });
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
      sku_rm_lines: skuRmLines,
      sku_bom_limit_qty: limitQty,
      sku_bom_limit_uom: limitUom,
      pm_lines: [],
      process_steps: [],
      created_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    await bom.update({
      sku_rm_lines: skuRmLines,
      sku_bom_limit_qty: limitQty,
      sku_bom_limit_uom: limitUom,
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
    lines_written: skuRmLines.length,
    sku_rm_matched: skuRmLines.filter((l) => l.raw_material_id != null).length,
    sku_rm_unmatched: skuRmLines.filter((l) => l.raw_material_id == null).length,
    sg_updates: applySg ? sgUpdated : 0,
    fill_size: packMeta.pack_size,
    unmatched,
  };
}

async function uploadFormulaRmBomExcel(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Excel file is required (multipart field "file")' });
    }

    const applySg = String(req.query.apply_sg ?? '1').trim() !== '0';

    let parsed;
    try {
      parsed = await parseWorkbookToRows(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'PARSE_ERROR' });
    }

    const groups = groupRowsByCompositeSku(parsed.rows);
    const results = [];
    const errors = [];

    for (const [compositeSku, groupRows] of groups.entries()) {
      try {
        const r = await processRmGroupForComposite(compositeSku, groupRows, applySg);
        results.push(r);
        if (!r.success) {
          errors.push({ composite_sku: compositeSku, error: r.error || 'update_failed' });
        }
      } catch (e) {
        console.error('formulaRmBom group error', compositeSku, e);
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
      apply_sg: applySg,
      results,
      errors,
    });
  } catch (err) {
    console.error('uploadFormulaRmBomExcel error', err);
    return res.status(500).json({ error: err.message || 'Failed to import Excel' });
  }
}

/**
 * POST JSON body: { chunk_index, chunk_total, apply_sg?, groups: [{ composite_sku, rows }] }
 * rows must match parseWorkbookToRows output shape.
 */
async function processFormulaRmBomChunk(req, res) {
  try {
    const applySg = String(req.body?.apply_sg ?? req.query?.apply_sg ?? '1').trim() !== '0';
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
        const r = await processRmGroupForComposite(compositeSku, groupRows, applySg);
        results.push(r);
        if (!r.success) {
          errors.push({ composite_sku: compositeSku, error: r.error || 'update_failed' });
        }
      } catch (e) {
        console.error('formulaRmBom chunk group error', compositeSku, e);
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
      apply_sg: applySg,
      groups_in_chunk: results.length,
      groups_ok: okCount,
      results,
      errors,
    });
  } catch (err) {
    console.error('processFormulaRmBomChunk error', err);
    return res.status(500).json({ error: err.message || 'Chunk import failed' });
  }
}

module.exports = {
  uploadFormulaRmBomExcelMiddleware,
  uploadFormulaRmBomExcel,
  processFormulaRmBomChunk,
  processRmGroupForComposite,
};
