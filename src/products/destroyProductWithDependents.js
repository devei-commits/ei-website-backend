/**
 * Shared destructive cleanup for catalogue / PR products (same dependents as DELETE /products/:id).
 */
const { Op } = require('sequelize');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const PlanningExtracted = require('../planningExtracted/models');
const ProductCustomization = require('../productCustomizations/models');
const ItemDedicatedFacilityLocation = require('../itemDedicatedFacilityLocations/models');
const BOM = require('../bom/models');
const ItemMaster = require('../itemsMaster/models');
const ProcurementRequest = require('../procurementRequests/models');
const ProcurementQuotation = require('../procurementQuotations/models');
const { deleteItemsListChain } = require('../masters/resetMaterialMasters');
const { Product } = require('./models');

/**
 * `procurement_requests.planning_extracted_id` FK blocks deleting planning rows unless these are removed first.
 * @param {number} productId — products.product_id
 * @param {import('sequelize').Transaction} transaction
 */
async function destroyProcurementRequestsForProductPlanning(productId, transaction) {
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
    await ProcurementQuotation.destroy({
      where: { procurement_request_id: { [Op.in]: requestIds } },
      transaction,
    });
  }
  await ProcurementRequest.destroy({
    where: { planning_extracted_id: { [Op.in]: planIds } },
    transaction,
  });
}

/**
 * @param {import('sequelize').Transaction} transaction
 */
async function destroyProductWithDependents(productId, transaction) {
  const pid = parseInt(String(productId), 10);
  if (!Number.isFinite(pid)) return;

  const whInvRows = await WarehouseInventory.findAll({
    where: { product_id: pid },
    transaction,
  });
  for (const whInv of whInvRows) {
    await WarehouseInventoryLocationHistory.destroy({
      where: { warehouse_inventory_id: whInv.id },
      transaction,
    });
    await whInv.destroy({ transaction });
  }

  await destroyProcurementRequestsForProductPlanning(pid, transaction);
  await PlanningExtracted.destroy({ where: { product_id: pid }, transaction });
  await ProductCustomization.destroy({ where: { product_id: pid }, transaction });
  await ItemDedicatedFacilityLocation.destroy({ where: { product_id: pid }, transaction });

  await deleteItemsListChain({ product_id: pid }, transaction);

  await BOM.destroy({ where: { product_id: pid }, transaction });

  await Product.destroy({ where: { product_id: pid }, transaction });
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
  const idSet = new Set(deletedProductIds.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
  if (idSet.size === 0) return;

  const prs = await ProcurementRequest.findAll({ attributes: ['id', 'items'], transaction });
  for (const row of prs) {
    const nextItems = stripProductIdsFromProcurementItems(row.items, idSet);
    await row.update({ items: nextItems }, { transaction });
  }
  const quotes = await ProcurementQuotation.findAll({ attributes: ['id', 'items'], transaction });
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
  destroyProductWithDependents,
  scrubProcurementJsonForDeletedProducts,
  reconcileItemMasterBomIdsRemovingBomIds,
};
