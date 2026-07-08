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

function pmUnifiedToLegacyQualityCategory(skuSlug, unifiedSub) {
  const sub = normalizeUnifiedPmSubCategory(skuSlug, unifiedSub) || unifiedSub;
  const k = normKey(sub);
  return PM_UNIFIED_TO_LEGACY_QUALITY_CATEGORY[k] ?? unifiedSub;
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
  return pmUnifiedToLegacyQualityCategory(sku, unifiedSub) || '';
}

/** End-to-end: a saved PM row's { group, material, form_data } → the quality-spec rule's category (sub-category intentionally omitted). */
function resolvePmQualitySpecCategoryFromRow(row) {
  const cats = resolvePmEditCategories(row);
  const category = resolvePmQualitySpecFunctionalCategory(cats);
  return { category, subCategory: '' };
}

module.exports = {
  resolvePmEditCategories,
  resolvePmQualitySpecFunctionalCategory,
  resolvePmQualitySpecCategoryFromRow,
};
