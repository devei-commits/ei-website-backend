/**
 * 1) Ensures the app schema exists: loads all Sequelize models then `db.sync()` (create missing
 *    tables only — does not `force` drop like seed.js).
 * 2) Removes every row from all application tables while keeping tables, columns, indexes, FKs.
 *
 * PostgreSQL: TRUNCATE … RESTART IDENTITY CASCADE over all `public` BASE TABLEs.
 * Excludes Sequelize migration history (`SequelizeMeta` / `sequelize_meta`) by default.
 *
 * Optional env:
 *   CLEAN_DATA_SYNC_ALTER=true  → pass `alter: true` to `db.sync()` to align columns with models
 *                                 (slower; use when schema drifted vs models).
 *
 * Safety: must pass `--yes` on the command line OR set ALLOW_CLEAN_DB=true in the environment.
 *
 * Usage:
 *   node cleanData.js --yes
 *   ALLOW_CLEAN_DB=true node cleanData.js
 *   npm run clean-data -- --yes
 *
 * Docker (from sprdlx repo root):
 *   docker compose exec backend node cleanData.js --yes
 *
 * Optional:
 *   --include-sequelize-meta   also truncate SequelizeMeta (migration history)
 */

require('dotenv').config();
const db = require('./db');
require('./registerModelsForSync');

function assertAllowedToRun(argv) {
  const hasFlag = argv.includes('--yes') || argv.includes('-y');
  const envOk = String(process.env.ALLOW_CLEAN_DB || '').toLowerCase() === 'true';
  if (!hasFlag && !envOk) {
    console.error(
      'Refusing to run: destructive data wipe. Re-run with --yes or ALLOW_CLEAN_DB=true'
    );
    process.exit(1);
  }
}

function quotePgIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * @param {{ includeSequelizeMeta?: boolean }} opts
 */
async function truncatePostgres(opts) {
  const excludeMeta = !opts.includeSequelizeMeta;
  const [rows] = await db.query(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       ${excludeMeta ? `AND table_name NOT IN ('SequelizeMeta', 'sequelize_meta')` : ''}
     ORDER BY table_name`,
    { raw: true }
  );

  const names = (rows || []).map((r) => r.name).filter(Boolean);
  if (!names.length) {
    console.warn(
      '[clean-data] No tables found in public schema after sync — check models / DATABASE_URL.'
    );
    return 0;
  }

  const list = names.map(quotePgIdent).join(', ');
  await db.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`, { raw: true });
  console.log(`[clean-data] Truncated ${names.length} table(s) in public (PostgreSQL).`);
  return names.length;
}

/**
 * @param {{ includeSequelizeMeta?: boolean }} opts
 */
async function truncateMysql(opts) {
  await db.query('SET FOREIGN_KEY_CHECKS = 0', { raw: true });
  const [tables] = await db.query('SHOW TABLES', { raw: true });
  const key = Object.keys((tables && tables[0]) || {})[0] || 'Tables_in_db';
  let n = 0;
  for (const row of tables || []) {
    const rawName = row[key];
    if (!rawName) continue;
    if (
      !opts.includeSequelizeMeta &&
      String(rawName).toLowerCase() === 'sequelizemeta'
    ) {
      continue;
    }
    await db.query(`TRUNCATE TABLE \`${String(rawName).replace(/`/g, '``')}\``, { raw: true });
    n += 1;
  }
  await db.query('SET FOREIGN_KEY_CHECKS = 1', { raw: true });
  console.log(`[clean-data] Truncated ${n} table(s) (MySQL).`);
  return n;
}

/**
 * @param {{ includeSequelizeMeta?: boolean }} opts
 */
async function deleteSqliteAll(opts) {
  const [rows] = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    { raw: true }
  );
  const names = (rows || []).map((r) => r.name).filter(Boolean);
  let n = 0;
  for (const name of names) {
    if (
      !opts.includeSequelizeMeta &&
      String(name).toLowerCase() === 'sequelizemeta'
    ) {
      continue;
    }
    const q = `"${String(name).replace(/"/g, '""')}"`;
    await db.query(`DELETE FROM ${q}`, { raw: true });
    n += 1;
  }
  await db.query('DELETE FROM sqlite_sequence', { raw: true }).catch(() => {});
  console.log(`[clean-data] Deleted rows from ${n} table(s) (SQLite).`);
  return n;
}

async function main() {
  assertAllowedToRun(process.argv);
  const includeSequelizeMeta =
    process.argv.includes('--include-sequelize-meta') ||
    String(process.env.CLEAN_DATA_INCLUDE_SEQUELIZE_META || '').toLowerCase() === 'true';

  const dialect = db.getDialect();
  const syncAlter = String(process.env.CLEAN_DATA_SYNC_ALTER || '').toLowerCase() === 'true';
  console.log(
    `[clean-data] dialect=${dialect} includeSequelizeMeta=${includeSequelizeMeta} syncAlter=${syncAlter}`
  );

  await db.authenticate();

  console.log('[clean-data] db.sync() — create missing tables (no force drop)...');
  await db.sync({ alter: syncAlter });
  console.log('[clean-data] sync complete.');

  let count = 0;
  if (dialect === 'postgres') {
    count = await truncatePostgres({ includeSequelizeMeta });
  } else if (dialect === 'mysql') {
    count = await truncateMysql({ includeSequelizeMeta });
  } else if (dialect === 'sqlite') {
    count = await deleteSqliteAll({ includeSequelizeMeta });
  } else {
    console.error(`[clean-data] Unsupported dialect: ${dialect}`);
    process.exit(1);
  }

  console.log('[clean-data] Done (tables present, all application rows removed).');
  await db.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[clean-data] Failed:', err);
  try {
    await db.close();
  } catch (_e) {
    /* ignore */
  }
  process.exit(1);
});
