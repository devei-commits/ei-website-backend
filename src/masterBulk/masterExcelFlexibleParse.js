/**
 * Detect row-1 vendor-pricing layout (SKU, Category, Sub-Category) vs row-4 RM/PM template.
 */

function cellToText(cell) {
  if (cell == null) return '';
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (v.richText && Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('').trim();
  if (v.text) return String(v.text).trim();
  if (v.result != null) return String(v.result).trim();
  return String(v).trim();
}

function normHeader(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const HEADER_ALIASES = {
  sku: ['sku', 'item sku', 'item code', 'code', 'zoho sku'],
  /** Excel "Item Name" — INCI / technical name */
  itemName: ['item name', 'inci', 'inci name'],
  category: ['category'],
  subCategory: ['sub-category', 'sub category', 'subcategory'],
  uom: ['uom', 'unit', 'units'],
  hsn: ['hsn', 'hsn code', 'hsn/sac'],
  gst: ['gst', 'gst %', 'gst%'],
  purchase: ['price/unit', 'price per unit', 'unit price', 'price', 'rate', 'purchase rate', 'purchase rate inr'],
  /** Excel "BOM Name (as used)" — trade / commercial name */
  tradeCommercial: [
    'bom name (as used)',
    'bom name',
    'trade/commercial name',
    'trade commercial name',
    'commercial name',
    'trade name',
  ],
  /** Legacy multi-sheet: description column may still mean trade name */
  legacyDescription: ['name', 'description', 'item description'],
  /** Legacy multi-sheet INCI column header */
  legacyInci: ['inci', 'inci name'],
};

function matchHeaderAlias(cellText, aliases) {
  const h = normHeader(cellText);
  return aliases.some((a) => h === a || h.includes(a));
}

/**
 * @returns {{ layout: 'row1'|'row4', dataStartRow: number, cols: object }|null}
 */
function detectWorksheetLayout(worksheet) {
  for (const headerRowNum of [1, 4]) {
    const row = worksheet.getRow(headerRowNum);
    const cols = {};
    const colCount = Math.min(row.cellCount || 20, 20);
    for (let c = 1; c <= colCount; c += 1) {
      const text = cellToText(row.getCell(c));
      if (!text) continue;
      if (!cols.sku && matchHeaderAlias(text, HEADER_ALIASES.sku)) cols.sku = c;
      else if (!cols.itemName && matchHeaderAlias(text, HEADER_ALIASES.itemName)) cols.itemName = c;
      else if (!cols.category && matchHeaderAlias(text, HEADER_ALIASES.category)) cols.category = c;
      else if (!cols.subCategory && matchHeaderAlias(text, HEADER_ALIASES.subCategory)) cols.subCategory = c;
      else if (!cols.uom && matchHeaderAlias(text, HEADER_ALIASES.uom)) cols.uom = c;
      else if (!cols.hsn && matchHeaderAlias(text, HEADER_ALIASES.hsn)) cols.hsn = c;
      else if (!cols.gst && matchHeaderAlias(text, HEADER_ALIASES.gst)) cols.gst = c;
      else if (!cols.purchase && matchHeaderAlias(text, HEADER_ALIASES.purchase)) cols.purchase = c;
      else if (!cols.tradeCommercial && matchHeaderAlias(text, HEADER_ALIASES.tradeCommercial)) {
        cols.tradeCommercial = c;
      } else if (!cols.inci && matchHeaderAlias(text, HEADER_ALIASES.legacyInci)) cols.inci = c;
      else if (!cols.itemName && matchHeaderAlias(text, HEADER_ALIASES.legacyDescription)) {
        cols.itemName = c;
      }
    }
    if (cols.sku != null && cols.itemName != null) {
      return {
        layout: headerRowNum === 1 ? 'row1' : 'row4',
        dataStartRow: headerRowNum + 1,
        cols: {
          sku: cols.sku,
          itemName: cols.itemName,
          category: cols.category ?? (headerRowNum === 4 ? 4 : null),
          subCategory: cols.subCategory ?? (headerRowNum === 4 ? 5 : null),
          uom: cols.uom ?? (headerRowNum === 4 ? 6 : null),
          hsn: cols.hsn ?? (headerRowNum === 4 ? 7 : null),
          gst: cols.gst ?? (headerRowNum === 4 ? 8 : null),
          purchase: cols.purchase ?? (headerRowNum === 4 ? 9 : null),
          tradeCommercial: cols.tradeCommercial ?? cols.inci ?? (headerRowNum === 4 ? 12 : null),
        },
      };
    }
  }
  return null;
}

/**
 * RM fill workbook (Raw Materials, Club Items, …): row 4 = headers, data from row 5.
 * A=# (skip), B=SKU, C=Item Name, D=Category (skip), E=Sub-Category → RM category,
 * F=UOM, G=HSN, H=GST%, then skip Purchase Rate / Current Stock / Zoho Status,
 * C=Item Name → INCI and trade/commercial name (same value); BOM Name (as used) is ignored.
 */
const RM_FILL_HEADER_ROW = 4;
const RM_FILL_DATA_START_ROW = 5;

/** @deprecated use RM_FILL_HEADER_ROW */
const RAW_MATERIALS_FILL_HEADER_ROW = RM_FILL_HEADER_ROW;
/** @deprecated use RM_FILL_DATA_START_ROW */
const RAW_MATERIALS_FILL_DATA_START_ROW = RM_FILL_DATA_START_ROW;

function detectRmFillWorkbookLayout(worksheet) {
  const row = worksheet.getRow(RM_FILL_HEADER_ROW);
  const found = {};
  const colLimit = Math.min(row.cellCount || 24, 24);
  for (let c = 1; c <= colLimit; c += 1) {
    const text = cellToText(row.getCell(c));
    if (!text) continue;
    if (!found.sku && matchHeaderAlias(text, HEADER_ALIASES.sku)) found.sku = c;
    else if (!found.itemName && matchHeaderAlias(text, HEADER_ALIASES.itemName)) found.itemName = c;
    else if (!found.subCategory && matchHeaderAlias(text, HEADER_ALIASES.subCategory)) found.subCategory = c;
    else if (!found.uom && matchHeaderAlias(text, HEADER_ALIASES.uom)) found.uom = c;
    else if (!found.hsn && matchHeaderAlias(text, HEADER_ALIASES.hsn)) found.hsn = c;
    else if (!found.gst && matchHeaderAlias(text, HEADER_ALIASES.gst)) found.gst = c;
  }
  if (found.sku == null || found.itemName == null || found.subCategory == null) return null;
  return {
    dataStartRow: RM_FILL_DATA_START_ROW,
    cols: {
      sku: found.sku,
      itemName: found.itemName,
      subCategory: found.subCategory,
      uom: found.uom ?? 6,
      hsn: found.hsn ?? 7,
      gst: found.gst ?? 8,
    },
  };
}

/** Fill workbook: Item Name is used for both INCI and trade/commercial name. */
function namesFromFillItemName(itemNameRaw) {
  const item = String(itemNameRaw || '').trim();
  return {
    inci_name: item,
    trade_commercial_name: item,
    description: item,
  };
}

/** @deprecated use detectRmFillWorkbookLayout */
function detectRawMaterialsFillLayout(worksheet) {
  return detectRmFillWorkbookLayout(worksheet) != null;
}

function parseRmFillWorksheet(worksheet, layoutInfo) {
  const layout = layoutInfo ?? detectRmFillWorkbookLayout(worksheet);
  if (!layout) return [];
  const { cols, dataStartRow } = layout;
  const rows = [];
  const sheetName = worksheet.name;
  const lastRow = Math.max(
    worksheet.lastRow?.number ?? 0,
    worksheet.actualRowCount ?? 0,
    worksheet.rowCount ?? 0
  );
  for (let r = dataStartRow; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const sku = cellToText(row.getCell(cols.sku));
    const names = namesFromFillItemName(cellToText(row.getCell(cols.itemName)));
    const subCategory = cellToText(row.getCell(cols.subCategory));
    const uom = cols.uom ? cellToText(row.getCell(cols.uom)) : '';
    const hsn = cols.hsn ? cellToText(row.getCell(cols.hsn)) : '';
    const gstCell = cols.gst ? row.getCell(cols.gst) : null;
    if (!sku && !names.inci_name) continue;
    rows.push({
      excel_row: r,
      line_type: 'Raw Material',
      import_profile: 'rm_raw_materials_worksheet',
      zoho_sku_code: sku,
      ...names,
      sheet_name: sheetName,
      sub_category: subCategory,
      uom,
      hsn_code: hsn,
      gst_pct: gstCell ? gstCell.value : null,
    });
  }
  return rows;
}

/** @deprecated use parseRmFillWorksheet */
function parseRawMaterialsFillWorksheet(worksheet) {
  return parseRmFillWorksheet(worksheet);
}

function parseWorksheetDataRows(worksheet, sheetName, layoutInfo, lineType, importProfile) {
  const rows = [];
  const { dataStartRow, cols } = layoutInfo;
  const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;
  for (let r = dataStartRow; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const sku = cols.sku ? cellToText(row.getCell(cols.sku)) : '';
    const names = namesFromFillItemName(
      cols.itemName ? cellToText(row.getCell(cols.itemName)) : ''
    );
    const category = cols.category ? cellToText(row.getCell(cols.category)) : '';
    const subCategory = cols.subCategory ? cellToText(row.getCell(cols.subCategory)) : '';
    const uom = cols.uom ? cellToText(row.getCell(cols.uom)) : '';
    const hsn = cols.hsn ? cellToText(row.getCell(cols.hsn)) : '';
    const gstCell = cols.gst ? row.getCell(cols.gst) : null;
    const purchaseCell = cols.purchase ? row.getCell(cols.purchase) : null;
    if (!sku && !names.inci_name) continue;
    rows.push({
      excel_row: r,
      line_type: lineType,
      import_profile: importProfile,
      zoho_sku_code: sku,
      ...names,
      sheet_name: sheetName,
      category,
      sub_category: subCategory,
      uom,
      hsn_code: hsn,
      gst_pct: gstCell ? gstCell.value : null,
      purchase_rate_inr: purchaseCell ? purchaseCell.value : null,
    });
  }
  return rows;
}

/** Same row-4 layout as RM fill sheets; used for Primary Packaging and other PM tabs. */
const detectMasterFillWorkbookLayout = detectRmFillWorkbookLayout;

/**
 * @param {object} opts
 * @param {'Raw Material'|'Packaging'} opts.lineType
 * @param {string} opts.importProfile
 */
function parseMasterFillWorksheet(worksheet, layoutInfo, opts) {
  const rows = parseRmFillWorksheet(worksheet, layoutInfo);
  return rows.map((r) => ({
    ...r,
    line_type: opts.lineType,
    import_profile: opts.importProfile,
  }));
}

function parsePmFillWorksheet(worksheet, layoutInfo) {
  return parseMasterFillWorksheet(worksheet, layoutInfo, {
    lineType: 'Packaging',
    importProfile: 'pm_fill_worksheet',
  });
}

module.exports = {
  cellToText,
  detectWorksheetLayout,
  detectRmFillWorkbookLayout,
  detectMasterFillWorkbookLayout,
  detectRawMaterialsFillLayout,
  parseRmFillWorksheet,
  parsePmFillWorksheet,
  parseMasterFillWorksheet,
  parseRawMaterialsFillWorksheet,
  parseWorksheetDataRows,
  RM_FILL_HEADER_ROW,
  RM_FILL_DATA_START_ROW,
  RAW_MATERIALS_FILL_HEADER_ROW,
  RAW_MATERIALS_FILL_DATA_START_ROW,
};
