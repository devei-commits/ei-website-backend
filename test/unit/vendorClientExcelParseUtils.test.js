const ExcelJS = require('exceljs');
const {
  readZohoContactIdFromCell,
  readZohoContactIdMetaFromCell,
  readZohoIdFromXlsxCell,
  buildZohoColumnOverlayFromXlsx,
  resolveZohoFromExcelFields,
  prepareMasterImportRows,
} = require('../../src/vendorClient/vendorClientExcelParseUtils');

describe('vendorClientExcelParseUtils', () => {
  test('readZohoContactIdFromCell prefers cell.text over rounded number', () => {
    const id = readZohoContactIdFromCell({
      value: 3628277000000250000,
      text: '3628277000000250123',
    });
    expect(id).toBe('3628277000000250123');
  });

  test('readZohoContactIdMetaFromCell marks Excel number cells unreliable', () => {
    const meta = readZohoContactIdMetaFromCell({
      value: 3628277000000250000,
      text: '3.62828E+18',
    });
    expect(meta.reliable).toBe(false);
    expect(meta.id).toBeTruthy();
  });

  test('readZohoIdFromXlsxCell keeps string-stored Zoho ids', () => {
    const meta = readZohoIdFromXlsxCell({
      t: 's',
      v: '3628277000000250123',
      w: '3628277000000250123',
    });
    expect(meta.id).toBe('3628277000000250123');
    expect(meta.reliable).toBe(true);
  });

  test('resolveZohoFromExcelFields does not upsert on unreliable ids', () => {
    const resolved = resolveZohoFromExcelFields({
      zohoContactId: '3628277000000250000',
      zohoContactIdReliable: false,
    });
    expect(resolved.displayId).toBe('3628277000000250000');
    expect(resolved.upsertId).toBeNull();
    expect(resolved.unreliable).toBe(true);
  });

  test('buildZohoColumnOverlayFromXlsx reads string cells from workbook buffer', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Active Vendors');
    ws.getCell('A1').value = 'Zoho Contact ID';
    ws.getCell('A2').value = '3628277000000250123';
    const buf = await wb.xlsx.writeBuffer();
    const overlay = buildZohoColumnOverlayFromXlsx(buf, 'Active Vendors', [
      'zoho contact id',
      'zoho id',
    ]);
    expect(overlay.byRow[2].id).toBe('3628277000000250123');
    expect(overlay.byRow[2].reliable).toBe(true);
  });

  test('prepareMasterImportRows merges duplicate zoho+name rows', () => {
    const row = (n, zoho, name) => ({
      excel_row: n,
      sheet_name: 'Active Vendors',
      payload: {
        zoho_id: zoho,
        name,
        email: null,
        data: { zohoId: zoho },
      },
    });

    const { rows, stats } = prepareMasterImportRows([
      row(2, 'ZOHO-A', 'Acme'),
      row(3, 'ZOHO-A', 'Acme'),
      row(4, 'ZOHO-A', 'Acme'),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].excel_row).toBe(4);
    expect(stats.merged_duplicate_rows).toBe(2);
  });

  test('prepareMasterImportRows clears zoho when same id different names', () => {
    const row = (n, zoho, name) => ({
      excel_row: n,
      sheet_name: 'Active Vendors',
      payload: {
        zoho_id: zoho,
        name,
        email: `${n}@test.com`,
        data: { zohoId: zoho },
      },
    });

    const { rows, stats } = prepareMasterImportRows([
      row(2, 'ZOHO-A', 'Vendor One'),
      row(3, 'ZOHO-A', 'Vendor Two'),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0].payload.zoho_id).toBe('ZOHO-A');
    expect(rows[1].payload.zoho_id).toBeNull();
    expect(stats.zoho_id_collisions_cleared).toBe(1);
  });
});
