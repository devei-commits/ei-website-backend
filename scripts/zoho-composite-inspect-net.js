#!/usr/bin/env node
/**
 * Fetch one Zoho composite and print mapped_items + derived sku_bom_limit (raw sum heuristic).
 * Usage: node scripts/zoho-composite-inspect-net.js [composite_id]
 */
require('dotenv').config();
const { fetchCompositeItem } = require('../src/services/zohoBooks');
const {
  suggestLimitFromSkuLines,
  zohoUnitToSkuUom,
  makeKeyMaps,
  matchMaster,
  normalizeZohoId,
} = require('../src/products/zohoCompositeSkuBomSuggestion');
const db = require('../db');
const RawMaterial = require('../src/rawMaterials/models');
const PackMaterial = require('../src/packMaterials/models');

function norm(v) {
  return String(v || '').trim().toLowerCase();
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

const zid = normalizeZohoId(process.argv[2] || '1252231000005967310');

(async () => {
  if (!zid) {
    console.error('Missing composite id');
    process.exit(1);
  }
  const composite = await fetchCompositeItem(zid);
  const mappedItems = Array.isArray(composite.mapped_items) ? composite.mapped_items : [];

  console.log('=== From Zoho API (composite_item) ===');
  console.log('composite_item_id:', composite.composite_item_id ?? composite.item_id ?? zid);
  console.log('name:', composite.name);
  console.log('sku:', composite.sku);
  console.log('mapped_items count:', mappedItems.length);
  console.log('');

  console.log('=== Raw mapped_items (quantity & unit are per 1 composite unit in Zoho) ===');
  mappedItems.forEach((item, i) => {
    console.log(
      `${i + 1}. name=${JSON.stringify(String(item.name || '').slice(0, 70))} sku=${item.sku} qty=${item.quantity} unit=${item.unit} item_id=${item.item_id}`
    );
  });
  console.log('');

  const allAsSkuLines = mappedItems.map((item, i) => ({
    row_number: i + 1,
    qty_per_unit: Number(item.quantity) || 0,
    uom: zohoUnitToSkuUom(item.unit),
  }));
  console.log('=== If every line were treated as SKU BOM line (naive) ===');
  console.log(JSON.stringify(suggestLimitFromSkuLines(allAsSkuLines), null, 2));
  console.log('');

  try {
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
    let pmCount = 0;
    let heuristicPm = 0;
    for (const item of mappedItems) {
      const rm = matchMaster(item, rmMaps);
      if (rm) {
        skuRows.push({
          qty_per_unit: Number(item.quantity) || 0,
          uom: zohoUnitToSkuUom(item.unit),
          label: `RM match: ${rm.code || rm.sku}`,
        });
        continue;
      }
      const pm = matchMaster(item, pmMaps);
      if (pm) {
        pmCount += 1;
        continue;
      }
      if (looksLikePmItem(item)) {
        heuristicPm += 1;
        continue;
      }
      skuRows.push({
        qty_per_unit: Number(item.quantity) || 0,
        uom: zohoUnitToSkuUom(item.unit),
        label: `unmatched RM-style: ${String(item.name || item.sku || '').slice(0, 50)}`,
      });
    }

    console.log('=== Same classification as zoho-composite-fill-bom-db.js (needs DB) ===');
    console.log('lines counted as pack (PM master match):', pmCount);
    console.log('lines skipped as pack (name/unit heuristic):', heuristicPm);
    console.log('lines on SKU BOM for limit sum:', skuRows.length);
    skuRows.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.label} → qty_per_unit=${r.qty_per_unit} uom=${r.uom}`);
    });
    console.log('');
    const limitInfo = suggestLimitFromSkuLines(
      skuRows.map((r) => ({ qty_per_unit: r.qty_per_unit, uom: r.uom }))
    );
    console.log('=== suggestLimitFromSkuLines(sku_rm_lines only) ===');
    console.log(JSON.stringify(limitInfo, null, 2));
  } catch (e) {
    console.log('=== DB classification skipped ===');
    console.log(String(e?.message || e));
    console.log('(Run inside Docker / with DATABASE_URL pointing at a live DB to mirror fill-bom PM/RM split.)');
  }

  await db.close().catch(() => {});
})().catch(async (e) => {
  console.error(e?.message || e);
  await db.close().catch(() => {});
  process.exit(1);
});
