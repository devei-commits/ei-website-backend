/**
 * POST /api/v1/sales-orders/zoho-import-by-so-no
 *
 * Pull a single sales order from Zoho Books by its SO number and upsert it into
 * `sales_orders` (+ `planning_extracted`), then seed `fulfillment_orders` so it shows
 * up on the Fulfillment page immediately.
 *
 * Shares its import core with scripts/zoho-pull-salesorders-to-sales-orders.js via
 * scripts/lib/zoho-sales-order-upsert.js — this route is the single-SO, on-demand entry
 * point; the script remains the bulk one.
 *
 * Lives outside controller.js because the shared upsert lib requires controller.js
 * (persistSalesOrderWithPlanning); importing it from there would be circular.
 */

const { findSalesordersByNumber, normalizeZohoId } = require('../services/zohoBooks');
const { importZohoSalesOrderRow } = require('../../scripts/lib/zoho-sales-order-upsert');
const { findExistingZohoSalesOrderPresence } = require('../../scripts/lib/zoho-sales-order-existing');
const { baseOrderIdFromZoho } = require('../../scripts/lib/zoho-sales-order-import');

async function importSalesOrderFromZohoBySoNo(req, res) {
  try {
    const b = req.body || {};
    const soNo = String(b.soNo ?? b.so_no ?? b.salesorderNumber ?? b.salesorder_number ?? '').trim();
    // Opt-in refresh of an already-imported SO; default is to refuse with 409.
    const updateExisting = b.updateExisting === true || b.update_existing === true;

    if (!soNo) {
      return res.status(400).json({ error: 'soNo is required', code: 'MISSING_SO_NO' });
    }

    let matches;
    try {
      matches = await findSalesordersByNumber(soNo);
    } catch (e) {
      console.error('importSalesOrderFromZohoBySoNo: Zoho lookup failed', e);
      return res
        .status(502)
        .json({ error: e.message || 'Failed to query Zoho', code: 'ZOHO_LOOKUP_FAILED' });
    }

    if (!matches.length) {
      return res
        .status(404)
        .json({ error: `No Zoho sales order found with number "${soNo}"`, code: 'ZOHO_SO_NOT_FOUND' });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        error: `Multiple Zoho sales orders share number "${soNo}"; resolve in Zoho first`,
        code: 'ZOHO_SO_AMBIGUOUS',
      });
    }

    const listRow = matches[0];
    const zohoId = normalizeZohoId(listRow.salesorder_id);
    if (!zohoId) {
      return res
        .status(502)
        .json({ error: 'Zoho sales order is missing salesorder_id', code: 'ZOHO_SO_NO_ID' });
    }

    const resolvedSoNo = baseOrderIdFromZoho(listRow, zohoId);
    const presence = await findExistingZohoSalesOrderPresence(zohoId, resolvedSoNo);
    if (presence.skip && !updateExisting) {
      return res.status(409).json({
        error: `Sales order "${resolvedSoNo}" is already imported`,
        code: 'SO_ALREADY_IMPORTED',
        reasons: presence.reasons,
        sales_order_id: presence.salesOrderId,
        fulfillment_order_id: presence.fulfillmentOrderId,
        planning_row_count: presence.planningRowCount,
      });
    }

    let result;
    try {
      result = await importZohoSalesOrderRow(listRow, zohoId, {
        createdBy: req.user?.email || req.user?.name || 'Zoho import (UI)',
      });
    } catch (e) {
      // Detail fetch or mapping blew up — surface Zoho failures distinctly from DB ones.
      console.error('importSalesOrderFromZohoBySoNo: import failed', e);
      const isZoho = e && (e.zohoRaw != null || e.statusCode != null);
      return res.status(isZoho ? 502 : 500).json({
        error: e.message || 'Failed to import sales order from Zoho',
        code: isZoho ? 'ZOHO_IMPORT_FAILED' : 'SO_IMPORT_FAILED',
      });
    }

    const salesOrder = result.salesOrder;
    const plain = salesOrder && salesOrder.get ? salesOrder.get({ plain: true }) : salesOrder;

    return res.status(result.action === 'create' ? 201 : 200).json({
      imported: true,
      source: 'zoho',
      action: result.action,
      so_no: plain ? plain.order_id : resolvedSoNo,
      sales_order_id: plain ? plain.id : null,
      zoho_salesorder_id: zohoId,
      fulfillment_order_id: result.fulfillment?.id ?? null,
      fulfillment_action: result.fulfillment?.action ?? null,
      client_matched: result.clientFound,
      // Lines whose SKU has no product master — imported, but planning may be incomplete.
      unmatched_lines: result.unmatched,
    });
  } catch (err) {
    console.error('importSalesOrderFromZohoBySoNo error', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to import sales order from Zoho' });
  }
}

module.exports = { importSalesOrderFromZohoBySoNo };
