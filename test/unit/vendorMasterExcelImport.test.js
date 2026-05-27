const ExcelJS = require('exceljs');
const {
  normalizeSheetName,
  findActiveVendorsWorksheet,
  excelFieldsToVendorMasterPayload,
  parseActiveVendorsWorkbook,
  parseAdditionalPocsWorkbook,
  parseAdditionalAddressesWorkbook,
  findAdditionalAddressesWorksheet,
} = require('../../src/vendorClient/vendorMasterExcelImport');

describe('vendorMasterExcelImport', () => {
  test('normalizeSheetName matches Active Vendors', () => {
    expect(normalizeSheetName('Active Vendors')).toBe('active vendors');
  });

  test('findActiveVendorsWorksheet ignores Summary', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const active = wb.addWorksheet('Active Vendors');
    expect(findActiveVendorsWorksheet(wb)).toBe(active);
  });

  test('excelFieldsToVendorMasterPayload mirrors trade name to legal name', () => {
    const payload = excelFieldsToVendorMasterPayload({
      tradeName: 'Acme Trading',
      legalName: '',
      primaryEmail: 'a@acme.test',
    });
    expect(payload).not.toBeNull();
    expect(payload.data.legalName).toBe('Acme Trading');
    expect(payload.data.tradeName).toBe('Acme Trading');
    expect(payload.name).toBe('Acme Trading');
  });

  test('excelFieldsToVendorMasterPayload accepts zoho-only row', () => {
    const payload = excelFieldsToVendorMasterPayload({
      zohoContactId: '1252231000099999001',
      primaryEmail: '',
      legalName: '',
      tradeName: '',
    });
    expect(payload).not.toBeNull();
    expect(payload.name).toBe('Vendor 1252231000099999001');
    expect(payload.zoho_id).toBe('1252231000099999001');
  });

  test('excelFieldsToVendorMasterPayload maps vendor columns', () => {
    const payload = excelFieldsToVendorMasterPayload({
      zohoContactId: '1252231000037973999',
      setupCategoryHint: 'VENDORS - COGS-RAW MATERIAL',
      legalName: 'Raw Materials Pvt Ltd',
      tradeName: 'RM Supplier',
      primaryEmail: 'vendor@example.test',
      primaryPhone: '+91-8888888888',
      status: 'Active',
      billingAddress: 'Plot 9',
      billingCity: 'Mumbai',
      billingState: 'Maharashtra',
      billingCountry: 'India',
      gstin: '27AAAAA0000A1Z5',
      pan: 'AAAAA0000A',
      msmeUdyamNo: 'UDYAM-MH-01-0001234',
      msmeUdyamType: 'Micro',
      tdsName: 'Commission',
      tdsPercent: '2',
      tdsApplicable: 'Yes',
      paymentTerms: 'Net 30',
      beneficiaryName: 'RM Supplier',
      bankName: 'HDFC',
      bankAccountNumber: '1234567890',
      bankIfsc: 'HDFC0001234',
      currencyCode: 'INR',
    });
    expect(payload).not.toBeNull();
    expect(payload.type).toBe('vendor');
    expect(payload.zoho_id).toBe('1252231000037973999');
    expect(payload.category).toBe('VENDORS - COGS-RAW MATERIAL');
    expect(payload.data.setupCategory).toBe('VENDORS - COGS-RAW MATERIAL');
    expect(payload.data.cfCategory).toBe('VENDORS - COGS-RAW MATERIAL');
    expect(payload.data.msme).toContain('UDYAM-MH-01-0001234');
    expect(payload.data.tdsApplicable).toBe('Yes');
    expect(payload.data.banks).toHaveLength(1);
    expect(payload.data.banks[0].ifsc).toBe('HDFC0001234');
    expect(payload.payment_terms).toBe('Net 30');
  });

  test('parseActiveVendorsWorkbook reads data rows from Active Vendors', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const ws = wb.addWorksheet('Active Vendors');
    ws.addRow([
      'Zoho Contact ID',
      'Entity Type',
      'Setup Category',
      'Setup Category Hint (CF. CATEGORY)',
      'Legal Name',
      'Trade Name',
      'Primary Email',
      'Primary Phone',
      'Status',
      'GSTIN',
      'TDS Applicable',
      'Payment Terms',
      'Beneficiary Name',
      'Bank Name',
      'Bank Account Number',
      'IFSC / Bank Code',
      'Currency Code',
    ]);
    ws.addRow([
      'ZOHO-V-1',
      'vendor',
      '',
      'VENDORS- SERVICE&MAINTANANCE-OFFICE MANAGEMENT',
      'Office Services Ltd',
      'Office Svc',
      'office@vendor.test',
      '+91-7777777777',
      'Active',
      '27BBBBB0000B1Z5',
      'No',
      'Due on Receipt',
      'Office Svc',
      'ICICI',
      '9876543210',
      'ICIC0009876',
      'INR',
    ]);

    const { rows, sheetName } = parseActiveVendorsWorkbook(wb);
    expect(sheetName).toBe('Active Vendors');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.name).toBe('Office Svc');
    expect(rows[0].payload.data.cfCategory).toContain('OFFICE MANAGEMENT');
  });

  test('parseAdditionalPocsWorkbook maps POCs by vendor Zoho Contact ID', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    wb.addWorksheet('Active Vendors');

    const ws = wb.addWorksheet('Additional POCs');
    ws.addRow([
      'Zoho Contact ID',
      'Vendor Name (for reference)',
      'Salutation',
      'POC First Name',
      'POC Last Name',
      'POC Email',
      'POC Phone',
      'POC Mobile',
      'POC Department',
      'POC Designation',
      'Is Primary POC',
      'Last Modified Time',
    ]);
    ws.addRow([
      'ZOHO-V-POC-1',
      'Office Svc',
      'Ms.',
      'Priya',
      'Shah',
      'priya@vendor.test',
      '',
      '9000000001',
      'Accounts',
      'Manager',
      'Yes',
      '2026-05-01',
    ]);

    const { pocsByZohoId } = parseAdditionalPocsWorkbook(wb);
    expect(Object.keys(pocsByZohoId)).toHaveLength(1);
    expect(pocsByZohoId['ZOHO-V-POC-1']).toHaveLength(1);
    expect(pocsByZohoId['ZOHO-V-POC-1'][0]).toMatchObject({
      name: 'Priya Shah',
      role: 'Manager — Accounts',
      email: 'priya@vendor.test',
      phone: '9000000001',
      preferred: 'No',
      level: 'L2 (Escalation)',
      salutation: 'Ms.',
      department: 'Accounts',
      excelLastModifiedTime: '2026-05-01',
    });
    expect(pocsByZohoId['ZOHO-V-POC-1'][0].notes).toContain('Ms.');
  });

  test('findAdditionalAddressesWorksheet accepts Addiional Addresses typo', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Addiional Addresses');
    expect(findAdditionalAddressesWorksheet(wb)).toBe(ws);
  });

  test('parseAdditionalAddressesWorkbook maps addresses by vendor Zoho Contact ID', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Active Vendors');

    const ws = wb.addWorksheet('Additional Addresses');
    ws.addRow([
      'Zoho Contact ID',
      'Vendors Name (for reference)',
      'Zoho address Id',
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
    ]);
    ws.addRow([
      'ZOHO-V-ADDR-1',
      'RM Supplier',
      'ZA-SKIP-1',
      'Warehouse',
      'Plot 12 Industrial Area',
      'Gate 2',
      'Pune',
      'Maharashtra',
      'India',
      '411001',
      '9123456789',
      '27AAAAA0000A1Z5',
      'MH',
    ]);

    const { additionalAddressesByZohoId } = parseAdditionalAddressesWorkbook(wb);
    expect(Object.keys(additionalAddressesByZohoId)).toHaveLength(1);
    expect(additionalAddressesByZohoId['ZOHO-V-ADDR-1']).toHaveLength(1);
    expect(additionalAddressesByZohoId['ZOHO-V-ADDR-1'][0]).toMatchObject({
      attention: 'Warehouse',
      address: 'Plot 12 Industrial Area',
      street2: 'Gate 2',
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
      pincode: '411001',
      phone: '9123456789',
      gstin: '27AAAAA0000A1Z5',
      placeOfSupply: 'MH',
    });
    expect(additionalAddressesByZohoId['ZOHO-V-ADDR-1'][0].zohoAddressId).toBeUndefined();
  });
});
