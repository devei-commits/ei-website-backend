#!/usr/bin/env node
/**
 * Zoho Books GET /items → local `products` (PR), `raw_materials` (RM), `pack_materials` (PM).
 * Zoho exposes a single Items API; we classify each row then upsert into the right table.
 *
 * Classification (first match in ZOHO_PULL_KIND_ORDER, default pr,pm,rm):
 * - Each step tests Zoho `sku` then `name` against a regex.
 * - Defaults: EI-PR-, EI-PM-, EI-RM- (after prefix, any char incl. another -)
 * Override per env (full RegExp string, case-insensitive flag added if not present):
 *   ZOHO_PULL_KIND_PR_REGEX   (default ^EI-PR[-_])
 *   ZOHO_PULL_KIND_PM_REGEX   (default ^EI-PM[-_])
 *   ZOHO_PULL_KIND_RM_REGEX   (default ^EI-RM[-_])
 *   ZOHO_PULL_KIND_ORDER      (default pr,pm,rm)
 *   ZOHO_PULL_UNMATCHED       skip | pr | rm | pm — where to put items that match no regex (default skip)
 *
 * Incremental: state file + watermark like before; “known” Zoho ids = union of
 * products.zoho_item_id, raw_materials.zoho_id, pack_materials.zoho_id.
 *
 * Env: DATABASE_URL, Zoho OAuth/org (see prior docs). ZOHO_PULL_FILTER_BY, ZOHO_PULL_STATE_FILE, etc.
 *
 * Usage: node scripts/zoho-pull-items-to-products.js [--dry-run] [--full] [--update-existing] [--reset-state] [--max-pages=N] [--limit=N]
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { Op } = require('sequelize');

const db = require('../db');
const { Product } = require('../src/products/models');
const RawMaterial = require('../src/rawMaterials/models');
const PackMaterial = require('../src/packMaterials/models');
const { listAllItems, normalizeZohoId, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');

const STATE_VERSION = 2;

/** @returns {{ dryRun: boolean, updateExisting: boolean, full: boolean, resetState: boolean, maxPages?: number, limit?: number }} */
function parseArgs(argv) {
  const z = parseZohoPullArgs(argv);
  return {
    dryRun: argv.includes('--dry-run') || z.dryRun,
    updateExisting: argv.includes('--update-existing'),
    full: argv.includes('--full'),
    resetState: argv.includes('--reset-state'),
    maxPages: z.maxPages,
    limit: z.limit,
  };
}

function defaultStateFilePath() {
  return path.join(__dirname, '.zoho-pull-items-state.json');
}

function getStateFilePath() {
  const p = process.env.ZOHO_PULL_STATE_FILE;
  return p && String(p).trim() ? path.resolve(process.cwd(), String(p).trim()) : defaultStateFilePath();
}

function parseMaybeNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, unknown>} item
 * @returns {number | null} epoch ms, or null if unknown
 */
function zohoItemActivityMs(item) {
  const raw =
    item.last_modified_time != null && String(item.last_modified_time).trim() !== ''
      ? item.last_modified_time
      : item.last_modified_date != null && String(item.last_modified_date).trim() !== ''
        ? item.last_modified_date
        : item.created_time != null && String(item.created_time).trim() !== ''
          ? item.created_time
          : null;
  if (raw == null) return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function compileKindRegex(envKey, fallbackPattern) {
  const raw = process.env[envKey];
  if (raw != null && String(raw).trim() !== '') {
    try {
      const s = String(raw).trim();
      if (s.length >= 2 && s[0] === '/' && s.lastIndexOf('/') > 0) {
        const last = s.lastIndexOf('/');
        const body = s.slice(1, last);
        const flags = s.slice(last + 1) || 'i';
        return new RegExp(body, flags);
      }
      return new RegExp(s, 'i');
    } catch (e) {
      console.warn(`[zoho-pull] invalid ${envKey}, using default:`, e.message);
    }
  }
  return new RegExp(fallbackPattern, 'i');
}

/**
 * @param {Record<string, unknown>} item
 * @returns {'pr' | 'rm' | 'pm' | 'skip'}
 */
function classifyZohoMasterItem(item) {
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const rePr = compileKindRegex('ZOHO_PULL_KIND_PR_REGEX', '^EI-PR[-_]');
  const rePm = compileKindRegex('ZOHO_PULL_KIND_PM_REGEX', '^EI-PM[-_]');
  const reRm = compileKindRegex('ZOHO_PULL_KIND_RM_REGEX', '^EI-RM[-_]');
  const map = { pr: rePr, pm: rePm, rm: reRm };
  const orderRaw = process.env.ZOHO_PULL_KIND_ORDER || 'pr,pm,rm';
  const order = orderRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((k) => map[k]);

  const test = (re) => re.test(sku) || re.test(name);
  for (const k of order) {
    if (test(map[k])) return /** @type {'pr'|'rm'|'pm'} */ (k);
  }

  const u = String(process.env.ZOHO_PULL_UNMATCHED || 'skip').toLowerCase();
  if (u === 'pr' || u === 'rm' || u === 'pm') return u;
  return 'skip';
}

/**
 * @param {Record<string, unknown>} item
 */
function zohoItemToProductAttrs(item) {
  const zid = normalizeZohoId(item.item_id);
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const rateRaw = item.rate != null ? item.rate : item.sales_rate;
  const mrp = parseMaybeNum(rateRaw);
  const taxRate = parseMaybeNum(item.tax_percentage);
  const description =
    item.description != null && String(item.description).trim() !== ''
      ? String(item.description).trim()
      : null;
  const now = new Date();
  const productCode = sku || (zid ? `ZHO-PR-${zid}` : null);
  const status =
    item.status != null && String(item.status).trim() !== ''
      ? String(item.status).trim().toLowerCase()
      : null;

  return {
    zoho_item_id: zid,
    product_code: productCode,
    product_sku: sku || null,
    product_name: name || productCode || 'Zoho item',
    mrp_price: mrp,
    tax_rate: taxRate,
    product_description: description,
    status,
    created_at: now,
    updated_at: now,
  };
}

/**
 * @param {Record<string, unknown>} item
 */
function zohoItemToRawMaterialAttrs(item) {
  const zid = normalizeZohoId(item.item_id);
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const code = sku || (zid ? `ZHO-RM-${zid}` : 'UNKNOWN');
  const rateRaw =
    item.purchase_rate != null && String(item.purchase_rate).trim() !== ''
      ? item.purchase_rate
      : item.rate != null
        ? item.rate
        : item.sales_rate;
  const now = new Date();
  const hsn = item.hsn_or_sac != null && String(item.hsn_or_sac).trim() !== '' ? String(item.hsn_or_sac).trim() : null;
  const unit = item.unit != null && String(item.unit).trim() !== '' ? String(item.unit).trim() : null;
  const status =
    item.status != null && String(item.status).trim() !== ''
      ? String(item.status).trim().toLowerCase()
      : null;

  return {
    code,
    name: name || code,
    price_per_kg: parseMaybeNum(rateRaw),
    gst: parseMaybeNum(item.tax_percentage),
    sku: sku || null,
    hsn_code: hsn,
    uom: unit,
    zoho_id: zid,
    status,
    created_at: now,
    updated_at: now,
  };
}

/**
 * @param {Record<string, unknown>} item
 */
function zohoItemToPackMaterialAttrs(item) {
  const zid = normalizeZohoId(item.item_id);
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const code = sku || (zid ? `ZHO-PM-${zid}` : 'UNKNOWN');
  const rateRaw =
    item.purchase_rate != null && String(item.purchase_rate).trim() !== ''
      ? item.purchase_rate
      : item.rate != null
        ? item.rate
        : item.sales_rate;
  const now = new Date();
  const hsn = item.hsn_or_sac != null && String(item.hsn_or_sac).trim() !== '' ? String(item.hsn_or_sac).trim() : null;
  const unit = item.unit != null && String(item.unit).trim() !== '' ? String(item.unit).trim() : null;
  const status =
    item.status != null && String(item.status).trim() !== ''
      ? String(item.status).trim().toLowerCase()
      : null;

  return {
    code,
    description: name || code,
    price_per_pc: parseMaybeNum(rateRaw),
    sku: sku || null,
    hsn_code: hsn,
    unit,
    zoho_id: zid,
    status,
    created_at: now,
    updated_at: now,
  };
}

/** @typedef {{ version: number, organizationId: string, lastPullCompletedAt: string | null, lastRun?: Record<string, unknown> }} PullState */

/** @returns {Promise<PullState | null>} */
async function readState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const trimmed = raw != null ? String(raw).trim() : '';
    if (!trimmed) {
      console.warn(`[zoho-pull] state file is empty, ignoring: ${filePath}`);
      return null;
    }
    try {
      const data = JSON.parse(trimmed);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (parseErr) {
      console.warn(
        `[zoho-pull] state file is not valid JSON (will run as first pull). Delete or fix: ${filePath}`,
        parseErr && parseErr.message ? parseErr.message : parseErr
      );
      return null;
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** @param {string} filePath @param {PullState} state */
async function writeState(filePath, state) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Union of Zoho item ids already stored on PR / RM / PM (for incremental “new id” detection). */
async function loadKnownZohoItemIds() {
  const set = new Set();
  const [prows, rmrows, pmrows] = await Promise.all([
    Product.findAll({ attributes: ['zoho_item_id'], raw: true }),
    RawMaterial.findAll({ attributes: ['zoho_id'], raw: true }),
    PackMaterial.findAll({ attributes: ['zoho_id'], raw: true }),
  ]);
  for (const r of prows || []) {
    const z = normalizeZohoId(r.zoho_item_id);
    if (z) set.add(z);
  }
  for (const r of rmrows || []) {
    const z = normalizeZohoId(r.zoho_id);
    if (z) set.add(z);
  }
  for (const r of pmrows || []) {
    const z = normalizeZohoId(r.zoho_id);
    if (z) set.add(z);
  }
  return set;
}

/**
 * Existing row keyed by Zoho Books item_id (first wins: pr, then rm, then pm on conflict).
 * @returns {Promise<Map<string, { kind: 'pr'|'rm'|'pm', row: import('sequelize').Model }>>}
 */
async function loadExistingRowsByZohoId() {
  const map = new Map();
  const products = await Product.findAll({
    where: { zoho_item_id: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } },
  });
  for (const row of products) {
    const z = normalizeZohoId(row.get('zoho_item_id'));
    if (z && !map.has(z)) map.set(z, { kind: 'pr', row });
  }
  const rms = await RawMaterial.findAll({
    where: { zoho_id: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } },
  });
  for (const row of rms) {
    const z = normalizeZohoId(row.get('zoho_id'));
    if (z && !map.has(z)) map.set(z, { kind: 'rm', row });
  }
  const pms = await PackMaterial.findAll({
    where: { zoho_id: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } },
  });
  for (const row of pms) {
    const z = normalizeZohoId(row.get('zoho_id'));
    if (z && !map.has(z)) map.set(z, { kind: 'pm', row });
  }
  return map;
}

/**
 * @param {'pr'|'rm'|'pm'} kind
 * @param {import('sequelize').Model} row
 * @param {Record<string, unknown>} attrs
 * @param {boolean} dryRun
 */
async function applyUpdate(kind, row, attrs, dryRun) {
  if (dryRun) return;
  if (kind === 'pr') {
    await row.update({
      product_name: attrs.product_name,
      product_sku: attrs.product_sku,
      product_code: attrs.product_code,
      mrp_price: attrs.mrp_price,
      tax_rate: attrs.tax_rate,
      product_description: attrs.product_description,
      status: attrs.status,
      updated_at: new Date(),
    });
  } else if (kind === 'rm') {
    await row.update({
      name: attrs.name,
      sku: attrs.sku,
      code: attrs.code,
      price_per_kg: attrs.price_per_kg,
      gst: attrs.gst,
      hsn_code: attrs.hsn_code,
      uom: attrs.uom,
      status: attrs.status,
      updated_at: new Date(),
    });
  } else {
    await row.update({
      description: attrs.description,
      sku: attrs.sku,
      code: attrs.code,
      price_per_pc: attrs.price_per_pc,
      hsn_code: attrs.hsn_code,
      unit: attrs.unit,
      status: attrs.status,
      updated_at: new Date(),
    });
  }
}

/**
 * @param {'pr'|'rm'|'pm'} kind
 * @param {Record<string, unknown>} attrs
 * @param {boolean} dryRun
 */
async function applyCreate(kind, attrs, dryRun) {
  if (dryRun) return;
  if (kind === 'pr') await Product.create(attrs);
  else if (kind === 'rm') await RawMaterial.create(attrs);
  else await PackMaterial.create(attrs);
}

async function main() {
  const opts = parseArgs(process.argv);
  const { dryRun, updateExisting, full, resetState } = opts;
  const statePath = getStateFilePath();
  const filterBy = process.env.ZOHO_PULL_FILTER_BY || 'Status.All';
  const overlapMs = Math.max(
    0,
    Number(process.env.ZOHO_PULL_INCREMENTAL_OVERLAP_MS) || 120000
  );

  if (resetState) {
    try {
      await fs.unlink(statePath);
      console.log(`[zoho-pull] removed state file: ${statePath}`);
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
      console.log(`[zoho-pull] no state file to remove: ${statePath}`);
    }
    return;
  }

  const orgId = getOrgId();
  let prevState = await readState(statePath);
  if (prevState && prevState.organizationId && prevState.organizationId !== orgId) {
    console.warn(
      `[zoho-pull] state org ${prevState.organizationId} differs from ZOHO_BOOKS_ORGANIZATION_ID=${orgId}; treating as --full`
    );
    prevState = null;
  }

  const useIncrementalWatermark =
    !full && prevState && prevState.lastPullCompletedAt && String(prevState.lastPullCompletedAt).trim();

  let cutoffMs = null;
  if (useIncrementalWatermark) {
    const t = Date.parse(String(prevState.lastPullCompletedAt));
    if (Number.isFinite(t)) {
      cutoffMs = t - overlapMs;
    }
  }

  await db.authenticate();

  const pullStartedAt = new Date().toISOString();
  const allItems = await listAllItems({
    filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });

  let itemsToProcess = allItems;
  if (cutoffMs != null) {
    const knownZohoIds = await loadKnownZohoItemIds();
    itemsToProcess = allItems.filter((item) => {
      const zid = normalizeZohoId(item.item_id);
      if (!zid) return false;
      const ms = zohoItemActivityMs(item);
      if (ms == null) return true;
      if (ms > cutoffMs) return true;
      if (!knownZohoIds.has(zid)) return true;
      return false;
    });
    console.log(
      `[zoho-pull] incremental lastPullCompletedAt=${prevState.lastPullCompletedAt} overlapMs=${overlapMs} knownZohoIdsInDb=${knownZohoIds.size} → ${itemsToProcess.length}/${allItems.length} items`
    );
  } else {
    console.log(`[zoho-pull] full fetch: ${allItems.length} items (filter_by=${filterBy})`);
  }

  const existingByZoho = await loadExistingRowsByZohoId();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let skippedUnclassified = 0;
  const byKind = { pr: { inserted: 0, updated: 0 }, rm: { inserted: 0, updated: 0 }, pm: { inserted: 0, updated: 0 } };

  const incrementalMode = cutoffMs != null;

  for (const item of itemsToProcess) {
    const zid = normalizeZohoId(item.item_id);
    if (!zid) {
      skipped += 1;
      continue;
    }

    const kind = classifyZohoMasterItem(item);
    if (kind === 'skip') {
      skippedUnclassified += 1;
      skipped += 1;
      continue;
    }

    let attrsForCreate;
    if (kind === 'pr') attrsForCreate = zohoItemToProductAttrs(item);
    else if (kind === 'rm') attrsForCreate = zohoItemToRawMaterialAttrs(item);
    else attrsForCreate = zohoItemToPackMaterialAttrs(item);

    function attrsForKind(k) {
      if (k === 'pr') return zohoItemToProductAttrs(item);
      if (k === 'rm') return zohoItemToRawMaterialAttrs(item);
      return zohoItemToPackMaterialAttrs(item);
    }

    try {
      const existing = existingByZoho.get(zid);
      if (existing) {
        if (existing.kind !== kind) {
          console.warn(
            `[zoho-pull] zoho_id=${zid} already on ${existing.kind}; Zoho classifies as ${kind} — updating existing ${existing.kind} row only`
          );
        }
        const attrsForUpdate = attrsForKind(existing.kind);
        const shouldUpdate = incrementalMode || updateExisting;
        if (shouldUpdate) {
          if (dryRun) {
            updated += 1;
            byKind[existing.kind].updated += 1;
          } else {
            await applyUpdate(existing.kind, existing.row, attrsForUpdate, false);
            updated += 1;
            byKind[existing.kind].updated += 1;
          }
        } else {
          skipped += 1;
        }
        continue;
      }

      if (dryRun) {
        inserted += 1;
        byKind[kind].inserted += 1;
        continue;
      }

      await applyCreate(kind, attrsForCreate, false);
      inserted += 1;
      byKind[kind].inserted += 1;
    } catch (e) {
      errors += 1;
      console.error(`[zoho-pull] kind=${kind} zoho_id=${zid}:`, e && e.message ? e.message : e);
    }
  }

  const pullCompletedAt = new Date().toISOString();

  if (!dryRun && errors === 0) {
    /** @type {PullState} */
    const nextState = {
      version: STATE_VERSION,
      organizationId: orgId,
      lastPullCompletedAt: pullCompletedAt,
      lastRun: {
        startedAt: pullStartedAt,
        completedAt: pullCompletedAt,
        mode: incrementalMode ? 'incremental' : 'full',
        filterBy,
        fetchedFromZoho: allItems.length,
        processedAfterFilter: itemsToProcess.length,
        inserted,
        updated,
        skipped,
        skippedUnclassified,
        errors,
        byKind,
      },
    };
    await writeState(statePath, nextState);
    console.log(`[zoho-pull] state saved: ${statePath}`);
  } else if (!dryRun && errors > 0) {
    console.warn(
      `[zoho-pull] state file not updated (${statePath}) because errors=${errors}; fix and re-run to retry`
    );
  } else {
    console.log(`[zoho-pull] dry-run: state file not updated (${statePath})`);
  }

  console.log(
    `[zoho-pull] done: inserted=${inserted}, updated=${updated}, skipped=${skipped} (unclassified=${skippedUnclassified}), errors=${errors}, dryRun=${dryRun}`
  );
  console.log(
    `[zoho-pull] by kind: PR ins=${byKind.pr.inserted} up=${byKind.pr.updated}, RM ins=${byKind.rm.inserted} up=${byKind.rm.updated}, PM ins=${byKind.pm.inserted} up=${byKind.pm.updated}`
  );
  await db.close();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await db.close();
  } catch (_x) {
    /* ignore */
  }
  process.exit(1);
});
