/**
 * Outbound MTR (WH → MU): available to transfer = wh_stock − reserved (matches Production MTR modal).
 */

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function qtyAvailableWh(whStock, reserved) {
  return Math.max(0, toNum(whStock) - toNum(reserved));
}

function isQtyShort(available, required) {
  return toNum(available) + 1e-9 < toNum(required);
}

/**
 * Aggregate positive line qty by RM/PM id (and track code for error messages).
 * @param {Array<object>} lineItems
 * @returns {{ rm: Map<number, { qty: number, code: string }>, pm: Map<number, { qty: number, code: string }>, unresolved: Array<{ code: string, qty: number, unit: string }> }}
 */
function aggregateMtrLineQuantities(lineItems) {
  const rm = new Map();
  const pm = new Map();
  const unresolved = [];

  for (const li of lineItems || []) {
    const qty = toNum(li.quantity);
    if (qty <= 0) continue;
    const code = String(li.code || li.itemCode || li.rm_code || li.pm_code || '').trim();

    if (li.raw_material_id != null) {
      const id = Number(li.raw_material_id);
      const prev = rm.get(id) || { qty: 0, code };
      rm.set(id, { qty: prev.qty + qty, code: prev.code || code });
      continue;
    }
    if (li.pack_material_id != null) {
      const id = Number(li.pack_material_id);
      const prev = pm.get(id) || { qty: 0, code };
      pm.set(id, { qty: prev.qty + qty, code: prev.code || code });
      continue;
    }
    if (code) unresolved.push({ code, qty, unit: String(li.unit || '').trim() });
  }

  return { rm, pm, unresolved };
}

/**
 * @param {import('sequelize').ModelStatic} WarehouseInventory
 * @param {Array<object>} lineItems — after resolveLineItemCodes
 * @returns {Promise<{ ok: true } | { ok: false, error: string, details?: Array<object> }>}
 */
async function validateOutboundMtrWarehouseStock(WarehouseInventory, lineItems) {
  const { rm, pm, unresolved } = aggregateMtrLineQuantities(lineItems);

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
    const available = qtyAvailableWh(plain?.wh_stock, plain?.reserved);
    if (isQtyShort(available, agg.qty)) {
      shortages.push({
        type: 'RM',
        code: agg.code || `RM#${rmId}`,
        requested: agg.qty,
        available,
      });
    }
  }

  for (const [pmId, agg] of pm) {
    const inv = await WarehouseInventory.findOne({
      where: { item_type: 'PM', pack_material_id: pmId },
      attributes: ['wh_stock', 'reserved'],
    });
    const plain = inv && inv.get ? inv.get({ plain: true }) : inv;
    const available = qtyAvailableWh(plain?.wh_stock, plain?.reserved);
    if (isQtyShort(available, agg.qty)) {
      shortages.push({
        type: 'PM',
        code: agg.code || `PM#${pmId}`,
        requested: agg.qty,
        available,
      });
    }
  }

  if (shortages.length === 0) return { ok: true };

  const first = shortages[0];
  const unitHint = first.type === 'RM' ? 'KG' : 'PCS';
  const summary = shortages
    .slice(0, 3)
    .map((s) => `${s.code} (need ${s.requested} ${unitHint}, WH available ${s.available} ${unitHint})`)
    .join('; ');
  const more = shortages.length > 3 ? ` (+${shortages.length - 3} more)` : '';

  return {
    ok: false,
    error: `Insufficient warehouse stock for MTR: ${summary}${more}. Reduce "To transfer" or receive stock at warehouse (available = WH stock − reserved).`,
    details: shortages,
  };
}

module.exports = {
  aggregateMtrLineQuantities,
  qtyAvailableWh,
  validateOutboundMtrWarehouseStock,
};
