'use strict';

/**
 * Avg Month Requirement (spec §6.1 / §6.3): average of the last N months of ACTUAL consumption,
 * derived from warehouse_inventory_location_history outbound rows (qty_delta < 0). This replaces the
 * stubbed warehouse_inventory.avg_mo column (which defaults/seeds to 0).
 *
 * Consumption is summed per item over the window then divided by the window length in months, so the
 * result is an average monthly draw in the ledger's native unit (same unit as the avg_mo column it
 * replaces — no kg conversion here).
 *
 * @param {Array<{item_type?: string, raw_material_id?: number|null, pack_material_id?: number|null, qty_delta: number}>} ledgerRows
 *   Outbound ledger rows already filtered to the window (qty_delta < 0). Sequelize instances or plain.
 * @param {number} windowMonths - number of months the window spans (e.g. 6). Clamped to >= 1.
 * @returns {{ rm: Map<number, number>, pm: Map<number, number> }} avg monthly consumption per item id
 */
function avgMonthlyConsumptionByItem(ledgerRows, windowMonths) {
  const months = Number(windowMonths) > 0 ? Number(windowMonths) : 1;
  const rmTotal = new Map();
  const pmTotal = new Map();
  for (const row of ledgerRows || []) {
    const d = row && row.get ? row.get({ plain: true }) : row;
    if (!d) continue;
    const qty = -(Number(d.qty_delta) || 0); // outbound stored negative → consumption positive
    if (!(qty > 0)) continue;
    if (d.item_type === 'RM' && d.raw_material_id != null) {
      const k = Number(d.raw_material_id);
      rmTotal.set(k, (rmTotal.get(k) || 0) + qty);
    } else if (d.item_type === 'PM' && d.pack_material_id != null) {
      const k = Number(d.pack_material_id);
      pmTotal.set(k, (pmTotal.get(k) || 0) + qty);
    }
  }
  const toAvg = (totals) => {
    const out = new Map();
    for (const [k, total] of totals) out.set(k, total / months);
    return out;
  };
  return { rm: toAvg(rmTotal), pm: toAvg(pmTotal) };
}

/** Default window for Avg Month Requirement (spec: trailing 6 months). */
const AVG_MONTH_WINDOW_MONTHS = 6;

module.exports = { avgMonthlyConsumptionByItem, AVG_MONTH_WINDOW_MONTHS };
