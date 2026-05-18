const {
  executeMasterCategoryRows,
} = require('../../src/masterBulk/masterCategoriesExcelImport');

jest.mock('../../src/products/masterSkuLookup', () => ({
  findRawMaterialByMasterSku: jest.fn(),
  findPackMaterialByMasterSku: jest.fn(),
}));

jest.mock('../../src/cache/redis', () => ({
  delByPattern: jest.fn().mockResolvedValue(0),
}));

const { findRawMaterialByMasterSku, findPackMaterialByMasterSku } = require('../../src/products/masterSkuLookup');

describe('masterCategoriesExcelImport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('updates RM category fields from excel row', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    findRawMaterialByMasterSku.mockResolvedValue({
      id: 1,
      code: 'EI-RM-SURF-00001',
      form_data: { vendors: [] },
      update,
    });

    const summary = await executeMasterCategoryRows(
      [
        {
          sheet_name: 'Bulk Raw Materials',
          excel_row: 2,
          item_type: 'RM',
          sku: 'EI-RM-SURF-00001',
          category: 'Surfactants / Cleansing',
          sub_category: 'Raw material',
        },
      ],
      { details: true }
    );

    expect(summary.rm_updated).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0][0];
    expect(payload.group).toBe('Raw material');
    expect(payload.category).toBe('Surfactants / Cleansing');
    expect(payload.form_data.subCategory).toBe('Raw material');
    expect(payload.form_data.rmCategory).toBe('Surfactants / Cleansing');
    expect(payload.form_data.excelCategory).toBe('Surfactants / Cleansing');
  });

  test('skips when master not found', async () => {
    findPackMaterialByMasterSku.mockResolvedValue(null);
    const summary = await executeMasterCategoryRows(
      [
        {
          sheet_name: 'Labels',
          excel_row: 3,
          item_type: 'PM',
          sku: 'MISSING',
          category: 'Self-adhesive Label',
          sub_category: 'Labels',
        },
      ],
      { details: true }
    );
    expect(summary.skipped).toBe(1);
    expect(summary.pm_updated).toBe(0);
  });
});
