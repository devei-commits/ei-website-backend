const ExcelJS = require('exceljs');
const {
  detectSihHeaderColumns,
  findWorksheetForBucket,
  parseSihBucketWorkbook,
  buildBucketUpdates,
} = require('../../src/warehouseInventory/warehouseSihBucketExcelImport');

function mockWorksheet(name, headerRow, dataRows) {
  const rows = [headerRow, ...dataRows];
  return {
    name,
    rowCount: rows.length,
    getRow: (n) => ({
      cellCount: rows[n - 1]?.length ?? 0,
      getCell: (c) => ({ value: rows[n - 1]?.[c - 1] ?? '' }),
    }),
  };
}

describe('warehouseSihBucketExcelImport', () => {
  test('findWorksheetForBucket ml1 prefers STOCK IN HAND sheet name', () => {
    const wb = {
      worksheets: [{ name: 'Summary' }, { name: 'STOCK IN HAND' }],
    };
    expect(findWorksheetForBucket(wb, 'ml1').name).toBe('STOCK IN HAND');
  });

  test('findWorksheetForBucket warehouse prefers Sheet3', () => {
    const wb = {
      worksheets: [{ name: 'Cover' }, { name: 'Sheet3' }],
    };
    expect(findWorksheetForBucket(wb, 'warehouse').name).toBe('Sheet3');
  });

  test('detectSihHeaderColumns finds sku, item_name, SIH', () => {
    const ws = mockWorksheet(
      'Sheet3',
      ['sku', 'item_name', 'SIH'],
      [['5M001', 'Water', 100]]
    );
    const layout = detectSihHeaderColumns(ws, 'warehouse');
    expect(layout).not.toBeNull();
    expect(layout.cols.sku).toBe(1);
    expect(layout.cols.itemName).toBe(2);
    expect(layout.cols.sih).toBe(3);
    expect(layout.dataStartRow).toBe(2);
  });

  test('detectSihHeaderColumns ml1 prefers PHYSICAL QTY over SIH', () => {
    const ws = mockWorksheet(
      'STOCK IN HAND',
      ['sku', 'item_name', 'SIH', 'PHYSICAL QTY'],
      [['5M001', 'Water', 999, 88]]
    );
    const layout = detectSihHeaderColumns(ws, 'ml1');
    expect(layout).not.toBeNull();
    expect(layout.cols.sih).toBe(4);
    expect(layout.qtyColumn).toBe('physical_qty');
  });

  test('parseSihBucketWorkbook reads ML1 STOCK IN HAND with PHYSICAL QTY', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('STOCK IN HAND');
    ws.addRow(['sku', 'item_name', 'PHYSICAL QTY']);
    ws.addRow(['5M00524', 'Glycerin', 88]);
    const buf = await wb.xlsx.writeBuffer();
    const { rows, sheetName, bucket } = await parseSihBucketWorkbook(Buffer.from(buf), 'ml1');
    expect(sheetName).toBe('STOCK IN HAND');
    expect(bucket).toBe('ml1');
    expect(rows).toHaveLength(1);
    expect(rows[0].sih).toBe(88);
  });

  test('buildBucketUpdates ml1 keeps wh and ml2, updates ml1 and SIH sum', () => {
    const before = { wh_stock: 50, ml1_stock: 10, ml2_stock: 5, reorder_pt: 0, qc_status: 'In Stock' };
    const updates = buildBucketUpdates('ml1', 120, before);
    expect(updates.wh_stock).toBe(50);
    expect(updates.ml1_stock).toBe(120);
    expect(updates.ml2_stock).toBe(5);
    expect(updates.stock_in_hand).toBe(175);
  });

  test('parseSihBucketWorkbook reads ML2 Sheet3 rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet3');
    ws.addRow(['sku', 'item_name', 'stock in hand']);
    ws.addRow(['5M00524', 'Glycerin', 42]);
    const buf = await wb.xlsx.writeBuffer();
    const { rows, sheetName, bucket } = await parseSihBucketWorkbook(Buffer.from(buf), 'ml2');
    expect(sheetName).toBe('Sheet3');
    expect(bucket).toBe('ml2');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('5M00524');
    expect(rows[0].sih).toBe(42);
  });
});
