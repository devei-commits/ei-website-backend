/**
 * PM sub-category slugs (PPM / SPM / TPM) and SKU series (4 / 5M / 5L).
 * Keep in sync with EI-Admin/src/constants/materialMasterSkuRules.ts
 */

function normKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** @returns {'ppm'|'spm-monocarton'|'spm-labels'|'tpm'|''} */
function normalizePmSubCategorySlug(raw) {
  const k = normKey(raw);
  if (!k) return '';
  if (k === 'ppm') return 'ppm';
  if (k.includes('spm') && (k.includes('monocarton') || k.includes('mono carton'))) return 'spm-monocarton';
  if (k === 'monocarton' || k === 'monocartons') return 'spm-monocarton';
  if (k.includes('spm') && k.includes('label')) return 'spm-labels';
  if (k === 'labels' || k === 'label') return 'spm-labels';
  if (k === 'tpm' || k.includes('other component')) return 'tpm';
  if (k === 'primary') return 'tpm';
  return '';
}

/** @returns {'primary'|'monocarton'|'labels'|null} */
function pmSkuSeriesKey(subLower) {
  const slug = normalizePmSubCategorySlug(subLower) || subLower;
  if (slug === 'spm-monocarton') return 'monocarton';
  if (slug === 'spm-labels') return 'labels';
  if (slug === 'ppm' || slug === 'tpm') return 'primary';
  if (subLower === 'monocarton') return 'monocarton';
  if (subLower === 'labels') return 'labels';
  if (subLower === 'primary') return 'primary';
  return null;
}

/** @returns {'Primary'|'Secondary'|'Tertiary'|''} */
function pmLevelForSubCategorySlug(subLower) {
  const slug = normalizePmSubCategorySlug(subLower);
  if (slug === 'ppm') return 'Primary';
  if (slug === 'spm-monocarton' || slug === 'spm-labels') return 'Secondary';
  if (slug === 'tpm') return 'Tertiary';
  return '';
}

module.exports = {
  normalizePmSubCategorySlug,
  pmSkuSeriesKey,
  pmLevelForSubCategorySlug,
};
