/**
 * Idempotent schema patch: individual per-line tax on sale order items, entered on the SO
 * (never a hardcoded/flat platform GST%) and carried through to invoice generation.
 *
 *   fulfillment_order_items.tax_pct     DECIMAL(5,2)  — rate entered on the line, default 0
 *   fulfillment_order_items.tax_amount  DECIMAL(12,2) — ₹ amount for ordered_qty × unit_price, kept
 *                                                        in sync with tax_pct by the client
 *
 * Uses ADD COLUMN IF NOT EXISTS, so a re-run is a no-op. Ships as a merge-time patch that applies
 * on boot to every environment (local == live image) — see src/fulfillment/models.js for the
 * matching Sequelize attributes.
 */
const db = require('../../db');

let ran = false;

async function ensureFulfillmentOrderItemTaxColumns() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE fulfillment_order_items
         ADD COLUMN IF NOT EXISTS tax_pct DECIMAL(5, 2) DEFAULT 0`,
    );
    await db.query(
      `ALTER TABLE fulfillment_order_items
         ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(12, 2) DEFAULT 0`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureFulfillmentOrderItemTaxColumns failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureFulfillmentOrderItemTaxColumns };
