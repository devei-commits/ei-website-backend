/**
 * Excel Category / Sub-Category columns are the source of truth (verbatim strings).
 * No mapping to fixed enums or EI-RM-* / EI-PM-* keys.
 */

const { normalizePmSubCategorySlug, pmLevelForSubCategorySlug } = require('../lib/pmSubCategoryRules');

function trim(s) {
  return String(s || '').trim();
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
  mapRmImportCategories,
  mapPmImportCategories,
  resolveRmEditFromDb,
  resolvePmEditFromDb,
};
