const {
  mapZohoSoStatus,
  buildFormDataFromZoho,
  buildOrderStatusFromZoho,
  baseOrderIdFromZoho,
  customFieldFromZoho,
} = require('../../scripts/lib/zoho-sales-order-import');

describe('zohoSalesOrderImportMap', () => {
  test('mapZohoSoStatus maps draft and pending_approval to Draft', () => {
    expect(mapZohoSoStatus('draft', 'pending_approval')).toBe('Draft');
    expect(mapZohoSoStatus('confirmed')).toBe('Approved');
    expect(mapZohoSoStatus('void')).toBe('Cancelled');
  });

  test('buildFormDataFromZoho links client and retainer custom field', () => {
    const fd = buildFormDataFromZoho(
      {
        salesorder_number: 'SO-03611',
        date: '2026-04-14',
        customer_name: 'EL CLINICAL HEALTHCARE PRIVATE LIMITED',
        customer_id: '1252231000024420003',
        status: 'draft',
        order_status: 'pending_approval',
        delivery_method: 'BLUEDART',
        cf_retainer_invoice_number: 'RET-01107',
        reference_number: 'EI/PI/07-04/1359',
        shipment_date: '2026-06-15',
      },
      '1252231000040833074',
      { client: { id: 99, entity_code: 'EI-CLI-00012' } }
    );
    expect(fd.zohoSalesorderId).toBe('1252231000040833074');
    expect(fd.vendorClientId).toBe(99);
    expect(fd.clientEntityCode).toBe('EI-CLI-00012');
    expect(fd.deliveryMethod).toBe('BLUEDART');
    expect(fd.cfRetainerInvoiceNumber).toBe('RET-01107');
    expect(fd.reference).toBe('EI/PI/07-04/1359');
    expect(fd.expectedShipmentDate).toBe('2026-06-15');
  });

  test('buildOrderStatusFromZoho captures fulfillment fields', () => {
    const os = buildOrderStatusFromZoho({
      status: 'draft',
      order_status: 'pending_approval',
      invoiced_status: 'not_invoiced',
      paid_status: 'unpaid',
      shipped_status: 'pending',
      delivery_method: 'BLUEDART',
      quantity: 3000,
    });
    expect(os.deliveryMethod).toBe('BLUEDART');
    expect(os.currentSubStatus).toBe('');
    expect(os.quantity).toBe(3000);
  });

  test('baseOrderIdFromZoho prefers salesorder_number', () => {
    expect(baseOrderIdFromZoho({ salesorder_number: 'SO-03611' }, '999')).toBe('SO-03611');
  });

  test('customFieldFromZoho reads hash and top-level cf_*', () => {
    expect(
      customFieldFromZoho(
        { custom_field_hash: { cf_retainer_invoice_number: 'RET-01107' } },
        'cf_retainer_invoice_number'
      )
    ).toBe('RET-01107');
    expect(
      customFieldFromZoho({ cf_retainer_invoice_number_unformatted: 'RET-99' }, 'cf_retainer_invoice_number')
    ).toBe('RET-99');
  });
});
