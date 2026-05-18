/**
 * Create or update fulfillment_orders (+ items + default batch split) from an imported sales_orders row.
 */

const {
  FulfillmentOrder,
  FulfillmentOrderItem,
  FulfillmentBatchSplit,
} = require('../../src/fulfillment/models');

function shipAddressFromZoho(zohoRow) {
  const addr = zohoRow?.shipping_address || zohoRow?.delivery_address;
  if (!addr || typeof addr !== 'object') return null;
  const parts = [
    addr.address,
    addr.address1,
    addr.address2,
    addr.street2,
    addr.city,
    addr.state,
    addr.zip,
    addr.country,
  ]
    .map((p) => (p != null ? String(p).trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function customerCityFromZoho(zohoRow) {
  const addr = zohoRow?.shipping_address || zohoRow?.delivery_address || zohoRow?.billing_address;
  if (addr && typeof addr === 'object' && addr.city) return String(addr.city).trim() || null;
  return null;
}

function computeSoValue(items) {
  return (items || []).reduce((sum, it) => {
    const qty = Number(it.quantity) || 0;
    const rate = Number(it.unitPrice ?? it.rate) || 0;
    return sum + qty * rate;
  }, 0);
}

function fulfillmentItemsFromSalesOrderItems(items) {
  return (Array.isArray(items) ? items : []).map((it, idx) => {
    const orderedQty = Math.round(Number(it.quantity) || 0);
    const unitPrice = Number(it.unitPrice ?? it.rate) || 0;
    return {
      itemNo: String(idx + 1).padStart(3, '0'),
      sku: String(it.sku || it.itemCode || '').trim() || null,
      productName: String(it.productName || it.itemName || it.name || 'Line item').trim(),
      pack: String(it.pack || '').trim() || null,
      orderedQty,
      unitPrice,
    };
  });
}

/**
 * @param {*} salesOrderRow Sequelize instance or plain with id, order_id, customer_name, etc.
 * @param {Record<string, unknown>} payload sales_orders payload used on import
 * @param {Record<string, unknown>} [zohoRow] optional Zoho detail for address / courier
 * @param {{ dryRun?: boolean }} opts
 */
async function ensureFulfillmentOrderFromImportedSalesOrder(salesOrderRow, payload, zohoRow = {}, opts = {}) {
  if (String(process.env.ZOHO_SO_IMPORT_SEED_FULFILLMENT || '1').trim() === '0') {
    return { action: 'skip', reason: 'disabled' };
  }

  const plain = salesOrderRow.get ? salesOrderRow.get({ plain: true }) : salesOrderRow;
  const salesOrderId = Number(plain.id);
  if (!Number.isFinite(salesOrderId) || salesOrderId <= 0) {
    return { action: 'skip', reason: 'no_sales_order_id' };
  }

  const soNo = String(plain.order_id || payload.order_id || '').trim();
  if (!soNo) return { action: 'skip', reason: 'no_so_no' };

  const customer = String(plain.customer_name || payload.customer_name || '').trim();
  if (!customer) return { action: 'skip', reason: 'no_customer' };

  const items = fulfillmentItemsFromSalesOrderItems(payload.items || plain.items);
  const soValue = computeSoValue(items);
  const shipAddress = shipAddressFromZoho(zohoRow) || null;
  const customerCity = customerCityFromZoho(zohoRow);
  const deliveryMethod =
    zohoRow.delivery_method != null ? String(zohoRow.delivery_method).trim() : '';
  const notesParts = ['Imported from Zoho Books'];
  if (deliveryMethod) notesParts.push(`Delivery: ${deliveryMethod}`);
  const notes = notesParts.join(' · ');

  let existing = await FulfillmentOrder.findOne({ where: { sales_order_id: salesOrderId } });
  if (!existing) {
    existing = await FulfillmentOrder.findOne({ where: { so_no: soNo } });
  }

  const header = {
    so_no: soNo,
    sales_order_id: salesOrderId,
    customer_name: customer,
    customer_city: customerCity,
    order_date: plain.order_date || payload.order_date || null,
    due_date: plain.expected_shipment_date || payload.expected_shipment_date || null,
    priority: 'normal',
    so_status: 'planned',
    so_value: soValue,
    ship_address: shipAddress,
    payment_terms: plain.payment_terms || payload.payment_terms || null,
    notes,
  };

  if (opts.dryRun) {
    return { action: existing ? 'update' : 'create', dryRun: true, soNo };
  }

  if (existing) {
    await existing.update(header);
    const rebuilt = await syncFulfillmentLineItems(existing.id, items, {
      forceRebuild: !!opts.forceRebuild,
    });
    return {
      action: 'update',
      fulfillmentOrderId: existing.id,
      soNo,
      itemsRebuilt: rebuilt,
    };
  }

  const order = await FulfillmentOrder.create(header);
  await createFulfillmentLineItems(order.id, items);

  return { action: 'create', fulfillmentOrderId: order.id, soNo };
}

/**
 * Insert or refresh fulfillment lines from imported SO items.
 * Skips destructive rebuild when any split is linked to production.
 * @param {number} fulfillmentOrderId
 * @param {ReturnType<typeof fulfillmentItemsFromSalesOrderItems>} items
 * @param {{ forceRebuild?: boolean }} opts
 */
async function syncFulfillmentLineItems(fulfillmentOrderId, items, opts = {}) {
  const existingItems = await FulfillmentOrderItem.findAll({
    where: { fulfillment_order_id: fulfillmentOrderId },
    include: [{ model: FulfillmentBatchSplit, as: 'batchSplits' }],
  });

  if (existingItems.length === 0) {
    await createFulfillmentLineItems(fulfillmentOrderId, items);
    return true;
  }

  const forceRebuild =
    opts.forceRebuild ||
    String(process.env.ZOHO_SO_IMPORT_FULFILLMENT_REBUILD_ITEMS || '').trim() === '1';
  if (!forceRebuild) return false;

  const hasProductionLink = existingItems.some((row) => {
    const d = row.get ? row.get({ plain: true }) : row;
    return (d.batchSplits || []).some((s) => s.production_batch_id != null);
  });
  if (hasProductionLink) return false;

  for (const row of existingItems) {
    await FulfillmentBatchSplit.destroy({ where: { fulfillment_order_item_id: row.id } });
    await row.destroy();
  }
  await createFulfillmentLineItems(fulfillmentOrderId, items);
  return true;
}

/**
 * @param {number} fulfillmentOrderId
 * @param {ReturnType<typeof fulfillmentItemsFromSalesOrderItems>} items
 */
async function createFulfillmentLineItems(fulfillmentOrderId, items) {
  for (const item of items) {
    const orderItem = await FulfillmentOrderItem.create({
      fulfillment_order_id: fulfillmentOrderId,
      item_no: item.itemNo,
      sku: item.sku,
      product_name: item.productName,
      pack: item.pack,
      ordered_qty: item.orderedQty,
      rate: item.unitPrice,
      unit_price: item.unitPrice,
    });

    await FulfillmentBatchSplit.create({
      fulfillment_order_item_id: orderItem.id,
      fulfillment_order_id: fulfillmentOrderId,
      production_batch_id: null,
      bmr_no: null,
      bpr_no: null,
      planned_qty: item.orderedQty,
      fg_qty: 0,
      ff_status: 'fg_pending',
    });
  }
}

module.exports = {
  ensureFulfillmentOrderFromImportedSalesOrder,
  syncFulfillmentLineItems,
  createFulfillmentLineItems,
  shipAddressFromZoho,
  fulfillmentItemsFromSalesOrderItems,
  computeSoValue,
};
