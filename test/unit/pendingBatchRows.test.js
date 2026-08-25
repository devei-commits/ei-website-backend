/**
 * Products & Batches is built from fulfillment_batch_splits, so a newly created sales order showed
 * nothing there — its items exist but planning has not cut a batch yet. These synthesise a row per
 * such line so the order is visible with "Batch creation pending".
 */
const { buildPendingBatchRows, PENDING_STAGE, PENDING_STAGE_LABEL } = require('../../src/fulfillment/pendingBatchRows');

const orderMap = {
  7: {
    id: 7, so_no: 'SO-00110', order_date: '2026-05-01', due_date: '2026-05-12',
    priority: 'High', so_status: 'planned', commercial_status: 'draft',
    customer_name: 'MED MANOR ORGANICS PVT LTD..', vendor_client_id: 3,
  },
};
const clientsById = new Map([[3, { code: 'EI-CLI-00127', city: 'Pune' }]]);
const item = (over = {}) => ({
  id: 11, fulfillment_order_id: 7, sku: 'PR0004405', product_code: 'PR0004405',
  product_name: 'MOISTAR DEEP RESTORE LOTION-25ML', pack: '25 ML', ordered_qty: 10000, unit_price: 17.5,
  ...over,
});

const build = (items, withSplits = []) =>
  buildPendingBatchRows({ items, itemIdsWithSplits: withSplits, orderMap, clientsById });

describe('buildPendingBatchRows', () => {
  it('creates a row for an order line that has no batch', () => {
    const [row] = build([item()]);
    expect(row.soNo).toBe('SO-00110');
    expect(row.product.name).toBe('MOISTAR DEEP RESTORE LOTION-25ML');
    expect(row.product.orderedQty).toBe(10000);
    expect(row.batch.stage).toBe(PENDING_STAGE);
    expect(row.batch.stageLabel).toBe(PENDING_STAGE_LABEL);
    expect(row.batch.batchNo).toBe('');
    expect(row.pendingBatch).toBe(true);
  });

  it('skips a line that already has a batch — no duplicate against the real row', () => {
    expect(build([item()], [11])).toEqual([]);
    expect(build([item()], new Set([11]))).toEqual([]);
  });

  it('carries the client code so the row groups with its client', () => {
    const [row] = build([item()]);
    expect(row.client).toMatchObject({ name: 'MED MANOR ORGANICS PVT LTD..', code: 'EI-CLI-00127', city: 'Pune' });
  });

  it('reports zero progress — nothing is made, packed or shipped yet', () => {
    const [row] = build([item()]);
    expect([row.fgQty, row.pickedQty, row.packedQty, row.invoicedQty, row.shippedQty]).toEqual([0, 0, 0, 0, 0]);
    expect(row.batch.plannedQty).toBe(0);
    expect(row.batch.coveragePct).toBe(0);
  });

  it('never flags a pending line as SLA-overdue — no stage clock has started', () => {
    const [row] = build([item()]);
    expect(row.slaFlag).toEqual({ overdue: false, approaching: false, daysOverdue: 0 });
  });

  it('uses a negative id so it cannot collide with a real split id', () => {
    expect(build([item()])[0].id).toBe(-11);
  });

  it('drops an item whose order is not in scope rather than emitting an orphan', () => {
    expect(build([item({ fulfillment_order_id: 999 })])).toEqual([]);
  });

  it('falls back to sku when the line has no product code', () => {
    const [row] = build([item({ product_code: null })]);
    expect(row.product.code).toBe('PR0004405');
  });

  it('handles an empty or missing item list', () => {
    expect(build([])).toEqual([]);
    expect(buildPendingBatchRows({ items: undefined, itemIdsWithSplits: [], orderMap, clientsById })).toEqual([]);
  });
});
