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
  test('findWorksheetForBucket ml1 prefers Inventory Summary sheet name', () => {
    const wb = {
      worksheets: [{ name: 'Cover' }, { name: 'Inventory Summary' }],
    };
    expect(findWorksheetForBucket(wb, 'ml1').name).toBe('Inventory Summary');
  });

  test('findWorksheetForBucket ml1 falls back to legacy STOCK IN HAND sheet name', () => {
    const wb = {
      worksheets: [{ name: 'Summary' }, { name: 'STOCK IN HAND' }],
    };
    expect(findWorksheetForBucket(wb, 'ml1').name).toBe('STOCK IN HAND');
  });

  test('findWorksheetForBucket ml1 prefers Inventory Summary over legacy STOCK IN HAND when both present', () => {
    const wb = {
      worksheets: [{ name: 'STOCK IN HAND' }, { name: 'Inventory Summary' }],
    };
    expect(findWorksheetForBucket(wb, 'ml1').name).toBe('Inventory Summary');
  });

  test('findWorksheetForBucket ml2 prefers Inventory Summary sheet name', () => {
    const wb = {
      worksheets: [{ name: 'Cover' }, { name: 'Inventory Summary' }],
    };
    expect(findWorksheetForBucket(wb, 'ml2').name).toBe('Inventory Summary');
  });

  test('findWorksheetForBucket ml2 falls back to legacy Sheet3 sheet name', () => {
    const wb = {
      worksheets: [{ name: 'Cover' }, { name: 'Sheet3' }],
    };
    expect(findWorksheetForBucket(wb, 'ml2').name).toBe('Sheet3');
  });

  test('findWorksheetForBucket ml2 prefers Inventory Summary over legacy Sheet3 when both present', () => {
    const wb = {
      worksheets: [{ name: 'Sheet3' }, { name: 'Inventory Summary' }],
    };
    expect(findWorksheetForBucket(wb, 'ml2').name).toBe('Inventory Summary');
  });

  test('findWorksheetForBucket warehouse prefers CONSOLIDATED SIH sheet name', () => {
    const wb = {
      worksheets: [{ name: 'Cover' }, { name: 'CONSOLIDATED SIH' }],
    };
    expect(findWorksheetForBucket(wb, 'warehouse').name).toBe('CONSOLIDATED SIH');
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

  test('detectSihHeaderColumns ml1 prefers PHYSICAL QTY over SIH (legacy workbook)', () => {
    const ws = mockWorksheet(
      'STOCK IN HAND',
      ['sku', 'item_name', 'SIH', 'PHYSICAL QTY'],
      [['5M001', 'Water', 999, 88]]
    );
    const layout = detectSihHeaderColumns(ws, 'ml1');
    expect(layout).not.toBeNull();
    expect(layout.cols.sih).toBe(4);
    expect(layout.qtyColumn).toBe('quantity_available');
  });

  test('detectSihHeaderColumns ml1 prefers quantity_available over PHYSICAL QTY and SIH', () => {
    const ws = mockWorksheet(
      'Inventory Summary',
      ['sku', 'item_name', 'SIH', 'PHYSICAL QTY', 'quantity_available'],
      [['5M001', 'Water', 999, 88, 42]]
    );
    const layout = detectSihHeaderColumns(ws, 'ml1');
    expect(layout).not.toBeNull();
    expect(layout.cols.sih).toBe(5);
    expect(layout.qtyColumn).toBe('quantity_available');
  });

  test('parseSihBucketWorkbook reads ML1 STOCK IN HAND with PHYSICAL QTY (legacy)', async () => {
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

  test('parseSihBucketWorkbook reads ML1 Inventory Summary sheet using sku, item_name, quantity_available (ignoring other columns)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory Summary');
    ws.addRow([
      'item_id', 'sku', 'item_name', 'category_id', 'category_name',
      'is_combo_product', 'quantity_available', 'reorder_level', 'Status',
    ]);
    ws.addRow(['1001', '5M00524', 'Glycerin', '9', 'Solvents', 'false', 88, 10, 'active']);
    const buf = await wb.xlsx.writeBuffer();
    const { rows, sheetName, bucket } = await parseSihBucketWorkbook(Buffer.from(buf), 'ml1');
    expect(sheetName).toBe('Inventory Summary');
    expect(bucket).toBe('ml1');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('5M00524');
    expect(rows[0].item_name).toBe('Glycerin');
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

  test('parseSihBucketWorkbook reads ML2 Sheet3 rows (legacy)', async () => {
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

  test('parseSihBucketWorkbook reads ML2 Inventory Summary sheet using sku, item_name, quantity_available (ignoring other columns)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory Summary');
    ws.addRow([
      'item_id', 'sku', 'item_name', 'category_id', 'category_name',
      'is_combo_product', 'quantity_available', 'reorder_level', 'Status',
    ]);
    ws.addRow(['2002', '6T00042', 'Master Carton', '11', 'Tertiary', 'false', 55, 5, 'active']);
    const buf = await wb.xlsx.writeBuffer();
    const { rows, sheetName, bucket } = await parseSihBucketWorkbook(Buffer.from(buf), 'ml2');
    expect(sheetName).toBe('Inventory Summary');
    expect(bucket).toBe('ml2');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('6T00042');
    expect(rows[0].item_name).toBe('Master Carton');
    expect(rows[0].sih).toBe(55);
  });

  test('buildBucketUpdates ml2 keeps wh and ml1, updates ml2 and SIH sum', () => {
    const before = { wh_stock: 50, ml1_stock: 10, ml2_stock: 5, reorder_pt: 0, qc_status: 'In Stock' };
    const updates = buildBucketUpdates('ml2', 55, before);
    expect(updates.wh_stock).toBe(50);
    expect(updates.ml1_stock).toBe(10);
    expect(updates.ml2_stock).toBe(55);
    expect(updates.stock_in_hand).toBe(115);
  });
});
