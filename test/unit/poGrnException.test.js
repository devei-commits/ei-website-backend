const { computeState, detectQcFail } = require('../../src/purchaseOrders/grnExceptionController');

const poStub = (map) => ({ get: (k) => map[k] });
const items = [{ itemCode: 'RM1', quantity: 100, rate: 10, tax: 0 }, { itemCode: 'RM2', quantity: 50, rate: 20, tax: 0 }];
const completeGrn = (lines, qc) => [{ status: 'GRN Complete', qc_status: qc || 'Passed', line_items: lines }];

describe('GRN-stage exception computeState', () => {
  test('full receipt, QC passed → no partial, no qc-fail, can raise RTV but not short-close', () => {
    const s = computeState(
      poStub({ id: 1, items, exception_status: null }),
      null,
      completeGrn([{ itemCode: 'RM1', rcvdQty: 100 }, { itemCode: 'RM2', rcvdQty: 50 }], 'Passed'),
    );
    expect(s.partialReceipt).toBe(false);
    expect(s.qcFailed).toBe(false);
    expect(s.canShortClose).toBe(false);
    expect(s.canRaiseRtv).toBe(true);
  });

  test('partial receipt → partialReceipt + balance + canShortClose', () => {
    const s = computeState(
      poStub({ id: 1, items, exception_status: null }),
      null,
      completeGrn([{ itemCode: 'RM1', rcvdQty: 95 }, { itemCode: 'RM2', rcvdQty: 50 }], 'Passed'),
    );
    expect(s.partialReceipt).toBe(true);
    expect(s.partialLines).toHaveLength(1);
    expect(s.partialLines[0].balanceQty).toBe(5);
    expect(s.canShortClose).toBe(true);
  });

  test('QC rejected on header → qcFailed', () => {
    const s = computeState(poStub({ id: 1, items, exception_status: null }), null, completeGrn([{ itemCode: 'RM1', rcvdQty: 100 }], 'Rejected'));
    expect(s.qcFailed).toBe(true);
  });

  test('QC rejected on a line → qcFailed', () => {
    expect(detectQcFail([{ qc_status: 'Passed', line_items: [{ itemCode: 'RM1', qcStatus: 'Rejected' }] }])).toBe(true);
    expect(detectQcFail([{ qc_status: 'Passed', line_items: [{ itemCode: 'RM1', qcStatus: 'Passed' }] }])).toBe(false);
  });

  test('already short-closed → cannot short-close again', () => {
    const s = computeState(
      poStub({ id: 1, items, exception_status: null, short_closed_at: new Date() }),
      null,
      completeGrn([{ itemCode: 'RM1', rcvdQty: 95 }, { itemCode: 'RM2', rcvdQty: 50 }], 'Passed'),
    );
    expect(s.shortClosed).toBe(true);
    expect(s.canShortClose).toBe(false);
  });

  test('RTV raised → cannot raise again, can resolve', () => {
    const s = computeState(
      poStub({ id: 1, items, exception_status: null, rtv_status: 'raised' }),
      null,
      completeGrn([{ itemCode: 'RM1', rcvdQty: 100 }, { itemCode: 'RM2', rcvdQty: 50 }], 'Rejected'),
    );
    expect(s.rtvRaised).toBe(true);
    expect(s.canRaiseRtv).toBe(false);
    expect(s.canResolveRtv).toBe(true);
  });

  test('GRN not complete → no partial / no short-close / no RTV', () => {
    const s = computeState(
      poStub({ id: 1, items, exception_status: null }),
      null,
      [{ status: 'Under GRN', qc_status: 'Under test', line_items: [{ itemCode: 'RM1', rcvdQty: 90 }] }],
    );
    expect(s.grnComplete).toBe(false);
    expect(s.partialReceipt).toBe(false);
    expect(s.canShortClose).toBe(false);
    expect(s.canRaiseRtv).toBe(false);
  });

  test('cancelled PO → no short-close / no RTV', () => {
    const s = computeState(
      poStub({ id: 1, items, exception_status: 'cancelled' }),
      null,
      completeGrn([{ itemCode: 'RM1', rcvdQty: 95 }, { itemCode: 'RM2', rcvdQty: 50 }], 'Rejected'),
    );
    expect(s.canShortClose).toBe(false);
    expect(s.canRaiseRtv).toBe(false);
  });
});
