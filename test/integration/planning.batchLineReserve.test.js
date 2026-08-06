/**
 * Integration: per-planning-batch manual reserve/un-reserve (Batches RM/PM Status popups).
 *   - reserve creates ReservedBatchItem keyed by planning_batch_id + is_manual, syncs warehouse reserved
 *   - free-pool guard rejects (409) when SIH − others is insufficient
 *   - un-reserve destroys the row, resyncs reserved to 0
 *   - refreshReservationsFromPlanningBatches leaves manual rows alone AND does not double-count them
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');
const SalesOrder = require('../../src/salesOrders/models');
const { Product } = require('../../src/products/models');
const { ReservedBatchItem } = require('../../src/fulfillment/models');
const {
  reservePlanningBatchLines,
  unreservePlanningBatchLines,
  computePlanningBatchCoverage,
} = require('../../src/planningExtracted/planningBatchLineReserve');
const { refreshReservationsFromPlanningBatches } = require('../../src/planningExtracted/controller');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('planning per-batch line reserve', () => {
  let batchId;
  let planId;
  let rmId;
  let pmId;
  let rmTightId;
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    const so = await SalesOrder.create({ order_id: 'SO-PBLR-001', customer_name: 'Test', status: 'Approved' });
    const product = await Product.create({ zoho_sku_code: 'SKU-PBLR-001', product_name: 'PBLR Product', status: 'Active' });
    const rm = await RawMaterial.create({ code: 'RM-PBLR-001', name: 'PBLR RM', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-PBLR-001', description: 'PBLR PM', status: 'Active' });
    const rmTight = await RawMaterial.create({ code: 'RM-PBLR-TIGHT', name: 'PBLR RM Tight', status: 'Active' });
    rmId = rm.id;
    pmId = pm.id;
    rmTightId = rmTight.id;

    // order 100 units / 500 kg → kgPerUnit 5; batch 50 kg → 10 units.
    const plan = await PlanningExtracted.create({
      sales_order_id: so.id,
      product_id: product.product_id,
      order_qty_display: '100',
      total_kg_display: '500',
      bom_status: 'In Progress',
      sent_batch_indices: [],
      raw_materials: [{ raw_material_id: rmId, quantity: 20, unit: 'KG' }],
      packaging_materials: [{ pack_material_id: pmId, quantity: 10, unit: 'PCS' }],
    });
    planId = plan.id;

    const batch = await PlanningBatch.create({
      planning_extracted_id: planId,
      sequence: 1,
      batch_code: 'PBLR-B1',
      size_kg: 50,
      // RM: 50kg * 20% = 10 KG ; RM-tight: 50kg * 20% = 10 KG ; PM: 10 units * 2 = 20 PCS
      rm_lines: [
        { raw_material_id: rmId, rm_code: 'RM-PBLR-001', code: 'RM-PBLR-001', pct_w_w: 20 },
        { raw_material_id: rmTightId, rm_code: 'RM-PBLR-TIGHT', code: 'RM-PBLR-TIGHT', pct_w_w: 20 },
      ],
      pm_lines: [
        { pack_material_id: pmId, pm_code: 'PM-PBLR-001', code: 'PM-PBLR-001', qty_per_unit: 2 },
      ],
    });
    batchId = batch.id;

    await WarehouseInventory.create({ item_type: 'RM', raw_material_id: rmId, wh_stock: 100, stock_in_hand: 100, reserved: 0 });
    await WarehouseInventory.create({ item_type: 'PM', pack_material_id: pmId, wh_stock: 50, stock_in_hand: 50, reserved: 0 });
    // Tight RM: only 4 KG free but the line needs 10 → reserve must 409.
    await WarehouseInventory.create({ item_type: 'RM', raw_material_id: rmTightId, wh_stock: 4, stock_in_hand: 4, reserved: 0 });
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('reserve RM (code RM-PBLR-001) creates a manual row keyed by planning_batch_id and syncs reserved', async () => {
    if (!dbAvailable) return;
    const res = await reservePlanningBatchLines(batchId, 'rm', ['RM-PBLR-001']);
    expect(res.reserved.length).toBe(1);
    const rows = await ReservedBatchItem.findAll({ where: { planning_batch_id: batchId, raw_material_id: rmId } });
    expect(rows.length).toBe(1);
    expect(Number(rows[0].quantity_reserved)).toBe(10);
    expect(rows[0].is_manual).toBe(true);
    expect(rows[0].planning_extracted_id).toBe(planId);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    expect(Number(wh.reserved)).toBe(10);
  });

  test('reserve PM (all lines) reserves the batch PM requirement', async () => {
    if (!dbAvailable) return;
    const res = await reservePlanningBatchLines(batchId, 'pm', null);
    expect(res.reserved.length).toBe(1);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    expect(Number(wh.reserved)).toBe(20);
  });

  test('reserve fails with 409 when free pool is insufficient (tight RM)', async () => {
    if (!dbAvailable) return;
    await expect(reservePlanningBatchLines(batchId, 'rm', ['RM-PBLR-TIGHT'])).rejects.toMatchObject({ statusCode: 409 });
    const rows = await ReservedBatchItem.findAll({ where: { planning_batch_id: batchId, raw_material_id: rmTightId } });
    expect(rows.length).toBe(0);
  });

  test('coverage reports required vs reserved per line', async () => {
    if (!dbAvailable) return;
    const cov = await computePlanningBatchCoverage(batchId);
    const rmLine = cov.rm.find((l) => l.code === 'RM-PBLR-001');
    expect(rmLine.required).toBe(10);
    expect(rmLine.reserved).toBe(10);
    expect(rmLine.fullyReserved).toBe(true);
    const pmLine = cov.pm.find((l) => l.code === 'PM-PBLR-001');
    expect(pmLine.reserved).toBe(20);
  });

  test('auto rebuild leaves the manual reservation intact (manual wins, no double-count)', async () => {
    if (!dbAvailable) return;
    await refreshReservationsFromPlanningBatches(planId);
    // The manual RM row must survive and the material must not be reserved twice.
    const manualRows = await ReservedBatchItem.findAll({ where: { planning_batch_id: batchId, raw_material_id: rmId, is_manual: true } });
    expect(manualRows.length).toBe(1);
    expect(Number(manualRows[0].quantity_reserved)).toBe(10);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    expect(Number(wh.reserved)).toBe(10);
  });

  test('un-reserve RM destroys the manual row and resyncs reserved to 0', async () => {
    if (!dbAvailable) return;
    const res = await unreservePlanningBatchLines(batchId, 'rm', ['RM-PBLR-001']);
    expect(res.unreserved.length).toBe(1);
    const rows = await ReservedBatchItem.findAll({ where: { planning_batch_id: batchId, raw_material_id: rmId } });
    expect(rows.length).toBe(0);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    expect(Number(wh.reserved)).toBe(0);
  });
});
