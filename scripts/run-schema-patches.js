#!/usr/bin/env node
/**
 * Apply idempotent Postgres schema patches (see src/db/ensureSchemaPatches.js).
 * Use after restoring a backup or when the API reports a missing column.
 *
 *   npm run db:patch
 *   docker exec orders_app npm run db:patch
 */
const db = require('../db');
const { ensureSchemaPatches } = require('../src/db/ensureSchemaPatches');

async function main() {
  await db.authenticate();
  await ensureSchemaPatches();
  console.log('[db:patch] Schema patches applied.');
  await db.close();
}

main().catch((err) => {
  console.error('[db:patch] Failed:', err && err.message ? err.message : err);
  process.exit(1);
});
