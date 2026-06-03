const {
  buildPrPlanningExtractedIdByRequestId,
  purchaseOrderMatchesPlanningExtractedIds,
  sumScopedPurchaseOrderQtyForKey,
  computeItemsInvolvedStageFlow,
} = require('../../src/lib/itemsInvolvedStageFlow');

describe('itemsInvolvedStageFlow', () => {
  const prPeByRequestId = buildPrPlanningExtractedIdByRequestId([
    { id: 39, planning_extracted_id: 129 },
    { id: 40, planning_extracted_id: 129 },
  ]);

  test('purchaseOrderMatchesPlanningExtractedIds via form_data.requestId', () => {
    const po = {
      reference: 'PR-REQ-039',
      form_data: { requestId: '39' },
      items: [{ raw_material_id: 61, quantity: 50 }],
    };
    expect(purchaseOrderMatchesPlanningExtractedIds(po, new Set([129]), prPeByRequestId)).toBe(true);
    expect(purchaseOrderMatchesPlanningExtractedIds(po, new Set([999]), prPeByRequestId)).toBe(false);
  });

  test('purchaseOrderMatchesPlanningExtractedIds via Planning PE reference', () => {
    const po = { reference: 'Planning PE-129', form_data: {}, items: [] };
    expect(purchaseOrderMatchesPlanningExtractedIds(po, new Set([129]), prPeByRequestId)).toBe(true);
  });

  test('sumScopedPurchaseOrderQtyForKey ignores POs for other PIs', () => {
    const allPos = [
      { reference: 'Planning PE-129', form_data: { requestId: '39' }, items: [{ raw_material_id: 61, quantity: 50 }] },
      { reference: 'Planning PE-999', form_data: {}, items: [{ raw_material_id: 61, quantity: 200 }] },
    ];
    const sum = sumScopedPurchaseOrderQtyForKey('rm-61', [129], allPos, prPeByRequestId);
    expect(sum).toBe(50);
  });

  test('computeItemsInvolvedStageFlow sets plannedQty when PR qty exceeds scoped PO', () => {
    const flow = computeItemsInvolvedStageFlow(
      'rm-61',
      330,
      9,
      [129],
      [
        { reference: 'Planning PE-129', form_data: { requestId: '39' }, items: [{ raw_material_id: 61, quantity: 150 }] },
      ],
      prPeByRequestId,
      new Map(),
      new Map()
    );
    expect(flow.plannedQty).toBe(180);
    expect(flow.poQty).toBe(150);
  });
});
