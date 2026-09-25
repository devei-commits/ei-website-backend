#!/usr/bin/env node
/**
 * Revive planning_batches rows that exist in the Sept 15 backup but are missing from the live DB
 * (e.g. hard-deleted via the Batches "Delete" action, which is a real SQL DELETE — planning_batches
 * has no soft-delete despite carrying deleted_at/lifecycle_status columns).
 *
 * SAFE BY DEFAULT: prints a report and does nothing else unless you pass --yes.
 *
 * Usage:
 *   node scripts/revive-planning-batches.js                # dry run — report only
 *   node scripts/revive-planning-batches.js --yes           # actually insert the missing rows
 *   ALLOW_REVIVE_PLANNING_BATCHES=true node scripts/revive-planning-batches.js
 *
 * Run this from a machine/terminal that can actually reach the target DATABASE_URL (e.g. wherever
 * the prod tunnel on localhost:15432 is active) — it uses this project's own db.js connection.
 *
 * What it does NOT do:
 *   - Does not touch production_batches (BMR/BPR records) at all. If a batch's linked production
 *     batch got orphaned (planning_batch_id set NULL by the delete's FK cascade) rather than
 *     actually soft-deleted, this script's report will call that out, but relinking is a separate,
 *     deliberate step — ask for it once you've confirmed the planning_batches revival looks right.
 *   - Does not guess whether a revived batch should be marked "sent" again (sent_batch_indices) —
 *     that's not recoverable from this backup with confidence, since the batch's own sent status is
 *     tracked on planning_extracted, not on the batch row, and may have changed between Sept 15 and
 *     the deletion. Re-send from the app if this batch needs to show as sent.
 *   - Does not touch planning_extracted.custom_batches / batch_count — the app already recomputes
 *     those automatically the next time anyone opens this SO's "Plan Batches" screen
 *     (reconcilePlanningBatchDenorm, called from listBatches).
 */
require('dotenv').config();

// `host.docker.internal` only resolves from inside a Docker container's own DNS; run from a plain
// terminal on the host machine (as this script is meant to be) and it fails with ENOTFOUND even
// though the same tunnel is reachable as plain `localhost` on that same port. Swap it automatically
// — this only rewrites the hostname the script itself connects with, .env is never touched.
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('host.docker.internal')) {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = before.replace('host.docker.internal', 'localhost');
  console.log('Rewrote DATABASE_URL host: host.docker.internal -> localhost (script-local only, .env unchanged)');
}

require('../registerModelsForSync');

const fs = require('fs');
const path = require('path');

const BACKUP_SQL_PATH = path.join(__dirname, '..', 'backups', 'ei_pg_backup_20260915_094613.sql');

/** Unescape one Postgres COPY (text format) field: \N -> null, \\ \t \n \r -> literal chars. */
function unescapeCopyField(raw) {
  if (raw === '\\N') return null;
  return raw.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '\\') return '\\';
    return c;
  });
}

/** Parse the `COPY public.<table> (...) FROM stdin;` block for one table out of a pg_dump plain-SQL file. */
function parseCopyBlock(sqlText, tableName) {
  const startMarker = `COPY public.${tableName} (`;
  const startIdx = sqlText.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`COPY block for ${tableName} not found in backup`);
  const headerEnd = sqlText.indexOf(')', startIdx);
  const columnsRaw = sqlText.slice(startIdx + startMarker.length, headerEnd);
  const columns = columnsRaw.split(',').map((c) => c.trim());
  const dataStart = sqlText.indexOf('\n', headerEnd) + 1;
  const dataEnd = sqlText.indexOf('\n\\.', dataStart);
  const block = sqlText.slice(dataStart, dataEnd);
  const lines = block.split('\n').filter((l) => l.length > 0);
  return lines.map((line) => {
    const fields = line.split('\t').map(unescapeCopyField);
    const row = {};
    columns.forEach((col, i) => { row[col] = fields[i]; });
    return row;
  });
}

function toJsonOrNull(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--yes') || argv.includes('-y')
    || String(process.env.ALLOW_REVIVE_PLANNING_BATCHES || '').toLowerCase() === 'true';

  if (!fs.existsSync(BACKUP_SQL_PATH)) {
    console.error(`Backup file not found: ${BACKUP_SQL_PATH}`);
    process.exit(1);
  }
  const sqlText = fs.readFileSync(BACKUP_SQL_PATH, 'utf8');
  const backupRows = parseCopyBlock(sqlText, 'planning_batches');
  console.log(`Backup (Sept 15) has ${backupRows.length} planning_batches rows.`);

  const PlanningBatch = require('../src/planningExtracted/planningBatchModel');
  const PlanningExtracted = require('../src/planningExtracted/models');
  const { ProductionBatch } = require('../src/production/models');
  const db = require('../db');

  await db.authenticate();
  console.log('Connected to DATABASE_URL:', String(process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@'));

  const liveRows = await PlanningBatch.findAll({ attributes: ['id', 'planning_extracted_id', 'sequence', 'batch_code'] });
  const liveById = new Map(liveRows.map((r) => [r.id, r]));
  const liveByPeSeq = new Map(liveRows.map((r) => [`${r.planning_extracted_id}:${r.sequence}`, r]));

  const missing = backupRows.filter((b) => !liveById.has(Number(b.id)));
  console.log(`\n${missing.length} row(s) present in the Sept 15 backup but missing from the live DB right now:\n`);

  // Find the largest tight time-cluster of production_batches.deleted_at (any group of soft-deletes
  // within 5 minutes of each other) — this is almost always one bulk action, regardless of what
  // calendar date/time the server clock happened to label it, which is more reliable than trusting
  // "yesterday" against a clock that may be off.
  const allDeletedProd = await ProductionBatch.findAll({
    where: { deleted_at: { [require('sequelize').Op.ne]: null } },
    attributes: ['id', 'bmr_no', 'so_no', 'deleted_at'],
    order: [['deleted_at', 'ASC']],
  });
  let bestCluster = [];
  let current = [];
  for (const row of allDeletedProd) {
    const t = new Date(row.deleted_at).getTime();
    if (current.length === 0 || t - new Date(current[current.length - 1].deleted_at).getTime() <= 5 * 60 * 1000) {
      current.push(row);
    } else {
      if (current.length > bestCluster.length) bestCluster = current;
      current = [row];
    }
  }
  if (current.length > bestCluster.length) bestCluster = current;
  const clusterSoNos = new Set(bestCluster.map((r) => r.so_no));
  if (bestCluster.length > 0) {
    console.log(
      `Largest tight deletion cluster: ${bestCluster.length} production batch(es) soft-deleted between `
      + `${bestCluster[0].deleted_at} and ${bestCluster[bestCluster.length - 1].deleted_at} `
      + `(SOs: ${[...clusterSoNos].join(', ')}) — this is the most likely "yesterday" bulk action.\n`
    );
  }

  const toRevive = [];
  const conflicts = [];
  for (const b of missing) {
    const key = `${b.planning_extracted_id}:${b.sequence}`;
    const clash = liveByPeSeq.get(key);
    const pe = await PlanningExtracted.findByPk(Number(b.planning_extracted_id), { attributes: ['id', 'sales_order_id'] });
    let soNo = '(planning_extracted row gone)';
    if (pe) {
      const so = await require('../src/salesOrders/models').findByPk(pe.sales_order_id, { attributes: ['order_id'] });
      soNo = (so && so.order_id) || '(unknown SO)';
    }
    const inCluster = clusterSoNos.has(soNo);
    if (clash) {
      conflicts.push({ backup: b, clash });
      console.log(
        `  CONFLICT  id=${b.id} ${b.batch_code}  so_no=${soNo}  — a different batch (id=${clash.id}, ${clash.batch_code}) `
        + `already occupies planning_extracted_id=${b.planning_extracted_id} sequence=${b.sequence}. Skipping — needs manual review.`
      );
      continue;
    }
    toRevive.push({ ...b, __soNo: soNo, __inCluster: inCluster });
    console.log(
      `  REVIVE    id=${b.id} ${b.batch_code}  so_no=${soNo}  size_kg=${b.size_kg}`
      + `${inCluster ? '   <-- matches the yesterday cluster' : ''}`
    );
  }

  if (toRevive.length === 0) {
    console.log('\nNothing to revive (either nothing is missing, or every missing row conflicts with something already there).');
  } else {
    // Cross-check: any planning_extracted row these belonged to no longer exists at all?
    const peIds = [...new Set(toRevive.map((b) => Number(b.planning_extracted_id)))];
    const existingPe = await PlanningExtracted.findAll({ where: { id: peIds }, attributes: ['id'] });
    const existingPeIds = new Set(existingPe.map((p) => p.id));
    const orphanedByMissingPe = toRevive.filter((b) => !existingPeIds.has(Number(b.planning_extracted_id)));
    if (orphanedByMissingPe.length > 0) {
      console.log(
        `\nNOTE: ${orphanedByMissingPe.length} of the above belong to a planning_extracted row that no longer `
        + `exists either (ids: ${orphanedByMissingPe.map((b) => b.planning_extracted_id).join(', ')}). `
        + `They cannot be revived until that parent row exists — this script will skip them.`
      );
    }

    // Best-effort: report which of these look orphaned on the Production side (planning_batch_id
    // nulled by the delete's FK cascade, rather than the linked BMR being soft-deleted as intended).
    const orphanedProd = await ProductionBatch.findAll({
      where: { planning_batch_id: null },
      attributes: ['id', 'bmr_no', 'so_no', 'product_name', 'deleted_at'],
      order: [['id', 'DESC']],
      limit: 50,
    });
    if (orphanedProd.length > 0) {
      console.log(
        `\nFYI: ${orphanedProd.length} production_batches row(s) currently have planning_batch_id = NULL `
        + `(showing up to 50). Some of these may be the BMRs that belonged to the batches above, left `
        + `orphaned (not soft-deleted) by the delete's FK cascade. After reviewing the revive result, `
        + `ask me to relink the right ones — do not guess the mapping from this list alone:`
      );
      for (const p of orphanedProd) {
        console.log(`    production_batches.id=${p.id}  ${p.bmr_no}  so_no=${p.so_no}  ${p.product_name}  deleted_at=${p.deleted_at ?? 'null'}`);
      }
    }
  }

  const onlyCluster = argv.includes('--only-cluster');
  const revivable = onlyCluster ? toRevive.filter((b) => b.__inCluster) : toRevive;
  if (onlyCluster) {
    const skippedCount = toRevive.length - revivable.length;
    console.log(
      `\n--only-cluster: restricting to the ${revivable.length} row(s) matching the yesterday cluster `
      + `(${skippedCount} other REVIVE candidate(s) outside the cluster will be left alone).`
    );
  }

  if (!apply) {
    console.log(
      '\nDRY RUN — nothing was written.'
      + '\n  Revive everything listed as REVIVE above:      node scripts/revive-planning-batches.js --yes'
      + '\n  Revive ONLY the yesterday-cluster matches:      node scripts/revive-planning-batches.js --yes --only-cluster'
    );
    await db.close();
    return;
  }

  if (revivable.length === 0) {
    console.log('\nNothing to apply.');
    await db.close();
    return;
  }

  console.log('\nApplying...');
  let inserted = 0;
  await db.transaction(async (t) => {
    for (const b of revivable) {
      const peExists = await PlanningExtracted.findByPk(Number(b.planning_extracted_id), { attributes: ['id'], transaction: t });
      if (!peExists) {
        console.log(`  SKIP id=${b.id} ${b.batch_code} — parent planning_extracted_id=${b.planning_extracted_id} no longer exists.`);
        continue;
      }
      await PlanningBatch.create({
        id: Number(b.id),
        planning_extracted_id: Number(b.planning_extracted_id),
        sequence: Number(b.sequence),
        batch_code: b.batch_code,
        size_kg: b.size_kg != null ? Number(b.size_kg) : null,
        rm_lines: toJsonOrNull(b.rm_lines),
        pm_lines: toJsonOrNull(b.pm_lines),
        bom_confirmed_at: b.bom_confirmed_at,
        created_at: b.created_at,
        updated_at: new Date(),
        deleted_at: null,
        lifecycle_status: 'active',
      }, { transaction: t });
      inserted += 1;
      console.log(`  INSERTED id=${b.id} ${b.batch_code}`);
    }
  });

  console.log(`\nDone. Inserted ${inserted} row(s).`);
  console.log(
    'Next: open each affected SO\'s "Plan Batches" screen once — batch_count / custom_batches on the '
    + 'planning_extracted row recompute automatically on that fetch. If a revived batch needs to show '
    + 'as "sent to production" again, re-send it from the app; this script deliberately does not guess that.'
  );
  await db.close();
}

main().catch((e) => {
  console.error('revive-planning-batches failed:', e);
  process.exit(1);
});
