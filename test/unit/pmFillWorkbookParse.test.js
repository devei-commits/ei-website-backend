const ExcelJS = require('exceljs');
const {
  detectMasterFillWorkbookLayout,
  parsePmFillWorksheet,
} = require('../../src/masterBulk/masterExcelFlexibleParse');
const { mapPmFillWorksheetCategories } = require('../../src/masterBulk/masterCategoryImportMap');

function setCells(row, entries) {
  for (const [col, value] of Object.entries(entries)) {
    row.getCell(Number(col)).value = value;
  }
}

function buildPmFillSheet(sheetName, subCategoryLabel) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  setCells(ws.getRow(4), {
    1: '#',
    2: 'SKU Code',
    3: 'Item Name',
    4: 'Category',
    5: 'Sub-Category',
    6: 'UOM',
    7: 'HSN Code',
    8: 'GST %',
    9: 'Purchase Rate (INR)',
    10: 'Current Stock',
    11: 'Zoho Status',
    12: 'BOM Name (as used)',
  });
  setCells(ws.getRow(5), {
    2: '2000101',
    3: '30ml Glass Bottle',
    4: 'IGNORED',
    5: subCategoryLabel,
    6: 'PCS',
    7: '70109000',
    8: 18,
    9: 12.5,
    10: 500,
    11: 'Active',
    12: 'GLASS BOTTLE 30ML',
  });
  return ws;
}

describe.each([
  ['Labels', 'Labels', '5000101', 'Front Label 50ml', 'spm-labels', 'Secondary'],
  ['Monocartons', 'Monocartons', '5000201', '50ml Carton', 'spm-monocarton', 'Secondary'],
  ['Fitments & Misc', 'Fitments & Misc', '6000101', 'Spatula 5g', 'tpm-ancillary', 'Tertiary'],
])(
  'PM fill workbook parse (%s)',
  (sheetName, subCategoryLabel, sku, itemName, expectedGroup, expectedLevel) => {
    test('detects row-4 fill layout', () => {
      const ws = buildPmFillSheet(sheetName, subCategoryLabel);
      expect(detectMasterFillWorkbookLayout(ws)).not.toBeNull();
    });

    test('parses SKU, sub-category, GST; Item Name → INCI + trade; skips BOM/purchase/stock/zoho', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(sheetName);
      const header = {
        1: '#',
        2: 'SKU Code',
        3: 'Item Name',
        4: 'Category',
        5: 'Sub-Category',
        6: 'UOM',
        7: 'HSN Code',
        8: 'GST %',
        9: 'Purchase Rate (INR)',
        10: 'Current Stock',
        11: 'Zoho Status',
        12: 'BOM Name (as used)',
      };
      setCells(ws.getRow(4), header);
      setCells(ws.getRow(5), {
        2: sku,
        3: itemName,
        4: 'IGNORED',
        5: subCategoryLabel,
        6: 'PCS',
        7: '48191000',
        8: 12,
        9: 1,
        10: 99,
        11: 'Active',
        12: 'SHOULD BE IGNORED',
      });
      const rows = parsePmFillWorksheet(ws, detectMasterFillWorkbookLayout(ws));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        import_profile: 'pm_fill_worksheet',
        zoho_sku_code: sku,
        inci_name: itemName,
        trade_commercial_name: itemName,
        description: itemName,
        sub_category: subCategoryLabel,
      });
      expect(rows[0].purchase_rate_inr).toBeUndefined();
    });

    test('mapPmFillWorksheetCategories maps Sub-Category to group slug', () => {
      const m = mapPmFillWorksheetCategories({ subCategoryCol: subCategoryLabel, sheetName });
      expect(m.groupDb).toBe(expectedGroup);
      expect(m.levelDb).toBe(expectedLevel);
      expect(m.formDataPatch.excelSubCategory).toBe(subCategoryLabel);
    });
  }
);

describe('PM fill workbook parse (Primary Packaging)', () => {
  test('detectMasterFillWorkbookLayout matches row-4 headers on Primary Packaging', () => {
    const ws = buildPmFillSheet('Primary Packaging', 'Primary Packaging');
    const layout = detectMasterFillWorkbookLayout(ws);
    expect(layout).not.toBeNull();
    expect(layout.cols.tradeCommercial).toBeUndefined();
  });

  test('parsePmFillWorksheet maps Item Name → INCI and trade name; ignores BOM Name', () => {
    const ws = buildPmFillSheet('Primary Packaging', 'Primary Packaging');
    const rows = parsePmFillWorksheet(ws, detectMasterFillWorkbookLayout(ws));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      excel_row: 5,
      line_type: 'Packaging',
      import_profile: 'pm_fill_worksheet',
      zoho_sku_code: '2000101',
      inci_name: '30ml Glass Bottle',
      trade_commercial_name: '30ml Glass Bottle',
      description: '30ml Glass Bottle',
      sub_category: 'Primary Packaging',
      uom: 'PCS',
      hsn_code: '70109000',
    });
    expect(rows[0].gst_pct).toBe(18);
    expect(rows[0].purchase_rate_inr).toBeUndefined();
  });

  test('mapPmFillWorksheetCategories uses Sub-Category for group slug (ppm)', () => {
    const m = mapPmFillWorksheetCategories({
      subCategoryCol: 'Primary Packaging',
      sheetName: 'Primary Packaging',
    });
    expect(m.groupDb).toBe('ppm');
    expect(m.levelDb).toBe('Primary');
    expect(m.formDataPatch.excelSubCategory).toBe('Primary Packaging');
  });
});

describe('PM fill multi-tab workbook', () => {
  test('extractPmRowsFromBuffer merges Labels, Monocartons, and Fitments & Misc', async () => {
    const { extractPmRowsFromBuffer } = require('../../src/masterBulk/pmMasterExcelUpload');
    const wb = new ExcelJS.Workbook();
    for (const [name, sub, sku] of [
      ['Labels', 'Labels', '5000101'],
      ['Monocartons', 'Monocartons', '5000201'],
      ['Fitments & Misc', 'Fitments & Misc', '6000101'],
    ]) {
      const ws = wb.addWorksheet(name);
      setCells(ws.getRow(4), {
        1: '#',
        2: 'SKU Code',
        3: 'Item Name',
        4: 'Category',
        5: 'Sub-Category',
        6: 'UOM',
        7: 'HSN Code',
        8: 'GST %',
        12: 'BOM Name (as used)',
      });
      setCells(ws.getRow(5), { 2: sku, 3: `${name} item`, 5: sub, 6: 'PCS', 12: 'INCI' });
    }
    const buffer = await wb.xlsx.writeBuffer();
    const { rows, format } = await extractPmRowsFromBuffer(buffer);
    expect(format).toBe('pm_fill_worksheet');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sheet_name).sort()).toEqual(
      ['Fitments & Misc', 'Labels', 'Monocartons'].sort()
    );
  });
});
