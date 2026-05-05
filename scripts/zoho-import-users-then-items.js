#!/usr/bin/env node
/**
 * Run Zoho import in sequence:
 * 1) customers -> users
 * 2) items -> products/raw_materials/pack_materials
 *
 * This ensures each script writes its own missing-required-fields report:
 * - exports/zoho-customers-missing-required-fields.json
 * - exports/zoho-items-missing-required-fields.json
 */
const path = require('path');
const { spawn } = require('child_process');
const { cleanOutputFile } = require('./lib/zoho-required-fields');

function runNodeScript(file, args) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [file, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    cp.on('error', reject);
    cp.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} failed with exit code ${code}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  // Clean stale reports before both import scripts run.
  await cleanOutputFile('exports/zoho-customers-missing-required-fields.json');
  await cleanOutputFile('exports/zoho-items-missing-required-fields.json');

  const jobs = ['zoho-pull-customers-to-users.js', 'zoho-pull-items-to-products.js'];

  for (const job of jobs) {
    console.error(`[zoho-import-users-then-items] running ${job}`);
    await runNodeScript(path.resolve(__dirname, job), args);
  }

  console.error('[zoho-import-users-then-items] done');
  console.error('[zoho-import-users-then-items] reports:');
  console.error(' - exports/zoho-customers-missing-required-fields.json');
  console.error(' - exports/zoho-items-missing-required-fields.json');
}

main().catch((e) => {
  console.error('[zoho-import-users-then-items]', e?.message || e);
  process.exit(1);
});
