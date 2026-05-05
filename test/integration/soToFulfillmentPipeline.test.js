/**
 * Integration: GRN → BMR reserve → MTR (WH→MU) → dispensing → BPR fg_ready → Fulfillment lifecycle.
 *
 * This test is intentionally "controller-driven" (calls existing exported controller helpers)
 * to validate that inventory and workflow side-effects stay consistent across the pipeline.
 */
const db = require('../../db');
require('../../app');

const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const { Product } = require('../../src/products/models');
const BOM = require('../../src/bom/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const GoodsReceivedNote = require('../../src/grn/models');
const MaterialRequestNote = require('../../src/mrn/models');
const { ProductionBatch } = require('../../src/production/models');
const {
  applyRmReservedToInventory,
  applyPmReservedToInventory,
  updateBatch,
} = require('../../src/production/controller');

const { applyGrnCompletionToInventory } = require('../../src/grn/controller');
const mrnController = require('../../src/mrn/controller');
const productionController = require('../../src/production/controller');
const fulfillmentController = require('../../src/fulfillment/controller');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, ReservedBatchItem } = require('../../src/fulfillment/models');
const { User } = require('../../src/users/models');
const Address = require('../../src/models/Addresses');
const orders = require('../../src/orders/models');
const { Order } = orders;
const { isDbAvailable } = require('../helpers/dbAvailability');

function resMock() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(_payload) {
      // no-op: tests assert DB state
      return this;
    },
    send(_payload) {
      return this;
    },
  };
}

describe('SO→Planning→Inventory→Production→Fulfillment pipeline (integration)', () => {
  let rm;
  let pm;
  let fg;
  let bom;

  let rmWhInv;
  let pmWhInv;

  let productionBatch;
  let soNo;

  let fulfillmentOrder;
  let fulfillmentOrderItem;
  let split;

  let websiteOrder;

  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    await db.sync({ force: true });

    // Master data
    rm = await RawMaterial.create({ code: 'EI-RM-ACT-PIPE-001', name: 'Pipe RM', status: 'Active' });
    pm = await PackMaterial.create({ code: 'EI-PM-PKG-PIPE-001', description: 'Pipe PM', status: 'Active' });
    fg = await Product.create({
      zoho_sku_code: 'SKU-FG-PIPE-001',
      product_name: 'FG Pipe Product',
      status: 'Active',
      product_code: 'FG-PIPE-001',
      batch_size_kg: 30,
    });

    bom = await BOM.create({
      bom_code: 'BOM-PIPE-001',
      name: 'Pipe BOM',
      product_id: fg.product_id,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 100, uom: 'KG', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // Inventory: start empty in WH/MU; GRN will add WH stock
    rmWhInv = await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 0,
      wh_unit: 'KG',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });
    pmWhInv = await WarehouseInventory.create({
      item_type: 'PM',
      raw_material_id: null,
      pack_material_id: pm.id,
      product_id: null,
      wh_stock: 0,
      wh_unit: 'PCS',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });

    // Website order (so production/fulfillment can mirror stages)
    soNo = 'EI-SO-2026-001';
    const user = await User.create({
      email: 'pipe_user@example.com',
      password: 'x', // tests do not validate auth
      usertype: 'admin',
      fname: 'Pipe',
      lname: 'User',
    });
    const billing = await Address.create({
      user_id: user.userid,
      address_type: 'billing',
      address_line1: '1 Test Street',
      first_name: 'Pipe',
      last_name: 'User',
      city_text: 'Test City',
      state_text: 'Test State',
      country_text: 'IN',
      pincode: '000000',
    });
    const shipping = await Address.create({
      user_id: user.userid,
      address_type: 'shipping',
      address_line1: '2 Test Avenue',
      first_name: 'Pipe',
      last_name: 'User',
      city_text: 'Test City',
      state_text: 'Test State',
      country_text: 'IN',
      pincode: '000000',
    });
    websiteOrder = await Order.create({
      user_id: user.userid,
      billing_address_id: billing.address_id,
      shipping_address_id: shipping.address_id,
      so_no: soNo,
      fulfillment_stage: 'pending',
      order_status: 'pending',
      payment_status: 'pending',
      subtotal: 0,
      discount_total: 0,
      tax_total: 0,
      shipping_total: 0,
      grand_total: 0,
      advance_amount_due: 0,
    });

    // Production batch
    productionBatch = await ProductionBatch.create({
      bmr_no: 'BMR-2026-001',
      bpr_no: 'BPR-2026-001',
      product_name: fg.product_name,
      sku: fg.zoho_sku_code,
      so_no: soNo,
      order_qty: 30,
      batch_size: 30,
      batch_index: 1,
      total_batches: 1,
      planning_batch_id: null,
      bmr_status: 'draft',
      bpr_status: 'draft',
      rm_connected: false,
      pm_connected: false,
      rm_reserved: false,
      pm_reserved: false,
    });

    // Fulfillment: create a single split planned_qty = 30
    fulfillmentOrder = await FulfillmentOrder.create({
      so_no: soNo,
      customer_name: 'Pipe Customer',
      customer_city: 'Test City',
      priority: 'normal',
      so_status: 'planned',
      so_value: 0,
      order_date: '2026-03-20',
      due_date: '2026-03-30',
    });
    fulfillmentOrderItem = await FulfillmentOrderItem.create({
      fulfillment_order_id: fulfillmentOrder.id,
      item_no: '1',
      sku: fg.zoho_sku_code,
      product_name: fg.product_name,
      pack: 'PCS',
      ordered_qty: 30,
      rate: 0,
      unit_price: 0,
    });
    split = await FulfillmentBatchSplit.create({
      fulfillment_order_item_id: fulfillmentOrderItem.id,
      fulfillment_order_id: fulfillmentOrder.id,
      production_batch_id: productionBatch.id,
      bmr_no: productionBatch.bmr_no,
      bpr_no: productionBatch.bpr_no,
      planned_qty: 30,
      fg_qty: 0,
      ff_status: 'fg_pending',
    });
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('GRN Complete adds WH stock', async () => {
    if (!dbAvailable) return;
    const grn = await GoodsReceivedNote.create({
      grn_no: 'GRN-PIPE-001',
      status: 'GRN Complete',
      type: 'RM',
      line_items: [{ raw_material_id: rm.id, rcvdQty: 30 }],
    });

    const grn2 = await GoodsReceivedNote.create({
      grn_no: 'GRN-PIPE-002',
      status: 'GRN Complete',
      type: 'PM',
      line_items: [{ pack_material_id: pm.id, rcvdQty: 30 }],
    });

    await applyGrnCompletionToInventory(grn);
    await applyGrnCompletionToInventory(grn2);

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });

    expect(Number(rmInv.wh_stock)).toBe(30);
    expect(Number(rmInv.ml1_stock)).toBe(0);
    expect(Number(pmInv.wh_stock)).toBe(30);
    expect(Number(pmInv.ml1_stock)).toBe(0);
  });

  test('BMR reserve creates reservations and syncs warehouse_inventory.reserved', async () => {
    if (!dbAvailable) return;
    // Drive via controller updateBatch to ensure reserved transition side-effects are validated.
    const row = await ProductionBatch.findByPk(productionBatch.id);
    expect(row.bmr_status).toBe('draft');

    await updateBatch({ params: { id: String(productionBatch.id) }, body: { bmr_status: 'rm_reserved' } }, resMock());

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const reservedItems = await ReservedBatchItem.findAll({
      where: { production_batch_id: productionBatch.id, raw_material_id: rm.id },
    });

    expect(Number(rmInv.reserved)).toBe(30);
    expect(reservedItems.length).toBe(1);
  });

  test('MTR MRN Complete moves WH→MU and advances to dispensing', async () => {
    if (!dbAvailable) return;
    // BPR reserve too (PM needed for hasPm + moved inventory)
    await updateBatch({ params: { id: String(productionBatch.id) }, body: { bpr_status: 'pm_reserved' } }, resMock());

    const mrn = await MaterialRequestNote.create({
      mrn_no: 'MRN-PIPE-001',
      status: 'Received at MU',
      source: 'MTR',
      bmr_no: productionBatch.bmr_no,
      is_inbound_from_mu: false,
      mu_receive_zone: 'LOC-MU01',
      mu_receive_rack: 'R1',
      line_items: [
        { raw_material_id: rm.id, quantity: 30, unit: 'KG' },
        { pack_material_id: pm.id, quantity: 30, unit: 'PCS' },
      ],
    });

    await mrnController.update(
      {
        params: { id: String(mrn.id) },
        body: {
          status: 'Completed',
          mu_receive_zone: 'LOC-MU01',
          mu_receive_rack: 'R1',
        },
      },
      resMock()
    );

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    expect(Number(rmInv.wh_stock)).toBe(0);
    expect(Number(rmInv.ml1_stock)).toBe(30);
    expect(Number(rmInv.reserved)).toBe(0);

    expect(Number(pmInv.wh_stock)).toBe(0);
    expect(Number(pmInv.ml1_stock)).toBe(30);
    expect(Number(pmInv.reserved)).toBe(0);

    const batch = await ProductionBatch.findByPk(productionBatch.id);
    expect(batch.rm_connected).toBe(true);
    expect(batch.pm_connected).toBe(true);
    expect(batch.bmr_status).toBe('dispensing');
    expect(batch.bpr_status).toBe('pm_dispensing');
  });

  test('Dispensing consumes MU stock; BPR fg_ready adds FG inventory and sets fulfillment fg_qty', async () => {
    if (!dbAvailable) return;
    // Dispensing: consume 30 RM + 30 PM from MU (ML1)
    await productionController.updateBatch(
      {
        params: { id: String(productionBatch.id) },
        body: {
          dispensing_rm: [{ code: rm.code, dispensed: 30 }],
          dispensing_pm: [{ code: pm.code, dispensed: 30 }],
        },
      },
      resMock()
    );

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    expect(Number(rmInv.ml1_stock)).toBe(0);
    expect(Number(pmInv.ml1_stock)).toBe(0);

    // BPR fg_ready: should add product to PR warehouse_inventory and set split.fg_qty based on planned_qty
    await productionController.updateBatch(
      {
        params: { id: String(productionBatch.id) },
        body: { bpr_status: 'fg_ready' },
      },
      resMock()
    );

    const prInv = await WarehouseInventory.findOne({ where: { item_type: 'PR', product_id: fg.product_id } });
    const updatedSplit = await FulfillmentBatchSplit.findByPk(split.id);

    expect(Number(prInv.wh_stock)).toBe(30);
    expect(Number(updatedSplit.fg_qty)).toBe(30);
  });

  test('Fulfillment pick → invoice → ship → deliver mirrors website order stages', async () => {
    if (!dbAvailable) return;
    // pick
    await fulfillmentController.pickSplits(
      {
        params: { id: String(fulfillmentOrder.id) },
        body: {
          pickerName: 'Picker 1',
          pickDate: '2026-03-22',
          pickSlipNo: 'SLIP-1',
          remarks: 'Pick OK',
          splits: [{ bprNo: productionBatch.bpr_no, pickedQty: 30 }],
        },
      },
      resMock()
    );

    let updatedSplit = await FulfillmentBatchSplit.findByPk(split.id);
    expect(updatedSplit.ff_status).toBe('picking');

    let wo = await Order.findOne({ where: { so_no: soNo } });
    expect(wo.fulfillment_stage).toBe('packaged');

    // invoice
    await fulfillmentController.invoiceSplits(
      {
        params: { id: String(fulfillmentOrder.id) },
        body: {
          invoiceNo: 'INV-PIPE-001',
          invoiceDate: '2026-03-23',
          courier: 'DHL',
          bprNos: [productionBatch.bpr_no],
        },
      },
      resMock()
    );

    updatedSplit = await FulfillmentBatchSplit.findByPk(split.id);
    expect(updatedSplit.ff_status).toBe('invoiced');

    wo = await Order.findOne({ where: { so_no: soNo } });
    expect(wo.fulfillment_stage).toBe('invoiced');

    // ship
    await fulfillmentController.shipSplits(
      {
        params: { id: String(fulfillmentOrder.id) },
        body: {
          awbNo: 'AWB-PIPE-001',
          courier: 'DHL',
          dispatchDate: '2026-03-23',
          eta: '2026-03-25',
          bprNos: [productionBatch.bpr_no],
        },
      },
      resMock()
    );

    updatedSplit = await FulfillmentBatchSplit.findByPk(split.id);
    expect(updatedSplit.ff_status).toBe('shipped');

    wo = await Order.findOne({ where: { so_no: soNo } });
    expect(wo.fulfillment_stage).toBe('shipped');

    // deliver
    await fulfillmentController.deliverSplits(
      {
        params: { id: String(fulfillmentOrder.id) },
        body: {
          deliveryDate: '2026-03-25',
          receivedBy: 'Client Receiver',
          remarks: 'Delivered',
          bprNos: [productionBatch.bpr_no],
        },
      },
      resMock()
    );

    updatedSplit = await FulfillmentBatchSplit.findByPk(split.id);
    expect(updatedSplit.ff_status).toBe('closed');

    const refreshedFulfillmentOrder = await FulfillmentOrder.findByPk(fulfillmentOrder.id);
    expect(refreshedFulfillmentOrder.so_status).toBe('closed');

    // Stage 4: Exec% after delivery should be 100% for a fully closed split.
    // This mirrors `admin-dashboard/src/lib/fulfillmentExecutionPct.ts` weights and terminal-state behavior.
    const weights = {
      planBatch: 0.08,
      procurement: 0.12,
      production: 0.35,
      picking: 0.1,
      invoiced: 0.12,
      shipped: 0.13,
      delivered: 0.1,
    };
    const st = updatedSplit.ff_status;
    const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
    const terminal = st === 'delivered' || st === 'closed';
    const pPlan = terminal ? 1 : 0;
    const pProc = terminal ? 1 : 0;
    const pProd = st === 'closed' || st === 'delivered' ? 1 : 0;
    let score = weights.planBatch * pPlan + weights.procurement * pProc + weights.production * pProd;
    if (['picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(st)) score += weights.picking;
    if (['invoiced', 'shipped', 'delivered', 'closed'].includes(st)) score += weights.invoiced;
    if (['shipped', 'delivered', 'closed'].includes(st)) score += weights.shipped;
    if (['delivered', 'closed'].includes(st)) score += weights.delivered;
    const execPct = Math.round(clamp01(score) * 100);
    expect(execPct).toBe(100);
  });
});

