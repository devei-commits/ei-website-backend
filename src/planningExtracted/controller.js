const { Op } = require('sequelize');
const PlanningExtracted = require('./models');
const SalesOrder = require('../salesOrders/models');
const { Product } = require('../products/models');
const WarehouseInventory = require('../warehouseInventory/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

function daysLeftDisplay(dueDate) {
  if (!dueDate) return '';
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const diff = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Today';
  return `${diff} days`;
}

function formatRow(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
    const so = d.salesOrder || {};
  const prod = d.product || {};
  return {
    id: String(d.id),
    soNumber: so.order_id || '',
    salesOrderId: so.id,
    customerName: so.customer_name || '',
    expectedShipmentDate: so.expected_shipment_date || '',
    soStatus: so.status || '',
    productName: prod.product_name || '',
    productCode: prod.product_code || '',
    orderQty: d.order_qty_display || '',
    totalKg: d.total_kg_display || '',
    orderDate: d.order_date || '',
    dueDate: d.due_date || '',
    daysLeft: daysLeftDisplay(d.due_date),
    batchSize: d.batch_size_display || '',
    batchesRequired: d.batches_required ?? 0,
    bomStatus: d.bom_status || '',
    approvedBy: d.approved_by || '',
    rawMaterials: Array.isArray(d.raw_materials) ? d.raw_materials : [],
    packagingMaterials: Array.isArray(d.packaging_materials) ? d.packaging_materials : [],
    color: d.color || undefined,
    sales_order_id: d.sales_order_id,
    product_id: d.product_id,
    batchCount: d.batch_count != null ? Number(d.batch_count) : null,
    batchSizeKg: d.batch_size_kg != null ? Number(d.batch_size_kg) : null,
    plannedStartDate: d.planned_start_date || null,
    productionLine: d.production_line || null,
    bomConfirmedAt: d.bom_confirmed_at || null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

async function listPlanningExtracted(req, res) {
  try {
    const rows = await PlanningExtracted.findAll({
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'expected_shipment_date', 'status'] },
        { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code'] },
      ],
      order: [['due_date', 'ASC'], ['id', 'ASC']],
    });
    res.json(rows.map(formatRow));
  } catch (err) {
    console.error('listPlanningExtracted error', err);
    res.status(500).json({ error: 'Failed to list planning extracted' });
  }
}

async function getPlanningExtractedById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningExtracted.findByPk(id, {
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'order_date', 'expected_shipment_date', 'status'] },
        { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code'] },
      ],
    });
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });
    res.json(formatRow(row));
  } catch (err) {
    console.error('getPlanningExtractedById error', err);
    res.status(500).json({ error: 'Failed to fetch planning extracted' });
  }
}

async function updatePlanningExtracted(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningExtracted.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });
    const body = req.body || {};
    const camelToSnake = {
      orderQty: 'order_qty_display', totalKg: 'total_kg_display', orderDate: 'order_date', dueDate: 'due_date',
      batchSize: 'batch_size_display', batchesRequired: 'batches_required', bomStatus: 'bom_status', approvedBy: 'approved_by',
      rawMaterials: 'raw_materials', packagingMaterials: 'packaging_materials', color: 'color',
      batchCount: 'batch_count', batchSizeKg: 'batch_size_kg', plannedStartDate: 'planned_start_date',
      productionLine: 'production_line', bomConfirmedAt: 'bom_confirmed_at',
    };
    const allowed = [
      'order_qty_display', 'total_kg_display', 'order_date', 'due_date',
      'batch_size_display', 'batches_required', 'bom_status', 'approved_by',
      'raw_materials', 'packaging_materials', 'color',
      'batch_count', 'batch_size_kg', 'planned_start_date', 'production_line', 'bom_confirmed_at',
    ];
    for (const key of allowed) {
      if (body[key] !== undefined) row.set(key, body[key]);
    }
    for (const [camel, snake] of Object.entries(camelToSnake)) {
      if (body[camel] !== undefined) row.set(snake, body[camel]);
    }
    await row.save();
    const updated = await PlanningExtracted.findByPk(id, {
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'order_id', 'customer_name', 'expected_shipment_date', 'status'] },
        { model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code'] },
      ],
    });
    res.json(formatRow(updated));
  } catch (err) {
    console.error('updatePlanningExtracted error', err);
    res.status(500).json({ error: 'Failed to update planning extracted' });
  }
}

/**
 * GET /items-involved — aggregated RM/PM from confirmed BOMs only, with total required, SIH, surplus/shortage.
 * Used by Planning Items Involved tab. Each item includes planningExtractedIds so PR can be linked.
 */
async function getItemsInvolved(req, res) {
  try {
    const confirmed = await PlanningExtracted.findAll({
      where: { bom_confirmed_at: { [Op.ne]: null } },
      include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code'] }],
      order: [['id', 'ASC']],
    });

    const rmAgg = new Map(); // key: raw_material_id -> { totalRequired, unit, productNames, planningExtractedIds, name, code }
    const pmAgg = new Map(); // key: pack_material_id -> { totalRequired, unit, productNames, planningExtractedIds, name, code }

    for (const row of confirmed) {
      const plain = row.get ? row.get({ plain: true }) : row;
      const productName = plain.product?.product_name || '';
      const planId = plain.id;

      const rms = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
      for (const r of rms) {
        const id = r.raw_material_id != null ? Number(r.raw_material_id) : null;
        if (id == null || Number.isNaN(id)) continue;
        const qty = Number(r.quantity) || 0;
        const unit = r.unit || 'KG';
        if (!rmAgg.has(id)) {
          rmAgg.set(id, { totalRequired: 0, unit, productNames: [], planningExtractedIds: [], name: r.name || '', code: r.code || '' });
        }
        const agg = rmAgg.get(id);
        agg.totalRequired += qty;
        if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
        if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
        if (r.name) agg.name = r.name;
        if (r.code) agg.code = r.code;
      }

      const pms = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];
      for (const p of pms) {
        const id = p.pack_material_id != null ? Number(p.pack_material_id) : null;
        if (id == null || Number.isNaN(id)) continue;
        const qty = Number(p.quantity) || 0;
        const unit = p.unit || 'PCS';
        if (!pmAgg.has(id)) {
          pmAgg.set(id, { totalRequired: 0, unit, productNames: [], planningExtractedIds: [], name: p.name || '', code: p.code || '' });
        }
        const agg = pmAgg.get(id);
        agg.totalRequired += qty;
        if (productName && !agg.productNames.includes(productName)) agg.productNames.push(productName);
        if (planId && !agg.planningExtractedIds.includes(planId)) agg.planningExtractedIds.push(planId);
        if (p.name) agg.name = p.name;
        if (p.code) agg.code = p.code;
      }
    }

    const allRmIds = [...rmAgg.keys()];
    const allPmIds = [...pmAgg.keys()];
    const whWhere = [];
    if (allRmIds.length) whWhere.push({ item_type: 'RM', raw_material_id: { [Op.in]: allRmIds } });
    if (allPmIds.length) whWhere.push({ item_type: 'PM', pack_material_id: { [Op.in]: allPmIds } });
    const [whRows, rmsList, pmsList] = await Promise.all([
      whWhere.length ? WarehouseInventory.findAll({ where: { [Op.or]: whWhere } }) : Promise.resolve([]),
      allRmIds.length ? RawMaterial.findAll({ where: { id: allRmIds }, attributes: ['id', 'code', 'name'] }) : Promise.resolve([]),
      allPmIds.length ? PackMaterial.findAll({ where: { id: allPmIds }, attributes: ['id', 'code', 'description'] }) : Promise.resolve([]),
    ]);
    const sihByRm = new Map();
    const sihByPm = new Map();
    const whIdByRm = new Map();
    const whIdByPm = new Map();
    const batchNumberByRm = new Map();
    const batchNumberByPm = new Map();
    const expiryByRm = new Map();
    const expiryByPm = new Map();
    for (const w of whRows) {
      const s = Number(w.stock_in_hand) || 0;
      const whId = w.id;
      const batchNumber = w.batch_number || null;
      const expiryDate = w.expiry_date || null;
      if (w.item_type === 'RM' && w.raw_material_id) {
        sihByRm.set(w.raw_material_id, s);
        whIdByRm.set(w.raw_material_id, whId);
        if (batchNumber) batchNumberByRm.set(w.raw_material_id, batchNumber);
        if (expiryDate) expiryByRm.set(w.raw_material_id, expiryDate);
      }
      if (w.item_type === 'PM' && w.pack_material_id) {
        sihByPm.set(w.pack_material_id, s);
        whIdByPm.set(w.pack_material_id, whId);
        if (batchNumber) batchNumberByPm.set(w.pack_material_id, batchNumber);
        if (expiryDate) expiryByPm.set(w.pack_material_id, expiryDate);
      }
    }
    const rmInfo = new Map(rmsList.map((r) => [r.id, { code: r.code, name: r.name }]));
    const pmInfo = new Map(pmsList.map((p) => [p.id, { code: p.code, name: p.description || p.code }]));

    const out = [];
    for (const [id, agg] of rmAgg) {
      const sih = sihByRm.get(id) ?? 0;
      const surplusShortage = sih - agg.totalRequired;
      const info = rmInfo.get(id) || {};
      out.push({
        type: 'RM',
        raw_material_id: id,
        pack_material_id: null,
        code: agg.code || info.code || `RM-${id}`,
        name: agg.name || info.name || `RM ${id}`,
        category: 'RM',
        usedInProducts: agg.productNames,
        planningExtractedIds: agg.planningExtractedIds,
        totalRequired: agg.totalRequired,
        unit: agg.unit,
        sih,
        surplusShortage,
        coverage: agg.totalRequired > 0 ? Math.min(100, Math.round((sih / agg.totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByRm.get(id) ?? null,
        batchNumber: batchNumberByRm.get(id) ?? null,
        expiryDate: expiryByRm.get(id) ?? null,
      });
    }
    for (const [id, agg] of pmAgg) {
      const sih = sihByPm.get(id) ?? 0;
      const surplusShortage = sih - agg.totalRequired;
      const info = pmInfo.get(id) || {};
      out.push({
        type: 'PM',
        raw_material_id: null,
        pack_material_id: id,
        code: agg.code || info.code || `PM-${id}`,
        name: agg.name || info.name || `PM ${id}`,
        category: 'PM',
        usedInProducts: agg.productNames,
        planningExtractedIds: agg.planningExtractedIds,
        totalRequired: agg.totalRequired,
        unit: agg.unit,
        sih,
        surplusShortage,
        coverage: agg.totalRequired > 0 ? Math.min(100, Math.round((sih / agg.totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByPm.get(id) ?? null,
        batchNumber: batchNumberByPm.get(id) ?? null,
        expiryDate: expiryByPm.get(id) ?? null,
      });
    }

    res.json(out);
  } catch (err) {
    console.error('getItemsInvolved error', err);
    res.status(500).json({ error: 'Failed to fetch items involved' });
  }
}

/**
 * GET /:id/items-involved — items (RM/PM) for a single planning extracted row with SIH from warehouse.
 * Same shape as global items-involved but for one PI only (for Order Management / RM Plan view).
 */
async function getItemsInvolvedByPlanningId(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningExtracted.findByPk(id, {
      include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'product_code'] }],
    });
    if (!row) return res.status(404).json({ error: 'Planning extracted not found' });

    const plain = row.get ? row.get({ plain: true }) : row;
    const rmIds = [];
    const pmIds = [];
    const rmReq = new Map(); // id -> { quantity, unit, name, code }
    const pmReq = new Map();

    const rms = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
    for (const r of rms) {
      const rid = r.raw_material_id != null ? Number(r.raw_material_id) : null;
      if (rid == null || Number.isNaN(rid)) continue;
      rmIds.push(rid);
      rmReq.set(rid, { quantity: Number(r.quantity) || 0, unit: r.unit || 'KG', name: r.name || '', code: r.code || '' });
    }
    const pms = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];
    for (const p of pms) {
      const pid = p.pack_material_id != null ? Number(p.pack_material_id) : null;
      if (pid == null || Number.isNaN(pid)) continue;
      pmIds.push(pid);
      pmReq.set(pid, { quantity: Number(p.quantity) || 0, unit: p.unit || 'PCS', name: p.name || '', code: p.code || '' });
    }

    const whWhere = [];
    if (rmIds.length) whWhere.push({ item_type: 'RM', raw_material_id: { [Op.in]: rmIds } });
    if (pmIds.length) whWhere.push({ item_type: 'PM', pack_material_id: { [Op.in]: pmIds } });
    const [whRows, rmsList, pmsList] = await Promise.all([
      whWhere.length ? WarehouseInventory.findAll({ where: { [Op.or]: whWhere } }) : Promise.resolve([]),
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'] }) : Promise.resolve([]),
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : Promise.resolve([]),
    ]);

    const sihByRm = new Map();
    const reservedByRm = new Map();
    const whIdByRm = new Map();
    const batchByRm = new Map();
    const expiryByRm = new Map();
    const sihByPm = new Map();
    const reservedByPm = new Map();
    const whIdByPm = new Map();
    const batchByPm = new Map();
    const expiryByPm = new Map();
    for (const w of whRows) {
      const s = Number(w.stock_in_hand) || 0;
      const resv = Number(w.reserved) || 0;
      if (w.item_type === 'RM' && w.raw_material_id) {
        sihByRm.set(w.raw_material_id, s);
        reservedByRm.set(w.raw_material_id, resv);
        whIdByRm.set(w.raw_material_id, w.id);
        if (w.batch_number) batchByRm.set(w.raw_material_id, w.batch_number);
        if (w.expiry_date) expiryByRm.set(w.raw_material_id, w.expiry_date);
      }
      if (w.item_type === 'PM' && w.pack_material_id) {
        sihByPm.set(w.pack_material_id, s);
        reservedByPm.set(w.pack_material_id, resv);
        whIdByPm.set(w.pack_material_id, w.id);
        if (w.batch_number) batchByPm.set(w.pack_material_id, w.batch_number);
        if (w.expiry_date) expiryByPm.set(w.pack_material_id, w.expiry_date);
      }
    }

    const rmInfo = new Map(rmsList.map((r) => [r.id, { code: r.code, name: r.name }]));
    const pmInfo = new Map(pmsList.map((p) => [p.id, { code: p.code, name: p.description || p.code }]));

    const out = [];
    let idx = 0;
    for (const rid of rmIds) {
      const req = rmReq.get(rid) || {};
      const sih = sihByRm.get(rid) ?? 0;
      const reserved = reservedByRm.get(rid) ?? 0;
      const netStock = sih - reserved;
      const totalRequired = req.quantity || 0;
      const info = rmInfo.get(rid) || {};
      const name = req.name || info.name || `RM ${rid}`;
      const code = req.code || info.code || `RM-${rid}`;
      out.push({
        id: String(++idx),
        type: 'RM',
        raw_material_id: rid,
        pack_material_id: null,
        code,
        name,
        item: name,
        category: 'RM',
        usedInProducts: plain.product ? [plain.product.product_name || plain.product.product_code] : [],
        planningExtractedIds: [id],
        totalRequired,
        unit: req.unit || 'KG',
        sih,
        reserved,
        netStock,
        surplusShortage: netStock - totalRequired,
        coverage: totalRequired > 0 ? Math.min(100, Math.round((sih / totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByRm.get(rid) ?? null,
        batchNumber: batchByRm.get(rid) ?? null,
        expiryDate: expiryByRm.get(rid) ?? null,
      });
    }
    for (const pid of pmIds) {
      const req = pmReq.get(pid) || {};
      const sih = sihByPm.get(pid) ?? 0;
      const reserved = reservedByPm.get(pid) ?? 0;
      const netStock = sih - reserved;
      const totalRequired = req.quantity || 0;
      const info = pmInfo.get(pid) || {};
      const name = req.name || info.name || `PM ${pid}`;
      const code = req.code || info.code || `PM-${pid}`;
      out.push({
        id: String(++idx),
        type: 'PM',
        raw_material_id: null,
        pack_material_id: pid,
        code,
        name,
        item: name,
        category: 'PM',
        usedInProducts: plain.product ? [plain.product.product_name || plain.product.product_code] : [],
        planningExtractedIds: [id],
        totalRequired,
        unit: req.unit || 'PCS',
        sih,
        reserved,
        netStock,
        surplusShortage: netStock - totalRequired,
        coverage: totalRequired > 0 ? Math.min(100, Math.round((sih / totalRequired) * 100)) : 100,
        warehouseInventoryId: whIdByPm.get(pid) ?? null,
        batchNumber: batchByPm.get(pid) ?? null,
        expiryDate: expiryByPm.get(pid) ?? null,
      });
    }

    res.json(out);
  } catch (err) {
    console.error('getItemsInvolvedByPlanningId error', err);
    res.status(500).json({ error: 'Failed to fetch items involved for planning line' });
  }
}

module.exports = {
  listPlanningExtracted,
  getPlanningExtractedById,
  updatePlanningExtracted,
  getItemsInvolved,
  getItemsInvolvedByPlanningId,
};
