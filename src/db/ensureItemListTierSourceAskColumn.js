/**
 * Idempotent schema patch: link a price-list tier back to the planning_quotation_asks row
 * that produced it, so reopening that ask can clean up the pricing it generated.
 *
 *   item_list_tiers.source_ask_id  INTEGER (nullable — only set for tiers created via Record Quote)
 *
 * Uses ADD COLUMN IF NOT EXISTS, so a re-run is a no-op. Ships as a merge-time patch that applies
 * on boot to every environment (local == live image).
 */
const db = require('../../db');

let ran = false;

async function ensureItemListTierSourceAskColumn() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE item_list_tiers
         ADD COLUMN IF NOT EXISTS source_ask_id INTEGER`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureItemListTierSourceAskColumn failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureItemListTierSourceAskColumn };
