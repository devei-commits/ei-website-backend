/**
 * Detect whether a Zoho sales order is already represented locally — used to skip re-import edits.
 */

const db = require('../../db');
const SalesOrder = require('../../src/salesOrders/models');
const { FulfillmentOrder } = require('../../src/fulfillment/models');
const PlanningExtracted = require('../../src/planningExtracted/models');

/**
 * @param {string} zohoId normalized Zoho salesorder_id
 * @param {string} [soNo] local order_id / salesorder_number (e.g. SO-03611)
 * @returns {Promise<{
 *   skip: boolean,
 *   reasons: string[],
 *   salesOrderId: number | null,
 *   fulfillmentOrderId: number | null,
 *   planningRowCount: number,
 * }>}
 */
async function findExistingZohoSalesOrderPresence(zohoId, soNo) {
  const reasons = [];
  let salesOrderId = null;

  if (zohoId) {
    const [byZoho] = await db.query(
      `SELECT id FROM sales_orders WHERE (form_data->>'zohoSalesorderId') = :zid LIMIT 1`,
      { replacements: { zid: zohoId } }
    );
    if (byZoho && byZoho[0] && byZoho[0].id) {
      salesOrderId = Number(byZoho[0].id);
      reasons.push('sales_orders:zohoSalesorderId');
    }
  }

  const orderId = soNo != null ? String(soNo).trim() : '';
  if (orderId) {
    const byOrderId = await SalesOrder.findOne({
      where: { order_id: orderId },
      attributes: ['id'],
    });
    if (byOrderId) {
      const id = Number(byOrderId.id);
      if (!salesOrderId) {
        salesOrderId = id;
        reasons.push('sales_orders:order_id');
      } else if (salesOrderId !== id) {
        reasons.push('sales_orders:order_id_conflict');
      }
    }
  }

  let planningRowCount = 0;
  if (salesOrderId) {
    planningRowCount = await PlanningExtracted.count({
      where: { sales_order_id: salesOrderId },
    });
    if (planningRowCount > 0) reasons.push('planning_extracted');
  }

  let fulfillmentOrderId = null;
  if (salesOrderId) {
    const fo = await FulfillmentOrder.findOne({
      where: { sales_order_id: salesOrderId },
      attributes: ['id'],
    });
    if (fo) {
      fulfillmentOrderId = Number(fo.id);
      reasons.push('fulfillment_orders:sales_order_id');
    }
  }
  if (!fulfillmentOrderId && orderId) {
    const foByNo = await FulfillmentOrder.findOne({
      where: { so_no: orderId },
      attributes: ['id'],
    });
    if (foByNo) {
      fulfillmentOrderId = Number(foByNo.id);
      reasons.push('fulfillment_orders:so_no');
    }
  }

  const skip = reasons.length > 0;
  return { skip, reasons, salesOrderId, fulfillmentOrderId, planningRowCount };
}

module.exports = {
  findExistingZohoSalesOrderPresence,
};
