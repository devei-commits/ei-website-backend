/**
 * Backend port of EI-Admin-Dashboard's PM category resolution
 * (src/constants/eiMastersUnifiedSchema.ts, src/utils/masterImportCategoryResolve.ts).
 * Keep in sync with those files.
 *
 * Only resolves the CATEGORY level ("Primary Pack" / "Closures & Pumps" / "Secondary Pack" /
 * "Tertiary Pack" / "Ancillary") — there is no authoritative mapping from the frontend's unified
 * PM taxonomy (item types like BOTTLES/TUBES/CAPS) to the quality-spec sub-category labels seeded
 * from EI_Masters_QualityCheck.html ("Bottle (PET/HDPE)", "Cap (Flip-top/Disc-top)", ...) — the
 * frontend's own `clonePmQualitySubSpecTableDefaults` is stubbed to always return `[]`, i.e. this
 * sub-category link was never actually wired up there either. Guessing one here risks silently
 * wrong quality specs, so PM sub-category-level rule resolution is intentionally left unresolved.
 */
const { normalizePmSubCategorySlug } = require('../lib/pmSubCategoryRules');

/** PM SKU slug → sub-category (item-type) options, only the KEYS matter here (not exported for sub-sub use). */
const PM_SLUG_TO_SUBCATEGORY_OPTIONS = {
  ppm: ['TUBES', 'BOTTLES', 'JARS', 'CAPS', 'LIDS', 'PUMPS', 'DROPPERS', 'STICKS', 'SACHETS'],
  'spm-labels': ['SHEET FORM', 'ROLL FORM'],
  'spm-monocarton': ['LOCK BOTTOM', 'REVERSE TUCK END', 'STRAIGHT TUCK END'],
  'spm-other': ['SLEEVES', 'LEAFLETS', 'FITMENTS', 'TAMPER STICKER', 'QR CARDS'],
  'tpm-tertiary': ['SHIPPERS', 'PALLETS', 'STRETCH FILM', 'VOID FILL', 'TAPE', 'STRAPPING'],
  'tpm-ancillary': ['SPATULAS', 'BRUSHES', 'SPONGES', 'WANDS', 'PIPETTES', 'DESICCANTS'],
};

const PM_SUB_CATEGORY_ALIASES = {
  tube: 'TUBES', tubes: 'TUBES', 'tube (laminated)': 'TUBES',
  bottle: 'BOTTLES', bottles: 'BOTTLES', 'bottle (pet/hdpe)': 'BOTTLES',
  jar: 'JARS', jars: 'JARS', 'jar (pp/pet)': 'JARS',
  cap: 'CAPS', caps: 'CAPS', 'cap (flip-top/disc-top)': 'CAPS',
  lid: 'LIDS', lids: 'LIDS',
  pump: 'PUMPS', pumps: 'PUMPS', 'pump (lotion/foam)': 'PUMPS',
  dropper: 'DROPPERS', droppers: 'DROPPERS', 'dropper cap': 'DROPPERS',
  stick: 'STICKS', sticks: 'STICKS', 'roll-on': 'STICKS',
  sachet: 'SACHETS', sachets: 'SACHETS',
  'sheet form': 'SHEET FORM', 'roll form': 'ROLL FORM',
  'front label': 'SHEET FORM', 'back label': 'ROLL FORM',
  monocarton: 'LOCK BOTTOM', monocartons: 'LOCK BOTTOM',
  leaflet: 'LEAFLETS', leaflets: 'LEAFLETS',
  sleeves: 'SLEEVES', sleeve: 'SLEEVES',
  fitments: 'FITMENTS', fitment: 'FITMENTS',
  'tamper sticker': 'TAMPER STICKER',
  'qr cards': 'QR CARDS', 'qr card / insert': 'QR CARDS',
  shippers: 'SHIPPERS', shipper: 'SHIPPERS',
  pallets: 'PALLETS', pallet: 'PALLETS',
  'stretch film': 'STRETCH FILM',
  strapping: 'STRAPPING',
  spatulas: 'SPATULAS', spatula: 'SPATULAS',
  brushes: 'BRUSHES', brush: 'BRUSHES',
  sponges: 'SPONGES', sponge: 'SPONGES',
  wands: 'WANDS', wand: 'WANDS',
  pipettes: 'PIPETTES', pipette: 'PIPETTES',
  desiccants: 'DESICCANTS',
  'primary pack': 'BOTTLES',
  'closures & pumps': 'PUMPS',
  'secondary pack': 'SHEET FORM',
  'tertiary pack': 'SHIPPERS',
  ancillary: 'SPATULAS',
  sprayer: 'PUMPS',
  'mist spray': 'PUMPS',
};

const PM_UNIFIED_TO_LEGACY_QUALITY_CATEGORY = {
  tubes: 'Primary Pack', bottles: 'Primary Pack', jars: 'Primary Pack',
  sachets: 'Primary Pack', droppers: 'Primary Pack', sticks: 'Primary Pack',
  pumps: 'Closures & Pumps', caps: 'Closures & Pumps', lids: 'Closures & Pumps',
  'sheet form': 'Secondary Pack', 'roll form': 'Secondary Pack',
  'lock bottom': 'Secondary Pack', 'reverse tuck end': 'Secondary Pack', 'straight tuck end': 'Secondary Pack',
  leaflets: 'Secondary Pack', sleeves: 'Secondary Pack', fitments: 'Secondary Pack',
  'tamper sticker': 'Secondary Pack', 'qr cards': 'Secondary Pack',
  shippers: 'Tertiary Pack', pallets: 'Tertiary Pack', 'stretch film': 'Tertiary Pack',
  'void fill': 'Tertiary Pack', tape: 'Tertiary Pack', strapping: 'Tertiary Pack',
  spatulas: 'Ancillary', brushes: 'Ancillary', sponges: 'Ancillary',
  wands: 'Ancillary', pipettes: 'Ancillary', desiccants: 'Ancillary',
};

function normKey(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/‑/g, '-');
}

function trim(s) {
  return String(s || '').trim();
}

function normalizeUnifiedPmSubCategory(skuSlug, raw) {
  const detail = trim(raw);
  if (!detail) return '';
  const options = PM_SLUG_TO_SUBCATEGORY_OPTIONS[skuSlug];
  if (!options) return '';
  const lower = normKey(detail);
  const exact = options.find((o) => normKey(o) === lower);
  if (exact) return exact;
  const mapped = PM_SUB_CATEGORY_ALIASES[lower];
  if (mapped && options.includes(mapped)) return mapped;
  return '';
}

/**
 * Every PM SKU series maps to exactly one functional quality category. This is the fallback when an
 * item's detail sub-category is missing or is a label the item-type map doesn't know.
 *
 * Without it, `pmUnifiedToLegacyQualityCategory` returned the raw master value as though it were a
 * category — which put 74% of pack materials into phantom categories ("Labels", "Packaging -
 * Primary", "Other Components", "Shrink Sleeves") that the Spec Rules screen never offers and no
 * rule can target. `ppm` is deliberately absent: it spans both Primary Pack and Closures & Pumps,
 * so a ppm item with an unrecognised type stays unresolved rather than being guessed into one.
 */
const PM_SLUG_TO_LEGACY_QUALITY_CATEGORY = {
  'spm-labels': 'Secondary Pack',
  'spm-monocarton': 'Secondary Pack',
  'spm-other': 'Secondary Pack',
  'tpm-tertiary': 'Tertiary Pack',
  'tpm-ancillary': 'Ancillary',
};

function pmUnifiedToLegacyQualityCategory(skuSlug, unifiedSub) {
  const sub = normalizeUnifiedPmSubCategory(skuSlug, unifiedSub) || unifiedSub;
  const byItemType = PM_UNIFIED_TO_LEGACY_QUALITY_CATEGORY[normKey(sub)];
  if (byItemType) return byItemType;
  // Fall back to the SKU series rather than echoing the raw master text back as a category.
  return PM_SLUG_TO_LEGACY_QUALITY_CATEGORY[skuSlug] ?? '';
}

function normalizePmSkuCategoryForSelect(raw) {
  return normalizePmSubCategorySlug(raw) || '';
}

function normalizePmDetailSubCategoryForSelect(parent, raw) {
  const canon = normalizePmSkuCategoryForSelect(parent);
  if (!canon) return '';
  return normalizeUnifiedPmSubCategory(canon, raw);
}

function normalizePmDetailSubCategoryKey(raw) {
  for (const slug of Object.keys(PM_SLUG_TO_SUBCATEGORY_OPTIONS)) {
    const hit = normalizeUnifiedPmSubCategory(slug, raw);
    if (hit) return hit;
  }
  return trim(raw);
}

/** Port of resolvePmEditCategories — reconstructs category-resolution inputs from a saved PM row. */
function resolvePmEditCategories(record) {
  const fd = record.form_data && typeof record.form_data === 'object' ? record.form_data : {};
  const excelCat = trim(fd.excelCategory || fd.pmCategory || fd.matBody || record.material || '');
  const excelSub = trim(fd.excelSubCategory);
  const subCategoryRaw = trim(fd.pmSkuCategory || fd.subCategory || record.group || excelCat);
  const subCategory =
    normalizePmSkuCategoryForSelect(subCategoryRaw) || normalizePmSkuCategoryForSelect(excelCat) || subCategoryRaw;
  const optionalPmSubCategoryRaw = trim(
    fd.optionalPmSubCategory ||
      (excelSub && excelSub.toLowerCase() !== subCategoryRaw.toLowerCase() && excelSub.toLowerCase() !== excelCat.toLowerCase()
        ? excelSub
        : '') ||
      (record.material && trim(record.material) !== subCategory ? trim(record.material) : '')
  );
  const optionalPmSubCategory =
    normalizePmDetailSubCategoryForSelect(subCategory, optionalPmSubCategoryRaw) || optionalPmSubCategoryRaw;

  return { pmSkuCategory: subCategory, optionalPmSubCategory };
}

/** Category-level (functionalCategory) resolution only — see file docblock for why sub-category is omitted. */
function resolvePmQualitySpecFunctionalCategory(ctx) {
  const sku = normalizePmSkuCategoryForSelect(ctx.pmSkuCategory || '') || 'ppm';
  const unifiedSub = normalizePmDetailSubCategoryKey(ctx.optionalPmSubCategory) || trim(ctx.optionalPmSubCategory);
  const category = pmUnifiedToLegacyQualityCategory(sku, unifiedSub);
  if (category) return category;
  // A ppm item whose type is unknown could be either Primary Pack or Closures & Pumps. Primary Pack
  // is the series default (closures are the minority and are all named in the item-type map).
  return sku === 'ppm' ? 'Primary Pack' : '';
}

/**
 * End-to-end: a saved PM row's { group, material, form_data } → the quality-spec rule scope.
 *
 * `subCategory` is the item type the master itself records (BOTTLES, CAPS, SHEET FORM, …) — the
 * same vocabulary `PM_SLUG_TO_SUBCATEGORY_OPTIONS` defines and the master form stores. Earlier this
 * was hard-coded to '' because no mapping existed onto the HTML-seeded labels ("Bottle (PET/HDPE)");
 * using the item types directly needs no such mapping, so PM sub-category rules can now resolve.
 * It stays '' when the type is unknown, which just means only the category rule applies.
 */
function resolvePmQualitySpecCategoryFromRow(row) {
  const cats = resolvePmEditCategories(row);
  const category = resolvePmQualitySpecFunctionalCategory(cats);
  // Prefer the canonical item type; otherwise keep the value the master actually stores.
  // Much of the PM data is imported and carries its own vocabulary ("Labels",
  // "Self-Adhesive Labels") rather than the schema's SHEET FORM / ROLL FORM. Blanking those made
  // the sub-category shown on the master un-targetable by any rule — which is exactly what a user
  // hits when they read "Labels" on the item and cannot find it in the rules screen. Keeping the
  // raw value means a rule written against what the master displays resolves to that item.
  const subCategory = normalizePmDetailSubCategoryKey(cats.optionalPmSubCategory) || trim(cats.optionalPmSubCategory);
  return { category, subCategory };
}

/** PM SKU slug → the category LABEL the master form shows. Mirrors PM_SLUG_TO_CATEGORY_LABEL. */
const PM_SLUG_TO_CATEGORY_LABEL = {
  ppm: 'PPM — Primary (4XXXXX)',
  'spm-labels': 'SPM — Labels (5LXXXXX)',
  'spm-monocarton': 'SPM — Monocartons (5MXXXXX)',
  'spm-other': 'SPM — Other Secondary (5OXXXXX)',
  'tpm-tertiary': 'TPM — Tertiary (6TXXXXX)',
  'tpm-ancillary': 'TPM — Ancillary (6AXXXXX)',
};

/**
 * The same row in the MASTERS' vocabulary — the SKU series label and item type the PM form shows
 * ('SPM — Labels (5LXXXXX)' → 'SHEET FORM'). Resolved alongside the legacy functional scope so a
 * rule written in either vocabulary reaches the item.
 */
function resolvePmMasterScopeFromRow(row) {
  const cats = resolvePmEditCategories(row);
  const slug = normalizePmSkuCategoryForSelect(cats.pmSkuCategory || '') || 'ppm';
  return {
    category: PM_SLUG_TO_CATEGORY_LABEL[slug] || '',
    subCategory: normalizePmDetailSubCategoryKey(cats.optionalPmSubCategory) || trim(cats.optionalPmSubCategory),
    subSubCategory: '',
  };
}

module.exports = {
  resolvePmMasterScopeFromRow,
  resolvePmEditCategories,
  resolvePmQualitySpecFunctionalCategory,
  resolvePmQualitySpecCategoryFromRow,
};
