/**
 * Clears transactional order-management lifecycle data while keeping masters
 * (products, RM/PM, BOMs, vendors, facility structure, users, items_list rates).
 *
 * Wipes: SO → planning → procurement/quotations/PO/GRN → production (BMR/BPR) →
 * fulfillment → MRN/MTR → reservations → WH movement history & rack placements →
 * in-transit / SIH counters on warehouse_inventory.
 */
const db = require('../../db');
const SalesOrder = require('../salesOrders/models');
const PlanningExtracted = require('../planningExtracted/models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const PlanningBomOverride = require('../planningExtracted/planningBomOverrideModel');
const ProcurementRequest = require('../procurementRequests/models');
const ProcurementQuotation = require('../procurementQuotations/models');
const PurchaseOrder = require('../purchaseOrders/models');
const PoTracking = require('../poTracking/models');
const GoodsReceivedNote = require('../grn/models');
const {
  FulfillmentOrder,
  FulfillmentOrderItem,
  FulfillmentBatchSplit,
  FulfillmentInvoice,
  ReservedBatchItem,
} = require('../fulfillment/models');
const { ProductionBatch } = require('../production/models');
const MaterialRequestNote = require('../mrn/models');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const { WarehouseRackItem } = require('../warehouseLocations/models');
const LogisticsSchedule = require('../logisticsSchedules/models');
const UniversalSwapHistory = require('../universalSwap/models');

const CONFIRM_TOKEN = 'RESET_ORDER_MANAGEMENT_LIFECYCLE';

/** @typedef {{ table: string, deleted: number }} DeleteStat */

/**
 * @param {import('sequelize').Transaction | null} t
 * @param {import('sequelize').ModelStatic<any>} Model
 * @param {string} label
 * @returns {Promise<DeleteStat>}
 */
async function destroyAll(Model, label, t) {
  const deleted = await Model.destroy({ where: {}, transaction: t });
  return { table: label, deleted };
}

/**
 * @param {{ dryRun?: boolean; transaction?: import('sequelize').Transaction | null }} [opts]
 */
async function resetOrderLifecycle(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const externalTx = opts.transaction ?? null;
  const t = externalTx || (await db.transaction());
  const ownTx = !externalTx;

  /** @type {DeleteStat[]} */
  const stats = [];

  const run = async () => {
    const steps = [
      [FulfillmentInvoice, 'fulfillment_invoices'],
      [FulfillmentBatchSplit, 'fulfillment_batch_splits'],
      [FulfillmentOrderItem, 'fulfillment_order_items'],
      [FulfillmentOrder, 'fulfillment_orders'],
      [ReservedBatchItem, 'reserved_batch_items'],
      [ProductionBatch, 'production_batches'],
      [ProcurementQuotation, 'procurement_quotations'],
      [ProcurementRequest, 'procurement_requests'],
      [GoodsReceivedNote, 'goods_received_notes'],
      [PoTracking, 'po_tracking'],
      [PurchaseOrder, 'purchase_orders'],
      [PlanningBatch, 'planning_batches'],
      [PlanningBomOverride, 'planning_bom_override'],
      [PlanningExtracted, 'planning_extracted'],
      [SalesOrder, 'sales_orders'],
      [WarehouseInventoryLocationHistory, 'warehouse_inventory_location_history'],
      [MaterialRequestNote, 'material_request_notes'],
      [WarehouseRackItem, 'warehouse_rack_items'],
      [LogisticsSchedule, 'logistics_schedules'],
      [UniversalSwapHistory, 'universal_swap_history'],
    ];

    for (const [Model, label] of steps) {
      if (dryRun) {
        const count = await Model.count({ transaction: t });
        stats.push({ table: label, deleted: count });
      } else {
        stats.push(await destroyAll(Model, label, t));
      }
    }

    if (!dryRun) {
      const { backendNow } = require('../lib/backendTimestamps');
      const now = backendNow();
      const [whUpdated] = await db.query(
        `UPDATE warehouse_inventory
         SET wh_stock = 0,
             ml1_stock = 0,
             ml2_stock = 0,
             stock_in_hand = 0,
             reserved = 0,
             in_transit = 0,
             updated_at = :now`,
        { replacements: { now }, transaction: t }
      );
      stats.push({
        table: 'warehouse_inventory (zeroed counters)',
        deleted: Number(whUpdated) || 0,
      });
    } else {
      const whCount = await WarehouseInventory.count({ transaction: t });
      stats.push({ table: 'warehouse_inventory (rows to zero)', deleted: whCount });
    }
  };

  try {
    await run();
    if (ownTx) {
      if (dryRun) await t.rollback();
      else await t.commit();
    }
  } catch (err) {
    if (ownTx) await t.rollback();
    throw err;
  }

  if (!dryRun && ownTx) {
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
      stats.push({ table: 'warehouse_inventory.in_transit (re-synced)', deleted: 0 });
    } catch (e) {
      console.warn('[reset-order-lifecycle] in-transit re-sync failed:', e?.message || e);
    }
  }

  return { dryRun, stats };
}

module.exports = {
  CONFIRM_TOKEN,
  resetOrderLifecycle,
};
