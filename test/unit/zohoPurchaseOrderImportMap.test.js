const {
  mapZohoPoStatus,
  skuLooksLikePackaging,
  buildFormDataFromZoho,
  baseOrderIdFromZoho,
} = require('../../scripts/lib/zoho-purchase-order-import');

describe('zohoPurchaseOrderImportMap', () => {
  test('mapZohoPoStatus maps issued to Released', () => {
    expect(mapZohoPoStatus('issued')).toBe('Released');
    expect(mapZohoPoStatus('draft')).toBe('Draft');
    expect(mapZohoPoStatus('void')).toBe('Cancelled');
  });

  test('skuLooksLikePackaging detects PM sku prefixes', () => {
    expect(skuLooksLikePackaging('5M00524')).toBe(true);
    expect(skuLooksLikePackaging('5L00874')).toBe(true);
    expect(skuLooksLikePackaging('1000016')).toBe(false);
  });

  test('buildFormDataFromZoho sets vendor and approval for released', () => {
    const fd = buildFormDataFromZoho(
      {
        purchaseorder_number: 'EI/PO/26-03/2648',
        date: '2026-03-31',
        vendor_name: 'KRIYA INDUSTRIES',
        status: 'issued',
        custom_field_hash: { cf_source: 'VISPAC' },
      },
      '1252231000040470696',
      { vendorClient: { id: 42, entity_code: 'EI-VEN-00099' } }
    );
    expect(fd.zohoPurchaseOrderId).toBe('1252231000040470696');
    expect(fd.vendorClientId).toBe(42);
    expect(fd.vendorEntityCode).toBe('EI-VEN-00099');
    expect(fd.procurementApprovalStatus).toBe('approved');
    expect(fd.cfSource).toBe('VISPAC');
  });

  test('baseOrderIdFromZoho prefers purchaseorder_number', () => {
    expect(
      baseOrderIdFromZoho({ purchaseorder_number: 'EI/PO/26-03/2648' }, '999')
    ).toBe('EI/PO/26-03/2648');
    expect(baseOrderIdFromZoho({}, '999')).toBe('ZOHO-PO-999');
  });
});
