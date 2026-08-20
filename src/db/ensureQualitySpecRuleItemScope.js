/**
 * Idempotent schema patch: let a quality spec rule target ONE item, not just a category.
 *
 *   quality_spec_rules.item_code  VARCHAR(150) NOT NULL DEFAULT ''
 *
 * Scope ladder, least to most specific:
 *
 *   category  →  category+sub  →  category+sub+subsub  →  item_code
 *
 * '' means "not scoped to an item", which is every rule that existed before this patch — so the
 * backfill is the column default and nothing changes for them.
 *
 * The old uniqueness constraint (entity_type, category, sub_category, sub_sub_category) would have
 * collapsed every item rule under one category into a single row, so it is replaced by one that
 * includes item_code. The old index is dropped only after the new one exists.
 *
 * Uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so a re-run is a no-op.
 */
const db = require('../../db');

let ran = false;

async function ensureQualitySpecRuleItemScope() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE quality_spec_rules
         ADD COLUMN IF NOT EXISTS item_code VARCHAR(150) NOT NULL DEFAULT ''`,
    );
    // An item-scoped rule needs the item code to be part of identity, or two rules for two items in
    // the same category collide on the old constraint.
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS quality_spec_rules_scope_item_uniq
         ON quality_spec_rules (entity_type, category, sub_category, sub_sub_category, item_code)`,
    );
    await db.query('DROP INDEX IF EXISTS quality_spec_rules_scope_uniq');
    // Item lookups skip the category ladder entirely, so they get their own index.
    await db.query(
      `CREATE INDEX IF NOT EXISTS quality_spec_rules_item_idx
         ON quality_spec_rules (entity_type, item_code)
       WHERE item_code <> ''`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureQualitySpecRuleItemScope failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureQualitySpecRuleItemScope };
