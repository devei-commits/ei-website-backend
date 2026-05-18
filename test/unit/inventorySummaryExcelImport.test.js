const {
  detectHeaderColumns,
  findInventorySummaryWorksheet,
  resolveQuantityAvailableColumnIndex,
  isExcludedQuantityHeader,
} = require('../../src/warehouseInventory/inventorySummaryExcelImport');
const ExcelJS = require('exceljs');

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

describe('inventorySummaryExcelImport', () => {
  test('findInventorySummaryWorksheet prefers exact sheet name', () => {
    const wb = {
      worksheets: [
        { name: 'Other' },
        { name: 'Inventory Summary' },
      ],
    };
    expect(findInventorySummaryWorksheet(wb).name).toBe('Inventory Summary');
  });

  test('resolveQuantityAvailableColumnIndex prefers quantity_available over quantity_ordered', () => {
    const headers = [
      'item_id',
      'sku',
      'item_name',
      'quantity_purchased',
      'quantity_sold',
      'quantity_ordered',
      'quantity_demanded',
      'quantity_available',
      'quantity_available_for_sale',
      'quantity_in_transit',
    ];
    expect(isExcludedQuantityHeader('quantity_ordered')).toBe(true);
    expect(resolveQuantityAvailableColumnIndex(headers)).toBe(8);
  });

  test('detectHeaderColumns finds item_id, sku, quantity_available', () => {
    const ws = mockWorksheet(
      'Inventory Summary',
      ['item_id', 'sku', 'item_name', 'quantity_available'],
      [['z1', '5M001', 'Water', 100]]
    );
    const layout = detectHeaderColumns(ws);
    expect(layout).not.toBeNull();
    expect(layout.cols.itemId).toBe(1);
    expect(layout.cols.sku).toBe(2);
    expect(layout.cols.quantityAvailable).toBe(4);
    expect(layout.dataStartRow).toBe(2);
  });

  test('parseInventorySummaryWorkbook reads rows from buffer', async () => {
    const {
      parseInventorySummaryWorkbook,
    } = require('../../src/warehouseInventory/inventorySummaryExcelImport');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory Summary');
    ws.addRow(['item_id', 'sku', 'quantity_available']);
    ws.addRow(['12345', '5M00524', 42.5]);
    ws.addRow(['', '', '']);
    const buf = await wb.xlsx.writeBuffer();
    const { rows, sheetName } = await parseInventorySummaryWorkbook(Buffer.from(buf));
    expect(sheetName).toBe('Inventory Summary');
    expect(rows).toHaveLength(1);
    expect(rows[0].item_id).toBe('12345');
    expect(rows[0].sku).toBe('5M00524');
    expect(rows[0].quantity_available).toBe(42.5);
  });
});
