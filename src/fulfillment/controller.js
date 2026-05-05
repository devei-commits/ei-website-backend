const { Op } = require('sequelize');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, Transporter, FulfillmentInvoice, ReservedBatchItem } = require('./models');
const BOM = require('../bom/models');
const { ProductionBatch } = require('../production/models');
const SalesOrder = require('../salesOrders/models');
const VendorClient = require('../vendorClient/models');
const { loadShippingBillingByUserIds, loadAddressCityStateCountryByUserIds } = require('../addresses/clientAddressHelpers');
const { Product } = require('../products/models');
const { Order } = require('../orders/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { syncZohoInvoiceAfterFulfillment } = require('./zohoInvoiceSync');
const { validateStagedPaymentTermsJson } = require('./validateStagedPaymentTerms');
const {
  estimateOrderTotalKg,
  estimateTotalKgFromRmLines,
  batchesRequiredForOrderKg,
  buildPlanningSnapshotFromBom,
  roundPlanningMaterialQty,
} = require('../planningExtracted/orderKgMath');
const zohoEnv = require('../services/zohoEnv');

const INCLUDE_FULL = [
  {
    model: FulfillmentOrderItem,
    as: 'items',
    include: [{ model: FulfillmentBatchSplit, as: 'batchSplits' }],
  },
];

/* ── Helpers ── */

/** Build map production_batch_id -> production status/yield fields used by Fulfillment timeline. */
async function getBatchStatusMap(productionBatchIds) {
  const ids = [...new Set((productionBatchIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = await ProductionBatch.findAll({
    where: { id: ids },
    attributes: ['id', 'bmr_status', 'bpr_status', 'bulk_yield', 'fill_yield', 'fg_yield'],
  });
  const map = {};
  rows.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    map[d.id] = {
      bmr_status: d.bmr_status || null,
      bpr_status: d.bpr_status || null,
      bulk_yield: d.bulk_yield != null ? Number(d.bulk_yield) : null,
      fill_yield: d.fill_yield != null ? Number(d.fill_yield) : null,
      fg_yield: d.fg_yield != null ? Number(d.fg_yield) : null,
    };
  });
  return map;
}

/** Effective ff_status: only fg_ready when Production BPR is fg_ready; else fg_pending. Shipped/delivered stay from DB. */
function effectiveFfStatus(split, batchMap) {
  const stored = split.ff_status;
  if (['picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(stored)) return stored;
  const batchId = split.production_batch_id;
  if (batchId && batchMap[batchId]) {
    const bprStatus = batchMap[batchId].bpr_status;
    return bprStatus === 'fg_ready' ? 'fg_ready' : 'fg_pending';
  }
  return stored === 'fg_ready' ? 'fg_pending' : (stored || 'fg_pending');
}

function formatOrder(row, batchMap = {}) {
  const d = row.get ? row.get({ plain: true }) : row;
  const items = (d.items || []).map((item) => formatItem(item, batchMap));
  const allSplits = items.flatMap((i) => i.batchSplits || []);
  const soStatus = recalculateSOStatusFromSplits(allSplits);
  return {
    id: d.id,
    soNo: d.so_no,
    salesOrderId: d.sales_order_id,
    soDate: d.order_date,
    customer: d.customer_name,
    customerCity: d.customer_city,
    orderDate: d.order_date,
    dueDate: d.due_date,
    priority: d.priority,
    soStatus,
    soValue: d.so_value != null ? Number(d.so_value) : 0,
    shipAddress: d.ship_address || '',
    paymentTerms: d.payment_terms || '',
    notes: d.notes || '',
    invoiceNo: d.invoice_no || undefined,
    invoiceDate: d.invoice_date || undefined,
    awbNo: d.awb_no || undefined,
    dispatchDate: d.dispatch_date || undefined,
    courier: d.courier || undefined,
    zohoInvoiceId: d.zoho_invoice_id || undefined,
    items,
  };
}

function formatItem(d, batchMap = {}) {
  return {
    id: d.id,
    itemNo: d.item_no || '',
    sku: d.sku || '',
    productName: d.product_name,
    pack: d.pack || '',
    orderedQty: d.ordered_qty,
    rate: d.rate != null ? Number(d.rate) : 0,
    unitPrice: d.unit_price != null ? Number(d.unit_price) : 0,
    batchSplits: (d.batchSplits || []).map((s) => formatSplit(s, batchMap)),
  };
}

function formatSplit(d, batchMap = {}) {
  const ffStatus = effectiveFfStatus(d, batchMap);
  const pb = d.production_batch_id && batchMap[d.production_batch_id] ? batchMap[d.production_batch_id] : {};
  const plannedQty = Number(d.planned_qty) || 0;
  const fgQty = Number(d.fg_qty) || 0;
  const fgYield = pb.fg_yield != null ? Number(pb.fg_yield) : null;
  const fgOutput = fgQty > 0 ? fgQty : (fgYield != null ? fgYield : 0);
  const remainingQty = Math.max(0, plannedQty - fgOutput);
  const completionPercent = plannedQty > 0 ? Math.min(100, Math.round((fgOutput / plannedQty) * 100)) : 0;
  return {
    id: d.id,
    fulfillmentOrderItemId: d.fulfillment_order_item_id,
    fulfillmentOrderId: d.fulfillment_order_id,
    productionBatchId: d.production_batch_id,
    bmrNo: d.bmr_no || '',
    bprNo: d.bpr_no || '',
    plannedQty,
    fgQty,
    bmrStatus: pb.bmr_status || null,
    bprStatus: pb.bpr_status || null,
    bulkYield: pb.bulk_yield != null ? Number(pb.bulk_yield) : null,
    fillYield: pb.fill_yield != null ? Number(pb.fill_yield) : null,
    fgYield,
    fgOutput,
    remainingQty,
    completionPercent,
    fgLocation: d.fg_location,
    ffStatus,
    pickedQty: d.picked_qty || 0,
    pickerName: d.picker_name,
    pickDate: d.pick_date,
    pickSlipNo: d.pick_slip_no,
    remarks: d.remarks,
    invoiceNo: d.invoice_no,
    awbNo: d.awb_no,
    courier: d.courier,
    dispatchDate: d.dispatch_date,
    etaDate: d.eta_date,
    deliveryDate: d.delivery_date,
    receivedBy: d.received_by,
    deliveryRemarks: d.delivery_remarks,
  };
}

/** Recompute SO status from split objects that have .ffStatus (formatted). */
function recalculateSOStatusFromSplits(splits) {
  if (!splits.length) return 'planned';
  const fgSplits = splits.filter(s => s.fgQty > 0 || ['fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(s.ffStatus));
  // SO is closed only when every batch (split) is delivered/closed
  if (splits.every(s => ['delivered', 'closed'].includes(s.ffStatus))) return 'closed';
  if (!fgSplits.length) {
    if (splits.some(s => ['bulk_qc', 'wip'].includes(s.ffStatus))) return 'in_production';
    return 'planned';
  }
  if (fgSplits.some(s => ['shipped', 'delivered', 'closed'].includes(s.ffStatus))) return 'shipped';
  if (fgSplits.some(s => s.ffStatus === 'invoiced')) return 'invoiced';
  if (fgSplits.some(s => s.ffStatus === 'picking')) return 'picking';
  if (fgSplits.every(s => s.ffStatus === 'fg_ready')) return 'fg_ready';
  if (fgSplits.some(s => s.ffStatus === 'fg_ready')) return 'partial';
  if (splits.some(s => ['bulk_qc', 'wip', 'fg_pending'].includes(s.ffStatus))) return 'in_production';
  return 'planned';
}

function recalculateSOStatus(splits) {
  if (!splits.length) return 'planned';
  const fgSplits = splits.filter(s => s.fg_qty > 0 || ['fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(s.ff_status));
  // SO is closed only when every batch (split) is delivered/closed, not just the FG subset
  if (splits.every(s => ['delivered', 'closed'].includes(s.ff_status))) return 'closed';
  if (!fgSplits.length) {
    if (splits.some(s => ['bulk_qc', 'wip'].includes(s.ff_status))) return 'in_production';
    return 'planned';
  }
  if (fgSplits.some(s => ['shipped', 'delivered', 'closed'].includes(s.ff_status))) return 'shipped';
  if (fgSplits.some(s => s.ff_status === 'invoiced')) return 'invoiced';
  if (fgSplits.some(s => s.ff_status === 'picking')) return 'picking';
  if (fgSplits.every(s => s.ff_status === 'fg_ready')) return 'fg_ready';
  if (fgSplits.some(s => s.ff_status === 'fg_ready')) return 'partial';
  if (splits.some(s => ['bulk_qc', 'wip', 'fg_pending'].includes(s.ff_status))) return 'in_production';
  return 'planned';
}

/** Get next auto-incremented BMR/BPR numbers for the year (e.g. BMR-2026-001, BPR-2026-001). */
async function getNextBMRBPRSequence(year) {
  const prefix = `BMR-${year}-`;
  const batches = await ProductionBatch.findAll({
    where: { bmr_no: { [Op.like]: `${prefix}%` } },
    attributes: ['bmr_no'],
  });
  let maxNum = 0;
  for (const b of batches) {
    const num = parseInt(b.bmr_no.replace(prefix, ''), 10);
    if (!Number.isNaN(num) && num > maxNum) maxNum = num;
  }
  const next = maxNum + 1;
  const suffix = String(next).padStart(3, '0');
  return { bmrNo: `BMR-${year}-${suffix}`, bprNo: `BPR-${year}-${suffix}` };
}

/**
 * Ensure fulfillment has a batch split for every production batch linked to this SO (from Planning).
 * So the SO detail shows all batches and which are FG ready.
 */
async function syncOrderSplitsFromProduction(orderRow) {
  const d = orderRow.get ? orderRow.get({ plain: true }) : orderRow;
  const soNo = d.so_no;
  if (!soNo) return;
  const orderId = d.id;
  const items = d.items || [];
  if (!items.length) return;

  const prodBatches = await ProductionBatch.findAll({
    where: { so_no: soNo },
    attributes: ['id', 'bmr_no', 'bpr_no', 'sku', 'product_name', 'batch_size', 'order_qty', 'total_batches', 'bpr_status'],
    order: [['batch_index', 'ASC'], ['id', 'ASC']],
  });
  if (!prodBatches.length) return;

  for (const item of items) {
    const itemSku = (item.sku || '').trim().toLowerCase();
    const itemProductName = (item.product_name || '').trim().toLowerCase();
    const matchingBatches = prodBatches.filter((pb) => {
      const pbSku = (pb.sku || '').trim().toLowerCase();
      const pbName = (pb.product_name || '').trim().toLowerCase();
      return (itemSku && pbSku && itemSku === pbSku) || (itemProductName && pbName && (itemProductName === pbName || itemProductName.includes(pbName) || pbName.includes(itemProductName)));
    });

    // Used to avoid creating a 2nd split for the same production batch.
    const existingSplitBatchIds = new Set((item.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    // When SO was created before Planning created production batches, we create placeholder splits
    // with `production_batch_id = null`. Reuse those placeholders when the real batches arrive
    // so the split count doesn't inflate.
    const placeholderSplits = (item.batchSplits || []).filter((s) => !s.production_batch_id);

    for (const pb of matchingBatches) {
      const plain = pb.get ? pb.get({ plain: true }) : pb;
      if (existingSplitBatchIds.has(plain.id)) continue;

      const plannedQty = Math.max(0, Number(plain.batch_size) || 0) || Math.max(0, Math.floor((Number(plain.order_qty) || 0) / (Number(plain.total_batches) || 1)));
      const producedQty = Math.max(0, parseInt(plain.batch_size || plain.order_qty || 0, 10) || 0);
      const isFgReady = plain.bpr_status === 'fg_ready';
      const fgQty = isFgReady ? Math.min(plannedQty, producedQty) : 0;

      // Prefer updating an existing placeholder split (production_batch_id is null) to avoid duplicates.
      const placeholder = placeholderSplits.shift();
      if (placeholder && placeholder.id != null) {
        await FulfillmentBatchSplit.update(
          {
            production_batch_id: plain.id,
            bmr_no: plain.bmr_no || '',
            bpr_no: plain.bpr_no || '',
            planned_qty: plannedQty,
            fg_qty: fgQty,
            ff_status: isFgReady ? 'fg_ready' : 'fg_pending',
          },
          { where: { id: placeholder.id } }
        );
      } else {
        await FulfillmentBatchSplit.create({
          fulfillment_order_item_id: item.id,
          fulfillment_order_id: orderId,
          production_batch_id: plain.id,
          bmr_no: plain.bmr_no || '',
          bpr_no: plain.bpr_no || '',
          planned_qty: plannedQty,
          fg_qty: fgQty,
          ff_status: isFgReady ? 'fg_ready' : 'fg_pending',
        });
      }
      existingSplitBatchIds.add(plain.id);
    }
  }

  // Backfill fg_qty on existing splits that have production_batch_id but fg_qty 0 when the batch is already fg_ready
  // (e.g. split was created by sync after BPR was already marked fg_ready, so applyBprFgReadyToInventory never ran for it)
  const batchIdToProduced = {};
  prodBatches.forEach((pb) => {
    const plain = pb.get ? pb.get({ plain: true }) : pb;
    if (plain.bpr_status === 'fg_ready') {
      batchIdToProduced[plain.id] = Math.max(0, parseInt(plain.batch_size || plain.order_qty || 0, 10) || 0);
    }
  });
  const batchIdsToBackfill = Object.keys(batchIdToProduced).map(Number).filter(Boolean);
  if (batchIdsToBackfill.length === 0) return;

  const existingSplits = await FulfillmentBatchSplit.findAll({
    where: { fulfillment_order_id: orderId, production_batch_id: batchIdsToBackfill },
    order: [['production_batch_id', 'ASC'], ['id', 'ASC']],
  });
  const splitsWithZeroFg = existingSplits.filter((s) => !(Number(s.fg_qty) > 0));
  if (splitsWithZeroFg.length === 0) return;

  let remainingByBatch = { ...batchIdToProduced };
  for (const split of splitsWithZeroFg) {
    const bid = split.production_batch_id;
    const produced = remainingByBatch[bid];
    if (produced == null || produced <= 0) continue;
    const planned = Number(split.planned_qty) || 0;
    const qty = Math.min(planned, produced);
    if (qty > 0) {
      await split.update({ fg_qty: qty, ff_status: 'fg_ready' });
      remainingByBatch[bid] = produced - qty;
    }
  }
}

/* ── CRUD ── */

async function listOrders(req, res) {
  try {
    let rows = await FulfillmentOrder.findAll({
      include: INCLUDE_FULL,
      order: [['due_date', 'ASC'], ['id', 'ASC']],
    });
    for (const row of rows) {
      await syncOrderSplitsFromProduction(row);
    }
    rows = await FulfillmentOrder.findAll({
      include: INCLUDE_FULL,
      order: [['due_date', 'ASC'], ['id', 'ASC']],
    });
    const batchIds = rows.flatMap((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      return (d.items || []).flatMap((i) => (i.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    });
    const batchMap = await getBatchStatusMap(batchIds);
    res.json(rows.map((row) => formatOrder(row, batchMap)));
  } catch (err) {
    console.error('listOrders error:', err);
    res.status(500).json({ error: 'Failed to fetch fulfillment orders' });
  }
}

async function getOrderById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    let row = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
    await syncOrderSplitsFromProduction(row);
    row = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    const d = row.get ? row.get({ plain: true }) : row;
    const batchIds = (d.items || []).flatMap((i) => (i.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    const batchMap = await getBatchStatusMap(batchIds);
    res.json(formatOrder(row, batchMap));
  } catch (err) {
    console.error('getOrderById error:', err);
    res.status(500).json({ error: 'Failed to fetch fulfillment order' });
  }
}

async function createOrder(req, res) {
  try {
    const {
      soNo, salesOrderId, customer, customerCity, orderDate, dueDate,
      priority, shipAddress, paymentTerms, notes, items,
    } = req.body;

    if (!soNo || !customer) {
      return res.status(400).json({ error: 'soNo and customer are required' });
    }

    const ptErr = validateStagedPaymentTermsJson(paymentTerms);
    if (ptErr) {
      return res.status(400).json({ error: ptErr });
    }

    const createdByName = req.user ? (req.user.fullName || req.user.email) : null;

    const soValue = (items || []).reduce((sum, item) => {
      return sum + (item.orderedQty || 0) * (item.unitPrice || 0);
    }, 0);

    // Create or link a SalesOrder record
    let resolvedSalesOrderId = salesOrderId || null;
    if (!resolvedSalesOrderId) {
      const existingSO = await SalesOrder.findOne({ where: { order_id: soNo } });
      if (existingSO) {
        resolvedSalesOrderId = existingSO.id;
      } else {
        const newSO = await SalesOrder.create({
          order_id: soNo,
          customer_name: customer,
          order_date: orderDate || null,
          expected_shipment_date: dueDate || null,
          payment_terms: paymentTerms || null,
          status: 'Approved',
          items: (items || []).map((it, idx) => ({
            product_id: it.productId || null,
            sku: it.sku || '',
            productName: it.productName || '',
            pack: it.pack || '',
            quantity: it.orderedQty || 0,
            unitPrice: it.unitPrice || 0,
          })),
          created_by: createdByName,
        });
        resolvedSalesOrderId = newSO.id;

        // Auto-create planning_extracted rows from SO items + BOM (FG kg = units × fill size; RM = % of that kg)
        const PlanningExtracted = require('../planningExtracted/models');
        for (const item of (items || [])) {
          let productId = null;
          if (item.sku) {
            const prod = await Product.findOne({ where: { zoho_sku_code: item.sku } });
            if (prod) productId = prod.product_id;
          }
          if (!productId && item.productName) {
            const prod = await Product.findOne({ where: { product_name: item.productName } });
            if (prod) productId = prod.product_id;
          }
          if (!productId) continue;

          let rmLines = [];
          let pmLines = [];
          const bom = await BOM.findOne({ where: { product_id: productId } });
          if (bom) {
            const b = bom.get ? bom.get({ plain: true }) : bom;
            rmLines = Array.isArray(b.rm_lines) ? b.rm_lines : [];
            pmLines = Array.isArray(b.pm_lines) ? b.pm_lines : [];
          }

          const orderQty = item.orderedQty || 0;
          const product = await Product.findByPk(productId);
          const prodPlain = product && product.get ? product.get({ plain: true }) : product;
          const batchSizeKg = Number(prodPlain?.batch_size_kg) || 100;

          const estimatedTotalKg = estimateOrderTotalKg({
            orderQty,
            product: prodPlain,
            rmLines,
            batchSizeKg,
            batchesRequired: 1,
          });
          let safeTotalKg = estimatedTotalKg > 0 ? estimatedTotalKg : 0;
          if (safeTotalKg <= 0) {
            safeTotalKg = estimateTotalKgFromRmLines({
              rmLines,
              orderQty,
              batchSizeKg,
              batchesRequired: 1,
            });
          }
          if (safeTotalKg <= 0) {
            safeTotalKg = roundPlanningMaterialQty(batchSizeKg);
          }
          const batchesRequired = batchesRequiredForOrderKg(safeTotalKg, batchSizeKg);
          const { raw_materials, packaging_materials } = buildPlanningSnapshotFromBom(
            rmLines,
            pmLines,
            orderQty,
            safeTotalKg,
            batchSizeKg,
          );

          await PlanningExtracted.create({
            sales_order_id: newSO.id,
            product_id: productId,
            order_qty_display: `${orderQty} units`,
            total_kg_display: safeTotalKg ? `${safeTotalKg} KG` : null,
            order_date: orderDate || null,
            due_date: dueDate || null,
            batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
            batches_required: batchesRequired,
            batch_count: 0,
            batch_size_kg: batchSizeKg,
            bom_status: bom ? 'Confirmed' : 'Pending',
            // BOM is never auto-confirmed on SO creation: planner must confirm BOM + SG on first-batch flow.
            bom_confirmed_at: null,
            approved_by: createdByName,
            raw_materials,
            packaging_materials,
          });
        }
      }
    }

    const order = await FulfillmentOrder.create({
      so_no: soNo,
      sales_order_id: resolvedSalesOrderId,
      customer_name: customer,
      customer_city: customerCity || null,
      order_date: orderDate || null,
      due_date: dueDate || null,
      priority: priority || 'normal',
      so_status: 'planned',
      so_value: soValue,
      ship_address: shipAddress || null,
      payment_terms: paymentTerms || null,
      notes: notes || null,
    });

    if (items && items.length) {
      const soSuffix = soNo.replace(/\D/g, '').slice(-4) || String(order.id).padStart(4, '0');
      let splitCounter = 0;
      const totalSplits = items.reduce((sum, it) => sum + (it.batchSplits?.length || 1), 0);

      for (const item of items) {
        const orderItem = await FulfillmentOrderItem.create({
          fulfillment_order_id: order.id,
          item_no: item.itemNo || '001',
          sku: item.sku || null,
          product_name: item.productName,
          pack: item.pack || null,
          ordered_qty: item.orderedQty || 0,
          rate: item.unitPrice || 0,
          unit_price: item.unitPrice || 0,
        });

        const splits = item.batchSplits || [{ plannedQty: item.orderedQty }];
        for (const split of splits) {
          splitCounter++;
          let productionBatchId = null;
          let bmrNo = split.bmrNo || null;
          let bprNo = split.bprNo || null;

          // IMPORTANT: Fulfillment SO creation MUST NOT auto-generate new BMR/BPR numbers.
          // BMR/BPR should only be created later by Planning when the user confirms BOM per batch.
          // Here we only link to *already existing* production batches when the request includes bmrNo/bprNo.
          let pb = null;
          if (bmrNo) {
            pb = await ProductionBatch.findOne({ where: { bmr_no: bmrNo } });
          }
          if (!pb && bprNo) {
            pb = await ProductionBatch.findOne({ where: { bpr_no: bprNo } });
          }
          if (pb) {
            productionBatchId = pb.id;
            bmrNo = pb.bmr_no;
            bprNo = pb.bpr_no;
          }

          await FulfillmentBatchSplit.create({
            fulfillment_order_item_id: orderItem.id,
            fulfillment_order_id: order.id,
            production_batch_id: productionBatchId,
            bmr_no: bmrNo,
            bpr_no: bprNo,
            planned_qty: split.plannedQty || 0,
            fg_qty: split.fgQty || 0,
            fg_location: split.fgLocation || null,
            ff_status: split.ffStatus || 'fg_pending',
          });

          // Reserve RM/PM for this SO batch: BOM qty × planned qty → reserved_batch_items
          const plannedQty = split.plannedQty || item.orderedQty || 0;
          let productId = null;
          if (item.sku) {
            const prod = await Product.findOne({ where: { zoho_sku_code: item.sku } });
            if (prod) productId = prod.product_id;
          }
          if (!productId && item.productName) {
            const prod = await Product.findOne({ where: { product_name: item.productName } });
            if (prod) productId = prod.product_id;
          }
          // Only reserve if we are linked to an existing production batch.
          // When BMR/BPR are not created yet (expected), reservation happens later in production flow.
          if (productionBatchId && productId && plannedQty > 0) {
            const bom = await BOM.findOne({ where: { product_id: productId } });
            if (bom) {
              const rmLines = Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
              const pmLines = Array.isArray(bom.pm_lines) ? bom.pm_lines : [];
              for (const line of rmLines) {
                let rm = null;
                if (line.raw_material_id != null) {
                  rm = await RawMaterial.findByPk(line.raw_material_id);
                }
                if (!rm) {
                  const code = line.rm_code || line.rmCode || line.code;
                  if (!code) continue;
                  rm = await RawMaterial.findOne({ where: { code } });
                }
                if (!rm) continue;
                const qtyPerUnit = line.quantity != null ? Number(line.quantity) : (line.pct_w_w != null ? Number(line.pct_w_w) / 100 : 0);
                const qtyReserved = qtyPerUnit * plannedQty;
                if (qtyReserved <= 0) continue;
                await ReservedBatchItem.create({
                  production_batch_id: productionBatchId,
                  fulfillment_order_item_id: orderItem.id,
                  raw_material_id: rm.id,
                  pack_material_id: null,
                  quantity_reserved: qtyReserved,
                  unit: line.uom || 'KG',
                  so_no: soNo,
                });
              }
              for (const line of pmLines) {
                let pm = null;
                if (line.pack_material_id != null) {
                  pm = await PackMaterial.findByPk(line.pack_material_id);
                }
                if (!pm) {
                  const code = line.pm_code || line.pmCode || line.code;
                  if (!code) continue;
                  pm = await PackMaterial.findOne({ where: { code } });
                }
                if (!pm) continue;
                const qtyPerUnit = line.qty_per_unit != null ? Number(line.qty_per_unit) : 1;
                const qtyReserved = qtyPerUnit * plannedQty;
                if (qtyReserved <= 0) continue;
                await ReservedBatchItem.create({
                  production_batch_id: productionBatchId,
                  fulfillment_order_item_id: orderItem.id,
                  raw_material_id: null,
                  pack_material_id: pm.id,
                  quantity_reserved: qtyReserved,
                  unit: line.uom || 'PCS',
                  so_no: soNo,
                });
              }
            }
          }
        }
      }
    }

    const created = await FulfillmentOrder.findByPk(order.id, { include: INCLUDE_FULL });
    res.status(201).json(formatOrder(created));
  } catch (err) {
    console.error('createOrder error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A fulfillment order with this SO number already exists' });
    }
    res.status(500).json({ error: 'Failed to create fulfillment order' });
  }
}

async function updateOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FulfillmentOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });

    const CAMEL_MAP = {
      soNo: 'so_no', salesOrderId: 'sales_order_id',
      customer: 'customer_name', customerCity: 'customer_city',
      orderDate: 'order_date', dueDate: 'due_date',
      soStatus: 'so_status', soValue: 'so_value',
      shipAddress: 'ship_address', paymentTerms: 'payment_terms',
      invoiceNo: 'invoice_no', invoiceDate: 'invoice_date',
      awbNo: 'awb_no', dispatchDate: 'dispatch_date',
    };
    const ALLOWED = [
      'so_no', 'sales_order_id', 'customer_name', 'customer_city',
      'order_date', 'due_date', 'priority', 'so_status', 'so_value',
      'ship_address', 'payment_terms', 'notes',
      'invoice_no', 'invoice_date', 'awb_no', 'dispatch_date', 'courier',
    ];

    if (req.body.payment_terms !== undefined || req.body.paymentTerms !== undefined) {
      const ptToCheck = req.body.paymentTerms !== undefined ? req.body.paymentTerms : req.body.payment_terms;
      const ptErr = validateStagedPaymentTermsJson(ptToCheck);
      if (ptErr) return res.status(400).json({ error: ptErr });
    }

    for (const k of ALLOWED) {
      if (req.body[k] !== undefined) row.set(k, req.body[k]);
    }
    for (const [camel, snake] of Object.entries(CAMEL_MAP)) {
      if (req.body[camel] !== undefined) row.set(snake, req.body[camel]);
    }

    await row.save();
    const updated = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(updated));
  } catch (err) {
    console.error('updateOrder error:', err);
    res.status(500).json({ error: 'Failed to update fulfillment order' });
  }
}

async function deleteOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FulfillmentOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
    await row.destroy();
    res.json({ message: 'Fulfillment order deleted' });
  } catch (err) {
    console.error('deleteOrder error:', err);
    res.status(500).json({ error: 'Failed to delete fulfillment order' });
  }
}

/* ── Workflow Actions ── */

async function pickSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { splits, pickerName, pickDate, pickSlipNo, remarks } = req.body;
    if (!pickerName || !splits || !splits.length) {
      return res.status(400).json({ error: 'pickerName and splits are required' });
    }

    for (const pickInfo of splits) {
      const split = await FulfillmentBatchSplit.findOne({
        where: { fulfillment_order_id: id, bpr_no: pickInfo.bprNo },
      });
      if (!split) continue;
      const stored = split.ff_status;
      let canPick = stored === 'fg_ready';
      if (!canPick && stored === 'fg_pending' && split.production_batch_id) {
        const batch = await ProductionBatch.findByPk(split.production_batch_id, { attributes: ['bpr_status'] });
        const bprStatus = batch && (batch.get ? batch.get('bpr_status') : batch.bpr_status);
        canPick = bprStatus === 'fg_ready';
      }
      if (canPick) {
        split.set({
          ff_status: 'picking',
          picked_qty: pickInfo.pickedQty || split.fg_qty,
          picker_name: pickerName,
          pick_date: pickDate || new Date().toISOString().slice(0, 10),
          pick_slip_no: pickSlipNo || null,
          remarks: remarks || null,
        });
        await split.save();
      }
    }

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save();

    // Mirror stage into website orders table when picking starts
    await Order.update({ fulfillment_stage: 'packaged' }, { where: { so_no: order.so_no } });

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('pickSplits error:', err);
    res.status(500).json({ error: 'Failed to process pick' });
  }
}

async function invoiceSplits(req, res) {
  const tx = await FulfillmentOrder.sequelize.transaction();
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      await tx.rollback();
      return res.status(400).json({ error: 'Invalid id' });
    }

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL, transaction: tx });
    if (!order) {
      await tx.rollback();
      return res.status(404).json({ error: 'Fulfillment order not found' });
    }

    const { invoiceNo, invoiceDate, courier, bprNos } = req.body;
    if (!invoiceNo) {
      await tx.rollback();
      return res.status(400).json({ error: 'invoiceNo is required' });
    }

    const where = { fulfillment_order_id: id, ff_status: 'picking' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      where.bpr_no = { [Op.in]: bprNos };
    }
    await FulfillmentBatchSplit.update(
      { ff_status: 'invoiced', invoice_no: invoiceNo },
      { where, transaction: tx }
    );

    order.set({
      invoice_no: invoiceNo,
      invoice_date: invoiceDate || new Date().toISOString().slice(0, 10),
      courier: courier || null,
    });

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id }, transaction: tx });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save({ transaction: tx });

    // Mirror stage into website orders table when invoiced
    await Order.update({ fulfillment_stage: 'invoiced' }, { where: { so_no: order.so_no }, transaction: tx });

    const {
      vendorClientId,
      vendor_client_id: vendorClientIdSnake,
      userId,
      user_id: userIdSnake,
      lineItems: zohoLineItems,
    } = req.body || {};

    const zoho = await syncZohoInvoiceAfterFulfillment({
      fulfillmentOrder: order,
      lineItemsFromBody: Array.isArray(zohoLineItems) && zohoLineItems.length > 0 ? zohoLineItems : null,
      invoiceNo,
      invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      dueDate: null,
      vendorClientId: vendorClientId ?? vendorClientIdSnake,
      userId: userId ?? userIdSnake,
    });
    if (zohoEnv.booksEnabled && zohoEnv.syncInvoices && !zoho.synced) {
      const err = new Error(zoho.error || 'zoho_invoice_sync_failed');
      err.statusCode = 502;
      err.clientMessage = `Invoice created locally but Zoho sync failed (${zoho.error || 'unknown_error'}). Changes were rolled back.`;
      throw err;
    }
    if (zoho.synced && zoho.invoiceId) {
      await order.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
    }

    await tx.commit();
    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    if (!tx.finished) await tx.rollback();
    console.error('invoiceSplits error:', err);
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.clientMessage || err.message || 'Zoho invoice sync failed' });
    }
    res.status(500).json({ error: 'Failed to process invoice' });
  }
}

async function shipSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { awbNo, courier, dispatchDate, eta, bprNos } = req.body;

    const where = { fulfillment_order_id: id, ff_status: 'invoiced' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      where.bpr_no = { [Op.in]: bprNos };
    }
    await FulfillmentBatchSplit.update(
      {
        ff_status: 'shipped',
        awb_no: awbNo || null,
        courier: courier || null,
        dispatch_date: dispatchDate || new Date().toISOString().slice(0, 10),
        eta_date: eta || null,
      },
      { where }
    );

    order.set({
      awb_no: awbNo || null,
      dispatch_date: dispatchDate || new Date().toISOString().slice(0, 10),
      courier: courier || null,
    });

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save();

    // Mirror stage into website orders table when shipped
    await Order.update({ fulfillment_stage: 'shipped' }, { where: { so_no: order.so_no } });

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('shipSplits error:', err);
    res.status(500).json({ error: 'Failed to process shipment' });
  }
}

async function deliverSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { deliveryDate, receivedBy, remarks, bprNos } = req.body;

    const where = { fulfillment_order_id: id, ff_status: 'shipped' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      where.bpr_no = { [Op.in]: bprNos };
    }

    // Mark the delivered batch(es) as closed (done). SO closes only when all batches are closed.
    await FulfillmentBatchSplit.update(
      {
        ff_status: 'closed',
        delivery_date: deliveryDate || new Date().toISOString().slice(0, 10),
        received_by: receivedBy || null,
        delivery_remarks: remarks || null,
      },
      { where }
    );

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    const newStatus = recalculateSOStatus(allSplits);
    order.set('so_status', newStatus);
    await order.save();

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('deliverSplits error:', err);
    res.status(500).json({ error: 'Failed to process delivery' });
  }
}

/* ── Batch Splits list (for Products & Batches view) ── */

async function listBatchSplits(req, res) {
  try {
    const splits = await FulfillmentBatchSplit.findAll({
      include: [
        {
          model: FulfillmentOrderItem,
          as: 'orderItem',
          attributes: ['id', 'sku', 'product_name', 'pack', 'ordered_qty', 'unit_price'],
        },
        {
          model: FulfillmentOrder,
          as: 'fulfillmentOrder',
          attributes: ['id', 'so_no', 'customer_name', 'customer_city', 'order_date', 'due_date', 'priority'],
        },
      ],
      order: [['fulfillment_order_id', 'ASC'], ['id', 'ASC']],
    });

    const batchIds = splits.map((row) => {
      const d = row.get({ plain: true });
      return d.production_batch_id;
    }).filter(Boolean);
    const batchMap = await getBatchStatusMap(batchIds);

    res.json(splits.map(row => {
      const d = row.get({ plain: true });
      const formatted = formatSplit(d, batchMap);
      return {
        ...formatted,
        product: {
          sku: d.orderItem?.sku || '',
          productName: d.orderItem?.product_name || '',
          pack: d.orderItem?.pack || '',
          orderedQty: d.orderItem?.ordered_qty || 0,
          unitPrice: d.orderItem?.unit_price != null ? Number(d.orderItem.unit_price) : 0,
        },
        order: {
          id: d.fulfillmentOrder?.id,
          soNo: d.fulfillmentOrder?.so_no || '',
          customer: d.fulfillmentOrder?.customer_name || '',
          customerCity: d.fulfillmentOrder?.customer_city || '',
          orderDate: d.fulfillmentOrder?.order_date,
          dueDate: d.fulfillmentOrder?.due_date,
          priority: d.fulfillmentOrder?.priority || 'normal',
        },
      };
    }));
  } catch (err) {
    console.error('listBatchSplits error:', err);
    res.status(500).json({ error: 'Failed to fetch batch splits' });
  }
}

/* ── Lookup endpoints for AddSOModal ── */

/** First non-empty string from JSON `data` for given keys (camelCase + common variants). */
function pickDataStr(data, keys) {
  if (!data || typeof data !== 'object') return '';
  for (const k of keys) {
    const v = data[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

async function getNextSoNo(_req, res) {
  try {
    const latest = await FulfillmentOrder.findOne({
      order: [['id', 'DESC']],
      attributes: ['so_no'],
    });

    let nextNum = 1;
    if (latest && latest.so_no) {
      const match = latest.so_no.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    const year = new Date().getFullYear();
    const soNo = `EI-SO-${year}-${String(nextNum).padStart(3, '0')}`;
    res.json({ soNo });
  } catch (err) {
    console.error('getNextSoNo error:', err);
    res.status(500).json({ error: 'Failed to generate SO number' });
  }
}

async function getCustomers(_req, res) {
  try {
    const clients = await VendorClient.findAll({
      where: { type: 'client', status: 'active' },
      attributes: [
        'id', 'entity_code', 'name', 'city', 'location', 'country',
        'email', 'phone', 'category', 'notes', 'priority', 'segment',
        'payment_terms', 'contacts', 'data', 'user_id',
      ],
      order: [['name', 'ASC']],
    });

    const userIds = clients.map((c) => c.user_id).filter((id) => id != null);
    const [addrByUser, geoByUser] = await Promise.all([
      loadShippingBillingByUserIds(userIds),
      loadAddressCityStateCountryByUserIds(userIds),
    ]);

    res.json(clients.map(c => {
      const d = c.get({ plain: true });
      const data = d.data && typeof d.data === 'object' ? d.data : {};
      const fromTable = d.user_id != null ? addrByUser.get(Number(d.user_id)) : null;
      const geo = d.user_id != null ? geoByUser.get(Number(d.user_id)) : null;
      const shipFallback = data.shipping_address || data.shippingAddress || '';
      const billFallback = data.billing_address || data.billingAddress || '';
      const shippingAddress = (fromTable && fromTable.shipping) || shipFallback || '';
      const billingAddress = (fromTable && fromTable.billing) || billFallback || '';
      const contacts = Array.isArray(d.contacts) ? d.contacts : [];
      const contactLine = contacts.length
        ? contacts.map((x) => [x.name, x.role].filter(Boolean).join(' — ')).join('; ')
        : '';
      const city =
        (geo && geo.city) ||
        pickDataStr(data, ['city', 'City']) ||
        (d.city != null && String(d.city).trim() ? String(d.city).trim() : '');
      const state =
        (geo && geo.state) ||
        pickDataStr(data, ['state', 'State', 'region', 'Region']) ||
        (d.location != null && String(d.location).trim() ? String(d.location).trim() : '');
      const country =
        (geo && geo.country) ||
        pickDataStr(data, ['country', 'Country']) ||
        (d.country != null && String(d.country).trim() ? String(d.country).trim() : '');
      return {
        id: d.id,
        code: d.entity_code,
        name: d.name,
        city,
        state,
        country,
        /** State/region — same as `state` (legacy key for FE). */
        location: state,
        email: d.email || '',
        phone: d.phone || '',
        category: d.category || '',
        notes: d.notes || '',
        priority: d.priority || '',
        segment: d.segment || '',
        contacts,
        contactLine,
        paymentTerms: d.payment_terms || '',
        shippingAddress: shippingAddress || '',
        billingAddress: billingAddress || '',
        creditLimit: data.creditLimit != null ? String(data.creditLimit) : '',
        /** Keys used with ClientForm payables + receivables credit days (Fulfillment SO staging). */
        clientData: {
          payablesAdvancedPct: data.payablesAdvancedPct,
          payablesBeforeDispatchPct: data.payablesBeforeDispatchPct,
          payablesAfterDispatchPct: data.payablesAfterDispatchPct,
          receivablesCreditDays: data.receivablesCreditDays,
        },
      };
    }));
  } catch (err) {
    console.error('getCustomers error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}

/** Products lookup for Add SO modal: only Finished Goods (FG). RMs and PMs are materials used to build FGs. */
function derivePackSizeForFulfillmentRow(fillSize, productName) {
  const fromFill = String(fillSize || '').trim();
  if (fromFill) return fromFill;
  const n = String(productName || '').trim();
  if (!n) return '';
  const m = n.match(/(\d+(?:\.\d+)?)\s*(ML|MILLILIT(?:ER|RE)S?|L|LTR|LT|LIT(?:ER|RE)S?|G|GM|GRAMS?|KG|KGS|KILOGRAMS?)\b/i);
  if (!m) return '';
  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return '';
  const uRaw = String(m[2] || '').trim().toUpperCase();
  const uom =
    uRaw === 'ML' || uRaw.startsWith('MILLI') ? 'ML'
      : (uRaw === 'L' || uRaw === 'LTR' || uRaw === 'LT' || uRaw.startsWith('LIT')) ? 'L'
        : (uRaw === 'G' || uRaw === 'GM' || uRaw.startsWith('GRAM')) ? 'G'
          : (uRaw === 'KG' || uRaw === 'KGS' || uRaw.startsWith('KILO')) ? 'KG'
            : '';
  if (!uom) return '';
  return `${qty % 1 === 0 ? String(Math.trunc(qty)) : String(qty)} ${uom}`;
}

async function getProducts(_req, res) {
  try {
    const products = await Product.findAll({
      attributes: ['product_id', 'product_code', 'product_name', 'zoho_sku_code', 'fill_size', 'form', 'category', 'mrp_price'],
      order: [['product_name', 'ASC']],
    });

    const items = products.map(p => {
      const d = p.get({ plain: true });
      return {
        id: `PR-${d.product_id}`,
        type: 'product',
        name: d.product_name || d.product_code,
        sku: d.zoho_sku_code || d.product_code || '',
        pack: derivePackSizeForFulfillmentRow(d.fill_size, d.product_name),
        category: d.category || '',
        price: d.mrp_price != null ? Number(d.mrp_price) : 0,
      };
    });

    res.json(items);
  } catch (err) {
    console.error('getProducts error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
}

/* ── Transporters ── */

async function listTransporters(_req, res) {
  try {
    const rows = await Transporter.findAll({
      where: { status: 'active' },
      order: [['name', 'ASC']],
    });
    res.json(rows.map(r => {
      const d = r.get({ plain: true });
      return { id: d.id, name: d.name, code: d.code, phone: d.contact_phone, email: d.contact_email, trackingUrl: d.tracking_url };
    }));
  } catch (err) {
    console.error('listTransporters error:', err);
    res.status(500).json({ error: 'Failed to fetch transporters' });
  }
}

/* ── Invoice endpoints ── */

async function getNextInvoiceNo(_req, res) {
  try {
    const latest = await FulfillmentInvoice.findOne({
      order: [['id', 'DESC']],
      attributes: ['invoice_no'],
    });

    let nextNum = 1;
    if (latest && latest.invoice_no) {
      const match = latest.invoice_no.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    const year = new Date().getFullYear();
    const invoiceNo = `INV-${year}-${String(nextNum).padStart(4, '0')}`;
    res.json({ invoiceNo });
  } catch (err) {
    console.error('getNextInvoiceNo error:', err);
    res.status(500).json({ error: 'Failed to generate invoice number' });
  }
}

/**
 * POST /fulfillment/invoices — Zoho sync reads Books ids from local DB:
 * Body: `vendorClientId` / `vendor_client_id` (vendor_clients.id → zoho_id) or `userId` / `user_id` (users → zoho_contact_id).
 * lineItems: `{ productId }` / `{ rawMaterialId }` / `{ packMaterialId }` (+ optional rate, qty, name) → products.zoho_item_id / raw_materials.zoho_id / pack_materials.zoho_id.
 */
async function createInvoice(req, res) {
  const tx = await FulfillmentOrder.sequelize.transaction();
  try {
    const {
      fulfillmentOrderId, invoiceNo, invoiceDate, dueDate,
      preparedBy, transporterId, transporterName, lrAwbNo,
      remarks, subtotal, gstPercent, totalValue, lineItems, bprNos,
      vendorClientId, vendor_client_id, userId, user_id,
    } = req.body;

    if (!fulfillmentOrderId || !invoiceNo) {
      await tx.rollback();
      return res.status(400).json({ error: 'fulfillmentOrderId and invoiceNo are required' });
    }

    const order = await FulfillmentOrder.findByPk(fulfillmentOrderId, { transaction: tx });
    if (!order) {
      await tx.rollback();
      return res.status(404).json({ error: 'Fulfillment order not found' });
    }

    const splitWhere = { fulfillment_order_id: fulfillmentOrderId, ff_status: 'picking' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      splitWhere.bpr_no = { [Op.in]: bprNos };
    }

    const invoice = await FulfillmentInvoice.create({
      invoice_no: invoiceNo,
      fulfillment_order_id: fulfillmentOrderId,
      invoice_date: invoiceDate || new Date().toISOString().slice(0, 10),
      due_date: dueDate || null,
      prepared_by: preparedBy || null,
      transporter_id: transporterId || null,
      transporter_name: transporterName || null,
      lr_awb_no: lrAwbNo || null,
      remarks: remarks || null,
      subtotal: subtotal || 0,
      gst_percent: gstPercent ?? 18,
      total_value: totalValue || 0,
      status: 'confirmed',
      line_items: lineItems || null,
    }, { transaction: tx });

    await FulfillmentBatchSplit.update(
      { ff_status: 'invoiced', invoice_no: invoiceNo },
      { where: splitWhere, transaction: tx }
    );

    order.set({ invoice_no: invoiceNo, invoice_date: invoiceDate || new Date().toISOString().slice(0, 10), courier: transporterName || null });
    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: fulfillmentOrderId }, transaction: tx });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save({ transaction: tx });

    const zoho = await syncZohoInvoiceAfterFulfillment({
      fulfillmentOrder: order,
      lineItemsFromBody: lineItems,
      invoiceNo,
      invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      dueDate: dueDate || null,
      vendorClientId: vendorClientId ?? vendor_client_id,
      userId: userId ?? user_id,
    });
    if (zohoEnv.booksEnabled && zohoEnv.syncInvoices && !zoho.synced) {
      const err = new Error(zoho.error || 'zoho_invoice_sync_failed');
      err.statusCode = 502;
      err.clientMessage = `Invoice created locally but Zoho sync failed (${zoho.error || 'unknown_error'}). Changes were rolled back.`;
      throw err;
    }
    if (zoho.synced && zoho.invoiceId) {
      await invoice.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
      await order.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
    }
    await tx.commit();
    await invoice.reload();

    const d = invoice.get({ plain: true });
    res.status(201).json({
      id: d.id,
      invoiceNo: d.invoice_no,
      fulfillmentOrderId: d.fulfillment_order_id,
      invoiceDate: d.invoice_date,
      dueDate: d.due_date,
      preparedBy: d.prepared_by,
      transporterId: d.transporter_id,
      transporterName: d.transporter_name,
      lrAwbNo: d.lr_awb_no,
      remarks: d.remarks,
      subtotal: d.subtotal != null ? Number(d.subtotal) : 0,
      gstPercent: d.gst_percent != null ? Number(d.gst_percent) : 18,
      totalValue: d.total_value != null ? Number(d.total_value) : 0,
      status: d.status,
      lineItems: d.line_items,
      zoho_invoice_id: zoho.invoiceId || d.zoho_invoice_id || null,
      zoho_sync: zoho.synced ? { synced: true } : zoho.error && zoho.error !== 'zoho_invoices_disabled' ? { synced: false, error: zoho.error } : undefined,
    });
  } catch (err) {
    if (!tx.finished) await tx.rollback();
    console.error('createInvoice error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'An invoice with this number already exists' });
    }
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.clientMessage || err.message || 'Zoho invoice sync failed' });
    }
    res.status(500).json({ error: 'Failed to create invoice' });
  }
}

async function listInvoices(req, res) {
  try {
    const where = {};
    if (req.query.fulfillment_order_id) where.fulfillment_order_id = req.query.fulfillment_order_id;

    const rows = await FulfillmentInvoice.findAll({
      where,
      include: [{ model: Transporter, as: 'transporter', attributes: ['id', 'name', 'code'] }],
      order: [['id', 'DESC']],
    });

    res.json(rows.map(r => {
      const d = r.get({ plain: true });
      return {
        id: d.id,
        invoiceNo: d.invoice_no,
        fulfillmentOrderId: d.fulfillment_order_id,
        invoiceDate: d.invoice_date,
        dueDate: d.due_date,
        preparedBy: d.prepared_by,
        transporterName: d.transporter_name || d.transporter?.name || '',
        lrAwbNo: d.lr_awb_no,
        subtotal: d.subtotal != null ? Number(d.subtotal) : 0,
        gstPercent: d.gst_percent != null ? Number(d.gst_percent) : 18,
        totalValue: d.total_value != null ? Number(d.total_value) : 0,
        status: d.status,
        lineItems: d.line_items,
        zohoInvoiceId: d.zoho_invoice_id || null,
      };
    }));
  } catch (err) {
    console.error('listInvoices error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
}

/**
 * GET /api/v1/fulfillment/so-planning-availability?so_no=EI-SO-YYYY-XXX
 *
 * Returns per-product planning batch availability (RM/PM) based on current
 * warehouse inventory (available = stock_in_hand - reserved), plus for each planning
 * batch: needed vs already requested (reserved_batch_items) totals.
 */
async function getSoPlanningAvailability(req, res) {
  try {
    const soNo = String(req.query.so_no || '').trim();
    if (!soNo) return res.status(400).json({ error: 'so_no is required' });
    console.log('[FULFILLMENT-AVAIL] START', { soNo });

    const PlanningExtracted = require('../planningExtracted/models');
    const PlanningBatch = require('../planningExtracted/planningBatchModel');
    const { ProductionBatch: ProductionBatchModel } = require('../production/models');
    const { Product: ProductModel } = require('../products/models');

    const salesOrder = await SalesOrder.findOne({
      where: { order_id: soNo },
      attributes: ['id', 'order_id'],
    });
    if (!salesOrder) {
      console.log('[FULFILLMENT-AVAIL] NO_SALES_ORDER_MATCH', { soNo });
      return res.json({ success: true, soNo, items: [] });
    }
    console.log('[FULFILLMENT-AVAIL] SALES_ORDER_MATCH', { soNo, salesOrderId: salesOrder.id, orderId: salesOrder.order_id });

    const planningRows = await PlanningExtracted.findAll({
      where: { sales_order_id: salesOrder.id },
      attributes: ['id', 'batch_count', 'order_qty_display', 'sent_batch_indices'],
      include: [
        { model: ProductModel, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'zoho_sku_code'] },
      ],
    });
    console.log('[FULFILLMENT-AVAIL] PLANNING_ROWS', {
      soNo,
      planningRowCount: planningRows.length,
      planningRowIds: planningRows.map((r) => (r.get ? r.get('id') : r.id)),
    });

    const items = [];

    for (const plan of planningRows) {
      const planPlain = plan.get ? plan.get({ plain: true }) : plan;
      const planId = planPlain.id;
      const totalBatches = Number(planPlain.batch_count ?? 0) || 0;
      const sentIndices = Array.isArray(planPlain.sent_batch_indices) ? planPlain.sent_batch_indices : [];

      const planningBatches = await PlanningBatch.findAll({
        where: { planning_extracted_id: planId },
        order: [['sequence', 'ASC']],
        attributes: ['id', 'sequence', 'size_kg', 'rm_lines', 'pm_lines', 'batch_code'],
      });
      console.log('[FULFILLMENT-AVAIL] PLAN_BATCHES', {
        soNo,
        planningExtractedId: planId,
        totalBatchesConfigured: totalBatches,
        planningBatchCount: planningBatches.length,
        sentIndices,
      });

      const effectiveTotalBatches = totalBatches > 0 ? totalBatches : planningBatches.length;
      const sentCount = planningBatches.filter((b) => sentIndices.includes((b.sequence ?? 1) - 1)).length;

      // Collect required RM/PM identifiers across planning batches for this PI.
      // Prefer explicit IDs when present (raw_material_id / pack_material_id), else fall back to codes.
      const requiredRmIds = new Set();
      const requiredPmIds = new Set();
      const requiredRmCodes = new Set();
      const requiredPmCodes = new Set();
      for (const b of planningBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        const pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
        for (const line of rmLines) {
          const id = line.raw_material_id ?? line.rawMaterialId;
          if (id != null) {
            const n = Number(id);
            if (!Number.isNaN(n)) requiredRmIds.add(n);
          } else {
            const code = line.rm_code || line.rmCode || line.code;
            if (code) requiredRmCodes.add(code);
          }
        }
        for (const line of pmLines) {
          const id = line.pack_material_id ?? line.packMaterialId;
          if (id != null) {
            const n = Number(id);
            if (!Number.isNaN(n)) requiredPmIds.add(n);
          } else {
            const code = line.pm_code || line.pmCode || line.code;
            if (code) requiredPmCodes.add(code);
          }
        }
      }

      const rmListById = requiredRmIds.size
        ? await RawMaterial.findAll({ where: { id: { [Op.in]: [...requiredRmIds] } }, attributes: ['id', 'code'] })
        : [];
      const rmListByCode = requiredRmCodes.size
        ? await RawMaterial.findAll({ where: { code: { [Op.in]: [...requiredRmCodes] } }, attributes: ['id', 'code'] })
        : [];
      const rmList = [...rmListById, ...rmListByCode].filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i);

      const pmListById = requiredPmIds.size
        ? await PackMaterial.findAll({ where: { id: { [Op.in]: [...requiredPmIds] } }, attributes: ['id', 'code'] })
        : [];
      const pmListByCode = requiredPmCodes.size
        ? await PackMaterial.findAll({ where: { code: { [Op.in]: [...requiredPmCodes] } }, attributes: ['id', 'code'] })
        : [];
      const pmList = [...pmListById, ...pmListByCode].filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i);
      console.log('[FULFILLMENT-AVAIL] REQUIRED_ITEMS', {
        soNo,
        planningExtractedId: planId,
        requiredRmIds: [...requiredRmIds],
        requiredRmCodes: [...requiredRmCodes],
        resolvedRmIds: rmList.map((r) => (r.get ? r.get('id') : r.id)),
        requiredPmIds: [...requiredPmIds],
        requiredPmCodes: [...requiredPmCodes],
        resolvedPmIds: pmList.map((p) => (p.get ? p.get('id') : p.id)),
      });

      const rmCodeToId = new Map(rmList.map((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        return [d.code, d.id];
      }));
      const pmCodeToId = new Map(pmList.map((p) => {
        const d = p.get ? p.get({ plain: true }) : p;
        return [d.code, d.id];
      }));

      // Fetch current warehouse availability for these RM/PM codes.
      const rmIds = rmList.map((r) => (r.get ? r.get({ plain: true }).id : r.id));
      const pmIds = pmList.map((p) => (p.get ? p.get({ plain: true }).id : p.id));

      const rmInvRows = rmIds.length
        ? await WarehouseInventory.findAll({ where: { item_type: 'RM', raw_material_id: { [Op.in]: rmIds } }, attributes: ['raw_material_id', 'stock_in_hand', 'reserved'] })
        : [];
      const pmInvRows = pmIds.length
        ? await WarehouseInventory.findAll({ where: { item_type: 'PM', pack_material_id: { [Op.in]: pmIds } }, attributes: ['pack_material_id', 'stock_in_hand', 'reserved'] })
        : [];

      const rmAvailableById = {};
      rmInvRows.forEach((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        const avail = Number(d.stock_in_hand ?? 0) - Number(d.reserved ?? 0);
        rmAvailableById[d.raw_material_id] = Math.max(0, avail);
      });
      const pmAvailableById = {};
      pmInvRows.forEach((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        const avail = Number(d.stock_in_hand ?? 0) - Number(d.reserved ?? 0);
        pmAvailableById[d.pack_material_id] = Math.max(0, avail);
      });
      console.log('[FULFILLMENT-AVAIL] INVENTORY_AVAILABLE', {
        soNo,
        planningExtractedId: planId,
        rmAvailableById,
        pmAvailableById,
      });

      // For each planning batch: compute RM/PM required totals + for simulation per-code availability.
      const batchRequired = new Map(); // planningBatchId -> { rmReqById, rmNeededTotal, pmReqById, pmNeededTotal }
      const batchNeededTotals = new Map(); // planningBatchId -> { rmNeededTotal, pmNeededTotal }
      let rmLineTotalCount = 0;
      let rmLineAvailableCount = 0;
      let pmLineTotalCount = 0;
      let pmLineAvailableCount = 0;

      for (const b of planningBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const planningBatchId = plain.id;
        const sizeKg = plain.size_kg != null ? Number(plain.size_kg) : 0;

        const rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        const pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];

        const rmReqById = {};
        let rmNeededTotal = 0;
        for (const line of rmLines) {
          let rid = line.raw_material_id ?? line.rawMaterialId;
          if (rid == null) {
            const code = line.rm_code || line.rmCode || line.code;
            if (!code) continue;
            rid = rmCodeToId.get(code);
          }
          const ridNum = rid != null ? Number(rid) : null;
          if (ridNum == null || Number.isNaN(ridNum)) continue;
          let qtyKg = 0;
          const pct = Number(line.pct_w_w ?? line.pct ?? 0);
          if (Number.isFinite(pct) && pct > 0 && sizeKg > 0) {
            qtyKg = (sizeKg * pct) / 100;
          } else if (line.quantity != null) {
            // When saved from SO-level override, planning_bom_override may store precomputed quantities.
            qtyKg = Number(line.quantity ?? 0) || 0;
          }
          if (qtyKg <= 0) continue;
          rmReqById[ridNum] = (rmReqById[ridNum] ?? 0) + qtyKg;
          rmNeededTotal += qtyKg;
          rmLineTotalCount += 1;
          if (Number(rmAvailableById[ridNum] ?? 0) >= qtyKg) rmLineAvailableCount += 1;
        }

        const pmReqById = {};
        let pmNeededTotal = 0;
        const batchSizeUnits = Math.round(sizeKg) || 0;
        for (const line of pmLines) {
          let pid = line.pack_material_id ?? line.packMaterialId;
          if (pid == null) {
            const code = line.pm_code || line.pmCode || line.code;
            if (!code) continue;
            pid = pmCodeToId.get(code);
          }
          const pidNum = pid != null ? Number(pid) : null;
          if (pidNum == null || Number.isNaN(pidNum)) continue;
          let qtyUnits = 0;
          if (line.qty_per_unit != null) {
            const qtyPerUnit = Number(line.qty_per_unit);
            if (Number.isFinite(qtyPerUnit) && qtyPerUnit > 0 && batchSizeUnits > 0) {
              qtyUnits = qtyPerUnit * batchSizeUnits;
            }
          } else if (line.quantity != null) {
            qtyUnits = Number(line.quantity ?? 0) || 0;
          } else if (line.value != null) {
            // Some legacy payloads store "value" as qty_per_unit.
            const qtyPerUnit = Number(line.value ?? 0);
            if (Number.isFinite(qtyPerUnit) && qtyPerUnit > 0 && batchSizeUnits > 0) {
              qtyUnits = qtyPerUnit * batchSizeUnits;
            }
          }
          if (qtyUnits <= 0) continue;
          pmReqById[pidNum] = (pmReqById[pidNum] ?? 0) + qtyUnits;
          pmNeededTotal += qtyUnits;
          pmLineTotalCount += 1;
          if (Number(pmAvailableById[pidNum] ?? 0) >= qtyUnits) pmLineAvailableCount += 1;
        }

        batchRequired.set(planningBatchId, { rmReqById, rmNeededTotal, pmReqById, pmNeededTotal });
        batchNeededTotals.set(planningBatchId, { rmNeededTotal, pmNeededTotal });
      }

      // Map planning_batch_id -> production_batch_id (for reserved requested).
      const planningBatchIds = planningBatches.map((b) => (b.get ? b.get({ plain: true }).id : b.id));
      const prodBatches = planningBatchIds.length
        ? await ProductionBatchModel.findAll({
          where: { planning_batch_id: { [Op.in]: planningBatchIds } },
          attributes: ['id', 'planning_batch_id', 'bmr_status', 'bpr_status'],
        })
        : [];
      const prodByPlanningId = {};
      prodBatches.forEach((pb) => {
        const d = pb.get ? pb.get({ plain: true }) : pb;
        prodByPlanningId[d.planning_batch_id] = d.id;
      });

      const prodIds = prodBatches.map((pb) => (pb.get ? pb.get({ plain: true }).id : pb.id));
      const reservedRows = prodIds.length
        ? await ReservedBatchItem.findAll({
          where: { production_batch_id: { [Op.in]: prodIds } },
          attributes: ['production_batch_id', 'raw_material_id', 'pack_material_id', 'quantity_reserved'],
        })
        : [];

      const reservedRMByProductionId = {};
      const reservedPMByProductionId = {};
      reservedRows.forEach((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        const qty = Number(d.quantity_reserved ?? 0) || 0;
        const pid = d.production_batch_id;
        if (d.raw_material_id != null) reservedRMByProductionId[pid] = (reservedRMByProductionId[pid] ?? 0) + qty;
        if (d.pack_material_id != null) reservedPMByProductionId[pid] = (reservedPMByProductionId[pid] ?? 0) + qty;
      });

      // Simulate how many batches can be started with current warehouse availability.
      const rmAvailableSim = { ...rmAvailableById };
      let rmStartableCount = 0;
      const rmStartableByPlanningId = {};

      const pmAvailableSim = { ...pmAvailableById };
      let pmStartableCount = 0;
      const pmStartableByPlanningId = {};

      for (const b of planningBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const planningBatchId = plain.id;
        const { rmReqById, rmNeededTotal, pmReqById, pmNeededTotal } = batchRequired.get(planningBatchId) || {
          rmReqById: {}, rmNeededTotal: 0, pmReqById: {}, pmNeededTotal: 0,
        };

        // RM simulation
        const rmHasRequirements = Object.keys(rmReqById).length > 0 && rmNeededTotal > 0;
        const rmOk = rmHasRequirements && Object.entries(rmReqById).every(([ridStr, reqQty]) => {
          const rid = Number(ridStr);
          return Number(reqQty ?? 0) <= Number(rmAvailableSim[rid] ?? 0);
        });
        if (rmOk) {
          rmStartableCount += 1;
          rmStartableByPlanningId[planningBatchId] = true;
          for (const [ridStr, reqQty] of Object.entries(rmReqById)) {
            const rid = Number(ridStr);
            rmAvailableSim[rid] = Number(rmAvailableSim[rid] ?? 0) - Number(reqQty ?? 0);
          }
        } else {
          rmStartableByPlanningId[planningBatchId] = false;
        }

        // PM simulation
        const pmHasRequirements = Object.keys(pmReqById).length > 0 && pmNeededTotal > 0;
        const pmOk = pmHasRequirements && Object.entries(pmReqById).every(([pidStr, reqQty]) => {
          const pid = Number(pidStr);
          return Number(reqQty ?? 0) <= Number(pmAvailableSim[pid] ?? 0);
        });
        if (pmOk) {
          pmStartableCount += 1;
          pmStartableByPlanningId[planningBatchId] = true;
          for (const [pidStr, reqQty] of Object.entries(pmReqById)) {
            const pid = Number(pidStr);
            pmAvailableSim[pid] = Number(pmAvailableSim[pid] ?? 0) - Number(reqQty ?? 0);
          }
        } else {
          pmStartableByPlanningId[planningBatchId] = false;
        }
      }

      // Started counts = batches that already have reserved/requested RM/PM via production.
      let rmStartedCount = 0;
      let pmStartedCount = 0;
      const batchRows = planningBatches.map((b) => {
        const plain = b.get ? b.get({ plain: true }) : b;
        const planningBatchId = plain.id;
        const batchNo = Number(plain.sequence ?? 1);
        const sent = sentIndices.includes(batchNo - 1);

        const needed = batchNeededTotals.get(planningBatchId) || { rmNeededTotal: 0, pmNeededTotal: 0 };
        const prodId = prodByPlanningId[planningBatchId] ?? null;
        const rmRequested = prodId != null ? Number(reservedRMByProductionId[prodId] ?? 0) : 0;
        const pmRequested = prodId != null ? Number(reservedPMByProductionId[prodId] ?? 0) : 0;

        if (rmRequested > 0) rmStartedCount += 1;
        if (pmRequested > 0) pmStartedCount += 1;

        return {
          sequence: batchNo,
          sent,
          rmNeededTotalKg: needed.rmNeededTotal,
          rmRequestedTotalKg: rmRequested,
          rmRemainingTotalKg: Math.max(0, needed.rmNeededTotal - rmRequested),
          pmNeededTotalUnits: needed.pmNeededTotal,
          pmRequestedTotalUnits: pmRequested,
          pmRemainingTotalUnits: Math.max(0, needed.pmNeededTotal - pmRequested),
          rmStartable: !!rmStartableByPlanningId[planningBatchId],
          pmStartable: !!pmStartableByPlanningId[planningBatchId],
        };
      });

      const product = planPlain.product || {};
      console.log('[FULFILLMENT-AVAIL] PLAN_RESULT', {
        soNo,
        planningExtractedId: planId,
        productName: product.product_name || '',
        sku: product.zoho_sku_code || product.product_code || '',
        effectiveTotalBatches,
        sentCount,
        rmStartableCount,
        rmStartedCount,
        pmStartableCount,
        pmStartedCount,
        rmLineAvailableCount,
        rmLineTotalCount,
        pmLineAvailableCount,
        pmLineTotalCount,
        batchRows: batchRows.map((b) => ({
          sequence: b.sequence,
          sent: b.sent,
          rmStartable: b.rmStartable,
          pmStartable: b.pmStartable,
          rmNeededTotalKg: b.rmNeededTotalKg,
          rmRequestedTotalKg: b.rmRequestedTotalKg,
          pmNeededTotalUnits: b.pmNeededTotalUnits,
          pmRequestedTotalUnits: b.pmRequestedTotalUnits,
        })),
      });
      items.push({
        productName: product.product_name || '',
        sku: product.zoho_sku_code || product.product_code || '',
        totalBatches: effectiveTotalBatches,
        sentCount,
        rmStartableCount,
        rmStartedCount,
        pmStartableCount,
        pmStartedCount,
        rmLineAvailableCount,
        rmLineTotalCount,
        pmLineAvailableCount,
        pmLineTotalCount,
        batches: batchRows,
      });
    }

    console.log('[FULFILLMENT-AVAIL] END', {
      soNo,
      itemCount: items.length,
      items: items.map((i) => ({
        productName: i.productName,
        sku: i.sku,
        totalBatches: i.totalBatches,
        rmStartableCount: i.rmStartableCount,
        pmStartableCount: i.pmStartableCount,
      })),
    });
    res.json({ success: true, soNo, items });
  } catch (err) {
    console.error('getSoPlanningAvailability error:', err);
    res.status(500).json({ error: 'Failed to fetch so planning availability' });
  }
}

module.exports = {
  listOrders,
  getOrderById,
  createOrder,
  updateOrder,
  deleteOrder,
  pickSplits,
  invoiceSplits,
  shipSplits,
  deliverSplits,
  listBatchSplits,
  getNextSoNo,
  getCustomers,
  getProducts,
  listTransporters,
  getNextInvoiceNo,
  createInvoice,
  listInvoices,
  getSoPlanningAvailability,
};
