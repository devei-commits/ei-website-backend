/**
 * Shared cleanup for catalogue / PR products (same dependents as DELETE /products/:id).
 * Default API delete is soft-delete; full PR reset uses hardDeleteProductWithDependents.
 */
const { Op } = require('sequelize');
const { softDeleteWhere, softDeleteInstance } = require('../lib/softDelete');

/** @param {import('sequelize').ModelStatic<any>} Model */
function unscopedModel(Model) {
  return typeof Model.unscoped === 'function' ? Model.unscoped() : Model;
}

/**
 * @param {import('sequelize').ModelStatic<any>} Model
 * @param {import('sequelize').WhereOptions} where
 * @param {import('sequelize').Transaction} transaction
 */
async function hardDestroyWhere(Model, where, transaction) {
  return unscopedModel(Model).destroy({ where, transaction });
}
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const PlanningExtracted = require('../planningExtracted/models');
const ProductCustomization = require('../productCustomizations/models');
const BOM = require('../bom/models');
const ProcurementRequest = require('../procurementRequests/models');
const ProcurementQuotation = require('../procurementQuotations/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const { Product } = require('./models');

/**
 * @param {import('sequelize').WhereOptions} where
 * @param {import('sequelize').Transaction} transaction
 */
async function softDeleteItemsListChain(where, transaction) {
  const lists = await ItemsList.findAll({ where, attributes: ['id'], transaction });
  const listIds = lists.map((r) => r.id);
  if (listIds.length === 0) return;
  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: { [Op.in]: listIds } },
    attributes: ['id'],
    transaction,
  });
  const rateIds = rates.map((r) => r.id);
  if (rateIds.length > 0) {
    await softDeleteWhere(
      ItemListTier,
      { item_list_vendor_rate_id: { [Op.in]: rateIds } },
      { transaction }
    );
  }
  await softDeleteWhere(ItemListVendorRate, { items_list_id: { [Op.in]: listIds } }, { transaction });
  await softDeleteWhere(ItemsList, { id: { [Op.in]: listIds } }, { transaction });
}

/**
 * Soft-delete procurement rows tied to planning for this product.
 * @param {number} productId — products.product_id
 * @param {import('sequelize').Transaction} transaction
 */
async function softDeleteProcurementRequestsForProductPlanning(productId, transaction) {
  const plans = await PlanningExtracted.findAll({
    where: { product_id: productId },
    attributes: ['id'],
    transaction,
  });
  const planIds = plans.map((p) => p.id);
  if (planIds.length === 0) return;

  const requests = await ProcurementRequest.findAll({
    where: { planning_extracted_id: { [Op.in]: planIds } },
    attributes: ['id'],
    transaction,
  });
  const requestIds = requests.map((r) => r.id);
  if (requestIds.length > 0) {
    await softDeleteWhere(
      ProcurementQuotation,
      { procurement_request_id: { [Op.in]: requestIds } },
      { transaction }
    );
  }
  await softDeleteWhere(
    ProcurementRequest,
    { planning_extracted_id: { [Op.in]: planIds } },
    { transaction }
  );
}

/**
 * @param {import('sequelize').Transaction} transaction
 */
async function softDeleteProductWithDependents(productId, transaction) {
  const pid = parseInt(String(productId), 10);
  if (!Number.isFinite(pid)) return;

  const whInvRows = await WarehouseInventory.findAll({
    where: { product_id: pid },
    transaction,
  });
  for (const whInv of whInvRows) {
    await softDeleteWhere(
      WarehouseInventoryLocationHistory,
      { warehouse_inventory_id: whInv.id },
      { transaction }
    );
    await softDeleteInstance(whInv, { transaction });
  }

  await softDeleteProcurementRequestsForProductPlanning(pid, transaction);
  await softDeleteWhere(PlanningExtracted, { product_id: pid }, { transaction });
  await softDeleteWhere(ProductCustomization, { product_id: pid }, { transaction });

  await softDeleteItemsListChain({ product_id: pid }, transaction);

  await softDeleteWhere(BOM, { product_id: pid }, { transaction });

  await softDeleteWhere(Product, { product_id: pid }, { transaction });
}

/** @deprecated use softDeleteProductWithDependents */
const destroyProductWithDependents = softDeleteProductWithDependents;

/**
 * @param {import('sequelize').WhereOptions} where
 * @param {import('sequelize').Transaction} transaction
 */
async function hardDeleteItemsListChain(where, transaction) {
  const lists = await unscopedModel(ItemsList).findAll({ where, attributes: ['id'], transaction });
  const listIds = lists.map((r) => r.id);
  if (listIds.length === 0) return;
  const rates = await unscopedModel(ItemListVendorRate).findAll({
    where: { items_list_id: { [Op.in]: listIds } },
    attributes: ['id'],
    transaction,
  });
  const rateIds = rates.map((r) => r.id);
  if (rateIds.length > 0) {
    await hardDestroyWhere(
      ItemListTier,
      { item_list_vendor_rate_id: { [Op.in]: rateIds } },
      transaction
    );
  }
  await hardDestroyWhere(ItemListVendorRate, { items_list_id: { [Op.in]: listIds } }, transaction);
  await hardDestroyWhere(ItemsList, { id: { [Op.in]: listIds } }, transaction);
}

/**
 * Hard-delete planning_extracted and all rows that reference it for this product.
 * @param {number} productId
 * @param {import('sequelize').Transaction} transaction
 */
async function hardDeletePlanningChainForProduct(productId, transaction) {
  const plans = await unscopedModel(PlanningExtracted).findAll({
    where: { product_id: productId },
    attributes: ['id'],
    transaction,
  });
  const planIds = plans.map((p) => p.id);
  if (planIds.length === 0) return;

  const PlanningBatch = require('../planningExtracted/planningBatchModel');
  const PlanningBomOverride = require('../planningExtracted/planningBomOverrideModel');
  const PlanningQuotationAsk = require('../planningQuotationAsks/models');
  const { ReservedBatchItem } = require('../fulfillment/models');

  const requests = await unscopedModel(ProcurementRequest).findAll({
    where: { planning_extracted_id: { [Op.in]: planIds } },
    attributes: ['id'],
    transaction,
  });
  const requestIds = requests.map((r) => r.id);
  if (requestIds.length > 0) {
    await hardDestroyWhere(
      ProcurementQuotation,
      { procurement_request_id: { [Op.in]: requestIds } },
      transaction
    );
    await hardDestroyWhere(ProcurementRequest, { id: { [Op.in]: requestIds } }, transaction);
  }

  await hardDestroyWhere(ReservedBatchItem, { planning_extracted_id: { [Op.in]: planIds } }, transaction);
  await hardDestroyWhere(PlanningQuotationAsk, { planning_extracted_id: { [Op.in]: planIds } }, transaction);
  await hardDestroyWhere(PlanningBatch, { planning_extracted_id: { [Op.in]: planIds } }, transaction);
  await hardDestroyWhere(PlanningBomOverride, { planning_extracted_id: { [Op.in]: planIds } }, transaction);
  await hardDestroyWhere(PlanningExtracted, { id: { [Op.in]: planIds } }, transaction);
}

/**
 * Physically removes a product and its dependents (including soft-deleted rows).
 * @param {number} productId
 * @param {import('sequelize').Transaction} transaction
 * @param {{ skipBom?: boolean }} [opts]
 */
async function hardDeleteProductWithDependents(productId, transaction, opts = {}) {
  const pid = parseInt(String(productId), 10);
  if (!Number.isFinite(pid)) return;

  const whInvRows = await unscopedModel(WarehouseInventory).findAll({
    where: { product_id: pid },
    transaction,
  });
  for (const whInv of whInvRows) {
    await hardDestroyWhere(
      WarehouseInventoryLocationHistory,
      { warehouse_inventory_id: whInv.id },
      transaction
    );
    await unscopedModel(WarehouseInventory).destroy({ where: { id: whInv.id }, transaction });
  }

  await hardDeletePlanningChainForProduct(pid, transaction);
  await hardDestroyWhere(ProductCustomization, { product_id: pid }, transaction);
  await hardDeleteItemsListChain({ product_id: pid }, transaction);

  if (!opts.skipBom) {
    await hardDestroyWhere(BOM, { product_id: pid }, transaction);
  }

  await hardDestroyWhere(Product, { product_id: pid }, transaction);
}

function stripProductIdsFromProcurementItems(items, idSet) {
  if (!Array.isArray(items)) return items;
  return items.filter((it) => {
    if (!it || typeof it !== 'object') return true;
    const pid = Number(it.product_id ?? it.productId);
    if (Number.isFinite(pid) && idSet.has(pid)) return false;
    return true;
  });
}

/**
 * Remove procurement lines that pointed at deleted PR / FG product ids.
 * @param {number[]} deletedProductIds
 * @param {import('sequelize').Transaction} transaction
 */
async function scrubProcurementJsonForDeletedProducts(deletedProductIds, transaction) {
  const { activeRowWhere } = require('../lib/softDelete');
  const idSet = new Set(deletedProductIds.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
  if (idSet.size === 0) return;

  const prs = await ProcurementRequest.findAll({
    where: activeRowWhere(),
    attributes: ['id', 'items'],
    transaction,
  });
  for (const row of prs) {
    const nextItems = stripProductIdsFromProcurementItems(row.items, idSet);
    await row.update({ items: nextItems }, { transaction });
  }
  const quotes = await ProcurementQuotation.findAll({
    where: activeRowWhere(),
    attributes: ['id', 'items'],
    transaction,
  });
  for (const row of quotes) {
    const nextItems = stripProductIdsFromProcurementItems(row.items, idSet);
    await row.update({ items: nextItems }, { transaction });
  }
}

/**
 * Drop deleted BOM ids from items_master.bom_ids JSON (no FK enforcement).
 * @param {number[]} bomIdsToRemove
 * @param {import('sequelize').Transaction} transaction
 */
async function reconcileItemMasterBomIdsRemovingBomIds(bomIdsToRemove, transaction) {
  const ItemMaster = require('../itemsMaster/models');
  const idSet = new Set(bomIdsToRemove.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
  if (idSet.size === 0) return;

  const masters = await ItemMaster.findAll({ attributes: ['id', 'bom_ids'], transaction });
  for (const m of masters) {
    const cur = Array.isArray(m.bom_ids) ? m.bom_ids : [];
    const next = cur.filter((bid) => !idSet.has(Number(bid)));
    if (next.length !== cur.length) {
      await m.update({ bom_ids: next }, { transaction });
    }
  }
}

module.exports = {
  softDeleteProductWithDependents,
  destroyProductWithDependents,
  hardDeleteProductWithDependents,
  softDeleteItemsListChain,
  scrubProcurementJsonForDeletedProducts,
  reconcileItemMasterBomIdsRemovingBomIds,
  unscopedModel,
};
