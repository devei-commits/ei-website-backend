const { computeThreeWayMatch } = require('../../src/purchaseOrders/threeWayMatch');

const PO_ITEMS = [
  { itemCode: 'RM1', itemName: 'Alpha', quantity: '100', rate: '25', tax: '18' },
  { itemCode: 'RM2', itemName: 'Beta', quantity: '50', rate: '40', tax: '18' },
];
const grn = (lines) => [{ line_items: lines }];

describe('computeThreeWayMatch', () => {
  test('full receipt + exact invoice → pass', () => {
    const r = computeThreeWayMatch({
      poItems: PO_ITEMS,
      grnRows: grn([
        { itemCode: 'RM1', rcvdQty: 100, invoiceQty: 100, unitPrice: 25 },
        { itemCode: 'RM2', rcvdQty: 50, invoiceQty: 50, unitPrice: 40 },
      ]),
      invoiceAmount: 5310, // (100*25 + 50*40) * 1.18
    });
    expect(r.verdict).toBe('pass');
    expect(r.totals.receivedPayable).toBe(5310);
    expect(r.totals.amountVariancePct).toBe(0);
    expect(r.lines.every((l) => l.matched)).toBe(true);
  });

  test('no invoice → awaiting_invoice', () => {
    const r = computeThreeWayMatch({ poItems: PO_ITEMS, grnRows: grn([{ itemCode: 'RM1', rcvdQty: 100, unitPrice: 25 }]), invoiceAmount: null });
    expect(r.verdict).toBe('awaiting_invoice');
  });

  test('short receipt → variance + short_received line + recomputed payable', () => {
    const r = computeThreeWayMatch({
      poItems: PO_ITEMS,
      grnRows: grn([
        { itemCode: 'RM1', rcvdQty: 95, invoiceQty: 95, unitPrice: 25 },
        { itemCode: 'RM2', rcvdQty: 50, invoiceQty: 50, unitPrice: 40 },
      ]),
      invoiceAmount: 5310,
    });
    expect(r.verdict).toBe('variance');
    expect(r.lines[0].verdict).toBe('short_received');
    expect(r.totals.receivedPayable).toBe(5162.5); // (95*25 + 50*40)*1.18
    expect(r.totals.amountOk).toBe(false);
  });

  test('invoice amount over tolerance → variance', () => {
    const r = computeThreeWayMatch({
      poItems: PO_ITEMS,
      grnRows: grn([
        { itemCode: 'RM1', rcvdQty: 100, invoiceQty: 100, unitPrice: 25 },
        { itemCode: 'RM2', rcvdQty: 50, invoiceQty: 50, unitPrice: 40 },
      ]),
      invoiceAmount: 6000,
    });
    expect(r.verdict).toBe('variance');
    expect(r.totals.amountVariancePct).toBeCloseTo(12.99, 1);
  });

  test('billed qty exceeds received → over_billed line', () => {
    const r = computeThreeWayMatch({
      poItems: PO_ITEMS,
      grnRows: grn([
        { itemCode: 'RM1', rcvdQty: 100, invoiceQty: 110, unitPrice: 25 },
        { itemCode: 'RM2', rcvdQty: 50, invoiceQty: 50, unitPrice: 40 },
      ]),
      invoiceAmount: 5310,
    });
    expect(r.lines[0].verdict).toBe('over_billed');
    expect(r.verdict).toBe('variance');
  });

  test('amount within ±2% tolerance → pass', () => {
    const r = computeThreeWayMatch({
      poItems: PO_ITEMS,
      grnRows: grn([
        { itemCode: 'RM1', rcvdQty: 100, invoiceQty: 100, unitPrice: 25 },
        { itemCode: 'RM2', rcvdQty: 50, invoiceQty: 50, unitPrice: 40 },
      ]),
      invoiceAmount: 5400, // +1.7%
    });
    expect(r.verdict).toBe('pass');
    expect(r.totals.amountOk).toBe(true);
  });

  test('GRN receipt with no matching PO line → unexpected line', () => {
    const r = computeThreeWayMatch({
      poItems: PO_ITEMS,
      grnRows: grn([
        { itemCode: 'RM1', rcvdQty: 100, invoiceQty: 100, unitPrice: 25 },
        { itemCode: 'RM2', rcvdQty: 50, invoiceQty: 50, unitPrice: 40 },
        { itemCode: 'RMX', rcvdQty: 5, invoiceQty: 5, unitPrice: 10 },
      ]),
      invoiceAmount: 5310,
    });
    const extra = r.lines.find((l) => l.code === 'rmx');
    expect(extra).toBeTruthy();
    expect(extra.verdict).toBe('unexpected');
    expect(r.verdict).toBe('variance');
  });
});
