/**
 * Outbound MTR (WH → MU): transfer from production-reserved qty at warehouse,
 * capped by physical WH stock (matches Production MTR modal).
 */
const {
  materialQtyAdd,
  materialQtyFromDb,
  materialQtyGte,
  materialQtyGt,
  materialQtyMin,
  materialQtySubNonNeg,
  materialQtyToNum,
  sanitizeMrnLineItemQuantity,
} = require('../utils/materialQtyCompare');

/** Free stock — used for reserve flows, not outbound MTR. */
function qtyAvailableWh(whStock, reserved) {
  return materialQtyToNum(materialQtySubNonNeg(whStock, reserved));
}

/**
 * MTR pool = batch/production reserved qty transferable from WH now (capped by physical WH stock).
 * Prefer batchReserved (reserved_batch_items for this BMR/BPR) when provided; else warehouse_inventory.reserved.
 */
function qtyMtrFromReserved(whStock, reservedGlobal, batchReserved) {
  const wh = materialQtyFromDb(whStock);
  const alloc =
    batchReserved !== undefined && batchReserved !== null
      ? materialQtyFromDb(batchReserved)
      : materialQtyFromDb(reservedGlobal);
  return materialQtyToNum(materialQtyMin(alloc, wh));
}

/**
 * @param {number} productionBatchId
 * @returns {Promise<{ rm: Map<number, number>, pm: Map<number, number> }>}
 */
async function loadBatchReservedQtyMaps(productionBatchId) {
  const { ReservedBatchItem } = require('../fulfillment/models');
  const rm = new Map();
  const pm = new Map();
  if (!productionBatchId) return { rm, pm };
  const rows = await ReservedBatchItem.findAll({
    where: { production_batch_id: productionBatchId },
    attributes: ['raw_material_id', 'pack_material_id', 'quantity_reserved'],
  });
  for (const row of rows) {
    const plain = row.get ? row.get({ plain: true }) : row;
    const qty = materialQtyToNum(plain.quantity_reserved);
    if (qty <= 0) continue;
    if (plain.raw_material_id != null) {
      const id = Number(plain.raw_material_id);
      rm.set(id, materialQtyToNum(materialQtyAdd(rm.get(id) || 0, qty)));
    } else if (plain.pack_material_id != null) {
      const id = Number(plain.pack_material_id);
      pm.set(id, materialQtyToNum(materialQtyAdd(pm.get(id) || 0, qty)));
    }
  }
  return { rm, pm };
}

function isQtyShort(available, required) {
  return !materialQtyGte(available, required);
}

/**
 * Aggregate positive line qty by RM/PM id (and track code for error messages).
 * @param {Array<object>} lineItems
 * @returns {{ rm: Map<number, { qty: string, code: string }>, pm: Map<number, { qty: string, code: string }>, unresolved: Array<{ code: string, qty: string, unit: string }> }}
 */
function aggregateMtrLineQuantities(lineItems) {
  const rm = new Map();
  const pm = new Map();
  const unresolved = [];

  for (const li of lineItems || []) {
    const qty = sanitizeMrnLineItemQuantity(li.quantity);
    if (!materialQtyGt(qty, 0)) continue;
    const code = String(li.code || li.itemCode || li.rm_code || li.pm_code || '').trim();

    if (li.raw_material_id != null) {
      const id = Number(li.raw_material_id);
      const prev = rm.get(id) || { qty: '0', code };
      rm.set(id, { qty: materialQtyAdd(prev.qty, qty), code: prev.code || code });
      continue;
    }
    if (li.pack_material_id != null) {
      const id = Number(li.pack_material_id);
      const prev = pm.get(id) || { qty: '0', code };
      pm.set(id, { qty: materialQtyAdd(prev.qty, qty), code: prev.code || code });
      continue;
    }
    if (code) unresolved.push({ code, qty, unit: String(li.unit || '').trim() });
  }

  return { rm, pm, unresolved };
}

/**
 * @param {import('sequelize').ModelStatic} WarehouseInventory
 * @param {Array<object>} lineItems — after resolveLineItemCodes
 * @param {{ productionBatchId?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, error: string, details?: Array<object> }>}
 */
async function validateOutboundMtrWarehouseStock(WarehouseInventory, lineItems, opts = {}) {
  const { rm, pm, unresolved } = aggregateMtrLineQuantities(lineItems);
  const batchId = opts.productionBatchId != null ? Number(opts.productionBatchId) : null;
  const batchMaps =
    batchId && !Number.isNaN(batchId) ? await loadBatchReservedQtyMaps(batchId) : { rm: new Map(), pm: new Map() };

  if (unresolved.length > 0) {
    const codes = unresolved.map((u) => u.code).join(', ');
    return {
      ok: false,
      error: `Could not resolve material master for: ${codes}. Use a valid RM/PM code.`,
    };
  }

  const shortages = [];

  for (const [rmId, agg] of rm) {
    const inv = await WarehouseInventory.findOne({
      where: { item_type: 'RM', raw_material_id: rmId },
      attributes: ['wh_stock', 'reserved'],
    });
    const plain = inv && inv.get ? inv.get({ plain: true }) : inv;
    const batchReserved = batchMaps.rm.get(rmId);
    const mtrPool = qtyMtrFromReserved(plain?.wh_stock, plain?.reserved, batchReserved);
    if (isQtyShort(mtrPool, agg.qty)) {
      shortages.push({
        type: 'RM',
        code: agg.code || `RM#${rmId}`,
        requested: materialQtyToNum(agg.qty),
        available: mtrPool,
        reserved: batchReserved !== undefined ? materialQtyToNum(batchReserved) : materialQtyToNum(plain?.reserved),
        wh_stock: materialQtyToNum(plain?.wh_stock),
      });
    }
  }

  for (const [pmId, agg] of pm) {
    const inv = await WarehouseInventory.findOne({
      where: { item_type: 'PM', pack_material_id: pmId },
      attributes: ['wh_stock', 'reserved'],
    });
    const plain = inv && inv.get ? inv.get({ plain: true }) : inv;
    const batchReserved = batchMaps.pm.get(pmId);
    const mtrPool = qtyMtrFromReserved(plain?.wh_stock, plain?.reserved, batchReserved);
    if (isQtyShort(mtrPool, agg.qty)) {
      shortages.push({
        type: 'PM',
        code: agg.code || `PM#${pmId}`,
        requested: materialQtyToNum(agg.qty),
        available: mtrPool,
        reserved: batchReserved !== undefined ? materialQtyToNum(batchReserved) : materialQtyToNum(plain?.reserved),
        wh_stock: materialQtyToNum(plain?.wh_stock),
      });
    }
  }

  if (shortages.length === 0) return { ok: true };

  const first = shortages[0];
  const unitHint = first.type === 'RM' ? 'KG' : 'PCS';
  const summary = shortages
    .slice(0, 3)
    .map(
      (s) =>
        `${s.code} (need ${s.requested} ${unitHint}, reserved at WH ${s.reserved} ${unitHint}${s.wh_stock < s.reserved ? `, WH stock ${s.wh_stock}` : ''})`
    )
    .join('; ');
  const more = shortages.length > 3 ? ` (+${shortages.length - 3} more)` : '';

  return {
    ok: false,
    error: `Insufficient reserved stock for MTR: ${summary}${more}. Reserve material for production first, or reduce "To transfer".`,
    details: shortages,
  };
}

module.exports = {
  aggregateMtrLineQuantities,
  qtyAvailableWh,
  qtyMtrFromReserved,
  loadBatchReservedQtyMaps,
  validateOutboundMtrWarehouseStock,
};
