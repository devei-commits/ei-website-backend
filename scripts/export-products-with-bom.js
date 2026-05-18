#!/usr/bin/env node
/**
 * Export product + BOM + linked RM/PM master rows for N products (JSON).
 *
 * Uses the same DB connection as the API (`DATABASE_URL` in `.env`).
 *
 * Usage:
 *   node scripts/export-products-with-bom.js
 *   node scripts/export-products-with-bom.js --limit 10 --out exports/my-products.json
 *   node scripts/export-products-with-bom.js --product-ids 12,34,56
 *   node scripts/export-products-with-bom.js --any-products   # first N products even if no BOM
 *
 * Default: up to `--limit` products that have a `boms.product_id` link (filled from other products if fewer than limit).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs').promises;
const path = require('path');
const { Op } = require('sequelize');

const db = require('../db');
const { Product } = require('../src/products/models');
const BOM = require('../src/bom/models');
const RawMaterial = require('../src/rawMaterials/models');
const PackMaterial = require('../src/packMaterials/models');

function parseArgs(argv) {
  const out = {
    limit: 10,
    outPath: path.join('exports', 'products-with-bom.json'),
    productIds: null,
    anyProducts: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 10);
    else if (a.startsWith('--limit=')) out.limit = Math.max(1, Number(a.slice('--limit='.length)) || 10);
    else if (a === '--out') out.outPath = String(argv[++i] || '').trim() || out.outPath;
    else if (a.startsWith('--out=')) out.outPath = String(a.slice('--out='.length)).trim() || out.outPath;
    else if (a === '--product-ids') {
      const raw = String(argv[++i] || '');
      out.productIds = raw
        .split(/[,;\s]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (a.startsWith('--product-ids=')) {
      out.productIds = a
        .slice('--product-ids='.length)
        .split(/[,;\s]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (a === '--any-products') out.anyProducts = true;
  }
  return out;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function collectRmCodes(bomPlain) {
  const codes = new Set();
  const add = (line) => {
    if (!line || typeof line !== 'object') return;
    const c = line.rm_code ?? line.rmCode;
    if (c != null && String(c).trim()) codes.add(String(c).trim());
  };
  arr(bomPlain?.rm_lines).forEach(add);
  arr(bomPlain?.sku_rm_lines).forEach(add);
  return [...codes];
}

function collectPmCodes(bomPlain) {
  const codes = new Set();
  const add = (line) => {
    if (!line || typeof line !== 'object') return;
    const c = line.pm_code ?? line.pmCode;
    if (c != null && String(c).trim()) codes.add(String(c).trim());
  };
  arr(bomPlain?.pm_lines).forEach(add);
  return [...codes];
}

async function resolveMastersByCode(rmCodes, pmCodes) {
  const uniqRm = [...new Set(rmCodes.filter(Boolean))];
  const uniqPm = [...new Set(pmCodes.filter(Boolean))];
  const [rmRows, pmRows] = await Promise.all([
    uniqRm.length
      ? RawMaterial.findAll({ where: { code: { [Op.in]: uniqRm } }, raw: true })
      : [],
    uniqPm.length
      ? PackMaterial.findAll({ where: { code: { [Op.in]: uniqPm } }, raw: true })
      : [],
  ]);
  const rmByCode = {};
  rmRows.forEach((r) => {
    rmByCode[r.code] = r;
  });
  const pmByCode = {};
  pmRows.forEach((r) => {
    pmByCode[r.code] = r;
  });
  return { rmByCode, pmByCode };
}

async function pickProductIds(limit, anyProducts, explicitIds) {
  if (explicitIds && explicitIds.length) {
    return explicitIds.slice(0, limit);
  }
  if (anyProducts) {
    const rows = await Product.findAll({
      where: { deleted_at: null },
      attributes: ['product_id'],
      order: [['product_id', 'ASC']],
      limit,
      raw: true,
    });
    return rows.map((r) => r.product_id);
  }
  const boms = await BOM.findAll({
    attributes: ['product_id'],
    where: { product_id: { [Op.ne]: null } },
    order: [['product_id', 'ASC']],
    raw: true,
  });
  const seen = new Set();
  const ids = [];
  for (const b of boms) {
    const id = b.product_id;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  if (ids.length < limit) {
    const need = limit - ids.length;
    const more = await Product.findAll({
      where: {
        deleted_at: null,
        product_id: { [Op.notIn]: ids.length ? ids : [-1] },
      },
      attributes: ['product_id'],
      order: [['product_id', 'ASC']],
      limit: need,
      raw: true,
    });
    for (const r of more) {
      if (ids.length >= limit) break;
      ids.push(r.product_id);
    }
  }
  return ids;
}

function bomExportShape(plain) {
  if (!plain) return null;
  return {
    id: plain.id,
    bom_code: plain.bom_code,
    bom_sku: plain.bom_sku,
    zoho_id: plain.zoho_id,
    product_id: plain.product_id,
    client: plain.client,
    name: plain.name,
    category: plain.category,
    pack_size: plain.pack_size,
    type: plain.type,
    dosage: plain.dosage,
    status: plain.status,
    version: plain.version,
    bom_category: plain.bom_category,
    bom_unit: plain.bom_unit,
    bom_hsn: plain.bom_hsn,
    bom_tax_preference: plain.bom_tax_preference,
    bom_returnable: plain.bom_returnable,
    bom_associate_items: plain.bom_associate_items,
    bom_composite_item: plain.bom_composite_item,
    rm_lines: plain.rm_lines,
    sku_rm_lines: plain.sku_rm_lines,
    sku_bom_limit_qty: plain.sku_bom_limit_qty,
    sku_bom_limit_uom: plain.sku_bom_limit_uom,
    pm_lines: plain.pm_lines,
    process_steps: plain.process_steps,
    stability_summary: plain.stability_summary,
    notes: plain.notes,
    desc: plain.desc,
    description: plain.description,
    claims: plain.claims,
    regulatory: plain.regulatory,
    ph_range: plain.ph_range,
    spec_bulk: plain.spec_bulk,
    spec_process: plain.spec_process,
    spec_fg: plain.spec_fg,
    spec_pack: plain.spec_pack,
    spec_tests: plain.spec_tests,
    spec_release: plain.spec_release,
    yield_pct: plain.yield_pct,
    overage: plain.overage,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
}

async function main() {
  const { limit, outPath, productIds, anyProducts } = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to ei-website-backend/.env');
    process.exit(1);
  }
  await db.authenticate();

  const ids = await pickProductIds(limit, anyProducts, productIds);
  const products = await Product.findAll({
    where: { product_id: { [Op.in]: ids } },
    raw: true,
  });
  const byId = {};
  products.forEach((p) => {
    byId[p.product_id] = p;
  });

  const boms = await BOM.findAll({ where: { product_id: { [Op.in]: ids } }, raw: true });
  const bomByProductId = {};
  const duplicateBomWarnings = [];
  for (const b of boms) {
    const pid = b.product_id;
    if (pid == null) continue;
    if (bomByProductId[pid]) {
      duplicateBomWarnings.push({ product_id: pid, bom_ids: [bomByProductId[pid].id, b.id] });
      continue;
    }
    bomByProductId[pid] = b;
  }

  let allRm = [];
  let allPm = [];
  for (const pid of ids) {
    const bom = bomByProductId[pid];
    if (!bom) continue;
    allRm = allRm.concat(collectRmCodes(bom));
    allPm = allPm.concat(collectPmCodes(bom));
  }
  const { rmByCode, pmByCode } = await resolveMastersByCode(allRm, allPm);

  const exportProducts = ids.map((product_id) => {
    const product = byId[product_id] || null;
    const bomPlain = bomByProductId[product_id] || null;
    const rmCodes = collectRmCodes(bomPlain);
    const pmCodes = collectPmCodes(bomPlain);
    const rawMaterialsResolved = {};
    rmCodes.forEach((c) => {
      rawMaterialsResolved[c] = rmByCode[c] ?? null;
    });
    const packMaterialsResolved = {};
    pmCodes.forEach((c) => {
      packMaterialsResolved[c] = pmByCode[c] ?? null;
    });
    return {
      product_id,
      product,
      bom: bomExportShape(bomPlain),
      referenced_rm_codes: rmCodes,
      referenced_pm_codes: pmCodes,
      raw_materials_master_by_code: rawMaterialsResolved,
      pack_materials_master_by_code: packMaterialsResolved,
    };
  });

  const payload = {
    exported_at: new Date().toISOString(),
    limit,
    any_products: anyProducts,
    product_ids: ids,
    duplicate_bom_rows_skipped: duplicateBomWarnings,
    products: exportProducts,
  };

  const absOut = path.isAbsolute(outPath) ? outPath : path.join(__dirname, '..', outPath);
  await fs.mkdir(path.dirname(absOut), { recursive: true });
  await fs.writeFile(absOut, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${exportProducts.length} product bundle(s) to ${absOut}`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
