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
const { evaluateRequiredFields, writeMissingFieldsReport, cleanOutputFile } = require('./lib/zoho-required-fields');

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

function trunc(v, maxLen) {
  const s = String(v || '').trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
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
 * @returns {string}
 */
function normalizeCategoryKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function getZohoCfCategory(item) {
  const direct = item.cf_category != null ? String(item.cf_category).trim() : '';
  if (direct) return direct;
  const alt = item.cf_category_unformatted != null ? String(item.cf_category_unformatted).trim() : '';
  if (alt) return alt;
  const h = item.custom_field_hash && typeof item.custom_field_hash === 'object' ? item.custom_field_hash : null;
  if (h && h.cf_category != null && String(h.cf_category).trim()) return String(h.cf_category).trim();
  if (h && h.cf_category_unformatted != null && String(h.cf_category_unformatted).trim()) return String(h.cf_category_unformatted).trim();
  return '';
}

/**
 * @param {Record<string, unknown>} item
 * @returns {{ kind: 'pr' | 'rm' | 'pm' | 'skip', bucket: string, cfCategory: string | null }}
 */
function classifyZohoMasterItem(item) {
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const cfCategory = getZohoCfCategory(item);
  const cfKey = normalizeCategoryKey(cfCategory);

  const byCfCategory = {
    // PR
    'fg- ongoing': { kind: 'pr', bucket: 'Product' },
    // RM
    fragrance: { kind: 'rm', bucket: 'Raw Material' },
    'raw material': { kind: 'rm', bucket: 'Raw Material' },
    'rm- active': { kind: 'rm', bucket: 'Raw Material' },
    'rm- base': { kind: 'rm', bucket: 'Raw Material' },
    'rm- exceipient': { kind: 'rm', bucket: 'Raw Material' },
    // PM
    'packaging material': { kind: 'pm', bucket: 'Packaging Material' },
    ppm: { kind: 'pm', bucket: 'Packaging Material' },
    'ppm - bottle': { kind: 'pm', bucket: 'Packaging Material' },
    'ppm - closure': { kind: 'pm', bucket: 'Packaging Material' },
    'spm - label': { kind: 'pm', bucket: 'Packaging Material' },
    'spm - others': { kind: 'pm', bucket: 'Packaging Material' },
    'spm-carton and kit': { kind: 'pm', bucket: 'Packaging Material' },
    // Composite
    'terminated composites': { kind: 'pr', bucket: 'Composite' },
    'temporary composites': { kind: 'pr', bucket: 'Composite' },
    'permenant composites': { kind: 'pr', bucket: 'Composite' },
    'inhouse composites': { kind: 'pr', bucket: 'Composite' },
    // Other
    'equipment and accessories': { kind: 'pr', bucket: 'Other' },
    consumables: { kind: 'pr', bucket: 'Other' },
    'other expense': { kind: 'pr', bucket: 'Other' },
  };

  if (cfKey && byCfCategory[cfKey]) {
    const mapped = byCfCategory[cfKey];
    return { kind: mapped.kind, bucket: mapped.bucket, cfCategory: cfCategory || null };
  }

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
    if (test(map[k])) {
      const bucket = k === 'rm' ? 'Raw Material' : k === 'pm' ? 'Packaging Material' : 'Product';
      return { kind: /** @type {'pr'|'rm'|'pm'} */ (k), bucket, cfCategory: cfCategory || null };
    }
  }

  const u = String(process.env.ZOHO_PULL_UNMATCHED || 'skip').toLowerCase();
  if (u === 'pr' || u === 'rm' || u === 'pm') {
    const bucket = u === 'rm' ? 'Raw Material' : u === 'pm' ? 'Packaging Material' : 'Product';
    return { kind: u, bucket, cfCategory: cfCategory || null };
  }
  return { kind: 'skip', bucket: 'Unclassified', cfCategory: cfCategory || null };
}

/**
 * @param {Record<string, unknown>} item
 */
function zohoItemToProductAttrs(item, classification) {
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
    zoho_sku_code: sku || null,
    product_name: name || productCode || 'Zoho item',
    mrp_price: mrp,
    tax_rate: taxRate,
    category: classification && classification.bucket ? classification.bucket : null,
    product_description: description,
    status,
    created_at: now,
    updated_at: now,
  };
}

/**
 * @param {Record<string, unknown>} item
 */
function zohoItemToRawMaterialAttrs(item, classification) {
  const zid = normalizeZohoId(item.item_id);
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const code = trunc(sku || (zid ? `ZHO-RM-${zid}` : 'UNKNOWN'), 100) || 'UNKNOWN';
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
    name: trunc(name || code, 255) || code,
    price_per_kg: parseMaybeNum(rateRaw),
    gst: parseMaybeNum(item.tax_percentage),
    sku: trunc(sku, 100),
    hsn_code: trunc(hsn, 50),
    uom: trunc(unit, 20),
    category: classification && classification.bucket ? classification.bucket : null,
    group: trunc(classification && classification.cfCategory ? classification.cfCategory : null, 100),
    zoho_id: zid,
    status,
    created_at: now,
    updated_at: now,
  };
}

/**
 * @param {Record<string, unknown>} item
 */
function zohoItemToPackMaterialAttrs(item, classification) {
  const zid = normalizeZohoId(item.item_id);
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const code = trunc(sku || (zid ? `ZHO-PM-${zid}` : 'UNKNOWN'), 100) || 'UNKNOWN';
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
    description: trunc(name || code, 500) || code,
    price_per_pc: parseMaybeNum(rateRaw),
    sku: trunc(sku, 100),
    hsn_code: trunc(hsn, 50),
    unit: trunc(unit, 20),
    type: trunc(classification && classification.bucket ? classification.bucket : null, 100),
    group: trunc(classification && classification.cfCategory ? classification.cfCategory : null, 100),
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
      zoho_sku_code: attrs.zoho_sku_code,
      product_code: attrs.product_code,
      mrp_price: attrs.mrp_price,
      tax_rate: attrs.tax_rate,
      category: attrs.category,
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
      category: attrs.category,
      group: attrs.group,
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
      type: attrs.type,
      group: attrs.group,
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

  // Ensure stale report is removed before exporting missing entries.
  await cleanOutputFile('exports/zoho-items-missing-required-fields.json');

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
  let skippedMissingRequired = 0;
  const missingRequiredItems = [];
  const byKind = { pr: { inserted: 0, updated: 0 }, rm: { inserted: 0, updated: 0 }, pm: { inserted: 0, updated: 0 } };
  const requiredFieldsForItemImport = [
    { key: 'item_id', getValue: (item) => normalizeZohoId(item?.item_id) },
    { key: 'name', getValue: (item) => String(item?.name || '').trim() },
    {
      key: 'classification',
      getValue: (item) => {
        const cls = classifyZohoMasterItem(item);
        return cls.kind !== 'skip' ? cls.kind : '';
      },
    },
    {
      key: 'mrp_price',
      getValue: (item) => {
        const cls = classifyZohoMasterItem(item);
        if (cls.kind !== 'pr') return '__N/A__'; // only required for PR/Product
        const rateRaw = item.rate != null ? item.rate : item.sales_rate;
        return parseMaybeNum(rateRaw);
      },
    },
  ];

  const incrementalMode = cutoffMs != null;

  for (const item of itemsToProcess) {
    const missingFields = evaluateRequiredFields(item, requiredFieldsForItemImport);
    if (missingFields.length > 0) {
      skippedMissingRequired += 1;
      skipped += 1;
      const classification = classifyZohoMasterItem(item);
      const mrpRateRaw = item.rate != null ? item.rate : item.sales_rate;
      const mrp_price = classification.kind === 'pr' ? parseMaybeNum(mrpRateRaw) : null;
      missingRequiredItems.push({
        zoho_item_id: normalizeZohoId(item?.item_id) || null,
        name: String(item?.name || '').trim() || null,
        sku: String(item?.sku || '').trim() || null,
        status: String(item?.status || '').trim() || null,
        cf_category: getZohoCfCategory(item) || null,
        mrp_price,
        missing_fields: missingFields,
      });
      continue;
    }

    const zid = normalizeZohoId(item.item_id);
    if (!zid) {
      skipped += 1;
      continue;
    }

    const classification = classifyZohoMasterItem(item);
    const { kind } = classification;
    if (kind === 'skip') {
      skippedUnclassified += 1;
      skipped += 1;
      continue;
    }

    let attrsForCreate;
    if (kind === 'pr') attrsForCreate = zohoItemToProductAttrs(item, classification);
    else if (kind === 'rm') attrsForCreate = zohoItemToRawMaterialAttrs(item, classification);
    else attrsForCreate = zohoItemToPackMaterialAttrs(item, classification);

    function attrsForKind(k) {
      if (k === 'pr') return zohoItemToProductAttrs(item, classification);
      if (k === 'rm') return zohoItemToRawMaterialAttrs(item, classification);
      return zohoItemToPackMaterialAttrs(item, classification);
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

  const missingReportPath = await writeMissingFieldsReport({
    outputPath: 'exports/zoho-items-missing-required-fields.json',
    entity: 'zoho-items-to-products-rm-pm',
    requiredFields: requiredFieldsForItemImport.map((f) => f.key),
    missingRecords: missingRequiredItems,
    meta: {
      organizationId: orgId,
      filterBy,
      dryRun,
      maxPages: opts.maxPages ?? null,
      limit: opts.limit ?? null,
      fetchedFromZoho: allItems.length,
      processedAfterFilter: itemsToProcess.length,
    },
  });

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
    `[zoho-pull] required-fields: skippedMissingRequired=${skippedMissingRequired}, report=${missingReportPath}`
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
