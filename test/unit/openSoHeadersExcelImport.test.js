const ExcelJS = require('exceljs');
const {
  normalizeSheetName,
  findOpenSoHeadersWorksheet,
  excelFieldsToSalesOrderPayload,
  parseOpenSoHeadersWorkbook,
} = require('../../src/salesOrders/openSoHeadersExcelImport');

describe('openSoHeadersExcelImport', () => {
  test('normalizeSheetName matches Open SO Headers', () => {
    expect(normalizeSheetName('Open SO Headers')).toBe('open so headers');
  });

  test('findOpenSoHeadersWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const headers = wb.addWorksheet('Open SO Headers');
    expect(findOpenSoHeadersWorksheet(wb)).toBe(headers);
  });

  test('excelFieldsToSalesOrderPayload maps header columns', () => {
    const payload = excelFieldsToSalesOrderPayload({
      zohoSoNumber: '1252231000040833074',
      zohoSoNumberReliable: true,
      customerName: 'Acme Labs',
      zohoCustomerId: '1252231000037973999',
      orderDate: '2026-04-15',
      expectedShipmentDate: '2026-05-20',
      salesperson: 'Priya',
      placeOfSupply: 'MH',
      gstTreatment: 'business_gst',
      gstin: '27AAAAA0000A1Z5',
      billingAddress: 'Plot 1',
      billingCity: 'Mumbai',
      billingState: 'Maharashtra',
      billingCountry: 'India',
      billingPincode: '400001',
      billingPhone: '+91-9999999999',
      shippingAddress: 'Plot 2',
      shippingCity: 'Pune',
      shippingState: 'Maharashtra',
      shippingCountry: 'India',
      shippingPincode: '411001',
      shippingPhone: '+91-8888888888',
      paymentTerms: 'Net 30',
      advancePercent: '10',
      preShipmentPercent: '40',
      postShipmentPercent: '50',
      creditDays: '30',
      currency: 'INR',
      exchangeRate: '1',
      deliveryMethod: 'Courier',
      totalQtyOrdered: '100',
      totalQtyInvoiced: '20',
      totalQtyCancelled: '5',
      openQtyRemaining: '75',
      zohoStatus: 'open',
    });

    expect(payload).not.toBeNull();
    expect(payload.order_id).toBe('ZOHO-SO-1252231000040833074');
    expect(payload.customer_name).toBe('Acme Labs');
    expect(payload.order_date).toBe('2026-04-15');
    expect(payload.expected_shipment_date).toBe('2026-05-20');
    expect(payload.payment_terms).toBe('Net 30');
    expect(payload.form_data.zohoSalesorderId).toBe('1252231000040833074');
    expect(payload.form_data.zohoCustomerId).toBe('1252231000037973999');
    expect(payload.form_data.gstTreatment).toBe('business_gst');
    expect(payload.form_data.advancePercent).toBe(10);
    expect(payload.form_data.currencyCode).toBe('INR');
    expect(payload.form_data.source).toBe('excel_open_so_headers');
    expect(payload.order_status.quantity).toBe(100);
    expect(payload.order_status.quantityOpen).toBe(75);
    expect(payload.items).toEqual([]);
  });

  test('excelFieldsToSalesOrderPayload uses SO display number when present', () => {
    const payload = excelFieldsToSalesOrderPayload({
      zohoSoNumber: '1252231000040833074',
      zohoSoDisplayNumber: 'SO-03611',
      zohoSoNumberReliable: true,
      customerName: 'Acme',
    });
    expect(payload.order_id).toBe('SO-03611');
    expect(payload.form_data.zohoSalesorderNumber).toBe('SO-03611');
  });

  test('parseOpenSoHeadersWorkbook reads data rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Open SO Headers');
    const headers = [
      'EI SO Reference',
      'Zoho SO Number',
      'Status (Zoho)',
      'Customer Name',
      'Zoho Customer ID',
      'Order Date',
      'Expected Shipment / Due Date',
      'Payment Terms (raw)',
      'Currency',
    ];
    ws.getRow(1).values = [null, ...headers];
    ws.getRow(2).values = [
      null,
      'REF-1',
      '1252231000040833999',
      'open',
      'Test Client',
      '1252231000037973999',
      '2026-04-01',
      '2026-05-01',
      'Net 45',
      'INR',
    ];

    const parsed = parseOpenSoHeadersWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].payload.customer_name).toBe('Test Client');
    expect(parsed.rows[0].payload.form_data.zohoSalesorderId).toBe('1252231000040833999');
    expect(parsed.rows[0].payload.payment_terms).toBe('Net 45');
  });
});
