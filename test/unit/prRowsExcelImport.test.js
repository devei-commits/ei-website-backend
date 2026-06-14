const ExcelJS = require('exceljs');
const {
  normalizeSheetName,
  findPurchaseOrderWorksheet,
  findPrRowsWorksheet,
  findQuotationRowsWorksheet,
  findRawPoDetailWorksheet,
  prRowFieldsToItem,
  quotationRowFieldsToItem,
  rawPoDetailFieldsToItem,
  purchaseOrderFlatFieldsToItem,
  parsePurchaseOrderFlatWorkbook,
  parsePrRowsWorkbook,
  parseQuotationRowsWorkbook,
  parseRawPoDetailWorkbook,
  groupPrRowsToPoPayloads,
  groupPurchaseOrderFlatRows,
  applyQuotationRowsToGroupedPos,
  applyRawPoDetailsToGroupedPos,
  enrichItemsWithMaterialLookup,
} = require('../../src/purchaseOrders/prRowsExcelImport');

describe('prRowsExcelImport', () => {
  test('normalizeSheetName matches PurchaseOrder', () => {
    expect(normalizeSheetName('PurchaseOrder')).toBe('purchaseorder');
  });

  test('findPurchaseOrderWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const ws = wb.addWorksheet('PurchaseOrder');
    expect(findPurchaseOrderWorksheet(wb)).toBe(ws);
  });

  test('parsePurchaseOrderFlatWorkbook groups line rows by Purchase Order Number', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PurchaseOrder');
    ws.getRow(1).values = [
      null,
      'Purchase Order Number',
      'Purchase Order Date',
      'Delivery Date',
      'Expected Arrival Date',
      'Purchase Order Status',
      'Vendor Name',
      'GST Identification Number (GSTIN)',
      'Payment Terms',
      'Attention',
      'Address',
      'City',
      'State',
      'Country',
      'Code',
      'Phone',
      'Item Name',
      'SKU',
      'HSN/SAC',
      'QuantityOrdered',
      'Item Price',
      'Item Total',
    ];
    ws.getRow(2).values = [
      null,
      'PO-1001',
      '2026-05-01',
      '2026-05-10',
      '2026-05-12',
      'Open',
      'ABC Chemicals',
      '27AAAAA0000A1Z5',
      'Net 30',
      'Procurement',
      'Plot 1',
      'Mumbai',
      'Maharashtra',
      'India',
      '400001',
      '+91-9999999999',
      'Glycerin',
      'RM-GLY',
      '2905',
      '100',
      '140',
      '14000',
    ];
    ws.getRow(3).values = [
      null,
      'PO-1001',
      '2026-05-01',
      '2026-05-10',
      '2026-05-12',
      'Open',
      'ABC Chemicals',
      '27AAAAA0000A1Z5',
      'Net 30',
      'Procurement',
      'Plot 1',
      'Mumbai',
      'Maharashtra',
      'India',
      '400001',
      '+91-9999999999',
      'Niacinamide',
      'RM-NIA',
      '2936',
      '50',
      '320',
      '16000',
    ];

    const parsed = parsePurchaseOrderFlatWorkbook(wb);
    expect(parsed.format).toBe('purchase_order_flat');
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].payload.order_id).toBe('PO-1001');
    expect(parsed.rows[0].payload.vendor_name).toBe('ABC Chemicals');
    expect(parsed.rows[0].payload.form_data.vendorGstin).toBe('27AAAAA0000A1Z5');
    expect(parsed.rows[0].payload.form_data.vendorPincode).toBe('400001');
    expect(parsed.rows[0].payload.form_data.source).toBe('excel_purchase_order');
    expect(parsed.rows[0].payload.items).toHaveLength(2);
    expect(parsed.rows[0].payload.items[0].productName).toBe('Glycerin');

    const grouped = groupPurchaseOrderFlatRows(parsed.rows);
    expect(grouped.size).toBe(1);
    expect(grouped.get('PO-1001').payload.items).toHaveLength(2);
  });

  test('parsePurchaseOrderFlatWorkbook ignores skipped columns present in sheet', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PurchaseOrder');
    ws.getRow(1).values = [
      null,
      'Purchase Order ID',
      'Purchase Order Number',
      'Reference#',
      'Currency Code',
      'Product ID',
      'Item Name',
      'QuantityOrdered',
      'QuantityReceived',
      'Item Tax %',
      'Usage unit',
      'Total',
    ];
    ws.getRow(2).values = [
      null,
      '1252231000040999000',
      'PO-2002',
      'REF-SKIP',
      'USD',
      '1252231000090000001',
      'Cap 24mm',
      '20',
      '5',
      '18',
      'Nos',
      '5000',
    ];

    const parsed = parsePurchaseOrderFlatWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].payload.order_id).toBe('PO-2002');
    expect(parsed.rows[0].payload.form_data.currency).toBeUndefined();
    expect(parsed.rows[0].payload.items[0].quantity).toBe(20);
    expect(parsed.rows[0].payload.items[0].uom).toBeUndefined();
    expect(parsed.rows[0].payload.items[0].taxPercent).toBeUndefined();
  });

  test('purchaseOrderFlatFieldsToItem maps line columns', () => {
    const item = purchaseOrderFlatFieldsToItem({
      itemName: 'Glycerin',
      sku: 'RM-GLY',
      qtyOrdered: '100',
      unitPrice: '140',
      hsnSac: '2905',
      itemTotal: '14000',
    });
    expect(item.productName).toBe('Glycerin');
    expect(item.quantity).toBe(100);
    expect(item.unitPrice).toBe(140);
    expect(item.hsnCode).toBe('2905');
    expect(item.itemTotal).toBe(14000);
  });

  test('normalizeSheetName matches PR rows', () => {
    expect(normalizeSheetName('PR rows')).toBe('pr rows');
  });

  test('findPrRowsWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary');
    const ws = wb.addWorksheet('PR rows');
    expect(findPrRowsWorksheet(wb)).toBe(ws);
  });

  test('findQuotationRowsWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet 1-PR rows');
    const ws = wb.addWorksheet('Sheet 2- Quotation rows');
    expect(findQuotationRowsWorksheet(wb)).toBe(ws);
  });

  test('findRawPoDetailWorksheet finds sheet by name', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet 1-PR rows');
    const ws = wb.addWorksheet('Raw PO Detail (reconcile)');
    expect(findRawPoDetailWorksheet(wb)).toBe(ws);
  });

  test('prRowFieldsToItem maps columns', () => {
    const item = prRowFieldsToItem({
      itemName: 'Cap 24mm',
      sku: 'PM-CAP-24',
      reqQty: '500',
      openQtyRemaining: '300',
      uom: 'Nos',
      moq: '1000',
      plannedPrice: '1.5',
      packSize: '1 pc',
      leadTimeDays: '10',
      hsnSac: '3923',
      category: 'PM',
      zohoProductId: '1252231000001111222',
    });
    expect(item.productName).toBe('Cap 24mm');
    expect(item.quantity).toBe(500);
    expect(item.unitPrice).toBe(1.5);
    expect(item.zohoItemId).toBe('1252231000001111222');
    expect(item.type).toBe('PM');
    expect(item.itemCode).toBe('PM-CAP-24');
  });

  test('parsePrRowsWorkbook parses and groups by EI PO Reference', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PR rows');
    ws.getRow(1).values = [
      null,
      'EI PO Reference',
      'PO Status',
      'Category',
      'Priority',
      'Request Date',
      'Required Date',
      'Item Name',
      'Req Qty',
      'Open Qty (Remaining)',
      'UOM',
      'MOQ',
      'Planned Price (₹)',
      'Pack Size',
      'Lead Time (Days)',
      'Preferred Vendor',
      'Prefferred  Vendor Zoho ID',
      'HSN/SAC',
      'SKU',
      'Product ID (Zoho)',
    ];
    ws.getRow(2).values = [
      null, 'PO-001', 'Open', 'RM', 'High', '2026-05-01', '2026-05-15',
      'Glycerin', '100', '80', 'KG', '25', '150', '25 KG', '12',
      'ABC Chemicals', '1252231000030001000', '2905', 'RM-GLY', '1252231000090000001',
    ];
    ws.getRow(3).values = [
      null, 'PO-001', 'Open', 'RM', 'High', '2026-05-01', '2026-05-15',
      'Niacinamide', '50', '50', 'KG', '10', '320', '25 KG', '9',
      'ABC Chemicals', '1252231000030001000', '2936', 'RM-NIA', '1252231000090000002',
    ];

    const parsed = parsePrRowsWorkbook(wb);
    expect(parsed.rows.length).toBe(2);
    const grouped = groupPrRowsToPoPayloads(parsed.rows);
    expect(grouped.size).toBe(1);
    expect(grouped.get('PO-001').payload.items).toHaveLength(2);
  });

  test('parsePrRowsWorkbook carries forward PO key when repeated rows leave it blank', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PR rows');
    ws.getRow(1).values = [
      null,
      'EI PO Reference',
      'PO Status',
      'Category',
      'Item Name',
      'Req Qty',
      'SKU',
    ];
    ws.getRow(2).values = [null, 'PO-XYZ-01', 'Open', 'RM', 'Glycerin', '100', 'RM-GLY'];
    ws.getRow(3).values = [null, '', 'Open', 'RM', 'Niacinamide', '50', 'RM-NIA'];

    const parsed = parsePrRowsWorkbook(wb);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0].po_key).toBe('PO-XYZ-01');
    expect(parsed.rows[1].po_key).toBe('PO-XYZ-01');
  });

  test('quotationRowFieldsToItem maps quotation columns', () => {
    const item = quotationRowFieldsToItem({
      itemName: 'Glycerin',
      sku: 'RM-GLY',
      hsnSac: '2905',
      uom: 'KG',
      quotedQty: '100',
      unitPrice: '145',
      itemTaxPercent: '18',
      itemTaxAmount: '2610',
      itemTotal: '17110',
      currency: 'INR',
    });
    expect(item.productName).toBe('Glycerin');
    expect(item.quotedQty).toBe(100);
    expect(item.unitPrice).toBe(145);
    expect(item.taxPercent).toBe(18);
    expect(item.currency).toBe('INR');
  });

  test('parseQuotationRowsWorkbook parses quotation rows', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet 2- Quotation rows');
    ws.getRow(1).values = [
      null,
      'EI PO Reference',
      'Vendor',
      'Vendor Zoho ID',
      'Vendor GSTIN',
      'GST Treatment',
      'Item Name',
      'SKU',
      'HSN/SAC',
      'UOM',
      'Quoted Qty',
      'Rate / Unit Price (₹)',
      'Item Tax %',
      'Item Tax Amount',
      'Item Total',
      'Currency',
      'Quotation Date',
      'Validity / Expected Arrival',
      'Payment Terms',
      'Confirmed?',
    ];
    ws.getRow(2).values = [
      null,
      'PO-001',
      'ABC Chemicals',
      '1252231000030001000',
      '27AAAAA0000A1Z5',
      'business_gst',
      'Glycerin',
      'RM-GLY',
      '2905',
      'KG',
      '100',
      '145',
      '18',
      '2610',
      '17110',
      'INR',
      '2026-05-10',
      '2026-05-20',
      'Net 30',
      'Yes',
    ];
    const parsed = parseQuotationRowsWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].po_key).toBe('PO-001');
  });

  test('parseQuotationRowsWorkbook carries forward PO key for continuation rows', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotation rows');
    ws.getRow(1).values = [null, 'EI PO Reference', 'Item Name', 'SKU', 'Quoted Qty'];
    ws.getRow(2).values = [null, 'PO-001', 'Glycerin', 'RM-GLY', '100'];
    ws.getRow(3).values = [null, '', 'Niacinamide', 'RM-NIA', '50'];

    const parsed = parseQuotationRowsWorkbook(wb);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[1].po_key).toBe('PO-001');
  });

  test('applyQuotationRowsToGroupedPos merges quote fields to existing item', () => {
    const grouped = new Map();
    grouped.set('PO-001', {
      excel_rows: [2],
      payload: {
        order_id: 'PO-001',
        vendor_name: 'ABC Chemicals',
        form_data: {},
        items: [{ sku: 'RM-GLY', productName: 'Glycerin', quantity: 100, unitPrice: 150 }],
      },
    });
    const quotationRows = [
      {
        excel_row: 5,
        po_key: 'PO-001',
        fields: {
          vendor: 'ABC Chemicals',
          vendorZohoId: '1252231000030001000',
          vendorGstin: '27AAAAA0000A1Z5',
          gstTreatment: 'business_gst',
          itemName: 'Glycerin',
          sku: 'RM-GLY',
          quotedQty: '100',
          unitPrice: '145',
          itemTaxPercent: '18',
          itemTaxAmount: '2610',
          itemTotal: '17110',
          currency: 'INR',
          quotationDate: '2026-05-10',
          validityExpectedArrival: '2026-05-20',
          paymentTerms: 'Net 30',
          confirmed: 'Yes',
        },
      },
    ];
    applyQuotationRowsToGroupedPos(grouped, quotationRows);
    const po = grouped.get('PO-001').payload;
    expect(po.items[0].unitPrice).toBe(145);
    expect(po.items[0].taxPercent).toBe(18);
    expect(po.form_data.vendorZohoId).toBe('1252231000030001000');
    expect(po.form_data.paymentTerms).toBe('Net 30');
  });

  test('rawPoDetailFieldsToItem maps raw detail columns', () => {
    const item = rawPoDetailFieldsToItem({
      itemName: 'Glycerin',
      sku: 'RM-GLY',
      itemDesc: 'Pharma grade',
      quantityOrdered: '100',
      quantityReceived: '20',
      quantityCancelled: '5',
      quantityBilled: '50',
      usageUnit: 'KG',
      itemPrice: '140',
      itemTaxPercent: '18',
      itemTaxAmount: '2520',
      itemTotal: '16520',
      hsnSac: '2905',
      currencyCode: 'INR',
    });
    expect(item.productName).toBe('Glycerin');
    expect(item.quantityOrdered).toBe(100);
    expect(item.quantityReceived).toBe(20);
    expect(item.unitPrice).toBe(140);
    expect(item.currency).toBe('INR');
  });

  test('parseRawPoDetailWorkbook parses detail rows', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Raw PO Detail (reconcile)');
    ws.getRow(1).values = [
      null,
      'Purchase Order Number',
      'Reference#',
      'Purchase Order Date',
      'Delivery Date',
      'Expected Arrival Date',
      'Vendor Name',
      'GST Identification Number(GSTIN)',
      'GST Treatment',
      'Item Name',
      'SKU',
      'HSN/SAC',
      'Item Desc',
      'QuantityOrdered',
      'QuantityRecieved',
      'QuantityCancelled',
      'QuantityBilled',
      'Usage Unit',
      'Item Price',
      'Item Tax %',
      'Item Tax Amount',
      'Item Total',
      'Total',
      'Currency Code',
      'Payment Terms Label',
    ];
    ws.getRow(2).values = [
      null,
      'PO-Z-001',
      'PO-001',
      '2026-05-01',
      '2026-05-10',
      '2026-05-12',
      'ABC Chemicals',
      '27AAAAA0000A1Z5',
      'business_gst',
      'Glycerin',
      'RM-GLY',
      '2905',
      'Pharma grade',
      '100',
      '20',
      '5',
      '50',
      'KG',
      '140',
      '18',
      '2520',
      '16520',
      '16520',
      'INR',
      'Net 30',
    ];
    const parsed = parseRawPoDetailWorkbook(wb);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].po_key).toBe('PO-Z-001');
  });

  test('parseRawPoDetailWorkbook carries forward PO key for continuation rows', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Raw PO Detail (reconcile)');
    ws.getRow(1).values = [null, 'Reference#', 'Item Name', 'SKU', 'QuantityOrdered'];
    ws.getRow(2).values = [null, 'PO-001', 'Glycerin', 'RM-GLY', '100'];
    ws.getRow(3).values = [null, '', 'Niacinamide', 'RM-NIA', '50'];

    const parsed = parseRawPoDetailWorkbook(wb);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[1].po_key).toBe('PO-001');
  });

  test('applyRawPoDetailsToGroupedPos merges raw detail fields', () => {
    const grouped = new Map();
    grouped.set('PO-001', {
      excel_rows: [2],
      payload: {
        order_id: 'PO-001',
        vendor_name: null,
        order_date: null,
        expected_shipment_date: null,
        payment_terms: null,
        form_data: {},
        items: [{ sku: 'RM-GLY', productName: 'Glycerin', quantity: 100, unitPrice: 150 }],
      },
    });

    const rawRows = [
      {
        excel_row: 9,
        po_key: 'PO-001',
        fields: {
          purchaseOrderNumber: 'PO-Z-001',
          vendorName: 'ABC Chemicals',
          vendorGstin: '27AAAAA0000A1Z5',
          gstTreatment: 'business_gst',
          purchaseOrderDate: '2026-05-01',
          deliveryDate: '2026-05-10',
          expectedArrivalDate: '2026-05-12',
          paymentTermsLabel: 'Net 30',
          currencyCode: 'INR',
          poTotal: '16520',
          itemName: 'Glycerin',
          sku: 'RM-GLY',
          itemDesc: 'Pharma grade',
          quantityOrdered: '100',
          quantityRecieved: '20',
          quantityCancelled: '5',
          quantityBilled: '50',
          usageUnit: 'KG',
          itemPrice: '140',
          itemTaxPercent: '18',
          itemTaxAmount: '2520',
          itemTotal: '16520',
          hsnSac: '2905',
        },
      },
    ];

    applyRawPoDetailsToGroupedPos(grouped, rawRows);
    const po = grouped.get('PO-001').payload;
    expect(po.vendor_name).toBe('ABC Chemicals');
    expect(po.order_date).toBe('2026-05-01');
    expect(po.payment_terms).toBe('Net 30');
    expect(po.items[0].unitPrice).toBe(140);
    expect(po.items[0].quantityOrdered).toBe(100);
    expect(po.form_data.poTotal).toBe(16520);
  });

  test('applyRawPoDetailsToGroupedPos maps Purchase Order Number to Source Po Number', () => {
    const grouped = new Map();
    grouped.set('EI-PO-9001', {
      excel_rows: [2],
      payload: {
        order_id: 'EI-PO-9001',
        reference: 'PO-Z-001',
        vendor_name: null,
        form_data: {
          sourcePoNumber: 'PO-Z-001',
          eiPoReference: 'EI-PO-9001',
        },
        items: [{ sku: 'RM-GLY', productName: 'Glycerin', quantity: 100 }],
      },
    });

    const rawRows = [
      {
        excel_row: 10,
        po_key: 'PO-Z-001',
        fields: {
          purchaseOrderNumber: 'PO-Z-001',
          itemName: 'Glycerin',
          sku: 'RM-GLY',
          itemPrice: '140',
          quantityOrdered: '100',
          paymentTermsLabel: 'Net 30',
        },
      },
    ];

    applyRawPoDetailsToGroupedPos(grouped, rawRows);
    const po = grouped.get('EI-PO-9001').payload;
    expect(po.items[0].unitPrice).toBe(140);
    expect(po.items[0].quantityOrdered).toBe(100);
    expect(po.payment_terms).toBe('Net 30');
  });

  test('enrichItemsWithMaterialLookup maps sku using category', () => {
    const items = [
      {
        sku: 'RM-GLY',
        category: 'RM',
        itemName: 'Glycerin from excel',
      },
      {
        sku: 'PM-CAP-24',
        category: 'PM',
        itemName: 'Cap from excel',
      },
    ];
    const lookup = {
      rmBySku: new Map([
        ['RM-GLY', { id: 11, code: 'RM-0007', name: 'Glycerin USP' }],
      ]),
      pmBySku: new Map([
        ['PM-CAP-24', { id: 22, code: 'PM-0042', name: 'Cap 24mm White' }],
      ]),
    };

    const out = enrichItemsWithMaterialLookup(items, lookup);
    expect(out[0].raw_material_id).toBe(11);
    expect(out[0].itemCode).toBe('RM-0007');
    expect(out[0].itemName).toBe('Glycerin USP');
    expect(out[1].pack_material_id).toBe(22);
    expect(out[1].itemCode).toBe('PM-0042');
    expect(out[1].itemName).toBe('Cap 24mm White');
  });
});

