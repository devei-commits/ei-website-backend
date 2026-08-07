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

/**
 * How much of each requested line the facility can actually back right now.
 *
 * Reserving is NOT blocked by a shortage any more: the batch's claim on the material is always
 * recorded (quantity_requested), and only the stock-backed part goes into quantity_reserved. The
 * shortfall stays pending and is filled FIFO by src/lib/pendingReservationAllocator.js the moment
 * the material arrives in the facility.
 *
 * @returns {Promise<Map<number, {free:number, sih:number, otherBatchesReserved:number}>>}
 */
async function computeFreePoolForLines(batchId, kind, quantities) {
  const out = new Map();
  const itemType = kind === 'rm' ? 'RM' : 'PM';
  for (const [matId] of quantities) {
    const wh = await WarehouseInventory.findOne({
      where: kind === 'rm'
        ? { item_type: itemType, raw_material_id: matId }
        : { item_type: itemType, pack_material_id: matId },
    });
    const plain = wh?.get ? wh.get({ plain: true }) : wh;
    const sih = warehouseSihFromPlain(plain);
    const otherBatchesReserved = await sumReservedQtyOtherBatches(batchId, kind, matId);
    out.set(matId, { sih, otherBatchesReserved, free: Math.max(0, sih - otherBatchesReserved) });
  }
  return out;
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

/**
 * Per-code reserved (stock-backed) AND claimed (requested, incl. not-yet-arrived) for one batch.
 * @returns {Promise<{byCode: Record<string, number>, claimedByCode: Record<string, number>}>}
 */
async function getReservedAndClaimedByCodeForBatch(batchId, kind) {
  const where =
    kind === 'rm'
      ? { production_batch_id: batchId, pack_material_id: null, raw_material_id: { [Op.ne]: null } }
      : { production_batch_id: batchId, raw_material_id: null, pack_material_id: { [Op.ne]: null } };
  const rows = await ReservedBatchItem.findAll({
    where,
    attributes: ['raw_material_id', 'pack_material_id', 'quantity_reserved', 'quantity_requested'],
  });
  const byCode = {};
  const claimedByCode = {};
  for (const row of rows) {
    const plain = batchPlain(row);
    const qty = Number(plain.quantity_reserved) || 0;
    const req = Number(plain.quantity_requested);
    // Legacy rows (null requested) were fully stock-backed → claimed == reserved.
    const claimed = Number.isFinite(req) ? Math.max(req, 0) : qty;
    if (qty <= 0 && claimed <= 0) continue;
    let code = '';
    if (kind === 'rm' && plain.raw_material_id != null) {
      const rm = await RawMaterial.findByPk(plain.raw_material_id, { attributes: ['code'] });
      code = String(rm?.code || '').trim();
    } else if (kind === 'pm' && plain.pack_material_id != null) {
      const pm = await PackMaterial.findByPk(plain.pack_material_id, { attributes: ['code'] });
      code = String(pm?.code || '').trim();
    }
    if (!code) continue;
    byCode[code] = (byCode[code] ?? 0) + qty;
    claimedByCode[code] = (claimedByCode[code] ?? 0) + claimed;
  }
  return { byCode, claimedByCode };
}

/** Back-compat shape: stock-backed reserved qty per item code. */
async function getReservedByCodeForBatch(batchId, kind) {
  const { byCode } = await getReservedAndClaimedByCodeForBatch(batchId, kind);
  return byCode;
}

async function computeCoverage(d, kind, bomMeta) {
  const { rmLines, pmLines, source, batchSizeKg } = bomMeta;
  const requiredMap =
    kind === 'rm'
      ? await buildRmQuantitiesMap(d, rmLines, source, batchSizeKg, null)
      : await buildPmQuantitiesMap(d, pmLines, source, batchSizeKg, null);
  const { byCode: reservedByCode, claimedByCode } = await getReservedAndClaimedByCodeForBatch(d.id, kind);
  const lines = [];
  for (const [matId, meta] of requiredMap) {
    const required = Number(meta.quantity) || 0;
    const reserved = Number(reservedByCode[meta.code] ?? 0) || 0;
    const claimed = Number(claimedByCode[meta.code] ?? 0) || 0;
    lines.push({
      code: meta.code,
      materialId: matId,
      required,
      reserved,
      claimed,
      // Claimed but not yet in the facility — auto-allocated on GRN, FIFO.
      pending: Math.max(0, claimed - reserved),
      unit: meta.unit,
      fullyReserved: materialQtyGte(reserved, required),
      fullyClaimed: materialQtyGte(claimed, required),
    });
  }
  // `fullyReserved` stays STOCK-BACKED-only: it gates rm_reserved/pm_reserved, and a batch must not
  // advance to "reserved" on material that has not physically arrived. It flips on its own once the
  // allocator tops the lines up (see reconcilePendingReservationBatchFlags).
  const fullyReserved = lines.length > 0 && lines.every((l) => l.fullyReserved);
  const fullyClaimed = lines.length > 0 && lines.every((l) => l.fullyClaimed);
  const anyReserved = lines.some((l) => l.reserved > EPS);
  const anyPending = lines.some((l) => l.pending > EPS);
  return { lines, fullyReserved, fullyClaimed, anyReserved, anyPending };
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

  const freeByMat = await computeFreePoolForLines(d.id, kind, quantities);

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

  const pendingLines = [];
  for (const [matId, { quantity, unit, code }] of quantities) {
    const need = roundPlanningMaterialQty(Number(quantity) || 0);
    const existing = existingByMatId.get(matId);
    const cur = existing ? Number(batchPlain(existing).quantity_reserved) || 0 : 0;
    const free = freeByMat.get(matId)?.free ?? 0;
    // Stock-backed part now; the rest is a pending claim the allocator fills as material lands.
    const backed = roundPlanningMaterialQty(Math.max(cur, Math.min(need, free)));
    const shortBy = roundPlanningMaterialQty(Math.max(0, need - backed));
    if (shortBy > EPS) {
      pendingLines.push({ type: kind.toUpperCase(), code, materialId: matId, requested: need, reserved: backed, pending: shortBy, unit });
    }

    if (existing) {
      const ep = batchPlain(existing);
      const curRequested = Number(ep.quantity_requested);
      const requested = Number.isFinite(curRequested) ? Math.max(curRequested, need) : need;
      const updates = { quantity_requested: requested };
      if (!materialQtyGte(cur, backed)) updates.quantity_reserved = backed;
      await existing.update(updates);
    } else {
      await ReservedBatchItem.create({
        production_batch_id: d.id,
        raw_material_id: kind === 'rm' ? matId : null,
        pack_material_id: kind === 'pm' ? matId : null,
        quantity_reserved: backed,
        quantity_requested: need,
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
        reservedDelta: backed,
        reservedAfter: sum != null ? Number(sum) : 0,
        productionBatchId: d.id,
        batchNo,
        actionType: kind === 'rm' ? 'BMR_RESERVED' : 'BPR_RESERVED',
        notes: [code ? `Line ${code}` : null, shortBy > EPS ? `pending ${shortBy} ${unit}` : null]
          .filter(Boolean).join(' · ') || undefined,
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
  // `pendingReservations` lets the caller tell the user what was claimed-but-not-yet-in-stock.
  return { ...batchPlain(batchRow), pendingReservations: pendingLines };
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
  getReservedAndClaimedByCodeForBatch,
  syncBatchReserveFlags,
  // BOM → per-material required qty. Exported so the dev tray seeder produces figures identical
  // to what reservation uses (same rounding, same qty_per_unit / pct_w_w handling).
  buildRmQuantitiesMap,
  buildPmQuantitiesMap,
};
