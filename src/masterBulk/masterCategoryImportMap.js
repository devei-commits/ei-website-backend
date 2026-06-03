/**
 * Excel Category / Sub-Category columns are the source of truth (verbatim strings).
 * No mapping to fixed enums or EI-RM-* / EI-PM-* keys.
 */

const { normalizePmSubCategorySlug, pmLevelForSubCategorySlug } = require('../lib/pmSubCategoryRules');

function trim(s) {
  return String(s || '').trim();
}

/** Excel Sub-Category cell → persisted RM `category` (matches admin dropdown). */
function rmCategoryFromExcelSubCategory(subCategoryCol) {
  const k = trim(subCategoryCol)
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!k) return 'Bulk raw materials';
  if (k === 'raw material' || k === 'raw materials' || k.includes('bulk raw')) return 'Bulk raw materials';
  if (k === 'fragrance' || k === 'fragrances') return 'Fragrance';
  if (k === 'colors & pigments' || k === 'color & pigments') return 'Colors & Pigments';
  if (k === 'club items' || k === 'club item') return 'Club Items';
  if (k === 'solvents & carriers') return 'Bulk raw materials';
  if (k === 'pre-mixed bases' || k === 'pre-mixed based') return 'Bulk raw materials';
  return trim(subCategoryCol);
}

/**
 * "Raw Materials" fill workbook: skip Category column; Sub-Category → RM category.
 * @returns {{ subCategory: string, categoryDb: string, rmType: string|null, formDataPatch: object }}
 */
function mapRmRawMaterialsWorksheetCategories({ subCategoryCol }) {
  const subCategory = trim(subCategoryCol);
  const categoryDb = rmCategoryFromExcelSubCategory(subCategory);

  return {
    subCategory,
    categoryDb,
    rmType: null,
    formDataPatch: {
      subCategory,
      rmCategory: categoryDb,
      excelCategory: categoryDb,
      excelSubCategory: subCategory,
    },
  };
}

/**
 * @returns {{ subCategory: string, categoryDb: string, rmType: string|null, formDataPatch: object }}
 */
function mapRmImportCategories({ sheetName, categoryCol, subCategoryCol }) {
  const category = trim(categoryCol);
  const subCategory = trim(subCategoryCol) || trim(sheetName);

  return {
    subCategory,
    categoryDb: category,
    rmType: null,
    formDataPatch: {
      subCategory,
      rmCategory: category,
      excelCategory: category,
      excelSubCategory: subCategory,
    },
  };
}

/**
 * PM fill workbook (Primary Packaging, …): skip Category column; Sub-Category → `group` (PM category slug).
 * @returns {{ subCategory: string, pmCategory: string, groupDb: string, materialDb: string|null, levelDb: string|null, formDataPatch: object }}
 */
function mapPmFillWorksheetCategories({ subCategoryCol, sheetName }) {
  const subCategory = trim(subCategoryCol) || trim(sheetName);
  const mapped = mapPmImportCategories({
    sheetName,
    categoryCol: '',
    subCategoryCol: subCategory,
  });
  return {
    ...mapped,
    formDataPatch: {
      ...mapped.formDataPatch,
      excelCategory: subCategory,
      excelSubCategory: subCategory,
      pmCategory: subCategory,
    },
  };
}

/**
 * @returns {{ subCategory: string, pmCategory: string, groupDb: string, materialDb: string|null, formDataPatch: object }}
 */
function mapPmImportCategories({ sheetName, categoryCol, subCategoryCol }) {
  const category = trim(categoryCol);
  const subCol = trim(subCategoryCol);
  const skuSeriesRaw = category || subCol || trim(sheetName);
  const slug = normalizePmSubCategorySlug(skuSeriesRaw) || skuSeriesRaw.toLowerCase();
  const level = pmLevelForSubCategorySlug(slug);
  const optionalSub =
    subCol && category && subCol.toLowerCase() !== category.toLowerCase() ? subCol : '';

  return {
    subCategory: slug,
    pmCategory: category,
    groupDb: slug,
    materialDb: optionalSub || null,
    levelDb: level || null,
    formDataPatch: {
      subCategory: slug,
      pmSkuCategory: slug,
      ...(level ? { level } : {}),
      ...(optionalSub ? { optionalPmSubCategory: optionalSub } : {}),
    },
  };
}

/** Load edit form from DB — prefer stored Excel strings, no enum remapping. */
function resolveRmEditFromDb(row) {
  const fd = row?.form_data && typeof row.form_data === 'object' ? row.form_data : {};
  const subCategory = trim(fd.excelSubCategory || fd.subCategory || fd.sub_category || row?.group);
  const rmCategory = trim(fd.excelCategory || fd.rmCategory || row?.category);

  return {
    subCategory,
    rmCategoryKey: trim(fd.rmCategoryKey || fd.rm_category_key),
    rmCategory,
    rmType: trim(fd.rmType || row?.rm_type),
  };
}

function resolvePmEditFromDb(row) {
  const fd = row?.form_data && typeof row.form_data === 'object' ? row.form_data : {};
  const subCategory = trim(fd.excelSubCategory || fd.subCategory || fd.sub_category || row?.group);
  const pmCategory = trim(fd.excelCategory || fd.pmCategory || fd.pm_category || row?.material);

  return {
    subCategory,
    pmCategory,
    matBody: trim(fd.matBody || row?.material),
  };
}

module.exports = {
  rmCategoryFromExcelSubCategory,
  mapRmRawMaterialsWorksheetCategories,
  mapRmImportCategories,
  mapPmFillWorksheetCategories,
  mapPmImportCategories,
  resolveRmEditFromDb,
  resolvePmEditFromDb,
};
