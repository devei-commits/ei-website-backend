/**
 * Line-level RM/PM reservation for production batches (reserved_batch_items).
 */

const { Op } = require('sequelize');
const { ProductionBatch } = require('./models');
const { ReservedBatchItem } = require('../fulfillment/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const WarehouseInventory = require('../warehouseInventory/models');
const MaterialRequestNote = require('../mrn/models');
const { syncWarehouseReserved } = require('../planningExtracted/controller');
const { logReservedChange } = require('../warehouseInventory/locationHistoryHelpers');
const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');
const { materialQtyGte } = require('../utils/materialQtyCompare');

const EPS = 1e-6;

function batchPlain(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function warehouseSihFromPlain(plainWh) {
  if (!plainWh) return 0;
  const direct = Number(plainWh.stock_in_hand);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return (
    (Number(plainWh.wh_stock) || 0)
    + (Number(plainWh.ml1_stock) || 0)
    + (Number(plainWh.ml2_stock) || 0)
  );
}

async function sumReservedQtyOtherBatches(productionBatchId, kind, materialId) {
  const bid = Number(productionBatchId);
  const mid = Number(materialId);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(mid) || mid <= 0) return 0;
  // Shared pool: everyone else's reservation = total for the material − this production batch's own.
  // Counts Planning-batch and SO reservations too (the old query silently ignored them because a
  // NULL production_batch_id fails `!= bid`), so Production no longer over-allocates Planning-held stock.
  const { sumReservedOther } = require('../lib/reservedStockPool');
  return sumReservedOther(kind, mid, { productionBatchId: bid });
}

async function assertExclusiveBatchReserveAvailability(batchId, rmQuantities, pmQuantities) {
  const shortages = [];

  for (const [rmId, { quantity, code, unit }] of rmQuantities) {
    const need = Number(quantity) || 0;
    if (need <= 0) continue;
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    const plain = wh?.get ? wh.get({ plain: true }) : wh;
    const sih = warehouseSihFromPlain(plain);
    const otherReserved = await sumReservedQtyOtherBatches(batchId, 'rm', rmId);
    const free = Math.max(0, sih - otherReserved);
    if (need > free + EPS) {
      shortages.push({
        type: 'RM',
        code: code || `RM#${rmId}`,
        unit: unit || 'KG',
        need,
        free,
        otherBatchesReserved: otherReserved,
        sih,
      });
    }
  }

  for (const [pmId, { quantity, code, unit }] of pmQuantities) {
    const need = Number(quantity) || 0;
    if (need <= 0) continue;
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    const plain = wh?.get ? wh.get({ plain: true }) : wh;
    const sih = warehouseSihFromPlain(plain);
    const otherReserved = await sumReservedQtyOtherBatches(batchId, 'pm', pmId);
    const free = Math.max(0, sih - otherReserved);
    if (need > free + EPS) {
      shortages.push({
        type: 'PM',
        code: code || `PM#${pmId}`,
        unit: unit || 'PCS',
        need,
        free,
        otherBatchesReserved: otherReserved,
        sih,
      });
    }
  }

  if (shortages.length === 0) return;

  const summary = shortages
    .slice(0, 4)
    .map(
      (s) =>
        `${s.code} (need ${s.need} ${s.unit}, free ${s.free} ${s.unit} after ${s.otherBatchesReserved} ${s.unit} reserved by other batches)`,
    )
    .join('; ');
  const more = shortages.length > 4 ? ` (+${shortages.length - 4} more)` : '';
  const err = new Error(
    `Cannot reserve — stock is already allocated to other production batches. ${summary}${more}`,
  );
  err.statusCode = 409;
  err.reserveShortages = shortages;
  throw err;
}

function normalizeCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const set = new Set(
    codes.map((c) => String(c ?? '').trim()).filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

async function buildRmQuantitiesMap(d, bomRmLines, bomSource, planningBatchSizeKg, codesFilter) {
  const batchSizeKg = (bomSource === 'planning_batch' && planningBatchSizeKg != null && planningBatchSizeKg > 0)
    ? planningBatchSizeKg
    : (Number(d.batch_size) || Number(d.order_qty) || 0);
  if (batchSizeKg <= 0) return new Map();

  const rmQuantities = new Map();
  for (const line of bomRmLines || []) {
    const code = String(line.rm_code || line.rmCode || line.code || '').trim();
    if (!code) continue;
    if (codesFilter && !codesFilter.has(code)) continue;
    const rm = await RawMaterial.findOne({ where: { code } });
    if (!rm) continue;
    const rmId = rm.id;
    const pct = Number(line.pct_w_w ?? line.pct ?? 0);
    const directQty = Number(line.qty_per_unit ?? line.quantity ?? line.qty ?? 0) || 0;
    const quantity = pct > 0 ? (batchSizeKg * pct) / 100 : directQty;
    if (quantity <= 0) continue;
    const unit = line.uom || 'KG';
    const existing = rmQuantities.get(rmId);
    if (existing) {
      existing.quantity = roundPlanningMaterialQty(existing.quantity + quantity);
    } else {
      rmQuantities.set(rmId, { quantity: roundPlanningMaterialQty(quantity), unit, code });
    }
  }
  return rmQuantities;
}

async function buildPmQuantitiesMap(d, bomPmLines, bomSource, planningBatchSizeKg, codesFilter) {
  const totalBatches = Number(d.total_batches) || 0;
  const orderQty = Number(d.order_qty) || 0;
  const batchSizeUnits = (bomSource === 'planning_batch' && planningBatchSizeKg != null && planningBatchSizeKg > 0)
    ? Math.round(planningBatchSizeKg)
    : (totalBatches > 0 ? Math.ceil(orderQty / totalBatches) : (Number(d.batch_size) || orderQty || 1));

  const pmQuantities = new Map();
  for (const line of bomPmLines || []) {
    const code = String(line.pm_code || line.pmCode || line.code || '').trim();
    if (!code) continue;
    if (codesFilter && !codesFilter.has(code)) continue;
    const pm = await PackMaterial.findOne({ where: { code } });
    if (!pm) continue;
    const pmId = pm.id;
    const qtyPerUnit = line.qty_per_unit != null ? Number(line.qty_per_unit) : (line.quantity != null ? Number(line.quantity) : 1);
    const quantity = qtyPerUnit * batchSizeUnits;
    if (quantity <= 0) continue;
    const unit = line.uom || 'PCS';
    const existing = pmQuantities.get(pmId);
    if (existing) {
      existing.quantity = roundPlanningMaterialQty(existing.quantity + quantity);
    } else {
      pmQuantities.set(pmId, { quantity: roundPlanningMaterialQty(quantity), unit, code });
    }
  }
  return pmQuantities;
}

async function getReservedByCodeForBatch(batchId, kind) {
  const where =
    kind === 'rm'
      ? { production_batch_id: batchId, pack_material_id: null, raw_material_id: { [Op.ne]: null } }
      : { production_batch_id: batchId, raw_material_id: null, pack_material_id: { [Op.ne]: null } };
  const rows = await ReservedBatchItem.findAll({
    where,
    attributes: ['raw_material_id', 'pack_material_id', 'quantity_reserved'],
  });
  const byCode = {};
  for (const row of rows) {
    const plain = batchPlain(row);
    const qty = Number(plain.quantity_reserved) || 0;
    if (qty <= 0) continue;
    if (kind === 'rm' && plain.raw_material_id != null) {
      const rm = await RawMaterial.findByPk(plain.raw_material_id, { attributes: ['code'] });
      const code = String(rm?.code || '').trim();
      if (code) byCode[code] = (byCode[code] ?? 0) + qty;
    } else if (kind === 'pm' && plain.pack_material_id != null) {
      const pm = await PackMaterial.findByPk(plain.pack_material_id, { attributes: ['code'] });
      const code = String(pm?.code || '').trim();
      if (code) byCode[code] = (byCode[code] ?? 0) + qty;
    }
  }
  return byCode;
}

async function computeCoverage(d, kind, bomMeta) {
  const { rmLines, pmLines, source, batchSizeKg } = bomMeta;
  const requiredMap =
    kind === 'rm'
      ? await buildRmQuantitiesMap(d, rmLines, source, batchSizeKg, null)
      : await buildPmQuantitiesMap(d, pmLines, source, batchSizeKg, null);
  const reservedByCode = await getReservedByCodeForBatch(d.id, kind);
  const lines = [];
  for (const [matId, meta] of requiredMap) {
    const required = Number(meta.quantity) || 0;
    const reserved = Number(reservedByCode[meta.code] ?? 0) || 0;
    lines.push({
      code: meta.code,
      materialId: matId,
      required,
      reserved,
      unit: meta.unit,
      fullyReserved: materialQtyGte(reserved, required),
    });
  }
  const fullyReserved = lines.length > 0 && lines.every((l) => l.fullyReserved);
  const anyReserved = lines.some((l) => l.reserved > EPS);
  return { lines, fullyReserved, anyReserved };
}

async function syncBatchReserveFlags(batchRow, kind, bomMeta) {
  const d = batchPlain(batchRow);
  if (!bomMeta) return d;
  const { fullyReserved, anyReserved } = await computeCoverage(d, kind, bomMeta);
  const updates = {};

  if (kind === 'rm') {
    const locked = ['rm_connected', 'dispensing', 'in_production', 'bulk_qc', 'qc_failed', 'cleared'].includes(d.bmr_status);
    if (locked) return d;
    updates.rm_reserved = fullyReserved;
    if (fullyReserved && d.bmr_status === 'batch_confirmed') {
      updates.bmr_status = 'rm_reserved';
    } else if (!fullyReserved && d.bmr_status === 'rm_reserved' && !d.rm_connected) {
      updates.bmr_status = 'batch_confirmed';
    }
  } else {
    if (String(d.bmr_status || '').toLowerCase() !== 'cleared') {
      return d;
    }
    const locked = ['pm_connected', 'pm_dispensing', 'filling', 'fill_qc', 'packaging', 'pack_qc', 'qc_failed', 'fg_ready'].includes(d.bpr_status);
    if (locked) return d;
    updates.pm_reserved = fullyReserved;
    if (fullyReserved && (d.bpr_status === 'draft' || !d.bpr_status)) {
      updates.bpr_status = 'pm_reserved';
    } else if (!fullyReserved && d.bpr_status === 'pm_reserved' && !d.pm_connected) {
      updates.bpr_status = 'draft';
    }
  }

  if (Object.keys(updates).length > 0) {
    await batchRow.update(updates);
    await batchRow.reload();
  }
  return batchPlain(batchRow);
}

async function outboundMtrQtyForCode(bmrNo, kind, materialId) {
  const bmr = String(bmrNo || '').trim();
  const mid = Number(materialId);
  if (!bmr || !Number.isFinite(mid) || mid <= 0) return 0;
  const rows = await MaterialRequestNote.findAll({
    where: {
      bmr_no: bmr,
      source: 'MTR',
      is_inbound_from_mu: { [Op.not]: true },
    },
    attributes: ['line_items', 'status'],
  });
  let total = 0;
  for (const row of rows) {
    const plain = batchPlain(row);
    const lines = Array.isArray(plain.line_items) ? plain.line_items : [];
    for (const li of lines) {
      const qty = Number(li.quantity) || 0;
      if (qty <= 0) continue;
      if (kind === 'rm' && Number(li.raw_material_id) === mid) total += qty;
      if (kind === 'pm' && Number(li.pack_material_id) === mid) total += qty;
    }
  }
  return total;
}

function dispensingQtyForCode(dispensingArr, code) {
  const c = String(code || '').trim();
  if (!c || !Array.isArray(dispensingArr)) return 0;
  for (const line of dispensingArr) {
    const lc = String(line?.code ?? line?.pm_code ?? line?.rm_code ?? '').trim();
    if (lc === c) return Number(line.dispensed ?? 0) || 0;
  }
  return 0;
}

async function assertCanUnreserveLine(batchPlain, kind, code, materialId) {
  if (kind === 'rm' && batchPlain.rm_connected) {
    const err = new Error('Cannot remove RM reservation — material is already connected for this batch.');
    err.statusCode = 409;
    throw err;
  }
  if (kind === 'pm' && batchPlain.pm_connected) {
    const err = new Error('Cannot remove PM reservation — packaging is already connected for this batch.');
    err.statusCode = 409;
    throw err;
  }
  const dispensing = kind === 'rm' ? batchPlain.dispensing_rm : batchPlain.dispensing_pm;
  if (dispensingQtyForCode(dispensing, code) > EPS) {
    const err = new Error(`Cannot remove reservation — dispensing already recorded for ${code}.`);
    err.statusCode = 409;
    throw err;
  }
  const mtrQty = await outboundMtrQtyForCode(batchPlain.bmr_no, kind, materialId);
  if (mtrQty > EPS) {
    const err = new Error(`Cannot remove reservation — ${code} is on an outbound MTR for this batch.`);
    err.statusCode = 409;
    throw err;
  }
}

/**
 * Reserve selected BOM lines (or all when codes omitted).
 * @param {import('sequelize').Model} batchRow
 * @param {'rm'|'pm'} kind
 * @param {string[]|null} codes
 * @param {{ rmLines, pmLines, source, batchSizeKg }} bomMeta
 */
async function reserveProductionBatchLines(batchRow, kind, codes, bomMeta) {
  const d = batchPlain(batchRow);
  if (kind === 'pm' && String(d.bmr_status || '').toLowerCase() !== 'cleared') {
    const err = new Error('Packaging cannot start until BMR bulk QC is cleared');
    err.statusCode = 400;
    throw err;
  }
  const codesFilter = normalizeCodes(codes);
  const rmQuantities = kind === 'rm'
    ? await buildRmQuantitiesMap(d, bomMeta.rmLines, bomMeta.source, bomMeta.batchSizeKg, codesFilter)
    : new Map();
  const pmQuantities = kind === 'pm'
    ? await buildPmQuantitiesMap(d, bomMeta.pmLines, bomMeta.source, bomMeta.batchSizeKg, codesFilter)
    : new Map();

  const quantities = kind === 'rm' ? rmQuantities : pmQuantities;
  if (quantities.size === 0) {
    const err = new Error('No materials to reserve for the selected lines.');
    err.statusCode = 400;
    throw err;
  }

  await assertExclusiveBatchReserveAvailability(
    d.id,
    kind === 'rm' ? quantities : new Map(),
    kind === 'pm' ? quantities : new Map(),
  );

  const existingWhere =
    kind === 'rm'
      ? { production_batch_id: d.id, pack_material_id: null }
      : { production_batch_id: d.id, raw_material_id: null };
  const existingRows = await ReservedBatchItem.findAll({ where: existingWhere });
  const existingByMatId = new Map();
  for (const r of existingRows) {
    const p = batchPlain(r);
    const matId = kind === 'rm' ? Number(p.raw_material_id) : Number(p.pack_material_id);
    if (Number.isFinite(matId) && matId > 0) existingByMatId.set(matId, r);
  }

  const affectedRmIds = new Set();
  const affectedPmIds = new Set();
  const batchNo = kind === 'rm' ? (d.bmr_no || '') : (d.bpr_no || d.bmr_no || '');

  for (const [matId, { quantity, unit, code }] of quantities) {
    const existing = existingByMatId.get(matId);
    if (existing) {
      const ep = batchPlain(existing);
      const cur = Number(ep.quantity_reserved) || 0;
      if (materialQtyGte(cur, quantity)) continue;
      await existing.update({ quantity_reserved: roundPlanningMaterialQty(quantity) });
    } else {
      await ReservedBatchItem.create({
        production_batch_id: d.id,
        raw_material_id: kind === 'rm' ? matId : null,
        pack_material_id: kind === 'pm' ? matId : null,
        quantity_reserved: roundPlanningMaterialQty(quantity),
        unit,
      });
    }
    if (kind === 'rm') affectedRmIds.add(matId);
    else affectedPmIds.add(matId);

    const wh = await WarehouseInventory.findOne({
      where: kind === 'rm'
        ? { item_type: 'RM', raw_material_id: matId }
        : { item_type: 'PM', pack_material_id: matId },
    });
    if (wh) {
      const whPlain = batchPlain(wh);
      const sum = await ReservedBatchItem.sum('quantity_reserved', {
        where: kind === 'rm'
          ? { raw_material_id: matId }
          : { pack_material_id: matId },
      });
      await logReservedChange({
        warehouseInventoryId: whPlain.id,
        itemType: kind === 'rm' ? 'RM' : 'PM',
        rawMaterialId: kind === 'rm' ? matId : null,
        packMaterialId: kind === 'pm' ? matId : null,
        productId: null,
        reservedDelta: roundPlanningMaterialQty(quantity),
        reservedAfter: sum != null ? Number(sum) : 0,
        productionBatchId: d.id,
        batchNo,
        actionType: kind === 'rm' ? 'BMR_RESERVED' : 'BPR_RESERVED',
        notes: code ? `Line ${code}` : undefined,
      });
    }
  }

  await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
  try {
    const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[batchLineReserve] syncWarehouseInTransitAll failed:', e?.message || e);
  }

  await syncBatchReserveFlags(batchRow, kind, bomMeta);
  await batchRow.reload();
  return batchPlain(batchRow);
}

async function unreserveProductionBatchLines(batchRow, kind, codes, bomMeta) {
  const d = batchPlain(batchRow);
  const codesFilter = normalizeCodes(codes);
  if (!codesFilter || codesFilter.size === 0) {
    const err = new Error('Select at least one material code to unreserve.');
    err.statusCode = 400;
    throw err;
  }

  const requiredMap =
    kind === 'rm'
      ? await buildRmQuantitiesMap(d, bomMeta.rmLines, bomMeta.source, bomMeta.batchSizeKg, codesFilter)
      : await buildPmQuantitiesMap(d, bomMeta.pmLines, bomMeta.source, bomMeta.batchSizeKg, codesFilter);

  const where =
    kind === 'rm'
      ? { production_batch_id: d.id, pack_material_id: null, raw_material_id: { [Op.ne]: null } }
      : { production_batch_id: d.id, raw_material_id: null, pack_material_id: { [Op.ne]: null } };
  const rows = await ReservedBatchItem.findAll({ where });

  const affectedRmIds = new Set();
  const affectedPmIds = new Set();
  const batchNo = kind === 'rm' ? (d.bmr_no || '') : (d.bpr_no || d.bmr_no || '');

  for (const rbi of rows) {
    const plain = batchPlain(rbi);
    const matId = kind === 'rm' ? Number(plain.raw_material_id) : Number(plain.pack_material_id);
    const meta = requiredMap.get(matId);
    if (!meta) continue;
    const code = meta.code;
    await assertCanUnreserveLine(d, kind, code, matId);

    const qty = Number(plain.quantity_reserved) || 0;
    if (qty <= 0) {
      await rbi.destroy();
      continue;
    }
    if (kind === 'rm') affectedRmIds.add(matId);
    else affectedPmIds.add(matId);

    const wh = await WarehouseInventory.findOne({
      where: kind === 'rm'
        ? { item_type: 'RM', raw_material_id: matId }
        : { item_type: 'PM', pack_material_id: matId },
    });
    if (wh) {
      const whPlain = batchPlain(wh);
      const reservedBefore = Number(whPlain.reserved) || 0;
      const reservedAfter = Math.max(0, reservedBefore - qty);
      await logReservedChange({
        warehouseInventoryId: whPlain.id,
        itemType: kind === 'rm' ? 'RM' : 'PM',
        rawMaterialId: kind === 'rm' ? matId : null,
        packMaterialId: kind === 'pm' ? matId : null,
        productId: null,
        reservedDelta: -qty,
        reservedAfter,
        productionBatchId: d.id,
        batchNo,
        actionType: kind === 'rm' ? 'BMR_UNRESERVED' : 'BPR_UNRESERVED',
        notes: code ? `Line ${code}` : undefined,
      });
    }
    await rbi.destroy();
  }

  if (affectedRmIds.size > 0 || affectedPmIds.size > 0) {
    await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
  }
  await syncBatchReserveFlags(batchRow, kind, bomMeta);
  await batchRow.reload();
  return batchPlain(batchRow);
}

async function listProductionReservedItems() {
  const rows = await ReservedBatchItem.findAll({
    where: { production_batch_id: { [Op.ne]: null } },
    order: [['updated_at', 'DESC']],
    limit: 5000,
  });
  const batchIds = [...new Set(rows.map((r) => Number(batchPlain(r).production_batch_id)).filter((id) => id > 0))];
  const batches = batchIds.length
    ? await ProductionBatch.findAll({ where: { id: { [Op.in]: batchIds } } })
    : [];
  const batchById = new Map(batches.map((b) => [batchPlain(b).id, batchPlain(b)]));

  const items = [];
  for (const row of rows) {
    const plain = batchPlain(row);
    const batchId = Number(plain.production_batch_id);
    const batch = batchById.get(batchId);
    const qty = Number(plain.quantity_reserved) || 0;
    if (qty <= EPS) continue;

    let code = '';
    let name = '';
    let itemType = '';
    if (plain.raw_material_id != null) {
      itemType = 'RM';
      const rm = await RawMaterial.findByPk(plain.raw_material_id, { attributes: ['code', 'name', 'inci'] });
      code = String(rm?.code || '').trim();
      name = String(rm?.inci || rm?.name || code).trim();
    } else if (plain.pack_material_id != null) {
      itemType = 'PM';
      const pm = await PackMaterial.findByPk(plain.pack_material_id, { attributes: ['code', 'description'] });
      code = String(pm?.code || '').trim();
      name = String(pm?.description || code).trim();
    } else {
      continue;
    }

    items.push({
      id: plain.id,
      productionBatchId: batchId,
      bmrNo: batch?.bmr_no ?? null,
      bprNo: batch?.bpr_no ?? null,
      soNo: batch?.so_no ?? plain.so_no ?? null,
      productName: batch?.product_name ?? null,
      itemType,
      code,
      name,
      quantityReserved: qty,
      unit: plain.unit || (itemType === 'RM' ? 'KG' : 'PCS'),
      updatedAt: plain.updated_at,
    });
  }
  return items;
}

module.exports = {
  reserveProductionBatchLines,
  unreserveProductionBatchLines,
  listProductionReservedItems,
  computeBatchMaterialCoverage: computeCoverage,
  getReservedByCodeForBatch,
};
