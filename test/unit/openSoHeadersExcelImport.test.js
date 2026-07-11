const ExcelJS = require('exceljs');
const {
  normalizeSheetName,
  findSalesOrderWorksheet,
  findOpenSoHeadersWorksheet,
  findOpenSoLinesWorksheet,
  excelFieldsToSalesOrderPayload,
  excelLineFieldsToItem,
  parseSalesOrderFlatWorkbook,
  parseOpenSoHeadersWorkbook,
  parseOpenSoLinesWorkbook,
  groupItemsBySoKey,
} = require('../../src/salesOrders/openSoHeadersExcelImport');

describe('openSoHeadersExcelImport', () => {
  test('normalizeSheetName matches Sales Order', () => {
    expect(normalizeSheetName('Sales Order')).toBe('sales order');
  });

  test('findSalesOrderWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const sheet = wb.addWorksheet('Sales Order');
    expect(findSalesOrderWorksheet(wb)).toBe(sheet);
  });

  test('parseSalesOrderFlatWorkbook groups line rows by SalesOrder Number', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sales Order');
    ws.getRow(1).values = [
      null,
      'SalesOrder Number',
      'Order Date',
      'Expected Shipment Date',
      'Status',
      'Custom Status',
      'Customer ID',
      'Customer Name',
      'GST Identification Number (GSTIN)',
      'Payment Terms',
      'Item Name',
      'SKU',
      'QuantityOrdered',
      'Item Price',
      'HSN/SAC',
      'Item Total',
      'Billing Address',
      'Billing City',
      'Billing Code',
      'Shipping Address',
      'Shipping City',
      'Shipping Code',
    ];
    ws.getRow(2).values = [
      null,
      'SO-03611',
      '2026-04-01',
      '2026-05-01',
      'open',
      'Awaiting dispatch',
      '1252231000037973999',
      'Test Client',
      '27AAAAA0000A1Z5',
      'Net 45',
      'Face Wash',
      'FG-FW-100',
      '10',
      '120',
      '3304',
      '1200',
      'Plot 1',
      'Mumbai',
      '400001',
      'Plot 2',
      'Pune',
      '411001',
    ];
    ws.getRow(3).values = [
      null,
      'SO-03611',
      '2026-04-01',
      '2026-05-01',
      'open',
      'Awaiting dispatch',
      '1252231000037973999',
      'Test Client',
      '27AAAAA0000A1Z5',
      'Net 45',
      'Serum',
      'FG-SERUM-10ML',
      '5',
      '250',
      '3304',
      '1250',
      'Plot 1',
      'Mumbai',
      '400001',
      'Plot 2',
      'Pune',
      '411001',
    ];

    const parsed = parseSalesOrderFlatWorkbook(wb);
    expect(parsed.format).toBe('sales_order_flat');
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].payload.order_id).toBe('SO-03611');
    expect(parsed.rows[0].payload.customer_name).toBe('Test Client');
    // zohoStatus 'open' is a real Zoho status (not draft/void/cancelled) → Approved.
    expect(parsed.rows[0].payload.status).toBe('Approved');
    expect(parsed.rows[0].payload.form_data.zohoCustomerId).toBe('1252231000037973999');
    expect(parsed.rows[0].payload.form_data.zohoSalesorderId).toBeUndefined();
    expect(parsed.rows[0].payload.form_data.gstin).toBe('27AAAAA0000A1Z5');
    expect(parsed.rows[0].payload.form_data.billingPincode).toBe('400001');
    expect(parsed.rows[0].payload.form_data.shippingPincode).toBe('411001');
    expect(parsed.rows[0].payload.form_data.customStatus).toBe('Awaiting dispatch');
    expect(parsed.rows[0].payload.form_data.source).toBe('excel_sales_order');
    expect(parsed.rows[0].payload.items).toHaveLength(2);
    expect(parsed.rows[0].payload.items[0].productName).toBe('Face Wash');
    expect(parsed.rows[0].payload.items[0].zohoItemId).toBeUndefined();
    expect(parsed.rows[0].payload.items[1].sku).toBe('FG-SERUM-10ML');
    expect(parsed.rows[0].payload.order_status.quantity).toBe(15);
  });

  test('parseSalesOrderFlatWorkbook imports SalesOrder ID, Reference#, payment label, and Draft status', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sales Order');
    ws.getRow(1).values = [
      null,
      'SalesOrder ID',
      'Order Date',
      'Expected Shipment Date',
      'SalesOrder Number',
      'Status',
      'Custom Status',
      'Customer ID',
      'Customer Name',
      'Reference#',
      'GST Identification Number (GSTIN)',
      'Payment Terms',
      'Payment Terms Label',
      'Item Name',
      'SKU',
      'QuantityOrdered',
      'Item Price',
      'HSN/SAC',
      'Item Total',
      'Billing Address',
      'Billing City',
      'Billing Code',
      'Shipping Address',
      'Shipping City',
      'Shipping Code',
    ];
    ws.getRow(2).values = [
      null,
      '3628277000000926032',
      '2026-03-23',
      '',
      'SO-00468',
      'partially_invoiced',
      '',
      '3628277000000926032',
      'HEALTH Q LIFESCIENCES PRIVATE LIMITED',
      'SO-03565 & PO00002 & 1900442',
      '06AAFCH8713F2ZN',
      '0',
      '50% ADVANCE 50% AGAINST DISPATCH',
      'SKINQ SUN PROTECT ULTRA LIGHT GEL SPF 50+ 50ML',
      'PR0006906',
      '2907',
      '171',
      '33049990',
      '1253259',
      '2nd Floor, No.204, The Eva Mall',
      'Bengaluru',
      '560025',
      '2nd Floor, No.204, The Eva Mall',
      'Bengaluru',
      '560025',
    ];

    const parsed = parseSalesOrderFlatWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    const payload = parsed.rows[0].payload;
    expect(payload.order_id).toBe('SO-00468');
    // zohoStatus 'partially_invoiced' is a real Zoho status (not draft/void/cancelled) → Approved.
    expect(payload.status).toBe('Approved');
    expect(payload.order_status.orderStatus).toBe('partially_invoiced');
    expect(payload.order_status.zohoStatus).toBe('partially_invoiced');
    expect(payload.form_data.zohoSalesorderId).toBe('3628277000000926032');
    expect(payload.reference).toBe('SO-03565 & PO00002 & 1900442');
    expect(payload.form_data.eiSoReference).toBe('SO-03565&PO00002&1900442');
    expect(payload.payment_terms).toBe('50% ADVANCE 50% AGAINST DISPATCH');
    expect(payload.form_data.zohoStatus).toBe('partially_invoiced');
    expect(payload.items[0].sku).toBe('PR0006906');
    expect(payload.items[0].quantity).toBe(2907);
    expect(payload.items[0].unitPrice).toBe(171);
  });

  test('parseSalesOrderFlatWorkbook captures currency, product id, invoiced qty, tax %, salesperson, and notes', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sales Order');
    ws.getRow(1).values = [
      null,
      'SalesOrder ID',
      'SalesOrder Number',
      'Customer ID',
      'Customer Name',
      'Reference#',
      'Currency Code',
      'Product ID',
      'Item Name',
      'QuantityOrdered',
      'QuantityInvoiced',
      'Item Tax %',
      'Sales person',
      'Notes',
    ];
    ws.getRow(2).values = [
      null,
      '1252231000040833999',
      'SO-99999',
      '1252231000037973999',
      'Client',
      'REF-SKIP',
      'USD',
      '1252231000040001000',
      'Toner',
      '3',
      '1',
      '18',
      'Priya',
      'Handle with care',
    ];

    const parsed = parseSalesOrderFlatWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    const payload = parsed.rows[0].payload;
    expect(payload.order_id).toBe('SO-99999');
    expect(payload.form_data.zohoSalesorderId).toBe('1252231000040833999');
    expect(payload.form_data.currencyCode).toBe('USD');
    expect(payload.form_data.eiSoReference).toBe('REF-SKIP');
    expect(payload.reference).toBe('REF-SKIP');
    expect(payload.items[0].taxPercent).toBe(18);
    expect(payload.items[0].invoicedQty).toBe(1);
    expect(payload.items[0].zohoItemId).toBe('1252231000040001000');
    expect(payload.form_data.salespersonName).toBe('Priya');
    expect(payload.form_data.notes).toBe('Handle with care');
  });

  test('parseSalesOrderFlatWorkbook ignores columns with no field mapping (TDS, UPC, Item Type)', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sales Order');
    ws.getRow(1).values = [
      null,
      'SalesOrder ID',
      'SalesOrder Number',
      'Customer Name',
      'Reference#',
      'Item Name',
      'QuantityOrdered',
      'UPC',
      'Item Type',
      'TDS Name',
      'TDS Percentage',
      'TDS Amount',
    ];
    ws.getRow(2).values = [
      null,
      '1252231000040833999',
      'SO-99998',
      'Client',
      'REF-IGNORE',
      'Toner',
      '3',
      '012345678905',
      'goods',
      'TDS - Others',
      '10',
      '30',
    ];

    const parsed = parseSalesOrderFlatWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    const payload = parsed.rows[0].payload;
    expect(payload.order_id).toBe('SO-99998');
    // None of these columns have a form_data / item field — they're preserved only in raw_import.
    expect(payload.form_data.upc).toBeUndefined();
    expect(payload.form_data.itemType).toBeUndefined();
    expect(payload.form_data.tdsName).toBeUndefined();
    expect(payload.items[0].upc).toBeUndefined();
    expect(payload.items[0].itemType).toBeUndefined();
  });

  test('normalizeSheetName matches Open SO Headers', () => {
    expect(normalizeSheetName('Open SO Headers')).toBe('open so headers');
  });

  test('findOpenSoHeadersWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const headers = wb.addWorksheet('Open SO Headers');
    expect(findOpenSoHeadersWorksheet(wb)).toBe(headers);
  });

  test('findOpenSoLinesWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const lines = wb.addWorksheet('Open SO Lines');
    expect(findOpenSoLinesWorksheet(wb)).toBe(lines);
  });

  test('excelFieldsToSalesOrderPayload maps SalesOrder ID and Number columns', () => {
    const payload = excelFieldsToSalesOrderPayload({
      zohoSoId: '1252231000040833074',
      zohoSoIdReliable: true,
      zohoSoDisplayNumber: 'SO-03611',
      customerName: 'Acme',
    });
    expect(payload.order_id).toBe('SO-03611');
    expect(payload.form_data.zohoSalesorderId).toBe('1252231000040833074');
    expect(payload.form_data.zohoSalesorderNumber).toBe('SO-03611');
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

  test('excelFieldsToSalesOrderPayload treats SO number text as display number, not zoho id', () => {
    const payload = excelFieldsToSalesOrderPayload({
      zohoSoNumber: 'SO-03611',
      customerName: 'Acme',
    });
    expect(payload.order_id).toBe('SO-03611');
    expect(payload.form_data.zohoSalesorderNumber).toBe('SO-03611');
    expect(payload.form_data.zohoSalesorderId).toBeUndefined();
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

  test('excelLineFieldsToItem maps line columns', () => {
    const item = excelLineFieldsToItem({
      productName: 'Serum',
      sku: 'FG-SERUM-10ML',
      packSize: '10 ml',
      qtyOrdered: '100',
      qtyInvoiced: '20',
      qtyCancelled: '5',
      openQtyRemaining: '75',
      uom: 'Nos',
      unitPrice: '99.5',
      itemTotal: '9950',
      taxPercent: '18',
      taxAmount: '1791',
      cgstRatePercent: '9',
      sgstRatePercent: '9',
      igstRatePercent: '0',
      cgstAmount: '895.5',
      sgstAmount: '895.5',
      igstAmount: '0',
      zohoProductId: '1252231000040001000',
      hsnSac: '3304',
    });
    expect(item.productName).toBe('Serum');
    expect(item.quantity).toBe(100);
    expect(item.unitPrice).toBe(99.5);
    expect(item.taxPercent).toBe(18);
    expect(item.zohoItemId).toBe('1252231000040001000');
    expect(item.hsnCode).toBe('3304');
  });

  test('parseOpenSoLinesWorkbook reads rows and groups by SO key', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Open SO Lines');
    ws.getRow(1).values = [
      null,
      'Zoho SO Number',
      'Zoho SO ID',
      'Product(Item Name)',
      'SKU',
      'Qty Ordered',
      'Unit Price (₹)',
      'Tax %',
    ];
    ws.getRow(2).values = [
      null,
      'SO-03611',
      '1252231000040833999',
      'Face Wash',
      'FG-FW-100',
      '10',
      '120',
      '18',
    ];

    const parsed = parseOpenSoLinesWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].item.productName).toBe('Face Wash');
    const grouped = groupItemsBySoKey(parsed.rows);
    expect(grouped.get('1252231000040833999')).toHaveLength(1);
    expect(grouped.get('SO-03611')).toHaveLength(1);
  });

  test('parseOpenSoHeadersWorkbook includes late sparse rows', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Open SO Headers');
    ws.getRow(1).values = [null, 'Zoho SO Number', 'Customer Name', 'Order Date'];
    ws.getRow(2).values = [null, '1252231000040833001', 'Client A', '2026-04-01'];
    ws.getRow(60).values = [null, '1252231000040833002', 'Client B', '2026-04-02'];

    const parsed = parseOpenSoHeadersWorkbook(wb);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[1].payload.form_data.zohoSalesorderId).toBe('1252231000040833002');
  });

});
