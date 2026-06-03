const ExcelJS = require('exceljs');
const {
  detectRmFillWorkbookLayout,
  parseRmFillWorksheet,
} = require('../../src/masterBulk/masterExcelFlexibleParse');
const { mapRmRawMaterialsWorksheetCategories } = require('../../src/masterBulk/masterCategoryImportMap');

function setCells(row, entries) {
  for (const [col, value] of Object.entries(entries)) {
    row.getCell(Number(col)).value = value;
  }
}

function buildRmFillSheet(sheetName, subCategoryLabel) {
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
    2: '1000101',
    3: 'Glycerin USP',
    4: 'IGNORED',
    5: subCategoryLabel,
    6: 'KG',
    7: '29054500',
    8: 18,
    9: 999,
    10: 100,
    11: 'Active',
    12: 'GLYCERIN',
  });
  return ws;
}

describe('RM fill workbook parse', () => {
  test('detectRmFillWorkbookLayout matches row-4 headers (BOM Name column not required)', () => {
    const ws = buildRmFillSheet('Raw Materials', 'Raw Material');
    const layout = detectRmFillWorkbookLayout(ws);
    expect(layout).not.toBeNull();
    expect(layout.cols.itemName).toBe(3);
    expect(layout.cols.tradeCommercial).toBeUndefined();
  });

  test('parseRmFillWorksheet: Item Name → INCI and trade name; BOM Name ignored', () => {
    const ws = buildRmFillSheet('Raw Materials', 'Raw Material');
    const rows = parseRmFillWorksheet(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      excel_row: 5,
      import_profile: 'rm_raw_materials_worksheet',
      zoho_sku_code: '1000101',
      inci_name: 'Glycerin USP',
      trade_commercial_name: 'Glycerin USP',
      description: 'Glycerin USP',
      sub_category: 'Raw Material',
      uom: 'KG',
      hsn_code: '29054500',
    });
    expect(rows[0].gst_pct).toBe(18);
    expect(rows[0].purchase_rate_inr).toBeUndefined();
  });

  test('Club Items sheet uses same layout and maps Sub-Category to Club Items category', () => {
    const ws = buildRmFillSheet('Club Items', 'Club Items');
    const rows = parseRmFillWorksheet(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0].inci_name).toBe('Glycerin USP');
    expect(rows[0].trade_commercial_name).toBe('Glycerin USP');

    const m = mapRmRawMaterialsWorksheetCategories({ subCategoryCol: 'Club Items' });
    expect(m.categoryDb).toBe('Club Items');
  });

  test('mapRmRawMaterialsWorksheetCategories maps Raw Material to Bulk raw materials', () => {
    const m = mapRmRawMaterialsWorksheetCategories({ subCategoryCol: 'Raw Material' });
    expect(m.categoryDb).toBe('Bulk raw materials');
    expect(m.formDataPatch.rmCategory).toBe('Bulk raw materials');
  });
});
