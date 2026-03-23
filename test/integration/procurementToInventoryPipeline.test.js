/**
 * Integration (in-memory): PR → PO → GRN (Complete) → Warehouse Inventory.
 *
 * Purpose:
 * - Validate that inbound GRN completion updates `warehouse_inventory.wh_stock` / `stock_in_hand`.
 * - Validate that `warehouse-inventory` `poQuantity` is derived from `purchase_orders.items` before GRN completion.
 */

const db = require('../../db');
require('../../app');

const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { Product } = require('../../src/products/models');
const SalesOrder = require('../../src/salesOrders/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');
const ProcurementRequest = require('../../src/procurementRequests/models');
const VendorClient = require('../../src/vendorClient/models');
const ProcurementQuotation = require('../../src/procurementQuotations/models');
const PurchaseOrder = require('../../src/purchaseOrders/models');
const GoodsReceivedNote = require('../../src/grn/models');

const warehouseInventoryController = require('../../src/warehouseInventory/controller');
const { applyGrnCompletionToInventory } = require('../../src/grn/controller');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('procurement pipeline (PR → PO → GRN → inventory)', () => {
  let dbAvailable = true;

  test('PO quantities appear pre-GRN; GRN complete updates warehouse_inventory', async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    await db.sync({ force: true });

    // Masters
    const rm = await RawMaterial.create({ code: 'RM-PR-INV-001', name: 'PR/Inv RM', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-PR-INV-001', description: 'PR/Inv PM', status: 'Active' });
    const fg = await Product.create({ product_sku: 'SKU-FG-PR-INV-001', product_name: 'PR/Inv FG', status: 'Active' });

    const so = await SalesOrder.create({ order_id: 'SO-PR-INV-001', customer_name: 'PR Inv Customer', status: 'Approved' });

    // Planning rows (just enough to satisfy FK constraints)
    const plan = await PlanningExtracted.create({
      sales_order_id: so.id,
      product_id: fg.product_id,
      order_qty_display: '30',
      total_kg_display: '30',
      bom_status: 'In Progress',
      raw_materials: [{ raw_material_id: rm.id, quantity: 30, unit: 'KG' }],
      packaging_materials: [{ pack_material_id: pm.id, quantity: 30, unit: 'PCS' }],
    });
    const planBatch = await PlanningBatch.create({
      planning_extracted_id: plan.id,
      sequence: 1,
      batch_code: `PE-${plan.id}-B1`,
      size_kg: 30,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 100, uom: 'kg', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // Seed inventory rows so `listPayload()` can compute poQuantity for them
    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 0,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });
    await WarehouseInventory.create({
      item_type: 'PM',
      raw_material_id: null,
      pack_material_id: pm.id,
      product_id: null,
      wh_stock: 0,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });

    // PR + Quotation
    const pr = await ProcurementRequest.create({
      planning_extracted_id: plan.id,
      planning_batch_id: planBatch.id,
      priority: 'normal',
      required_by_date: '2026-03-30',
      status: 'Pending',
      items: [
        { type: 'RM', raw_material_id: rm.id, quantity_requested: 30, unit: 'KG' },
        { type: 'PM', pack_material_id: pm.id, quantity_requested: 30, unit: 'PCS' },
      ],
    });

    const vendor = await VendorClient.create({
      entity_code: 'EI-VEN-PRINV-0001',
      type: 'vendor',
      name: 'Test Vendor',
      status: 'active',
    });

    await ProcurementQuotation.create({
      procurement_request_id: pr.id,
      vendor_id: vendor.id,
      status: 'confirmed',
      items: [
        { itemId: rm.code, name: rm.name, raw_material_id: rm.id, orderQty: 30, pricePerUnit: 10, uom: 'KG', totalValue: 300 },
        { itemId: pm.code, name: pm.description, pack_material_id: pm.id, orderQty: 30, pricePerUnit: 1, uom: 'PCS', totalValue: 30 },
      ],
      total_value: 330,
    });

    // PO (draft / released not modeled as special behavior in backend)
    const po = await PurchaseOrder.create({
      order_id: 'PO-PRINV-001',
      vendor_name: vendor.name,
      branch: 'Main',
      order_date: '2026-03-20',
      expected_shipment_date: '2026-03-25',
      reference: 'From PR',
      payment_terms: '15 days',
      status: 'Draft',
      order_status: {},
      form_data: {},
      items: [
        { raw_material_id: rm.id, quantity: 30, uom: 'KG' },
        { pack_material_id: pm.id, quantity: 30, uom: 'PCS' },
      ],
    });

    // Before GRN complete, `warehouseInventoryController.listPayload()` should derive `poQuantity` from PO items.
    const pre = await warehouseInventoryController.listPayload();
    const rmRowPre = pre.rows.find((r) => r.type === 'RM' && r.sourceId === rm.id);
    const pmRowPre = pre.rows.find((r) => r.type === 'PM' && r.sourceId === pm.id);
    expect(rmRowPre).toBeDefined();
    expect(pmRowPre).toBeDefined();
    expect(Number(rmRowPre.poQuantity)).toBe(30);
    expect(Number(pmRowPre.poQuantity)).toBe(30);

    // GRN complete adds received quantities to warehouse_inventory.
    const grn = await GoodsReceivedNote.create({
      grn_no: 'GRN-PRINV-001',
      purchase_order_id: po.id,
      po_no: po.order_id,
      vendor: vendor.name,
      type: 'RM',
      status: 'GRN Complete',
      line_items: [
        { raw_material_id: rm.id, itemCode: rm.code, item: rm.name, rcvdQty: 30, poQty: 30, quantity: 30, unit: 'KG' },
        { pack_material_id: pm.id, itemCode: pm.code, item: pm.description, rcvdQty: 30, poQty: 30, quantity: 30, unit: 'PCS' },
      ],
      expected_date: '2026-03-25',
      received_date: '2026-03-25',
    });

    await applyGrnCompletionToInventory(grn);

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });

    expect(Number(rmInv.wh_stock)).toBe(30);
    expect(Number(rmInv.stock_in_hand)).toBe(30);

    expect(Number(pmInv.wh_stock)).toBe(30);
    expect(Number(pmInv.stock_in_hand)).toBe(30);
  });

  test('In Transit GRN contributes to warehouse inventory inTransit; GRN Complete removes it', async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    await db.sync({ force: true });

    // Masters
    const rm = await RawMaterial.create({ code: 'RM-PR-INV-002', name: 'PR/Inv RM 2', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-PR-INV-002', description: 'PR/Inv PM 2', status: 'Active' });
    const fg = await Product.create({ product_sku: 'SKU-FG-PR-INV-002', product_name: 'PR/Inv FG 2', status: 'Active' });

    const so = await SalesOrder.create({ order_id: 'SO-PR-INV-002', customer_name: 'PR Inv Customer 2', status: 'Approved' });

    // Planning rows (just enough to satisfy FK constraints)
    const plan = await PlanningExtracted.create({
      sales_order_id: so.id,
      product_id: fg.product_id,
      order_qty_display: '40',
      total_kg_display: '40',
      bom_status: 'In Progress',
      raw_materials: [{ raw_material_id: rm.id, quantity: 40, unit: 'KG' }],
      packaging_materials: [{ pack_material_id: pm.id, quantity: 40, unit: 'PCS' }],
    });
    const planBatch = await PlanningBatch.create({
      planning_extracted_id: plan.id,
      sequence: 1,
      batch_code: `PE-${plan.id}-B1`,
      size_kg: 40,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 100, uom: 'kg', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // Seed inventory rows so listPayload can compute inTransit + poQuantity.
    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 0,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });
    await WarehouseInventory.create({
      item_type: 'PM',
      raw_material_id: null,
      pack_material_id: pm.id,
      product_id: null,
      wh_stock: 0,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });

    // PR + Quotation (procurement side)
    const pr = await ProcurementRequest.create({
      planning_extracted_id: plan.id,
      planning_batch_id: planBatch.id,
      priority: 'normal',
      required_by_date: '2026-03-30',
      status: 'Pending',
      items: [
        { type: 'RM', raw_material_id: rm.id, quantity_requested: 40, unit: 'KG' },
        { type: 'PM', pack_material_id: pm.id, quantity_requested: 40, unit: 'PCS' },
      ],
    });

    const vendor = await VendorClient.create({
      entity_code: 'EI-VEN-PRINV-0002',
      type: 'vendor',
      name: 'Test Vendor 2',
      status: 'active',
    });
    await ProcurementQuotation.create({
      procurement_request_id: pr.id,
      vendor_id: vendor.id,
      status: 'confirmed',
      items: [
        { itemId: rm.code, name: rm.name, raw_material_id: rm.id, orderQty: 40, pricePerUnit: 10, uom: 'KG', totalValue: 400 },
        { itemId: pm.code, name: pm.description, pack_material_id: pm.id, orderQty: 40, pricePerUnit: 1, uom: 'PCS', totalValue: 40 },
      ],
      total_value: 440,
    });

    // PO
    const po = await PurchaseOrder.create({
      order_id: 'PO-PRINV-002',
      vendor_name: vendor.name,
      branch: 'Main',
      order_date: '2026-03-20',
      expected_shipment_date: '2026-03-25',
      reference: 'From PR',
      payment_terms: '15 days',
      status: 'Released',
      order_status: {},
      form_data: {},
      items: [
        { raw_material_id: rm.id, quantity: 40, uom: 'KG' },
        { pack_material_id: pm.id, quantity: 40, uom: 'PCS' },
      ],
    });

    // GRN in transit (stock not yet applied to wh_stock)
    const inTransitGrn = await GoodsReceivedNote.create({
      grn_no: 'GRN-PRINV-002-INTRANSIT',
      purchase_order_id: po.id,
      po_no: po.order_id,
      vendor: vendor.name,
      type: 'RM',
      status: 'In Transit',
      line_items: [
        { raw_material_id: rm.id, itemCode: rm.code, item: rm.name, poQty: 40, quantity: 40, unit: 'KG' },
        { pack_material_id: pm.id, itemCode: pm.code, item: pm.description, poQty: 40, quantity: 40, unit: 'PCS' },
      ],
      expected_date: '2026-03-25',
    });

    const pre = await warehouseInventoryController.listPayload();
    const rmRowPre = pre.rows.find((r) => r.type === 'RM' && r.sourceId === rm.id);
    const pmRowPre = pre.rows.find((r) => r.type === 'PM' && r.sourceId === pm.id);
    expect(rmRowPre).toBeDefined();
    expect(pmRowPre).toBeDefined();
    expect(Number(rmRowPre.inTransit)).toBe(40);
    expect(Number(pmRowPre.inTransit)).toBe(40);

    // Mark GRN Complete and apply inventory
    inTransitGrn.status = 'GRN Complete';
    await inTransitGrn.save();
    await applyGrnCompletionToInventory(inTransitGrn);

    const post = await warehouseInventoryController.listPayload();
    const rmRowPost = post.rows.find((r) => r.type === 'RM' && r.sourceId === rm.id);
    const pmRowPost = post.rows.find((r) => r.type === 'PM' && r.sourceId === pm.id);
    expect(Number(rmRowPost.inTransit)).toBe(0);
    expect(Number(pmRowPost.inTransit)).toBe(0);

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    expect(Number(rmInv.wh_stock)).toBe(40);
    expect(Number(pmInv.wh_stock)).toBe(40);
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });
});

