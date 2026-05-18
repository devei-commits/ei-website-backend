const XLSX = require('xlsx');
const {
  parseMrpPrice,
  parseBomPriceListBuffer,
  BOM_PRICE_LIST_SHEET,
} = require('../../src/products/bomPriceListMrpImport');

function buildWorkbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, BOM_PRICE_LIST_SHEET);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('bomPriceListMrpImport', () => {
  test('parseMrpPrice strips currency symbols', () => {
    expect(parseMrpPrice('₹499.50')).toBe(499.5);
    expect(parseMrpPrice(299)).toBe(299);
    expect(parseMrpPrice('')).toBeNull();
    expect(parseMrpPrice('abc')).toBeNull();
  });

  test('parses BOM Price List sheet for SKU and Selling Price/Unit only', () => {
    const buf = buildWorkbookBuffer([
      ['SKU', 'Composite Name', 'Client Name', 'MOQ', 'Selling Price/Unit'],
      ['EI-PR-TEST-1', 'Product A', 'Client X', '100', '499.00'],
      ['EI-PR-TEST-2', 'Product B', 'Client Y', '50', '₹1,250.50'],
      ['', 'Empty SKU row', '', '', '100'],
      ['EI-PR-TEST-3', 'No price', '', '', ''],
    ]);
    const { rows, sheetName } = parseBomPriceListBuffer(buf);
    expect(sheetName).toBe(BOM_PRICE_LIST_SHEET);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ excel_row: 2, sku: 'EI-PR-TEST-1', mrp_price: 499 });
    expect(rows[1]).toMatchObject({ excel_row: 3, sku: 'EI-PR-TEST-2', mrp_price: 1250.5 });
  });

  test('matches sheet name case-insensitively', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['SKU', 'Selling Price/Unit'],
      ['SKU-1', '10'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'bom price list');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const { rows } = parseBomPriceListBuffer(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('SKU-1');
  });
});
