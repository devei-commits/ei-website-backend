/**
 * Destructive reset helpers for Raw Material and Pack Material masters.
 * Clears FK-dependent rows, items_list chains, BOM JSON lines, and common JSON references.
 */
const { Op } = require('sequelize');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const { ReservedBatchItem } = require('../fulfillment/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const UniversalSwapHistory = require('../universalSwap/models');
const BOM = require('../bom/models');
const ItemMaster = require('../itemsMaster/models');
const PlanningExtracted = require('../planningExtracted/models');
const PlanningBatch = require('../planningExtracted/planningBatchModel');
const ProcurementRequest = require('../procurementRequests/models');
const ProcurementQuotation = require('../procurementQuotations/models');

async function deleteItemsListChain(where, transaction) {
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
    await ItemListTier.destroy({ where: { item_list_vendor_rate_id: { [Op.in]: rateIds } }, transaction });
  }
  await ItemListVendorRate.destroy({ where: { items_list_id: { [Op.in]: listIds } }, transaction });
  await ItemsList.destroy({ where: { id: { [Op.in]: listIds } }, transaction });
}

function stripRmFromProcurementItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const next = { ...it };
    next.raw_material_id = null;
    if ('rawMaterialId' in next) next.rawMaterialId = null;
    return next;
  });
}

function stripPmFromProcurementItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const next = { ...it };
    next.pack_material_id = null;
    if ('packMaterialId' in next) next.packMaterialId = null;
    return next;
  });
}

async function scrubProcurementJson(transaction, stripFn) {
  const prs = await ProcurementRequest.findAll({ attributes: ['id', 'items'], transaction });
  for (const row of prs) {
    const nextItems = stripFn(row.items);
    await row.update({ items: nextItems }, { transaction });
  }
  const quotes = await ProcurementQuotation.findAll({ attributes: ['id', 'items'], transaction });
  for (const row of quotes) {
    const nextItems = stripFn(row.items);
    await row.update({ items: nextItems }, { transaction });
  }
}

/**
 * @param {import('sequelize').Transaction} transaction
 */
async function resetRawMaterialsMasterData(transaction) {
  await ReservedBatchItem.destroy({ where: { raw_material_id: { [Op.ne]: null } }, transaction });

  const rmWh = await WarehouseInventory.findAll({
    where: { item_type: 'RM' },
    attributes: ['id'],
    transaction,
  });
  const rmWhIds = rmWh.map((r) => r.id);
  if (rmWhIds.length > 0) {
    await WarehouseInventoryLocationHistory.destroy({
      where: { warehouse_inventory_id: { [Op.in]: rmWhIds } },
      transaction,
    });
  }
  await WarehouseInventory.destroy({ where: { item_type: 'RM' }, transaction });
  await WarehouseInventoryLocationHistory.destroy({
    where: { raw_material_id: { [Op.ne]: null } },
    transaction,
  });

  await deleteItemsListChain({ raw_material_id: { [Op.ne]: null } }, transaction);

  await UniversalSwapHistory.destroy({ where: {}, transaction });

  const boms = await BOM.findAll({ attributes: ['id', 'rm_lines', 'sku_rm_lines'], transaction });
  for (const b of boms) {
    await b.update({ rm_lines: [], sku_rm_lines: [] }, { transaction });
  }

  await ItemMaster.update({ raw_material_ids: [] }, { where: {}, transaction });
  await PlanningExtracted.update({ raw_materials: [] }, { where: {}, transaction });

  await PlanningBatch.update({ rm_lines: [] }, { where: {}, transaction });

  await scrubProcurementJson(transaction, stripRmFromProcurementItems);

  const deleted = await RawMaterial.destroy({ where: {}, transaction });
  return { deletedRawMaterials: deleted };
}

/**
 * @param {import('sequelize').Transaction} transaction
 */
async function resetPackMaterialsMasterData(transaction) {
  await ReservedBatchItem.destroy({ where: { pack_material_id: { [Op.ne]: null } }, transaction });

  const pmWh = await WarehouseInventory.findAll({
    where: { item_type: 'PM' },
    attributes: ['id'],
    transaction,
  });
  const pmWhIds = pmWh.map((r) => r.id);
  if (pmWhIds.length > 0) {
    await WarehouseInventoryLocationHistory.destroy({
      where: { warehouse_inventory_id: { [Op.in]: pmWhIds } },
      transaction,
    });
  }
  await WarehouseInventory.destroy({ where: { item_type: 'PM' }, transaction });
  await WarehouseInventoryLocationHistory.destroy({
    where: { pack_material_id: { [Op.ne]: null } },
    transaction,
  });

  await deleteItemsListChain({ pack_material_id: { [Op.ne]: null } }, transaction);

  const boms = await BOM.findAll({ attributes: ['id', 'pm_lines'], transaction });
  for (const b of boms) {
    await b.update({ pm_lines: [] }, { transaction });
  }

  await ItemMaster.update({ pack_material_ids: [] }, { where: {}, transaction });
  await PlanningExtracted.update({ packaging_materials: [] }, { where: {}, transaction });

  await PlanningBatch.update({ pm_lines: [] }, { where: {}, transaction });

  await scrubProcurementJson(transaction, stripPmFromProcurementItems);

  const deleted = await PackMaterial.destroy({ where: {}, transaction });
  return { deletedPackMaterials: deleted };
}

module.exports = {
  deleteItemsListChain,
  resetRawMaterialsMasterData,
  resetPackMaterialsMasterData,
};
