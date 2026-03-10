const { Op } = require('sequelize');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, Transporter, FulfillmentInvoice, ReservedBatchItem } = require('./models');
const BOM = require('../bom/models');
const { ProductionBatch } = require('../production/models');
const SalesOrder = require('../salesOrders/models');
const VendorClient = require('../vendorClient/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

const INCLUDE_FULL = [
  {
    model: FulfillmentOrderItem,
    as: 'items',
    include: [{ model: FulfillmentBatchSplit, as: 'batchSplits' }],
  },
];

/* ── Helpers ── */

/** Build map production_batch_id -> { bpr_status } for deriving effective ff_status from Production. */
async function getBatchStatusMap(productionBatchIds) {
  const ids = [...new Set((productionBatchIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = await ProductionBatch.findAll({ where: { id: ids }, attributes: ['id', 'bpr_status'] });
  const map = {};
  rows.forEach((r) => { const d = r.get ? r.get({ plain: true }) : r; map[d.id] = { bpr_status: d.bpr_status }; });
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
  return {
    id: d.id,
    fulfillmentOrderItemId: d.fulfillment_order_item_id,
    fulfillmentOrderId: d.fulfillment_order_id,
    productionBatchId: d.production_batch_id,
    bmrNo: d.bmr_no || '',
    bprNo: d.bpr_no || '',
    plannedQty: d.planned_qty,
    fgQty: d.fg_qty || 0,
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
  if (!fgSplits.length) {
    if (splits.some(s => ['bulk_qc', 'wip'].includes(s.ffStatus))) return 'in_production';
    return 'planned';
  }
  if (fgSplits.every(s => ['delivered', 'closed'].includes(s.ffStatus))) return 'closed';
  if (fgSplits.some(s => ['shipped', 'delivered'].includes(s.ffStatus))) return 'shipped';
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
  if (!fgSplits.length) {
    if (splits.some(s => ['bulk_qc', 'wip'].includes(s.ff_status))) return 'in_production';
    return 'planned';
  }
  if (fgSplits.every(s => ['delivered', 'closed'].includes(s.ff_status))) return 'closed';
  if (fgSplits.some(s => ['shipped', 'delivered'].includes(s.ff_status))) return 'shipped';
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

/* ── CRUD ── */

async function listOrders(req, res) {
  try {
    const rows = await FulfillmentOrder.findAll({
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
    const row = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
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

        // Auto-create planning_extracted rows from SO items + BOM
        const PlanningExtracted = require('../planningExtracted/models');
        const BOM = require('../bom/models');
        for (const item of (items || [])) {
          let productId = null;
          if (item.sku) {
            const prod = await Product.findOne({ where: { product_sku: item.sku } });
            if (prod) productId = prod.product_id;
          }
          if (!productId && item.productName) {
            const prod = await Product.findOne({ where: { product_name: item.productName } });
            if (prod) productId = prod.product_id;
          }
          if (!productId) continue;

          let rawMaterials = [];
          let packagingMaterials = [];
          const bom = await BOM.findOne({ where: { product_id: productId } });
          if (bom) {
            rawMaterials = Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
            packagingMaterials = Array.isArray(bom.pm_lines) ? bom.pm_lines : [];
          }

          const orderQty = item.orderedQty || 0;
          const product = await Product.findByPk(productId);
          const batchSizeKg = product?.batch_size_kg || 100;
          const batchesRequired = batchSizeKg > 0 ? Math.ceil(orderQty / batchSizeKg) : 1;

          await PlanningExtracted.create({
            sales_order_id: newSO.id,
            product_id: productId,
            order_qty_display: `${orderQty} units`,
            total_kg_display: batchSizeKg ? `${orderQty} KG` : null,
            order_date: orderDate || null,
            due_date: dueDate || null,
            batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
            batches_required: batchesRequired,
            batch_count: batchesRequired,
            batch_size_kg: batchSizeKg,
            bom_status: bom ? 'Confirmed' : 'Pending',
            bom_confirmed_at: bom ? new Date() : null,
            approved_by: createdByName,
            raw_materials: rawMaterials,
            packaging_materials: packagingMaterials,
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

          const year = new Date().getFullYear();
          if (bmrNo) {
            const pb = await ProductionBatch.findOne({ where: { bmr_no: bmrNo } });
            if (pb) {
              productionBatchId = pb.id;
              if (!bprNo) bprNo = pb.bpr_no;
            }
          }
          if (!bmrNo) {
            const nextSeq = await getNextBMRBPRSequence(year);
            bmrNo = nextSeq.bmrNo;
            bprNo = nextSeq.bprNo;
          }

          if (!productionBatchId) {
            const pb = await ProductionBatch.create({
              bmr_no: bmrNo,
              bpr_no: bprNo,
              product_name: item.productName || 'Unknown Product',
              sku: item.sku || soNo,
              so_no: soNo,
              order_qty: item.orderedQty || 0,
              batch_size: split.plannedQty || item.orderedQty || 0,
              batch_no: `B-${String(splitCounter).padStart(2, '0')}`,
              batch_index: splitCounter,
              total_batches: totalSplits,
              bmr_status: 'draft',
              bpr_status: 'draft',
              due_date: dueDate || null,
            });
            productionBatchId = pb.id;
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
            const prod = await Product.findOne({ where: { product_sku: item.sku } });
            if (prod) productId = prod.product_id;
          }
          if (!productId && item.productName) {
            const prod = await Product.findOne({ where: { product_name: item.productName } });
            if (prod) productId = prod.product_id;
          }
          if (productId && plannedQty > 0) {
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
      if (split && split.ff_status === 'fg_ready') {
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

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('pickSplits error:', err);
    res.status(500).json({ error: 'Failed to process pick' });
  }
}

async function invoiceSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { invoiceNo, invoiceDate, courier } = req.body;
    if (!invoiceNo) return res.status(400).json({ error: 'invoiceNo is required' });

    await FulfillmentBatchSplit.update(
      { ff_status: 'invoiced', invoice_no: invoiceNo },
      { where: { fulfillment_order_id: id, ff_status: 'picking' } }
    );

    order.set({
      invoice_no: invoiceNo,
      invoice_date: invoiceDate || new Date().toISOString().slice(0, 10),
      courier: courier || null,
    });

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save();

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('invoiceSplits error:', err);
    res.status(500).json({ error: 'Failed to process invoice' });
  }
}

async function shipSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { awbNo, courier, dispatchDate, eta } = req.body;

    await FulfillmentBatchSplit.update(
      {
        ff_status: 'shipped',
        awb_no: awbNo || null,
        courier: courier || null,
        dispatch_date: dispatchDate || new Date().toISOString().slice(0, 10),
        eta_date: eta || null,
      },
      { where: { fulfillment_order_id: id, ff_status: 'invoiced' } }
    );

    order.set({
      awb_no: awbNo || null,
      dispatch_date: dispatchDate || new Date().toISOString().slice(0, 10),
      courier: courier || null,
    });

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save();

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

    const { deliveryDate, receivedBy, remarks } = req.body;

    await FulfillmentBatchSplit.update(
      {
        ff_status: 'delivered',
        delivery_date: deliveryDate || new Date().toISOString().slice(0, 10),
        received_by: receivedBy || null,
        delivery_remarks: remarks || null,
      },
      { where: { fulfillment_order_id: id, ff_status: 'shipped' } }
    );

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    const newStatus = recalculateSOStatus(allSplits);

    if (newStatus === 'closed') {
      await FulfillmentBatchSplit.update(
        { ff_status: 'closed' },
        { where: { fulfillment_order_id: id, ff_status: 'delivered' } }
      );
      order.set('so_status', 'closed');
    } else {
      order.set('so_status', newStatus);
    }
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
          attributes: ['id', 'so_no', 'customer_name', 'customer_city', 'due_date', 'priority'],
        },
      ],
      order: [['fulfillment_order_id', 'ASC'], ['id', 'ASC']],
    });

    res.json(splits.map(row => {
      const d = row.get({ plain: true });
      return {
        ...formatSplit(d),
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
      attributes: ['id', 'entity_code', 'name', 'city', 'location', 'payment_terms'],
      order: [['name', 'ASC']],
    });

    res.json(clients.map(c => {
      const d = c.get({ plain: true });
      return {
        id: d.id,
        code: d.entity_code,
        name: d.name,
        city: d.city || d.location || '',
        paymentTerms: d.payment_terms || '',
      };
    }));
  } catch (err) {
    console.error('getCustomers error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}

/** Products lookup for Add SO modal: only Finished Goods (FG). RMs and PMs are materials used to build FGs. */
async function getProducts(_req, res) {
  try {
    const products = await Product.findAll({
      attributes: ['product_id', 'product_code', 'product_name', 'product_sku', 'fill_size', 'form', 'category', 'mrp_price'],
      order: [['product_name', 'ASC']],
    });

    const items = products.map(p => {
      const d = p.get({ plain: true });
      return {
        id: `PR-${d.product_id}`,
        type: 'product',
        name: d.product_name || d.product_code,
        sku: d.product_sku || d.product_code || '',
        pack: d.fill_size ? `${d.fill_size} ${d.form || ''}`.trim() : d.form || '',
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

async function createInvoice(req, res) {
  try {
    const {
      fulfillmentOrderId, invoiceNo, invoiceDate, dueDate,
      preparedBy, transporterId, transporterName, lrAwbNo,
      remarks, subtotal, gstPercent, totalValue, lineItems,
    } = req.body;

    if (!fulfillmentOrderId || !invoiceNo) {
      return res.status(400).json({ error: 'fulfillmentOrderId and invoiceNo are required' });
    }

    const order = await FulfillmentOrder.findByPk(fulfillmentOrderId);
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

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
    });

    await FulfillmentBatchSplit.update(
      { ff_status: 'invoiced', invoice_no: invoiceNo },
      { where: { fulfillment_order_id: fulfillmentOrderId, ff_status: 'picking' } }
    );

    order.set({ invoice_no: invoiceNo, invoice_date: invoiceDate || new Date().toISOString().slice(0, 10), courier: transporterName || null });
    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: fulfillmentOrderId } });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save();

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
    });
  } catch (err) {
    console.error('createInvoice error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'An invoice with this number already exists' });
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
      };
    }));
  } catch (err) {
    console.error('listInvoices error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
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
};
