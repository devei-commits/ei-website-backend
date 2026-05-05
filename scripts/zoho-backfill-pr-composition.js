#!/usr/bin/env node
/**
 * Backfill PR BOM composition from Zoho composite items.
 *
 * Flow:
 * 1) Read PR products with zoho_item_id (default: latest 20).
 * 2) Fetch Zoho composite item once per PR (rate-limit friendly).
 * 3) Split mapped_items into RM/PM by matching local masters.
 * 4) Write rm_lines/pm_lines into linked BOM.
 *
 * Usage:
 *   node scripts/zoho-backfill-pr-composition.js
 *   node scripts/zoho-backfill-pr-composition.js --limit=20 --delay-ms=500
 *   node scripts/zoho-backfill-pr-composition.js --dry-run
 *   node scripts/zoho-backfill-pr-composition.js --product-ids=344,512
 */
require('dotenv').config();

const db = require('../db');
const { Op } = require('sequelize');
const { Product } = require('../src/products/models');
const BOM = require('../src/bom/models');
const RawMaterial = require('../src/rawMaterials/models');
const PackMaterial = require('../src/packMaterials/models');
const {
  getAccessToken,
  getBooksBaseUrl,
  getOrgId,
  readBooksJsonResponse,
  normalizeZohoId,
} = require('../src/services/zohoBooks');

function parseArgs(argv) {
  const getArg = (prefix) => {
    const hit = argv.find((a) => String(a).startsWith(`${prefix}=`));
    return hit ? String(hit).slice(prefix.length + 1).trim() : '';
  };
  const toInt = (v, fallback) => {
    const n = parseInt(String(v || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const productIdsRaw = getArg('--product-ids');
  const productIds = productIdsRaw
    ? productIdsRaw
        .split(',')
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return {
    limit: toInt(getArg('--limit'), 20),
    delayMs: toInt(getArg('--delay-ms'), 450),
    dryRun: argv.includes('--dry-run'),
    productIds,
    createBomIfMissing: !argv.includes('--no-create-bom'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function makeKeyMaps(rows, cfg) {
  const byZohoId = new Map();
  const bySku = new Map();
  const byCode = new Map();
  const byName = new Map();
  for (const r of rows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    const zid = normalizeZohoId(plain[cfg.zohoField]);
    if (zid) byZohoId.set(zid, plain);
    const sku = norm(plain[cfg.skuField]);
    if (sku) bySku.set(sku, plain);
    const code = norm(plain[cfg.codeField]);
    if (code) byCode.set(code, plain);
    for (const f of cfg.nameFields) {
      const k = norm(plain[f]);
      if (k && !byName.has(k)) byName.set(k, plain);
    }
  }
  return { byZohoId, bySku, byCode, byName };
}

function matchMaster(mappedItem, maps) {
  const zid = normalizeZohoId(mappedItem.item_id);
  if (zid && maps.byZohoId.has(zid)) return maps.byZohoId.get(zid);
  const sku = norm(mappedItem.sku);
  if (sku && maps.bySku.has(sku)) return maps.bySku.get(sku);
  if (sku && maps.byCode.has(sku)) return maps.byCode.get(sku);
  const nm = norm(mappedItem.name);
  if (nm && maps.byName.has(nm)) return maps.byName.get(nm);
  return null;
}

function looksLikePmItem(mappedItem) {
  const name = norm(mappedItem?.name);
  const unit = norm(mappedItem?.unit);
  if (unit === 'nos' || unit === 'pcs' || unit === 'pc') return true;
  const packKeywords = [
    'pack',
    'bottle',
    'pump',
    'label',
    'monocarton',
    'carton',
    'shipper',
    'sticker',
    'cap',
    'tube',
    'jar',
  ];
  return packKeywords.some((k) => name.includes(k));
}

async function fetchCompositeItem(zohoCompositeId) {
  const id = normalizeZohoId(zohoCompositeId);
  if (!id) throw new Error('missing_zoho_composite_id');
  const token = await getAccessToken();
  const orgId = getOrgId();
  const url = `${getBooksBaseUrl()}/compositeitems/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(orgId)}`;
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const raw = await readBooksJsonResponse(res);
  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  if (!res.ok || (code !== undefined && code !== 0)) {
    const msg = raw?.message || raw?.error || res.statusText || 'zoho_composite_fetch_failed';
    throw new Error(`zoho_composite_fetch_failed:${msg}`);
  }
  return raw?.composite_item || null;
}

function buildRmLines(rmMatches, existingRmLines) {
  const existing = Array.isArray(existingRmLines) ? existingRmLines : [];
  const byRmCode = new Map();
  existing.forEach((l) => {
    const k = norm(l?.rm_code);
    if (k && !byRmCode.has(k)) byRmCode.set(k, l);
  });
  const totalKg = rmMatches.reduce((sum, x) => sum + (Number(x.qtyKg) || 0), 0);
  return rmMatches.map((x) => {
    const old = byRmCode.get(norm(x.rm.code)) || null;
    const pct = totalKg > 0 ? (x.qtyKg / totalKg) * 100 : 0;
    return {
      phase: old?.phase || '',
      inci_name: x.rm.inci || x.rm.name || x.item.name || '',
      rm_code: x.rm.code || x.item.sku || '',
      raw_material_id: x.rm.id,
      pct_w_w: Number(pct.toFixed(6)),
      uom: old?.uom || x.rm.uom || 'KG',
    };
  });
}

function buildPmLines(pmMatches, existingPmLines) {
  const existing = Array.isArray(existingPmLines) ? existingPmLines : [];
  const byPmCode = new Map();
  existing.forEach((l) => {
    const k = norm(l?.pm_code);
    if (k && !byPmCode.has(k)) byPmCode.set(k, l);
  });
  return pmMatches.map((x) => {
    const old = byPmCode.get(norm(x.pm.code)) || null;
    const qty = Number(x.item.quantity);
    return {
      pm_code: x.pm.code || x.item.sku || '',
      pack_material_id: x.pm.id,
      description: x.pm.description || x.item.name || '',
      pack_type: old?.pack_type || x.pm.level || x.pm.type || 'Primary',
      qty_per_unit: Number.isFinite(qty) ? qty : 1,
      uom: old?.uom || x.pm.unit || x.item.unit || 'NOS',
    };
  });
}

function buildPmLinesFromUnknownPm(unknownPmItems, existingPmLines) {
  const existing = Array.isArray(existingPmLines) ? existingPmLines : [];
  const byPmCode = new Map();
  existing.forEach((l) => {
    const k = norm(l?.pm_code);
    if (k && !byPmCode.has(k)) byPmCode.set(k, l);
  });
  return unknownPmItems.map((item) => {
    const code = String(item?.sku || item?.item_id || '').trim();
    const old = byPmCode.get(norm(code)) || null;
    const qty = Number(item?.quantity);
    return {
      pm_code: code,
      pack_material_id: null,
      description: String(item?.name || '').trim(),
      pack_type: old?.pack_type || 'Primary',
      qty_per_unit: Number.isFinite(qty) ? qty : 1,
      uom: old?.uom || String(item?.unit || 'NOS').toUpperCase(),
    };
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('[zoho-backfill-pr-composition] start', opts);

  const [allRm, allPm] = await Promise.all([
    RawMaterial.findAll(),
    PackMaterial.findAll(),
  ]);
  const rmMaps = makeKeyMaps(allRm, {
    zohoField: 'zoho_id',
    skuField: 'sku',
    codeField: 'code',
    nameFields: ['name', 'inci'],
  });
  const pmMaps = makeKeyMaps(allPm, {
    zohoField: 'zoho_id',
    skuField: 'sku',
    codeField: 'code',
    nameFields: ['description'],
  });

  const where = { zoho_item_id: { [Op.ne]: null } };
  if (opts.productIds.length > 0) {
    where.product_id = { [Op.in]: opts.productIds };
  }
  const products = await Product.findAll({
    where,
    order: [['updated_at', 'DESC']],
    limit: opts.productIds.length > 0 ? undefined : opts.limit,
  });

  let processed = 0;
  let updated = 0;
  for (const p of products) {
    const product = p.get ? p.get({ plain: true }) : p;
    const zohoId = normalizeZohoId(product.zoho_item_id);
    if (!zohoId) continue;
    processed += 1;
    try {
      const composite = await fetchCompositeItem(zohoId);
      const mappedItems = Array.isArray(composite?.mapped_items) ? composite.mapped_items : [];
      let bom = await BOM.findOne({ where: { product_id: product.product_id } });

      const rmMatches = [];
      const pmMatches = [];
      const unknownPm = [];
      const unknown = [];
      for (const item of mappedItems) {
        const rm = matchMaster(item, rmMaps);
        if (rm) {
          rmMatches.push({ item, rm, qtyKg: Number(item.quantity) || 0 });
          continue;
        }
        const pm = matchMaster(item, pmMaps);
        if (pm) {
          pmMatches.push({ item, pm });
          continue;
        }
        if (looksLikePmItem(item)) {
          unknownPm.push(item);
          continue;
        }
        unknown.push({ name: item?.name, sku: item?.sku, item_id: item?.item_id });
      }

      if (!bom) {
        if (!opts.createBomIfMissing) {
          console.warn(`[skip] product_id=${product.product_id} missing BOM`);
          if (opts.delayMs > 0) await sleep(opts.delayMs);
          continue;
        }
        const bomCodeBase = String(product.product_code || `PR-${product.product_id}`).trim();
        const bomCode = bomCodeBase || `PR-${product.product_id}`;
        if (opts.dryRun) {
          console.log(`[dry-run] [product ${product.product_id}] would create BOM ${bomCode}`);
        } else {
          bom = await BOM.create({
            bom_code: bomCode,
            bom_sku: product.zoho_sku_code || bomCode,
            name: product.product_name || bomCode,
            status: 'Draft',
            type: 'FG',
            product_id: product.product_id,
            rm_lines: [],
            pm_lines: [],
            process_steps: [],
            created_at: new Date(),
            updated_at: new Date(),
          });
          console.log(`[created-bom] product=${product.product_id} bom_id=${bom.id} code=${bom.bom_code}`);
        }
      }

      const nextRmLines = buildRmLines(rmMatches, bom?.rm_lines || []);
      const nextPmLines = [
        ...buildPmLines(pmMatches, bom?.pm_lines || []),
        ...buildPmLinesFromUnknownPm(unknownPm, bom?.pm_lines || []),
      ];
      const totalRmKg = rmMatches.reduce((s, x) => s + (x.qtyKg || 0), 0);
      const totalRmG = totalRmKg * 1000;

      const logMsg = `[product ${product.product_id}] rm=${nextRmLines.length} pm=${nextPmLines.length} rmTotal=${totalRmG.toFixed(3)}g unknown=${unknown.length}`;
      if (opts.dryRun) {
        console.log('[dry-run]', logMsg);
      } else {
        await bom.update({
          rm_lines: nextRmLines,
          pm_lines: nextPmLines,
          updated_at: new Date(),
        });
        console.log('[updated]', logMsg);
        updated += 1;
      }
      if (unknown.length > 0) {
        console.warn(`[unknown mapped items][product ${product.product_id}]`, unknown.slice(0, 10));
      }
    } catch (e) {
      console.error(`[error] product_id=${product.product_id}`, e?.message || e);
    }
    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  console.log('[zoho-backfill-pr-composition] done', { processed, updated, dryRun: opts.dryRun });
}

main()
  .then(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('[zoho-backfill-pr-composition] failed', e?.message || e);
    await db.close().catch(() => {});
    process.exit(1);
  });

