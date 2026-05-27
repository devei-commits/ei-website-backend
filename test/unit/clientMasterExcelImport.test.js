const ExcelJS = require('exceljs');
const {
  normalizeSheetName,
  findActiveClientsWorksheet,
  excelFieldsToVendorClientPayload,
  parseActiveClientsWorkbook,
  parseAdditionalPocsWorkbook,
  parseAdditionalAddressesWorkbook,
} = require('../../src/vendorClient/clientMasterExcelImport');

describe('clientMasterExcelImport', () => {
  test('normalizeSheetName matches Active Clients', () => {
    expect(normalizeSheetName('Active Clients')).toBe('active clients');
    expect(normalizeSheetName('  Active   Clients ')).toBe('active clients');
  });

  test('findActiveClientsWorksheet ignores Summary', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const active = wb.addWorksheet('Active Clients');
    expect(findActiveClientsWorksheet(wb)).toBe(active);
  });

  test('excelFieldsToVendorClientPayload mirrors trade name to legal name', () => {
    const payload = excelFieldsToVendorClientPayload({
      tradeName: 'Client Trade Co',
      legalName: '',
      primaryEmail: 'c@client.test',
    });
    expect(payload).not.toBeNull();
    expect(payload.data.legalName).toBe('Client Trade Co');
    expect(payload.data.tradeName).toBe('Client Trade Co');
    expect(payload.name).toBe('Client Trade Co');
  });

  test('excelFieldsToVendorClientPayload maps client columns', () => {
    const payload = excelFieldsToVendorClientPayload({
      zohoContactId: '1252231000037973007',
      legalName: 'Acme Labs Pvt Ltd',
      tradeName: 'Acme Labs',
      primaryEmail: 'billing@acme.test',
      primaryPhone: '+91-9999999999',
      status: 'Active',
      customerSubType: 'business',
      billingAddress: '12 MG Road',
      billingCity: 'Hyderabad',
      billingState: 'Telangana',
      billingCountry: 'India',
      billingPincode: '500081',
      state: 'Telangana',
      country: 'India',
      gstin: '36AAAAA0000A1Z5',
      paymentTermsDays: '60',
      currencyCode: 'INR',
      salesOwner: 'Komal',
      accountManager: 'Shivam',
    });
    expect(payload).not.toBeNull();
    expect(payload.zoho_id).toBe('1252231000037973007');
    expect(payload.name).toBe('Acme Labs');
    expect(payload.email).toBe('billing@acme.test');
    expect(payload.status).toBe('active');
    expect(payload.data.customerSubType).toBe('business');
    expect(payload.data.legalName).toBe('Acme Labs Pvt Ltd');
    expect(payload.payment_terms).toBe('NET 60');
    expect(payload.data.currencyCode).toBe('INR');
    expect(payload.data.salesOwner).toBe('Komal');
    expect(payload.data.billingAddressObject.city).toBe('Hyderabad');
  });

  test('parseActiveClientsWorkbook reads data rows only from Active Clients', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const ws = wb.addWorksheet('Active Clients');
    ws.addRow([
      'Zoho Contact ID',
      'Entity Type',
      'Setup Category',
      'Legal Name',
      'Trade Name',
      'Brand Name',
      'Primary Email',
      'Primary Phone',
      'Status',
      'Customer Sub Type',
    ]);
    ws.addRow([
      'ZOHO-1',
      'client',
      'Customer',
      'Legal One',
      'Trade One',
      '',
      'one@test.com',
      '111',
      'Active',
      'individual',
    ]);

    const { rows, sheetName } = parseActiveClientsWorkbook(wb);
    expect(sheetName).toBe('Active Clients');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.name).toBe('Trade One');
    expect(rows[0].payload.data.customerSubType).toBe('individual');
    expect(rows[0].payload.zoho_id).toBe('ZOHO-1');
  });

  test('parseAdditionalPocsWorkbook maps POCs by client Zoho ID', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    wb.addWorksheet('Active Clients'); // not required for POCs parsing

    const ws = wb.addWorksheet('Additional POCs');
    ws.addRow([
      'Zoho Contact ID',
      'Client Name',
      'POC Display Name',
      'Salutation',
      'POC First Name',
      'POC Last Name',
      'POC Email',
      'POC Phone',
      'POC Mobile',
      'POC Designation',
      'is Primary POC',
      'Last Modifie Time',
    ]);
    ws.addRow([
      'Z-CLI-1',
      'Acme Labs',
      'John Doe',
      'Mr.',
      'John',
      'Doe',
      'john@acme.test',
      '9999999999',
      '',
      'Procurement',
      'Yes',
      '2026-01-01',
    ]);

    const { pocsByZohoId } = parseAdditionalPocsWorkbook(wb);
    expect(Object.keys(pocsByZohoId)).toHaveLength(1);
    expect(pocsByZohoId['Z-CLI-1']).toHaveLength(1);
    expect(pocsByZohoId['Z-CLI-1'][0]).toMatchObject({
      name: 'John Doe',
      role: 'Procurement',
      email: 'john@acme.test',
      phone: '9999999999',
      preferred: 'Yes',
      level: 'L1 (Primary)',
      notes: 'Mr.',
    });
  });

  test('parseAdditionalAddressesWorkbook maps addresses by client Zoho ID', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    wb.addWorksheet('Active Clients'); // not required for address parsing

    const ws = wb.addWorksheet('Additional Addresses');
    ws.addRow([
      'Zoho Contact ID',
      'Client Name',
      'Zoho Address ID',
      'Attention',
      'Address Line 1',
      'Address Line 2',
      'City',
      'State',
      'Country',
      'Pincode',
      'Phone',
      'GSTIN at this address',
      'Place of Supply',
      'Legal Name at this address',
      'Trade Name at this address',
    ]);

    ws.addRow([
      'Z-CLI-1',
      'Acme Labs',
      'ZA-1',
      'Billing Attn',
      '12 MG Road',
      'Line 2',
      'Hyderabad',
      'Telangana',
      'India',
      '500081',
      '9999999999',
      '36AAAAA0000A1Z5',
      'TS',
      'Legal Name Addr',
      'Trade Name Addr',
    ]);

    const { additionalAddressesByZohoId } = parseAdditionalAddressesWorkbook(wb);
    expect(Object.keys(additionalAddressesByZohoId)).toHaveLength(1);
    expect(additionalAddressesByZohoId['Z-CLI-1']).toHaveLength(1);
    expect(additionalAddressesByZohoId['Z-CLI-1'][0]).toMatchObject({
      zohoAddressId: 'ZA-1',
      attention: 'Billing Attn',
      address: '12 MG Road',
      street2: 'Line 2',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      pincode: '500081',
      phone: '9999999999',
      gstin: '36AAAAA0000A1Z5',
      placeOfSupply: 'TS',
      legalNameAtAddress: 'Legal Name Addr',
      tradeNameAtAddress: 'Trade Name Addr',
    });
  });
});
