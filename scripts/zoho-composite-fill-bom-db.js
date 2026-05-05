#!/usr/bin/env node
/**
 * One-off: fetch Zoho composite `mapped_items` and persist SKU BOM data only.
 *
 * Workflow context: a product may exist with **no `boms` row** yet (no product↔BOM link). Import /
 * this script is how per-unit lines land first. **Formula BOM** (`rm_lines`, % w/w) is built
 * separately in the admin UI **after** SKU BOM is present — this script never writes `rm_lines`.
 *
 * Writes ONLY:
 *   - sku_rm_lines + sku_bom_limit_qty / sku_bom_limit_uom  (SKU BOM — per-unit RM qtys)
 *   - pm_lines (Pack BOM) unless --sku-bom-only
 *
 * Does NOT read or write rm_lines (Formula BOM). Those columns are untouched.
 *
 * Product/BOM resolution order:
 *   1) --product-id= / --product-code=
 *   2) products.zoho_item_id = composite id
 *   3) boms.zoho_id = composite id
 *   4) products.zoho_sku_code = composite.sku from Zoho
 *
 * If the product exists but has no `boms` row, `--create-bom-if-missing` adds a **minimal stub**
 * so SKU BOM JSON has a row to attach to; it is not a full PR setup. Formula/pack specs in
 * the UI can follow once SKU BOM is in place.
 *
 * Uses OAuth from .env (ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
 * ZOHO_BOOKS_ORGANIZATION_ID, ZOHO_BOOKS_API_BASE — can be inventory.zoho.in/api/v1).
 *
 * Usage:
 *   node scripts/zoho-composite-fill-bom-db.js 1252231000017972949
 *   node scripts/zoho-composite-fill-bom-db.js 1252231000017972949 --dry-run
 *   node scripts/zoho-composite-fill-bom-db.js 1252231000017972949 --product-id=42
 *   node scripts/zoho-composite-fill-bom-db.js 1252231000017972949 --no-sku-match
 *   node scripts/zoho-composite-fill-bom-db.js 1252231000017972949 --sku-bom-only
 *   node scripts/zoho-composite-fill-bom-db.js 1252231000017972949 --create-bom-if-missing
 */
require('dotenv').config();

const { Op } = require('sequelize');
const db = require('../db');
const { Product } = require('../src/products/models');
const BOM = require('../src/bom/models');
const RawMaterial = require('../src/rawMaterials/models');
const PackMaterial = require('../src/packMaterials/models');
const { fetchCompositeItem } = require('../src/services/zohoBooks');
const {
  zohoUnitToSkuUom,
  suggestLimitFromSkuLines,
  makeKeyMaps,
  matchMaster,
  normalizeZohoId,
} = require('../src/products/zohoCompositeSkuBomSuggestion');

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

/** Align with zoho-backfill-pr-composition.js (RM/PM split). */
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

function parseArgs(argv) {
  const getArg = (prefix) => {
    const hit = argv.find((a) => String(a).startsWith(`${prefix}=`));
    return hit ? String(hit).slice(prefix.length + 1).trim() : '';
  };
  const idArg = argv.find((a) => !String(a).startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  const productIdRaw = getArg('--product-id') || getArg('--product_id');
  const productId = productIdRaw ? parseInt(productIdRaw, 10) : NaN;
  return {
    compositeId: idArg || '1252231000017972949',
    dryRun,
    productId: Number.isFinite(productId) && productId > 0 ? productId : null,
    productCode: getArg('--product-code') || getArg('--product_code') || null,
    noSkuMatch: argv.includes('--no-sku-match'),
    skuBomOnly: argv.includes('--sku-bom-only'),
    createBomIfMissing: argv.includes('--create-bom-if-missing'),
  };
}

/**
 * Minimal `boms` row: storage for sku_rm_lines / limits / pm_lines only. No formula (`rm_lines`).
 * User fills formula BOM in the UI after SKU BOM exists.
 * @param {import('sequelize').Model} product
 * @param {string} zid
 * @param {string | null | undefined} compositeName
 */
async function createMinimalBom(product, zid, compositeName) {
  const plain = product.get ? product.get({ plain: true }) : product;
  let bomCode = String(plain.product_code || '').trim();
  if (!bomCode) bomCode = `PR-${plain.product_id}`;
  bomCode = bomCode.slice(0, 100);

  const existingForProduct = await BOM.findOne({ where: { product_id: plain.product_id } });
  if (existingForProduct) return existingForProduct;

  const collision = await BOM.findOne({ where: { bom_code: bomCode } });
  if (collision) {
    if (collision.product_id == null) {
      const now = new Date();
      await collision.update({
        product_id: plain.product_id,
        zoho_id: zid,
        bom_sku: plain.zoho_sku_code || collision.bom_sku,
        name: plain.product_name || collision.name || bomCode,
        updated_at: now,
      });
      return collision.reload();
    }
    if (collision.product_id === plain.product_id) return collision;
    throw new Error(
      `bom_code "${bomCode}" is already linked to product_id=${collision.product_id}. Change product_code or link manually.`
    );
  }

  const now = new Date();
  return BOM.create({
    bom_code: bomCode,
    bom_sku: plain.zoho_sku_code || null,
    zoho_id: zid,
    name: (plain.product_name || compositeName || bomCode).toString().slice(0, 300),
    product_id: plain.product_id,
    type: 'FG',
    status: 'Draft',
    bom_composite_item: true,
    rm_lines: [],
    sku_rm_lines: [],
    pm_lines: [],
    process_steps: [],
    created_at: now,
    updated_at: now,
  });
}

/**
 * @param {Record<string, unknown>} composite
 * @param {string} zid normalized composite id
 * @returns {Promise<{ product?: import('sequelize').Model, bom?: import('sequelize').Model | null, matchReason?: string, error?: string }>}
 */
async function resolveProductAndBom(composite, zid, opts) {
  const idVariants = [...new Set([zid, String(composite.composite_item_id || '').trim()].filter(Boolean))];
  const zsku = composite.sku != null && String(composite.sku).trim() !== '' ? String(composite.sku).trim() : '';

  if (opts.productId) {
    const product = await Product.findByPk(opts.productId);
    if (!product) {
      return { error: `No product with product_id=${opts.productId}` };
    }
    const bom = await BOM.findOne({ where: { product_id: product.product_id } });
    return { product, bom, matchReason: `--product-id=${opts.productId}` };
  }

  if (opts.productCode) {
    const product = await Product.findOne({ where: { product_code: opts.productCode } });
    if (!product) {
      return { error: `No product with product_code=${opts.productCode}` };
    }
    const bom = await BOM.findOne({ where: { product_id: product.product_id } });
    return { product, bom, matchReason: `--product-code=${opts.productCode}` };
  }

  const bomByZoho = await BOM.findOne({
    where: { zoho_id: { [Op.in]: idVariants } },
  });
  if (bomByZoho && bomByZoho.product_id) {
    const p = await Product.findByPk(bomByZoho.product_id);
    if (p) {
      return { product: p, bom: bomByZoho, matchReason: 'boms.zoho_id' };
    }
  }

  let product = await Product.findOne({
    where: { zoho_item_id: { [Op.in]: idVariants } },
  });
  if (product) {
    const b = await BOM.findOne({ where: { product_id: product.product_id } });
    if (b) return { product, bom: b, matchReason: 'products.zoho_item_id' };
    return { product, bom: null, matchReason: 'products.zoho_item_id (no BOM row yet)' };
  }

  if (zsku && !opts.noSkuMatch) {
    product = await Product.findOne({ where: { zoho_sku_code: zsku } });
    if (product) {
      const b = await BOM.findOne({ where: { product_id: product.product_id } });
      if (b) {
        return { product, bom: b, matchReason: `products.zoho_sku_code=${zsku}` };
      }
      return { product, bom: null, matchReason: `products.zoho_sku_code=${zsku} (no BOM row yet)` };
    }
  }

  return {
    error: [
      `No product/BOM linked to composite ${zid}.`,
      zsku && !opts.noSkuMatch
        ? `Tried zoho_sku_code=${zsku} — not found.`
        : opts.noSkuMatch
          ? 'Skipped zoho_sku_code match (--no-sku-match).'
          : 'Composite had no sku to match.',
      'Fix: set products.zoho_item_id or boms.zoho_id to the composite id, align zoho_sku_code with Zoho, or pass --product-id= / --product-code=.',
    ].join(' '),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { compositeId, dryRun } = opts;
  const zid = normalizeZohoId(compositeId);
  if (!zid) {
    console.error('Invalid composite id');
    process.exit(1);
  }

  console.log('[zoho-composite-fill-bom-db] composite_id=', zid, dryRun ? '(dry-run)' : '');

  const composite = await fetchCompositeItem(zid);
  const mappedItems = Array.isArray(composite.mapped_items) ? composite.mapped_items : [];
  console.log('[zoho-composite-fill-bom-db] mapped_items count=', mappedItems.length);

  const [allRm, allPm] = await Promise.all([RawMaterial.findAll(), PackMaterial.findAll()]);
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

  const skuRows = [];
  const pmMatches = [];
  const unknownPm = [];

  for (const item of mappedItems) {
    const rm = matchMaster(item, rmMaps);
    if (rm) {
      skuRows.push({
        inci_name: rm.inci || rm.name || String(item.name || '').trim(),
        rm_code: rm.code || String(item.sku || '').trim(),
        raw_material_id: rm.id,
        qty_per_unit: Number(item.quantity) || 0,
        uom: zohoUnitToSkuUom(item.unit),
      });
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
    skuRows.push({
      inci_name: String(item.name || '').trim() || String(item.sku || '').trim() || 'Component',
      rm_code: String(item.sku || normalizeZohoId(item.item_id) || '').trim(),
      raw_material_id: null,
      qty_per_unit: Number(item.quantity) || 0,
      uom: zohoUnitToSkuUom(item.unit),
    });
  }

  const sku_rm_lines = skuRows.map((r, i) => ({
    row_number: i + 1,
    inci_name: r.inci_name,
    rm_code: r.rm_code,
    raw_material_id: r.raw_material_id,
    qty_per_unit: r.qty_per_unit,
    uom: r.uom,
  }));

  const resolved = await resolveProductAndBom(composite, zid, opts);
  if (resolved.error) {
    console.error(`[zoho-composite-fill-bom-db] ${resolved.error}`);
    process.exit(1);
  }
  let { product, bom, matchReason } = resolved;
  console.log('[zoho-composite-fill-bom-db] matched by:', matchReason);

  if (!bom) {
    if (!opts.createBomIfMissing) {
      console.error(
        `[zoho-composite-fill-bom-db] No boms row for product_id=${product.product_id}. Link or create a BOM in the app, or re-run with --create-bom-if-missing (stub row for SKU BOM only; formula BOM stays for the UI).`
      );
      process.exit(1);
    }
    if (dryRun) {
      console.log(
        `[zoho-composite-fill-bom-db] dry-run: would create minimal BOM for product_id=${product.product_id} (--create-bom-if-missing)`
      );
      bom = { id: null, pm_lines: [] };
    } else {
      bom = await createMinimalBom(product, zid, composite.name);
      console.log('[zoho-composite-fill-bom-db] created BOM id=', bom.id, 'bom_code=', bom.bom_code);
    }
  }

  const existingPm = Array.isArray(bom.pm_lines) ? bom.pm_lines : [];
  const pm_lines = [...buildPmLines(pmMatches, existingPm), ...buildPmLinesFromUnknownPm(unknownPm, existingPm)];

  const limitInfo = suggestLimitFromSkuLines(sku_rm_lines);
  const sku_bom_limit_qty = limitInfo.ok ? limitInfo.limitQty : null;
  const sku_bom_limit_uom = limitInfo.ok ? limitInfo.limitUom : null;

  console.log('[zoho-composite-fill-bom-db] product_id=', product.product_id, 'bom_id=', bom.id ?? '—');
  console.log('[zoho-composite-fill-bom-db] sku_rm_lines=', sku_rm_lines.length, 'pm_lines=', pm_lines.length);
  if (opts.skuBomOnly) {
    console.log('[zoho-composite-fill-bom-db] --sku-bom-only: will not update pm_lines (formula rm_lines never touched)');
  }
  if (limitInfo.warning) console.log('[zoho-composite-fill-bom-db] limit warning:', limitInfo.warning);
  console.log(
    '[zoho-composite-fill-bom-db] sku_bom_limit=',
    sku_bom_limit_qty,
    sku_bom_limit_uom
  );

  if (dryRun) {
    console.log('[zoho-composite-fill-bom-db] dry-run — no DB write');
    const preview = {
      sku_rm_lines,
      sku_bom_limit_qty,
      sku_bom_limit_uom,
      ...(opts.skuBomOnly ? {} : { pm_lines }),
    };
    console.log(JSON.stringify(preview, null, 2));
    await db.close().catch(() => {});
    process.exit(0);
  }

  if (bom.id == null) {
    console.error('[zoho-composite-fill-bom-db] internal error: BOM missing id after create');
    process.exit(1);
  }

  /** Only these columns — never rm_lines (Formula BOM). */
  const bomPatch = {
    sku_rm_lines,
    sku_bom_limit_qty,
    sku_bom_limit_uom,
    updated_at: new Date(),
  };
  if (!opts.skuBomOnly) {
    bomPatch.pm_lines = pm_lines;
  }
  await bom.update(bomPatch);

  console.log('[zoho-composite-fill-bom-db] updated BOM', bom.id, '(rm_lines / formula BOM unchanged)');
  await db.close().catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  console.error('[zoho-composite-fill-bom-db] failed', e?.message || e);
  await db.close().catch(() => {});
  process.exit(1);
});
