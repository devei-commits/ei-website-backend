/**
 * Backend port of EI-Admin-Dashboard's RM category/sub-category resolution
 * (src/constants/eiMastersUnifiedSchema.ts, src/constants/materialMasterSkuRules.ts,
 * src/utils/masterImportCategoryResolve.ts, src/lib/rmQualitySpecVisibility.ts).
 * Keep in sync with those files.
 *
 * Real RM data is inconsistent about which "layer" it stores: some rows have
 * form_data.optionalRmSubCategory already set to the legacy quality name ("Surfactant"),
 * others to the unified taxonomy name ("SURFACTANTS") — the alias tables below make both
 * resolve to the same functionalCategory/functionalSub.
 */

const EI_TAX_RM = {
  'RAW MATERIALS': {
    EMULSIFIERS: ['O/W', 'W/O'],
    SURFACTANTS: ['ANIONIC', 'CATIONIC', 'NON-IONIC', 'AMPHOTERIC'],
    PRESERVATIVES: ['BROAD SPECTRUM', 'BELOW 4.5'],
    SOLVENTS: ['HYDROPHOBIC - LIGHT', 'HYDROPHOBIC - HEAVY', 'HYDROPHILIC'],
    'WAXES / BUTTERS': ['NATURAL', 'SYNTHETIC'],
    'UV FILTERS': ['UVA', 'UVB', 'BROAD SPECTRUM'],
    ACTIVES: ['HYDROPHILIC', 'HYDROPHOBIC'],
    BOTANICALS: ['PG/GLYCERIN BASE', 'OIL BASE', 'AQUA BASE'],
    'RHEOLOGY MODIFIERS': ['ET - LOW', 'ET - MEDIUM', 'ET - HIGH'],
  },
  'FRAGRANCES / PERFUMES': {
    'OIL SOLUBLE': ['—'],
    'WATER SOLUBLE': ['—'],
  },
  COLOURS: {
    'OIL SOLUBLE': ['—'],
    'WATER SOLUBLE': ['—'],
  },
};

const RM_CATEGORY_OPTIONS = Object.keys(EI_TAX_RM);
const RM_SUB_CATEGORY_SKU_OPTIONS = ['RAW MATERIALS', 'FRAGRANCES / PERFUMES', 'COLOURS'];

const RM_SUB_CATEGORY_ALIASES = {
  surfactant: 'SURFACTANTS',
  surfactants: 'SURFACTANTS',
  emulsifier: 'EMULSIFIERS',
  emulsifiers: 'EMULSIFIERS',
  preservative: 'PRESERVATIVES',
  preservatives: 'PRESERVATIVES',
  solvent: 'SOLVENTS',
  solvents: 'SOLVENTS',
  'aqua / solvent': 'SOLVENTS',
  'solvents & carriers': 'SOLVENTS',
  active: 'ACTIVES',
  actives: 'ACTIVES',
  polymer: 'RHEOLOGY MODIFIERS',
  polymers: 'RHEOLOGY MODIFIERS',
  'rheology modifier': 'RHEOLOGY MODIFIERS',
  'rheology modifiers': 'RHEOLOGY MODIFIERS',
  botanical: 'BOTANICALS',
  botanicals: 'BOTANICALS',
  'uv filter': 'UV FILTERS',
  'uv filters': 'UV FILTERS',
  'waxes / butters': 'WAXES / BUTTERS',
  'wax / butter': 'WAXES / BUTTERS',
  excipient: 'SOLVENTS',
  excipients: 'SOLVENTS',
  fragrance: 'OIL SOLUBLE',
  'oil soluble': 'OIL SOLUBLE',
  'oil-soluble': 'OIL SOLUBLE',
  'water soluble': 'WATER SOLUBLE',
  'water-soluble': 'WATER SOLUBLE',
};

const RM_SUB_SUB_ALIASES = {
  anionic: 'ANIONIC',
  cationic: 'CATIONIC',
  'non-ionic': 'NON-IONIC',
  'non ionic': 'NON-IONIC',
  amphoteric: 'AMPHOTERIC',
  'uv filter': 'UVA',
  uva: 'UVA',
  uvb: 'UVB',
  'broad spectrum': 'BROAD SPECTRUM',
  'below 4.5': 'BELOW 4.5',
  hydrophilic: 'HYDROPHILIC',
  hydrophobic: 'HYDROPHOBIC',
  'hydrophobic - light': 'HYDROPHOBIC - LIGHT',
  'hydrophobic - heavy': 'HYDROPHOBIC - HEAVY',
  natural: 'NATURAL',
  synthetic: 'SYNTHETIC',
  'o/w': 'O/W',
  'w/o': 'W/O',
  'et - low': 'ET - LOW',
  'et - medium': 'ET - MEDIUM',
  'et - high': 'ET - HIGH',
  'pg/glycerin base': 'PG/GLYCERIN BASE',
  'oil base': 'OIL BASE',
  'aqua base': 'AQUA BASE',
  phenoxyethanol: 'BROAD SPECTRUM',
  'phenoxyethanol-type': 'BROAD SPECTRUM',
  paraben: 'BELOW 4.5',
  'paraben-type': 'BELOW 4.5',
  vitamin: 'HYDROPHILIC',
  'botanical extract': 'HYDROPHILIC',
  glycerin: 'HYDROPHILIC',
  alcohol: 'HYDROPHOBIC - LIGHT',
  glycol: 'HYDROPHOBIC - HEAVY',
  aqua: 'HYDROPHILIC',
  carbomer: 'ET - LOW',
  'cellulose derivative': 'ET - MEDIUM',
  'xanthan / gum': 'ET - HIGH',
};

const RM_UNIFIED_TO_LEGACY_QUALITY_CATEGORY = {
  emulsifiers: 'Excipient',
  surfactants: 'Surfactant',
  preservatives: 'Preservative',
  solvents: 'Aqua / Solvent',
  'waxes / butters': 'Excipient',
  'uv filters': 'Active',
  actives: 'Active',
  botanicals: 'Active',
  'rheology modifiers': 'Polymer',
  'oil soluble': 'Fragrance',
  'water soluble': 'Fragrance',
};

const RM_UNIFIED_TO_LEGACY_QUALITY_SUB = {
  surfactants: { anionic: 'Anionic', cationic: 'Cationic', 'non-ionic': 'Non-ionic', amphoteric: 'Amphoteric' },
  preservatives: { 'broad spectrum': 'Phenoxyethanol-type', 'below 4.5': 'Paraben-type' },
  'uv filters': { uva: 'UV Filter', uvb: 'UV Filter', 'broad spectrum': 'UV Filter' },
  actives: { hydrophilic: 'Vitamin', hydrophobic: 'Synthetic Active' },
  solvents: {
    aqua: 'Aqua',
    glycerin: 'Glycerin',
    alcohol: 'Alcohol',
    glycol: 'Glycol',
    hydrophilic: 'Glycerin',
    'hydrophobic - light': 'Alcohol',
    'hydrophobic - heavy': 'Glycol',
  },
  'rheology modifiers': { 'et - low': 'Carbomer', 'et - medium': 'Cellulose Derivative', 'et - high': 'Xanthan / Gum' },
};

function normKey(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/‑/g, '-');
}

function trim(s) {
  return String(s || '').trim();
}

function normalizeUnifiedRmCategory(raw) {
  const k = normKey(raw);
  if (!k) return '';
  if (k === 'raw materials' || k.includes('bulk raw') || k === 'raw material') return 'RAW MATERIALS';
  if (k === 'fragrance' || k === 'fragrances' || k.includes('fragrances / perfumes')) return 'FRAGRANCES / PERFUMES';
  if (k === 'colours' || k === 'colors' || k.includes('colors & pigments') || k === 'colour') return 'COLOURS';
  const exact = RM_CATEGORY_OPTIONS.find((o) => normKey(o) === k);
  return exact ?? '';
}

function normalizeUnifiedRmSubCategory(category, raw) {
  const detail = trim(raw);
  if (!detail) return '';
  const cat = normalizeUnifiedRmCategory(category);
  if (!cat) return '';
  const options = Object.keys(EI_TAX_RM[cat]);
  const lower = normKey(detail);
  const exact = options.find((o) => normKey(o) === lower);
  if (exact) return exact;
  const mapped = RM_SUB_CATEGORY_ALIASES[lower];
  if (mapped && options.includes(mapped)) return mapped;
  return '';
}

function normalizeUnifiedRmSubSubCategory(category, subCategory, raw) {
  const detail = trim(raw);
  if (!detail) return '';
  const cat = normalizeUnifiedRmCategory(category);
  const sub = normalizeUnifiedRmSubCategory(category, subCategory) || subCategory;
  if (!cat || !sub) return '';
  const options = (EI_TAX_RM[cat] || {})[sub] ?? [];
  if (!options.length || (options.length === 1 && options[0] === '—')) return '';
  const lower = normKey(detail);
  const exact = options.find((o) => normKey(o) === lower);
  if (exact) return exact;
  const mapped = RM_SUB_SUB_ALIASES[lower];
  if (mapped && options.includes(mapped)) return mapped;
  return '';
}

function rmUnifiedToLegacyQualityCategory(unifiedSub) {
  const k = normKey(unifiedSub);
  return RM_UNIFIED_TO_LEGACY_QUALITY_CATEGORY[k] ?? unifiedSub;
}

function rmUnifiedToLegacyQualitySub(unifiedSub, unifiedSubSub) {
  const subK = normKey(unifiedSub);
  const subSubK = normKey(unifiedSubSub);
  const bySub = RM_UNIFIED_TO_LEGACY_QUALITY_SUB[subK];
  if (bySub && bySub[subSubK]) return bySub[subSubK];
  return unifiedSubSub;
}

function normalizeRmSubCategoryForSelect(raw) {
  return normalizeUnifiedRmCategory(raw) || '';
}

function normalizeRmDetailSubCategoryForSelect(parent, raw) {
  return normalizeUnifiedRmSubCategory(parent, raw);
}

function normalizeRmDetailSubCategoryKey(raw) {
  for (const cat of RM_SUB_CATEGORY_SKU_OPTIONS) {
    const hit = normalizeUnifiedRmSubCategory(cat, raw);
    if (hit) return hit;
  }
  return trim(raw);
}

function normalizeRmSubSubCategoryForSelect(detailSub, raw, parentCategory) {
  const parentCat = parentCategory || 'RAW MATERIALS';
  const parent = normalizeRmSubCategoryForSelect(parentCat) || parentCat;
  const sub = normalizeRmDetailSubCategoryForSelect(parent, detailSub) || detailSub;
  return normalizeUnifiedRmSubSubCategory(parent, sub, raw);
}

/** Port of resolveRmEditCategories — reconstructs category-resolution inputs from a saved RM row. */
function resolveRmEditCategories(record) {
  const fd = record.form_data && typeof record.form_data === 'object' ? record.form_data : {};
  const subCategoryRaw = trim(fd.excelSubCategory || fd.subCategory || fd.sub_category || record.group || record.category);
  const subCategory =
    normalizeRmSubCategoryForSelect(subCategoryRaw) ||
    normalizeRmSubCategoryForSelect(record.category || '') ||
    normalizeRmSubCategoryForSelect(record.group || '') ||
    subCategoryRaw;
  const optionalRmSubCategory =
    normalizeRmDetailSubCategoryForSelect(subCategory, trim(fd.optionalRmSubCategory)) || trim(fd.optionalRmSubCategory);
  const optionalRmSubSubCategoryRaw = trim(fd.optionalRmSubSubCategory || fd.rm_sub_sub_category);
  const optionalRmSubSubCategory =
    normalizeRmSubSubCategoryForSelect(optionalRmSubCategory, optionalRmSubSubCategoryRaw, subCategory) ||
    optionalRmSubSubCategoryRaw;

  return { subCategory, optionalRmSubCategory, optionalRmSubSubCategory };
}

/** Port of resolveRmQualitySpecContext's functionalCategory/functionalSub derivation. */
function resolveRmQualitySpecFunctionalContext(ctx) {
  const unifiedCategory =
    normalizeRmDetailSubCategoryKey(ctx.optionalRmSubCategory) ||
    normalizeRmDetailSubCategoryForSelect(ctx.subCategory, ctx.optionalRmSubCategory) ||
    trim(ctx.optionalRmSubCategory);
  const unifiedSub =
    normalizeRmSubSubCategoryForSelect(unifiedCategory, ctx.optionalRmSubSubCategory ?? '', ctx.subCategory) ||
    trim(ctx.optionalRmSubSubCategory);

  return {
    functionalCategory: rmUnifiedToLegacyQualityCategory(unifiedCategory),
    functionalSub: rmUnifiedToLegacyQualitySub(unifiedCategory, unifiedSub),
  };
}

/** End-to-end: a saved RM row's { category, group, form_data } → the quality-spec rule's { category, subCategory }. */
function resolveRmQualitySpecCategoryFromRow(row) {
  const cats = resolveRmEditCategories(row);
  const { functionalCategory, functionalSub } = resolveRmQualitySpecFunctionalContext(cats);
  return { category: functionalCategory, subCategory: functionalSub };
}

module.exports = {
  resolveRmEditCategories,
  resolveRmQualitySpecFunctionalContext,
  resolveRmQualitySpecCategoryFromRow,
};
