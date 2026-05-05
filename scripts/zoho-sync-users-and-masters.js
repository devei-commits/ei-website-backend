#!/usr/bin/env node
/**
 * Run all Zoho contact -> DB syncs for users + masters:
 * 1) customers -> users
 * 2) customers -> vendor_clients(type=client)
 * 3) vendors   -> vendor_clients(type=vendor)
 *
 * Usage:
 *   node scripts/zoho-sync-users-and-masters.js [--dry-run] [--max-pages=N] [--limit=N] [--filter-by=...]
 */
const path = require('path');
const { spawn } = require('child_process');

function forwardArgs(argv) {
  return argv.filter((a) => !String(a).startsWith('--out'));
}

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
  const args = forwardArgs(process.argv.slice(2));
  const jobs = [
    'zoho-pull-customers-to-users.js',
    'zoho-pull-customers-to-clients.js',
    'zoho-pull-vendors-to-vendor-clients.js',
  ];

  for (const j of jobs) {
    console.error(`[zoho-sync-users-and-masters] running ${j}`);
    await runNodeScript(path.resolve(__dirname, j), args);
  }
  console.error('[zoho-sync-users-and-masters] done');
}

main().catch((e) => {
  console.error('[zoho-sync-users-and-masters]', e?.message || e);
  process.exit(1);
});

