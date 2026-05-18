const {
  mapRmImportCategories,
  mapPmImportCategories,
  resolveRmEditFromDb,
  resolvePmEditFromDb,
} = require('../../src/masterBulk/masterCategoryImportMap');

describe('masterCategoryImportMap (Excel verbatim)', () => {
  test('stores RM category and sub-category exactly from Excel columns', () => {
    const m = mapRmImportCategories({
      sheetName: 'Bulk Raw Materials',
      categoryCol: 'Bulk Raw Materials',
      subCategoryCol: 'Raw material',
    });
    expect(m.subCategory).toBe('Raw material');
    expect(m.categoryDb).toBe('Bulk Raw Materials');
    expect(m.formDataPatch.excelCategory).toBe('Bulk Raw Materials');
    expect(m.formDataPatch.excelSubCategory).toBe('Raw material');
    expect(m.formDataPatch.rmCategory).toBe('Bulk Raw Materials');
  });

  test('stores PM category and sub-category exactly from Excel columns', () => {
    const m = mapPmImportCategories({
      sheetName: 'Labels',
      categoryCol: 'Self-adhesive Label',
      subCategoryCol: 'Labels',
    });
    expect(m.subCategory).toBe('Labels');
    expect(m.pmCategory).toBe('Self-adhesive Label');
    expect(m.groupDb).toBe('Labels');
    expect(m.materialDb).toBe('Self-adhesive Label');
  });

  test('resolveRmEditFromDb returns stored excel fields', () => {
    const r = resolveRmEditFromDb({
      code: '1000016',
      category: 'Bulk Raw Materials',
      group: 'Raw material',
      form_data: {
        excelCategory: 'Bulk Raw Materials',
        excelSubCategory: 'Raw material',
      },
    });
    expect(r.subCategory).toBe('Raw material');
    expect(r.rmCategory).toBe('Bulk Raw Materials');
  });

  test('resolvePmEditFromDb returns stored excel fields', () => {
    const r = resolvePmEditFromDb({
      code: '500001',
      group: 'Labels',
      material: 'Self-adhesive Label',
      form_data: { excelCategory: 'Self-adhesive Label', excelSubCategory: 'Labels' },
    });
    expect(r.subCategory).toBe('Labels');
    expect(r.pmCategory).toBe('Self-adhesive Label');
  });
});
