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

  test('sumScopedPurchaseOrderQtyForKey ignores POs for other PIs (committed only)', () => {
    const allPos = [
      { reference: 'Planning PE-129', form_data: { requestId: '39' }, approval_status: 'approved', items: [{ raw_material_id: 61, quantity: 50 }] },
      { reference: 'Planning PE-999', form_data: {}, approval_status: 'approved', items: [{ raw_material_id: 61, quantity: 200 }] },
    ];
    const sum = sumScopedPurchaseOrderQtyForKey('rm-61', [129], allPos, prPeByRequestId);
    expect(sum).toBe(50);
  });

  test('sumScopedPurchaseOrderQtyForKey excludes un-approved (draft) POs', () => {
    const allPos = [
      { reference: 'Planning PE-129', form_data: { requestId: '39' }, status: 'Draft', approval_status: null, items: [{ raw_material_id: 61, quantity: 50 }] },
      { reference: 'Planning PE-129', form_data: { requestId: '40' }, status: 'Draft', approval_status: 'under_review', items: [{ raw_material_id: 61, quantity: 30 }] },
    ];
    // Neither is committed → 0 counts toward PO Qty.
    expect(sumScopedPurchaseOrderQtyForKey('rm-61', [129], allPos, prPeByRequestId)).toBe(0);
  });

  test('committed PO moves qty from Planned → PO Qty; draft PO stays Planned', () => {
    const releasedQty = 330;
    // Draft (un-approved) PO → still Planned, PO Qty 0.
    const draftFlow = computeItemsInvolvedStageFlow(
      'rm-61', releasedQty, 9, [129],
      [{ reference: 'Planning PE-129', form_data: { requestId: '39' }, status: 'Draft', approval_status: null, items: [{ raw_material_id: 61, quantity: 150 }] }],
      prPeByRequestId, new Map(), new Map()
    );
    expect(draftFlow.plannedQty).toBe(330);
    expect(draftFlow.poQty).toBe(0);

    // Approved PO → 150 moves to PO Qty, remaining 180 stays Planned.
    const approvedFlow = computeItemsInvolvedStageFlow(
      'rm-61', releasedQty, 9, [129],
      [{ reference: 'Planning PE-129', form_data: { requestId: '39' }, approval_status: 'approved', items: [{ raw_material_id: 61, quantity: 150 }] }],
      prPeByRequestId, new Map(), new Map()
    );
    expect(approvedFlow.plannedQty).toBe(180);
    expect(approvedFlow.poQty).toBe(150);
  });

  test('in-transit decrements PO Qty (approved PO 1000, 200 in transit → PO Qty 800)', () => {
    const flow = computeItemsInvolvedStageFlow(
      'rm-61', 1000, 0, [129],
      [{ reference: 'Planning PE-129', form_data: { requestId: '39' }, status: 'Released', approval_status: 'approved', items: [{ raw_material_id: 61, quantity: 1000 }] }],
      prPeByRequestId,
      new Map([['rm-61', 200]]),
      new Map()
    );
    expect(flow.poQty).toBe(800);
    expect(flow.inTransitQty).toBe(200);
  });
});
