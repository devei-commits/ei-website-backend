const { Op } = require('sequelize');
const PlanningExtracted = require('./models');
const PlanningBomOverride = require('./planningBomOverrideModel');
const SalesOrder = require('../salesOrders/models');
const { Product } = require('../products/models');
const WarehouseInventory = require('../warehouseInventory/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const BOM = require('../bom/models');

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
    customBatches: Array.isArray(d.custom_batches) ? d.custom_batches : null,
    sentBatchIndices: Array.isArray(d.sent_batch_indices) ? d.sent_batch_indices : [],
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
      customBatches: 'custom_batches',
      sentBatchIndices: 'sent_batch_indices',
    };
    const allowed = [
      'order_qty_display', 'total_kg_display', 'order_date', 'due_date',
      'batch_size_display', 'batches_required', 'bom_status', 'approved_by',
      'raw_materials', 'packaging_materials', 'color',
      'batch_count', 'batch_size_kg', 'planned_start_date', 'production_line', 'bom_confirmed_at',
      'custom_batches', 'sent_batch_indices',
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
 * GET /:id/bom-override — custom BOM for this planning extracted row (swapped/edited in Plan Batches).
 * Returns { rmLines, pmLines } or 404 if no override.
 */
async function getBomOverride(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await PlanningBomOverride.findOne({ where: { planning_extracted_id: id } });
    if (!row) return res.status(404).json({ error: 'No BOM override for this planning row' });
    const d = row.get ? row.get({ plain: true }) : row;
    res.json({
      rmLines: Array.isArray(d.rm_lines) ? d.rm_lines : [],
      pmLines: Array.isArray(d.pm_lines) ? d.pm_lines : [],
    });
  } catch (err) {
    console.error('getBomOverride error', err);
    res.status(500).json({ error: 'Failed to fetch BOM override' });
  }
}

/**
 * PUT /:id/bom-override — create or update custom BOM for this planning extracted row.
 * Body: { rmLines, pmLines }. Also syncs planning_extracted.raw_materials and packaging_materials from override
 * so items-involved and other flows use the custom BOM.
 */
async function putBomOverride(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const planRow = await PlanningExtracted.findByPk(id);
    if (!planRow) return res.status(404).json({ error: 'Planning extracted not found' });
    const body = req.body || {};
    const rmLines = Array.isArray(body.rmLines) ? body.rmLines : [];
    const pmLines = Array.isArray(body.pmLines) ? body.pmLines : [];

    const [override] = await PlanningBomOverride.findOrCreate({
      where: { planning_extracted_id: id },
      defaults: { rm_lines: rmLines, pm_lines: pmLines },
    });
    if (!override) return res.status(500).json({ error: 'Failed to create BOM override' });
    override.rm_lines = rmLines;
    override.pm_lines = pmLines;
    await override.save();

    const batchSizeKg = Number(planRow.batch_size_kg) || 500;
    const orderQtyNum = parseInt(String(planRow.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
    const totalKg = parseFloat(String(planRow.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
    const rawMaterials = rmLines.map((line) => {
      const pct = line.pct_w_w ?? line.pct ?? 0;
      const quantity = (batchSizeKg * pct) / 100;
      return {
        raw_material_id: line.raw_material_id ?? null,
        name: line.inci_name ?? line.name ?? line.rm_code ?? '',
        quantity: Math.round(quantity * 1000) / 1000,
        unit: line.uom || 'KG',
        code: line.rm_code ?? line.code ?? '',
      };
    });
    const unitsFraction = totalKg > 0 ? batchSizeKg / totalKg : 0;
    const unitsForBatch = Math.ceil(orderQtyNum * unitsFraction) || 0;
    const packagingMaterials = pmLines.map((line) => {
      const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
      const required = unitsForBatch * qtyPerUnit;
      return {
        pack_material_id: line.pack_material_id ?? null,
        name: line.description ?? line.name ?? line.pm_code ?? '',
        quantity: Math.ceil(required),
        unit: 'PCS',
        code: line.pm_code ?? line.code ?? '',
      };
    });
    planRow.raw_materials = rawMaterials;
    planRow.packaging_materials = packagingMaterials;
    await planRow.save();

    res.json({
      rmLines: override.rm_lines || [],
      pmLines: override.pm_lines || [],
    });
  } catch (err) {
    console.error('putBomOverride error', err);
    res.status(500).json({ error: 'Failed to save BOM override' });
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

    let rms = Array.isArray(plain.raw_materials) ? plain.raw_materials : [];
    let pms = Array.isArray(plain.packaging_materials) ? plain.packaging_materials : [];

    const productId = plain.product_id ?? plain.product?.product_id;
    if (productId != null && (rms.length === 0 || pms.length === 0)) {
      const bomRows = await BOM.findAll({ where: { product_id: productId }, limit: 1 });
      const bom = bomRows[0];
      if (bom) {
        const bomPlain = bom.get ? bom.get({ plain: true }) : bom;
        if (rms.length === 0 && Array.isArray(bomPlain.rm_lines) && bomPlain.rm_lines.length > 0) {
          const batchSizeKg = Number(plain.batch_size_kg) || 500;
          for (const line of bomPlain.rm_lines) {
            let rid = line.raw_material_id != null ? Number(line.raw_material_id) : null;
            if (rid == null && line.rm_code) {
              const rm = await RawMaterial.findOne({ where: { code: line.rm_code }, attributes: ['id'] });
              if (rm) rid = rm.id;
            }
            if (rid == null || Number.isNaN(rid)) continue;
            const pct = line.pct_w_w ?? line.pct ?? 0;
            const quantity = (batchSizeKg * pct) / 100;
            rms.push({
              raw_material_id: rid,
              name: line.inci_name ?? line.name ?? line.rm_code ?? '',
              quantity: Math.round(quantity * 1000) / 1000,
              unit: line.uom || 'KG',
              code: line.rm_code ?? line.code ?? '',
            });
          }
        }
        if (pms.length === 0 && Array.isArray(bomPlain.pm_lines) && bomPlain.pm_lines.length > 0) {
          const orderQtyNum = parseInt(String(plain.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
          const totalKg = parseFloat(String(plain.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
          const batchSizeKg = Number(plain.batch_size_kg) || 500;
          const unitsFraction = totalKg > 0 ? batchSizeKg / totalKg : 0;
          const unitsForBatch = Math.ceil(orderQtyNum * unitsFraction) || 0;
          for (const line of bomPlain.pm_lines) {
            let pid = line.pack_material_id != null ? Number(line.pack_material_id) : null;
            if (pid == null && line.pm_code) {
              const pm = await PackMaterial.findOne({ where: { code: line.pm_code }, attributes: ['id'] });
              if (pm) pid = pm.id;
            }
            if (pid == null || Number.isNaN(pid)) continue;
            const qtyPerUnit = line.qty_per_unit ?? line.qty ?? 1;
            const required = unitsForBatch * qtyPerUnit;
            pms.push({
              pack_material_id: pid,
              name: line.description ?? line.name ?? line.pm_code ?? '',
              quantity: Math.ceil(required),
              unit: 'PCS',
              code: line.pm_code ?? line.code ?? '',
            });
          }
        }
      }
    }

    // Resolve raw_material_id / pack_material_id by code or name when missing (planning_extracted often has code/name only)
    const rmCodes = [...new Set(rms.map((r) => (r.code || '').trim()).filter(Boolean))];
    const rmNames = [...new Set(rms.map((r) => (r.name || '').trim()).filter(Boolean))];
    const pmCodes = [...new Set(pms.map((p) => (p.code || '').trim()).filter(Boolean))];
    const pmNames = [...new Set(pms.map((p) => (p.name || '').trim()).filter(Boolean))];
    let rmByCode = {};
    let rmByName = {};
    let pmByCode = {};
    let pmByName = {};
    if (rmCodes.length > 0 || rmNames.length > 0) {
      const rmWhere = rmCodes.length && rmNames.length
        ? { [Op.or]: [{ code: { [Op.in]: rmCodes } }, { name: { [Op.in]: rmNames } }] }
        : (rmCodes.length ? { code: { [Op.in]: rmCodes } } : { name: { [Op.in]: rmNames } });
      const rmRows = await RawMaterial.findAll({ where: rmWhere, attributes: ['id', 'code', 'name'] });
      rmRows.forEach((x) => {
        const d = x.get ? x.get({ plain: true }) : x;
        if (d.code) rmByCode[d.code] = d.id;
        if (d.name) rmByName[String(d.name).trim().toLowerCase()] = d.id;
      });
    }
    if (pmCodes.length > 0 || pmNames.length > 0) {
      const pmWhere = pmCodes.length && pmNames.length
        ? { [Op.or]: [{ code: { [Op.in]: pmCodes } }, { description: { [Op.in]: pmNames } }] }
        : (pmCodes.length ? { code: { [Op.in]: pmCodes } } : { description: { [Op.in]: pmNames } });
      const pmRows = await PackMaterial.findAll({ where: pmWhere, attributes: ['id', 'code', 'description'] });
      pmRows.forEach((x) => {
        const d = x.get ? x.get({ plain: true }) : x;
        if (d.code) pmByCode[d.code] = d.id;
        if (d.description) pmByName[String(d.description).trim().toLowerCase()] = d.id;
      });
    }
    for (const r of rms) {
      if (r.raw_material_id != null && !Number.isNaN(Number(r.raw_material_id))) continue;
      const code = (r.code || '').trim();
      const nameKey = (r.name || '').trim().toLowerCase();
      if (code && rmByCode[code]) r.raw_material_id = rmByCode[code];
      else if (nameKey && rmByName[nameKey]) r.raw_material_id = rmByName[nameKey];
    }
    for (const p of pms) {
      if (p.pack_material_id != null && !Number.isNaN(Number(p.pack_material_id))) continue;
      const code = (p.code || '').trim();
      const nameKey = (p.name || '').trim().toLowerCase();
      if (code && pmByCode[code]) p.pack_material_id = pmByCode[code];
      else if (nameKey && pmByName[nameKey]) p.pack_material_id = pmByName[nameKey];
    }

    for (const r of rms) {
      const rid = r.raw_material_id != null ? Number(r.raw_material_id) : null;
      if (rid == null || Number.isNaN(rid)) continue;
      rmIds.push(rid);
      rmReq.set(rid, { quantity: Number(r.quantity) || 0, unit: r.unit || 'KG', name: r.name || '', code: r.code || '' });
    }
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
  getBomOverride,
  putBomOverride,
  getItemsInvolved,
  getItemsInvolvedByPlanningId,
};
