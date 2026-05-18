const {
  shipAddressFromZoho,
  fulfillmentItemsFromSalesOrderItems,
  computeSoValue,
} = require('../../scripts/lib/zoho-fulfillment-from-sales-order');

describe('zohoFulfillmentFromSalesOrder', () => {
  test('shipAddressFromZoho joins address parts', () => {
    const s = shipAddressFromZoho({
      shipping_address: {
        address: '123 Main',
        city: 'Hyderabad',
        state: 'Telangana',
        zip: '500055',
        country: 'India',
      },
    });
    expect(s).toContain('Hyderabad');
    expect(s).toContain('500055');
  });

  test('fulfillmentItemsFromSalesOrderItems maps qty and price', () => {
    const rows = fulfillmentItemsFromSalesOrderItems([
      { sku: 'FG-001', productName: 'Serum', quantity: 100, unitPrice: 12.5 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderedQty).toBe(100);
    expect(rows[0].unitPrice).toBe(12.5);
  });

  test('computeSoValue sums lines', () => {
    expect(
      computeSoValue([
        { quantity: 10, unitPrice: 5 },
        { quantity: 2, unitPrice: 100 },
      ])
    ).toBe(250);
  });
});
