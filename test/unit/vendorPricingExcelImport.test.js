const {
  inferItemTypeFromSheetName,
  normalizeSheetName,
} = require('../../src/masterBulk/vendorPricingExcelImport');

describe('vendorPricingExcelImport sheet mapping', () => {
  test('maps lifecycle worksheet names to RM or PM', () => {
    expect(inferItemTypeFromSheetName('Bulk Raw Materials')).toBe('RM');
    expect(inferItemTypeFromSheetName('Solvents & Carriers')).toBe('RM');
    expect(inferItemTypeFromSheetName('Pre-mixed Based')).toBe('RM');
    expect(inferItemTypeFromSheetName('CLUB Items')).toBe('RM');
    expect(inferItemTypeFromSheetName('Labels')).toBe('PM');
    expect(inferItemTypeFromSheetName('Monocartons')).toBe('PM');
    expect(inferItemTypeFromSheetName('Packaging - Primary')).toBe('PM');
    expect(inferItemTypeFromSheetName('Packaging - Secondary')).toBe('PM');
    expect(inferItemTypeFromSheetName('Shrink Sleeves')).toBe('PM');
    expect(inferItemTypeFromSheetName('Stickers & Kits')).toBe('PM');
    expect(inferItemTypeFromSheetName('Other Components')).toBe('PM');
  });

  test('returns null for unknown sheets', () => {
    expect(inferItemTypeFromSheetName('Summary')).toBeNull();
  });

  test('normalizeSheetName collapses spaces and case', () => {
    expect(normalizeSheetName('  Packaging   -   Primary ')).toBe('packaging - primary');
  });
});
