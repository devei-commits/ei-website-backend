/**
 * PM category slugs (PPM / SPM / TPM) and SKU series (4 / 5L / 5M / 5O / 6T / 6A).
 * Keep in sync with EI-Admin/src/constants/materialMasterSkuRules.ts
 */

function normKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** @returns {'ppm'|'spm-labels'|'spm-monocarton'|'spm-other'|'tpm-tertiary'|'tpm-ancillary'|''} */
function normalizePmSubCategorySlug(raw) {
  const k = normKey(raw);
  if (!k) return '';
  if (k === 'ppm' || k.includes('primary packaging')) return 'ppm';
  if (k.includes('spm') && k.includes('label')) return 'spm-labels';
  if (k === 'labels' || k === 'label') return 'spm-labels';
  if (k.includes('spm') && (k.includes('monocarton') || k.includes('mono carton'))) return 'spm-monocarton';
  if (k === 'monocarton' || k === 'monocartons') return 'spm-monocarton';
  if (k.includes('other secondary') || k === 'spm-other' || (k.includes('spm') && k.includes('other'))) {
    return 'spm-other';
  }
  if (k.includes('ancillary')) return 'tpm-ancillary';
  if (k === 'tpm' || k.includes('tertiary') || k.includes('other component')) {
    return 'tpm-tertiary';
  }
  const slugs = [
    'ppm',
    'spm-labels',
    'spm-monocarton',
    'spm-other',
    'tpm-tertiary',
    'tpm-ancillary',
  ];
  if (slugs.includes(k)) return k;
  return '';
}

/** @returns {'primary'|'labels'|'monocarton'|'other-secondary'|'tertiary'|'ancillary'|null} */
function pmSkuSeriesKey(subLower) {
  const slug = normalizePmSubCategorySlug(subLower) || subLower;
  if (slug === 'ppm') return 'primary';
  if (slug === 'spm-labels') return 'labels';
  if (slug === 'spm-monocarton') return 'monocarton';
  if (slug === 'spm-other') return 'other-secondary';
  if (slug === 'tpm-tertiary') return 'tertiary';
  if (slug === 'tpm-ancillary') return 'ancillary';
  if (subLower === 'labels') return 'labels';
  if (subLower === 'monocarton') return 'monocarton';
  if (subLower === 'primary') return 'primary';
  return null;
}

/** @returns {'Primary'|'Secondary'|'Tertiary'|''} */
function pmLevelForSubCategorySlug(subLower) {
  const slug = normalizePmSubCategorySlug(subLower);
  if (slug === 'ppm') return 'Primary';
  if (slug === 'spm-monocarton' || slug === 'spm-labels' || slug === 'spm-other') return 'Secondary';
  if (slug === 'tpm-tertiary' || slug === 'tpm-ancillary') return 'Tertiary';
  return '';
}

module.exports = {
  normalizePmSubCategorySlug,
  pmSkuSeriesKey,
  pmLevelForSubCategorySlug,
};
