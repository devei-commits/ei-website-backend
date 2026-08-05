/**
 * One-time, idempotent schema patch: drop the runaway DUPLICATE UNIQUE constraints
 * that `db.sync({ alter: true })` accumulated on a handful of tables (Sequelize re-adds
 * a `<table>_<col>_keyN` on every sync because it can't detect the existing one).
 *
 * For each (table, column) below it keeps exactly ONE single-column UNIQUE constraint
 * (prefers the canonical unsuffixed `<table>_<col>_key`, else the lexicographically
 * first) and drops all the others — each drop also removes its backing index.
 *
 * Idempotent: after the first run only one constraint remains per column, so a
 * re-run finds nothing to drop and is a no-op. Safe to leave wired at boot.
 *
 * This replaces the removed `db.sync({ alter: true })` + `ensure*` schema patches
 * (all already applied to the live DB). It ships as the merge-time cleanup.
 */
const { QueryTypes } = require('sequelize');
const db = require('../../db');

// Tables that suffered constraint bloat, with the columns that carry `unique: true`.
const TARGETS = [
  { table: 'facility_areas', columns: ['code', 'zoho_location_id'] },
  { table: 'warehouse_locations', columns: ['code', 'zoho_warehouse_id'] },
  { table: 'item_dedicated_facility_locations', columns: ['item_key'] },
  { table: 'lead_time_stats', columns: ['item_key'] },
];

let ran = false;

/** Names of every single-column UNIQUE constraint on (table, column), sorted. */
async function uniqueConstraintsFor(table, column) {
  const rows = await db.query(
    `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_attribute att
         ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE rel.relname = :table
        AND con.contype = 'u'
        AND array_length(con.conkey, 1) = 1
        AND att.attname = :column
      ORDER BY con.conname`,
    { type: QueryTypes.SELECT, replacements: { table, column } }
  );
  return rows.map((r) => r.conname);
}

/** Pick the constraint to KEEP: the canonical `<table>_<col>_key`, else the first. */
function pickKeeper(names, table, column) {
  const canonical = `${table}_${column}_key`;
  return names.includes(canonical) ? canonical : names[0];
}

async function dropDuplicateConstraints() {
  if (ran) return { dropped: 0, skipped: true };
  ran = true;
  let dropped = 0;
  for (const { table, columns } of TARGETS) {
    for (const column of columns) {
      let names;
      try {
        names = await uniqueConstraintsFor(table, column);
      } catch (e) {
        // table/column may not exist in some envs — skip quietly
        continue;
      }
      if (names.length <= 1) continue; // already clean
      const keep = pickKeeper(names, table, column);
      const toDrop = names.filter((n) => n !== keep);
      // Drop in chunks inside a transaction so a 1,000-constraint cleanup is one unit.
      const t = await db.transaction();
      try {
        for (const name of toDrop) {
          // identifiers are from pg catalog (safe), not user input
          await db.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`, { transaction: t });
          dropped += 1;
        }
        await t.commit();
      } catch (e) {
        await t.rollback();
        console.warn(`[schema-cleanup] failed dropping dupes on ${table}.${column}:`, e && e.message ? e.message : e);
      }
    }
  }
  if (dropped > 0) console.log(`[schema-cleanup] dropped ${dropped} duplicate UNIQUE constraints`);
  return { dropped };
}

module.exports = { dropDuplicateConstraints };
