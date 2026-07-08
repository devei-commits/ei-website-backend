#!/usr/bin/env node
/**
 * Seeds `quality_spec_rules` (category/sub-category quality-spec templates) from the RM/PM/PR
 * default constants in EI-Admin-Dashboard — the same data that today only lives client-side
 * (bootstrapped into each browser's localStorage on first use). This makes the backend the
 * single source of truth so it no longer varies by browser/device.
 *
 * RM/PM source: EI-Admin-Dashboard/src/constants/eiMastersQualityCheckSpecs.ts — generated
 * JSON-shaped TS exports (RM_QC_COMMON_BY_CATEGORY, RM_QC_SUB_BY_PATH, PM_QC_COMMON_BY_CATEGORY,
 * PM_QC_SUB_BY_PATH). Parsed via JSON.parse since each export body is valid JSON.
 *
 * PR source: PR quality specs are 3 independent sections (bulk clearance, final/FG-ready
 * clearance, dispatch specs) — never merged, each its own rule namespace here too
 * (entity_type: PR_BULK_CLEARANCE / PR_FINAL_CLEARANCE / PR_DISPATCH_SPECS). Category-level
 * defaults are hand-authored JS object literals (prBulkClearanceCommonTableDefaults.ts etc,
 * not JSON — unquoted keys/single quotes), so those are extracted with a small JS-literal
 * evaluator instead of JSON.parse. Sub-category defaults come from the generated
 * eiMastersFgClearanceSpecs.ts (JSON-shaped, same as RM/PM) plus a couple of hand-authored
 * fallback paths not covered by that generated file.
 *
 * Usage: node scripts/seed-quality-spec-rules.js [path-to-EI-Admin-Dashboard]
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');
const QualitySpecRule = require('../src/qualitySpecRules/models');

const DEFAULT_ADMIN_DASHBOARD_DIR = path.join(__dirname, '..', '..', 'EI-Admin-Dashboard');
const CONSTANTS_DIR = 'src/constants';

/** PR category set used by the quality-spec default tables (broader than the 3-option PR master category field). */
const PR_QUALITY_SPEC_CATEGORIES = ['Skin Care', 'Hair Care', 'Cleansing', 'Color Cosmetics', 'Baby / Sensitive'];

/** Extract `export const NAME: <Type> = { ... };` and JSON.parse the `{ ... }` body (RM/PM + generated PR sub-paths). */
function extractExportedJson(source, exportName) {
  const marker = `export const ${exportName}`;
  const startOfDecl = source.indexOf(marker);
  if (startOfDecl < 0) throw new Error(`Could not find "${marker}"`);
  const braceStart = source.indexOf('{', startOfDecl);
  if (braceStart < 0) throw new Error(`Could not find opening brace for ${exportName}`);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return JSON.parse(source.slice(braceStart, i));
}

/**
 * Extract `const NAME: <Type> = [...]` or `= {...}` as a real JS literal (unquoted keys, single
 * quotes, etc — not valid JSON) by balanced-bracket slicing + evaluating just that literal.
 * Safe here: source is our own repo's static data files, not external input.
 */
function extractJsValue(source, constName) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*:[^=]*=\\s*`);
  const m = re.exec(source);
  if (!m) throw new Error(`Could not find "const ${constName}"`);
  const start = m.index + m[0].length;
  const openChar = source[start];
  if (openChar !== '[' && openChar !== '{') {
    throw new Error(`Unexpected literal start for ${constName}: ${JSON.stringify(openChar)}`);
  }
  const closeChar = openChar === '[' ? ']' : '}';
  let depth = 0;
  let i = start;
  let inString = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) { i++; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return (${source.slice(start, i)});`)();
}

/** `const COMMON_BY_CATEGORY: Record<...> = { 'Category': IDENT, Bare: IDENT2, ... }` → { Category: IDENT }. Handles both quoted and bare identifier keys. */
function extractCategoryToConstNameMap(source) {
  const re = /const COMMON_BY_CATEGORY: Record<string, readonly CommonTemplate\[\]> = \{([\s\S]*?)\};/;
  const m = re.exec(source);
  if (!m) throw new Error('COMMON_BY_CATEGORY not found');
  const pairs = [...m[1].matchAll(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*(\w+)\s*,/g)];
  const map = {};
  for (const [, quoted, bare, ident] of pairs) map[quoted || bare] = ident;
  return map;
}

/** Loads a `prXCommonTableDefaults.ts`-shaped file's COMMON_BY_CATEGORY into { category: rows[] }. */
function loadPrCommonByCategoryFile(filePath, { fallbackToSkinCareFor = [] } = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const catToIdent = extractCategoryToConstNameMap(source);
  const result = {};
  for (const [category, ident] of Object.entries(catToIdent)) {
    result[category] = extractJsValue(source, ident);
  }
  // Replicate the frontend's runtime fallback: an unlisted category falls back to Skin Care's rows.
  for (const cat of fallbackToSkinCareFor) {
    if (!result[cat] && result['Skin Care']) result[cat] = result['Skin Care'];
  }
  return result;
}

/** RM_QC_COMMON_BY_CATEGORY / PM_QC_COMMON_BY_CATEGORY / PR common-by-category shape: { [category]: rows[] } */
function rulesFromCommonByCategory(entityType, byCategory) {
  return Object.entries(byCategory).map(([category, rows]) => ({
    entity_type: entityType,
    category,
    sub_category: '',
    rows,
  }));
}

/** RM_QC_SUB_BY_PATH / PM_QC_SUB_BY_PATH / PR sub-by-path shape: { "Category::SubCategory": rows[] } */
function rulesFromSubByPath(entityType, byPath) {
  return Object.entries(byPath).map(([pathKey, rows]) => {
    const sepIdx = pathKey.indexOf('::');
    const category = sepIdx >= 0 ? pathKey.slice(0, sepIdx) : pathKey;
    const subCategory = sepIdx >= 0 ? pathKey.slice(sepIdx + 2) : '';
    return { entity_type: entityType, category, sub_category: subCategory, rows };
  });
}

/** Merge a generated sub-by-path map with a hand-authored fallback map — generated wins on key collision. */
function mergeSubByPath(fallback, generated) {
  return { ...fallback, ...generated };
}

function loadRmPmRules(constantsDir) {
  const source = fs.readFileSync(path.join(constantsDir, 'eiMastersQualityCheckSpecs.ts'), 'utf8');
  return [
    ...rulesFromCommonByCategory('RM', extractExportedJson(source, 'RM_QC_COMMON_BY_CATEGORY')),
    ...rulesFromSubByPath('RM', extractExportedJson(source, 'RM_QC_SUB_BY_PATH')),
    ...rulesFromCommonByCategory('PM', extractExportedJson(source, 'PM_QC_COMMON_BY_CATEGORY')),
    ...rulesFromSubByPath('PM', extractExportedJson(source, 'PM_QC_SUB_BY_PATH')),
  ];
}

function loadPrRules(constantsDir) {
  const fgSource = fs.readFileSync(path.join(constantsDir, 'eiMastersFgClearanceSpecs.ts'), 'utf8');
  const bulkSubGenerated = extractExportedJson(fgSource, 'PR_BULK_CLEARANCE_SUB_BY_PATH');
  const finalSubGenerated = extractExportedJson(fgSource, 'PR_FINAL_CLEARANCE_SUB_BY_PATH');
  const dispatchSubGenerated = extractExportedJson(fgSource, 'PR_DISPATCH_SUB_BY_PATH');

  const bulkFallbackSub = extractJsValue(
    fs.readFileSync(path.join(constantsDir, 'prBulkClearanceSubSpecTableDefaults.ts'), 'utf8'),
    'FALLBACK_SUB_SPEC_TEMPLATES'
  );
  const finalFallbackSub = extractJsValue(
    fs.readFileSync(path.join(constantsDir, 'prFinalClearanceSubSpecTableDefaults.ts'), 'utf8'),
    'FALLBACK_SUB_SPEC_TEMPLATES'
  );

  const bulkCommon = loadPrCommonByCategoryFile(path.join(constantsDir, 'prBulkClearanceCommonTableDefaults.ts'));
  const finalCommon = loadPrCommonByCategoryFile(
    path.join(constantsDir, 'prFinalClearanceCommonTableDefaults.ts'),
    { fallbackToSkinCareFor: ['Cleansing'] }
  );
  const dispatchSharedRows = extractJsValue(
    fs.readFileSync(path.join(constantsDir, 'prDispatchSpecsCommonTableDefaults.ts'), 'utf8'),
    'PR_SHARED_DISPATCH_COMMON'
  );
  const dispatchCommon = Object.fromEntries(PR_QUALITY_SPEC_CATEGORIES.map((cat) => [cat, dispatchSharedRows]));

  return [
    ...rulesFromCommonByCategory('PR_BULK_CLEARANCE', bulkCommon),
    ...rulesFromSubByPath('PR_BULK_CLEARANCE', mergeSubByPath(bulkFallbackSub, bulkSubGenerated)),
    ...rulesFromCommonByCategory('PR_FINAL_CLEARANCE', finalCommon),
    ...rulesFromSubByPath('PR_FINAL_CLEARANCE', mergeSubByPath(finalFallbackSub, finalSubGenerated)),
    ...rulesFromCommonByCategory('PR_DISPATCH_SPECS', dispatchCommon),
    ...rulesFromSubByPath('PR_DISPATCH_SPECS', dispatchSubGenerated),
  ];
}

async function upsertRule({ entity_type, category, sub_category, rows }) {
  const [row] = await QualitySpecRule.findOrCreate({
    where: { entity_type, category, sub_category },
    defaults: { rows },
  });
  await row.update({ rows });
  return { entity_type, category, sub_category: sub_category || '(common)', count: rows.length };
}

async function main() {
  const adminDashboardDir = process.argv[2] || DEFAULT_ADMIN_DASHBOARD_DIR;
  const constantsDir = path.join(adminDashboardDir, CONSTANTS_DIR);
  if (!fs.existsSync(constantsDir)) {
    throw new Error(
      `Could not find ${CONSTANTS_DIR} under ${adminDashboardDir}. ` +
      `Pass the EI-Admin-Dashboard checkout path as an argument if it isn't a sibling directory.`
    );
  }

  const rules = [...loadRmPmRules(constantsDir), ...loadPrRules(constantsDir)];

  await db.authenticate();
  const results = [];
  for (const rule of rules) {
    results.push(await upsertRule(rule));
  }
  const byEntity = results.reduce((acc, r) => {
    acc[r.entity_type] = (acc[r.entity_type] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ ok: true, seeded: results.length, byEntity, results }, null, 2));
  await db.close();
}

main().catch(async (e) => {
  console.error('[seed-quality-spec-rules]', e && e.message ? e.message : e);
  try {
    await db.close();
  } catch (_e) {}
  process.exit(1);
});
