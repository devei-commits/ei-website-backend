/**
 * Clears transactional order-management lifecycle data while keeping masters
 * (products, RM/PM, BOMs, vendors, facility structure, users, items_list rates).
 *
 * Wipes every order pipeline (including soft-deleted rows):
 * B2B SO → planning → procurement/quotations/PO/GRN → production (BMR/BPR) →
 * fulfillment → MRN/MTR → reservations → website orders/payments → client hub
 * orders → WH movement history & rack placements → in-transit / SIH counters.
 */
const db = require('../../db');
const SalesOrder = require('../salesOrders/models');
const PlanningExtracted = require('../planningExtracted/models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const PlanningBomOverride = require('../planningExtracted/planningBomOverrideModel');
const PlanningQuotationAsk = require('../planningQuotationAsks/models');
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
const { Order, OrderItem } = require('../orders/models');
const { Payment } = require('../payments/models');
const { ClientOrder } = require('../clientHub/models');

const CONFIRM_TOKEN = 'RESET_ORDER_MANAGEMENT_LIFECYCLE';

/** @typedef {{ table: string, deleted: number }} DeleteStat */

/**
 * Hard-delete every row in a table, including soft-deleted (defaultScope hides those).
 * @param {import('sequelize').ModelStatic<any>} Model
 */
function unscopedModel(Model) {
  return typeof Model.unscoped === 'function' ? Model.unscoped() : Model;
}

/**
 * @param {import('sequelize').ModelStatic<any>} Model
 * @param {string} label
 * @param {import('sequelize').Transaction | null} t
 * @returns {Promise<DeleteStat>}
 */
async function hardDestroyAll(Model, label, t) {
  const deleted = await unscopedModel(Model).destroy({ where: {}, transaction: t });
  return { table: label, deleted };
}

/**
 * @param {import('sequelize').ModelStatic<any>} Model
 * @param {import('sequelize').Transaction | null} t
 */
async function hardCountAll(Model, t) {
  return unscopedModel(Model).count({ transaction: t });
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
      [PlanningQuotationAsk, 'planning_quotation_asks'],
      [PlanningExtracted, 'planning_extracted'],
      [SalesOrder, 'sales_orders'],
      [WarehouseInventoryLocationHistory, 'warehouse_inventory_location_history'],
      [MaterialRequestNote, 'material_request_notes'],
      [WarehouseRackItem, 'warehouse_rack_items'],
      [LogisticsSchedule, 'logistics_schedules'],
      [UniversalSwapHistory, 'universal_swap_history'],
      [Payment, 'payments'],
      [OrderItem, 'order_items'],
      [Order, 'orders'],
      [ClientOrder, 'client_orders'],
    ];

    for (const [Model, label] of steps) {
      if (dryRun) {
        const count = await hardCountAll(Model, t);
        stats.push({ table: label, deleted: count });
      } else {
        stats.push(await hardDestroyAll(Model, label, t));
      }
    }

    if (dryRun) {
      const [enquiryRows] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM enquiries
         WHERE linked_orders IS NOT NULL
           AND linked_orders::text NOT IN ('[]', 'null')`,
        { transaction: t }
      );
      stats.push({
        table: 'enquiries (linked_orders to clear)',
        deleted: enquiryRows?.[0]?.cnt ?? 0,
      });
    } else {
      const [updated] = await db.query(
        `UPDATE enquiries
         SET linked_orders = '[]'::jsonb
         WHERE linked_orders IS NOT NULL
           AND linked_orders::text NOT IN ('[]', 'null')
         RETURNING enquiry_id`,
        { transaction: t }
      );
      stats.push({
        table: 'enquiries (linked_orders cleared)',
        deleted: Array.isArray(updated) ? updated.length : 0,
      });
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
      const { invalidateForModule } = require('../cache/invalidateCacheForModule');
      await Promise.all([
        'fulfillment',
        'planning-extracted',
        'sales-orders',
        'dashboard',
        'orders',
        'production',
        'warehouse-inventory',
      ].map((root) => invalidateForModule(root)));
      stats.push({ table: 'redis (order lifecycle caches cleared)', deleted: 0 });
    } catch (e) {
      console.warn('[reset-order-lifecycle] redis cache clear failed:', e?.message || e);
    }
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
  hardDestroyAll,
  hardCountAll,
  unscopedModel,
};
