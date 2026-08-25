/**
 * Order lines that have no batch split yet — "batch creation pending".
 *
 * The Products & Batches view is built from `fulfillment_batch_splits`, so a freshly created sales
 * order showed nothing at all: its items exist, but planning has not yet cut a batch for them. That
 * made new orders invisible on the very screen used to track them into production.
 *
 * These rows carry the order + product exactly as a real row does, with zero quantities and a
 * `batch.stage` of 'PENDING', so the UI can render them in place with an empty Batch cell.
 */
'use strict';

const PENDING_STAGE = 'PENDING';
const PENDING_STAGE_LABEL = 'Batch creation pending';

/**
 * Build one synthetic row per order item that has no split.
 *
 * @param {object} args
 * @param {Array} args.items        candidate order items (already scoped to the matching orders)
 * @param {Set|Array} args.itemIdsWithSplits ids that DO have a split — those are skipped
 * @param {object} args.orderMap    fulfillment order id -> plain order row
 * @param {Map} args.clientsById    vendor client id -> { code, city }
 */
function buildPendingBatchRows({ items, itemIdsWithSplits, orderMap, clientsById }) {
  const withSplits = itemIdsWithSplits instanceof Set ? itemIdsWithSplits : new Set(itemIdsWithSplits || []);
  const rows = [];
  for (const raw of items || []) {
    const it = raw && raw.get ? raw.get({ plain: true }) : raw;
    if (!it) continue;
    if (withSplits.has(it.id)) continue;
    const order = orderMap ? orderMap[it.fulfillment_order_id] : null;
    if (!order) continue;
    const client = clientsById ? clientsById.get(order.vendor_client_id) : null;
    const orderedQty = Number(it.ordered_qty) || 0;
    rows.push({
      // Negative id keeps these distinct from real split ids and makes them obviously synthetic.
      id: -it.id,
      soId: order.id,
      soNo: order.so_no,
      soDate: order.order_date || null,
      dueDate: order.due_date || null,
      priority: order.priority || 'Normal',
      soStatus: order.so_status || '',
      commercialStatus: order.commercial_status || '',
      client: {
        name: order.customer_name || '',
        code: client ? client.code || null : null,
        city: client ? client.city || '' : '',
        id: order.vendor_client_id || null,
      },
      product: {
        name: it.product_name || '',
        code: it.product_code || it.sku || '',
        pack: it.pack || '',
        orderedQty,
        unitPrice: Number(it.unit_price) || 0,
      },
      batch: {
        batchNo: '',
        bprNo: '',
        bmrNo: '',
        plannedQty: 0,
        coveragePct: 0,
        stage: PENDING_STAGE,
        stageLabel: PENDING_STAGE_LABEL,
        fgLocation: null,
      },
      ffStatus: '',
      fgQty: 0,
      pickedQty: 0,
      packedQty: 0,
      invoicedQty: 0,
      shippedQty: 0,
      pickerName: null,
      pickDate: null,
      invoiceNo: null,
      awbNo: null,
      courier: null,
      dispatchDate: null,
      etaDate: null,
      deliveryDate: null,
      stageLogs: [],
      // No batch exists, so no stage clock has started — never flag these as overdue.
      slaFlag: { overdue: false, approaching: false, daysOverdue: 0 },
      commentCount: 0,
      pendingBatch: true,
    });
  }
  return rows;
}

module.exports = { buildPendingBatchRows, PENDING_STAGE, PENDING_STAGE_LABEL };
