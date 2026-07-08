/**
 * Backend port of EI-Admin-Dashboard's PR category/sub-category resolution
 * (src/constants/prMasterCategoryOptions.ts, src/lib/prQualitySpecVisibility.ts).
 * Keep in sync with that file.
 */

const PR_FUNCTIONAL_SUB_CATEGORIES = {
  'Skin Care': ['Cleansers', 'Moisturiser', 'Sunscreens', 'Actives', 'Others'],
  'Hair Care': ['Shampoos', 'Conditioners', 'Actives', 'Others'],
  Others: [],
};

const PR_CATEGORY_OPTIONS = Object.keys(PR_FUNCTIONAL_SUB_CATEGORIES);

/** Legacy EI-PR-* / composite code prefixes → canonical PR category label. */
const LEGACY_CODE_PREFIX_TO_CATEGORY = {
  SKC: 'Skin Care',
  HRC: 'Hair Care',
  BDY: 'Skin Care',
  SUN: 'Skin Care',
  OTC: 'Skin Care',
  COL: 'Others',
  MISC: 'Others',
};

const PR_CATEGORY_ALIASES = {
  skincare: 'Skin Care',
  'skin care': 'Skin Care',
  'face care': 'Skin Care',
  'body care': 'Skin Care',
  'sun care': 'Skin Care',
  derma: 'Skin Care',
  otc: 'Skin Care',
  'hair care': 'Hair Care',
  haircare: 'Hair Care',
  'hair cares': 'Hair Care',
  cleansing: 'Skin Care',
  cleanser: 'Skin Care',
  cleansers: 'Skin Care',
  'color cosmetics': 'Others',
  'colour cosmetics': 'Others',
  cosmetics: 'Others',
  makeup: 'Others',
  'make-up': 'Others',
  'baby / sensitive': 'Others',
  'baby sensitive': 'Others',
  baby: 'Others',
  sensitive: 'Others',
  miscellaneous: 'Others',
  misc: 'Others',
  other: 'Others',
  others: 'Others',
};

const PR_SUB_CATEGORY_ALIASES = {
  cleanser: 'Cleansers',
  cleansers: 'Cleansers',
  cleansing: 'Cleansers',
  facewash: 'Cleansers',
  'face wash': 'Cleansers',
  'body wash': 'Cleansers',
  'hand wash': 'Cleansers',
  'bar soap': 'Cleansers',
  'bath bar': 'Cleansers',
  soap: 'Cleansers',
  'cleansing balm': 'Cleansers',
  balm: 'Cleansers',
  moisturiser: 'Moisturiser',
  moisturizer: 'Moisturiser',
  moisturisers: 'Moisturiser',
  moisturizers: 'Moisturiser',
  sunscreen: 'Sunscreens',
  sunscreens: 'Sunscreens',
  'sun protection': 'Sunscreens',
  spf: 'Sunscreens',
  active: 'Actives',
  actives: 'Actives',
  other: 'Others',
  others: 'Others',
  shampoo: 'Shampoos',
  shampoos: 'Shampoos',
  conditioner: 'Conditioners',
  conditioners: 'Conditioners',
};

/** Renamed PR taxonomy paths → legacy template keys used by the FG-clearance quality-spec defaults. */
const PR_QUALITY_SPEC_PATH_ALIASES = {
  'Skin Care::Sunscreens': 'Skin Care::Sunscreen',
  'Hair Care::Shampoos': 'Hair Care::Shampoo',
  'Skin Care::Cleansers': 'Cleansing::Facewash',
};

function normalizePrCategoryForSelect(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/‑/g, '-');
  if (!k) return '';
  const exact = PR_CATEGORY_OPTIONS.find((o) => o.toLowerCase() === k);
  if (exact) return exact;
  return PR_CATEGORY_ALIASES[k] ?? '';
}

function normalizePrSubCategoryForSelect(category, raw) {
  const detail = String(raw || '').trim();
  if (!detail) return '';

  const tryCategory = (cat) => {
    const canon = normalizePrCategoryForSelect(cat);
    if (!canon) return '';
    if (canon === 'Others') return detail;
    const options = PR_FUNCTIONAL_SUB_CATEGORIES[canon] ?? [];
    const lower = detail.toLowerCase().replace(/‑/g, '-');
    const exact = options.find((o) => o.toLowerCase() === lower);
    if (exact) return exact;
    const mapped = PR_SUB_CATEGORY_ALIASES[lower];
    if (mapped && options.includes(mapped)) return mapped;
    return '';
  };

  const catNorm = normalizePrCategoryForSelect(category) || String(category ?? '').trim();
  if (catNorm) return tryCategory(catNorm);

  for (const cat of PR_CATEGORY_OPTIONS) {
    const hit = tryCategory(cat);
    if (hit) return hit;
  }
  return '';
}

/** Infer PR category label from legacy alphanumeric codes (EI-PR-SKC-*, EI-CI-HRC-*, etc.). */
function inferPrCategoryFromLegacyCode(code) {
  if (!code) return '';
  const upper = String(code).toUpperCase();
  for (const [key, label] of Object.entries(LEGACY_CODE_PREFIX_TO_CATEGORY)) {
    const pr = `EI-PR-${key}`;
    const ci = `EI-CI-${key}`;
    if (upper.startsWith(`${pr}-`) || upper === pr || upper.startsWith(`${ci}-`) || upper === ci) {
      return label;
    }
  }
  return '';
}

/** category = Product.category, normalized, falling back to inference from a legacy product code. */
function resolvePrQualitySpecCategory(rawCategory, productCode) {
  const source = String(rawCategory || '').trim() || inferPrCategoryFromLegacyCode(productCode || '');
  return normalizePrCategoryForSelect(source) || String(source || '').trim();
}

/** subCategory = pr_sub_category (parsed from BOM.notes), normalized against the resolved category. */
function resolvePrQualitySpecSubCategory(category, rawSubCategory) {
  return normalizePrSubCategoryForSelect(category, rawSubCategory) || String(rawSubCategory || '').trim();
}

/** Applies the FG-clearance legacy path aliasing, returning the (possibly different) category/subCategory pair to use for the sub-category-level rule lookup only — the category-level ("common") rule always uses the un-aliased resolved category. */
function resolvePrSubSpecPath(category, subCategory) {
  const key = `${String(category || '').trim()}::${String(subCategory || '').trim()}`;
  const aliased = PR_QUALITY_SPEC_PATH_ALIASES[key] ?? key;
  const sepIdx = aliased.indexOf('::');
  return {
    category: sepIdx >= 0 ? aliased.slice(0, sepIdx) : aliased,
    subCategory: sepIdx >= 0 ? aliased.slice(sepIdx + 2) : '',
  };
}

module.exports = {
  normalizePrCategoryForSelect,
  normalizePrSubCategoryForSelect,
  inferPrCategoryFromLegacyCode,
  resolvePrQualitySpecCategory,
  resolvePrQualitySpecSubCategory,
  resolvePrSubSpecPath,
};
