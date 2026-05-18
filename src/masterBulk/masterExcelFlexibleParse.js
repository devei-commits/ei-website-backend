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
  itemName: ['item name', 'name', 'description', 'item description'],
  category: ['category'],
  subCategory: ['sub-category', 'sub category', 'subcategory'],
  uom: ['uom', 'unit', 'units'],
  hsn: ['hsn', 'hsn code', 'hsn/sac'],
  gst: ['gst', 'gst %', 'gst%'],
  purchase: ['price/unit', 'price per unit', 'unit price', 'price', 'rate', 'purchase rate', 'purchase rate inr'],
  inci: ['inci', 'inci name'],
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
      else if (!cols.inci && matchHeaderAlias(text, HEADER_ALIASES.inci)) cols.inci = c;
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
          inci: cols.inci ?? (headerRowNum === 4 ? 12 : null),
        },
      };
    }
  }
  return null;
}

function parseWorksheetDataRows(worksheet, sheetName, layoutInfo, lineType, importProfile) {
  const rows = [];
  const { dataStartRow, cols } = layoutInfo;
  const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;
  for (let r = dataStartRow; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const sku = cols.sku ? cellToText(row.getCell(cols.sku)) : '';
    const itemName = cols.itemName ? cellToText(row.getCell(cols.itemName)) : '';
    const category = cols.category ? cellToText(row.getCell(cols.category)) : '';
    const subCategory = cols.subCategory ? cellToText(row.getCell(cols.subCategory)) : '';
    const uom = cols.uom ? cellToText(row.getCell(cols.uom)) : '';
    const hsn = cols.hsn ? cellToText(row.getCell(cols.hsn)) : '';
    const gstCell = cols.gst ? row.getCell(cols.gst) : null;
    const purchaseCell = cols.purchase ? row.getCell(cols.purchase) : null;
    const inci = cols.inci ? cellToText(row.getCell(cols.inci)) : '';
    if (!sku && !itemName) continue;
    rows.push({
      excel_row: r,
      line_type: lineType,
      import_profile: importProfile,
      zoho_sku_code: sku,
      description: itemName,
      sheet_name: sheetName,
      category,
      sub_category: subCategory,
      uom,
      hsn_code: hsn,
      gst_pct: gstCell ? gstCell.value : null,
      purchase_rate_inr: purchaseCell ? purchaseCell.value : null,
      inci_name: inci,
    });
  }
  return rows;
}

module.exports = {
  cellToText,
  detectWorksheetLayout,
  parseWorksheetDataRows,
};
