/**
 * Detects whether an item's quality-spec fields were touched in a create/update payload.
 * The first time this is true for an item, the caller should set `quality_specs_locked = true`
 * (one-way — never reset back to false) so that item stops tracking category/sub-category rule
 * changes and keeps whatever quality specs it was saved with.
 */

const RM_QUALITY_SPEC_EDIT_KEYS = [
  'rmQualitySpecRows',
  'rmQualitySubSpecRowsByPath',
  'rmQualitySpecHiddenParameters',
  'rmQualitySubSpecHiddenByPath',
];

const PM_QUALITY_SPEC_EDIT_KEYS = [
  'pmQualitySpecRows',
  'pmQualitySubSpecRowsByPath',
  'pmQualitySpecHiddenParameters',
  'pmQualitySubSpecHiddenByPath',
];

const PR_QUALITY_SPEC_EDIT_KEYS = [
  'pr_quality_spec_rows_by_section',
  'prQualitySpecRowsBySection',
  'pr_quality_bulk_sub_spec_rows_by_path',
  'prQualityBulkSubSpecRowsByPath',
  'pr_quality_final_sub_spec_rows_by_path',
  'prQualityFinalSubSpecRowsByPath',
  'pr_quality_dispatch_sub_spec_rows_by_path',
  'prQualityDispatchSubSpecRowsByPath',
];

function hasNonEmptyValue(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

/** True if any of `keys` is present with non-empty content on `source` (a form_data object or request body). */
function payloadHasQualitySpecEdits(source, keys) {
  if (!source || typeof source !== 'object') return false;
  return keys.some((key) => hasNonEmptyValue(source[key]));
}

module.exports = {
  RM_QUALITY_SPEC_EDIT_KEYS,
  PM_QUALITY_SPEC_EDIT_KEYS,
  PR_QUALITY_SPEC_EDIT_KEYS,
  payloadHasQualitySpecEdits,
};
