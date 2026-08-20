/**
 * Push resolved Quality Spec Rules into the master rows a GRN's QC screen is built from.
 *
 * The QC payload reads each item master's saved `form_data`. But an unlocked master does NOT store
 * its quality rows — the RM/PM controllers resolve them live from `quality_spec_rules` on every
 * read, and only a user editing the item's specs (`quality_specs_locked`) writes rows onto the row
 * itself. `loadMastersForQc` queries the tables directly, so it saw the bare `form_data` and the QC
 * screen showed no parameters for any item whose specs come from a rule.
 *
 * This closes that gap by resolving the same rules the masters would, using the same category
 * resolvers, and writing the rows into the in-memory copy under the keys the QC extractor reads.
 * Locked masters are left alone: their saved rows are deliberately frozen and must not be
 * overwritten by a rule that has since changed.
 */
const { resolveEntityQualitySpecs } = require('../qualitySpecRules/resolveForItem');
const { layerQualitySpecRuleRows } = require('../qualitySpecRules/resolver');
const { resolveRmQualitySpecCategoryFromRow, resolveRmMasterScopeFromRow } = require('../qualitySpecRules/rmCategoryResolve');
const { resolvePmQualitySpecCategoryFromRow, resolvePmMasterScopeFromRow } = require('../qualitySpecRules/pmCategoryResolve');

function plainFormData(row) {
  const fd = row && row.form_data;
  return fd != null && typeof fd === 'object' && !Array.isArray(fd) ? fd : {};
}

/** Does this master already carry quality rows of its own? */
function hasOwnQualityRows(row, masterType) {
  const fd = plainFormData(row);
  const commonKey = masterType === 'PM' ? 'pmQualitySpecRows' : 'rmQualitySpecRows';
  return Array.isArray(fd[commonKey]) && fd[commonKey].length > 0;
}

async function enrichRmMaster(row) {
  if (row.quality_specs_locked === true) return row;
  const fd = plainFormData(row);
  const { category, subCategory, subSubCategory } = resolveRmQualitySpecCategoryFromRow({
    category: row.category,
    group: row.group,
    form_data: fd,
  });
  const { commonRows, subRows } = await resolveEntityQualitySpecs(
    'RM', category, subCategory, subSubCategory, row.code,
    resolveRmMasterScopeFromRow({ category: row.category, group: row.group, form_data: fd }),
  );
  if (commonRows.length === 0 && subRows.length === 0) return row;
  // QC wants the effective parameter list, not the master screen's two-table split. Writing the
  // merged rows into the common key also avoids losing sub/item rows for an item with no
  // sub-category, where there is no `category::subCategory` path to hang them on.
  row.form_data = { ...fd, rmQualitySpecRows: layerQualitySpecRuleRows(commonRows, subRows) };
  return row;
}

async function enrichPmMaster(row) {
  if (row.quality_specs_locked === true) return row;
  const fd = plainFormData(row);
  const { category, subCategory } = resolvePmQualitySpecCategoryFromRow({
    group: row.group,
    material: row.material,
    form_data: fd,
  });
  const { commonRows, subRows } = await resolveEntityQualitySpecs(
    'PM', category, subCategory, '', row.code,
    resolvePmMasterScopeFromRow({ group: row.group, material: row.material, form_data: fd }),
  );
  const effective = layerQualitySpecRuleRows(commonRows, subRows);
  if (effective.length === 0) return row;
  row.form_data = { ...fd, pmQualitySpecRows: effective };
  return row;
}

/**
 * Enrich every distinct master in the maps `loadMastersForQc` returns. The maps hold the SAME
 * object under several keys (id, code, upper-cased code, sku), so enrichment is done once per
 * object identity and the shared reference carries the result to every key.
 */
async function applyQualitySpecRulesToQcMasters(masters) {
  if (!masters) return masters;
  const rmRows = new Set([...(masters.rmById?.values() ?? []), ...(masters.rmByCode?.values() ?? [])]);
  const pmRows = new Set([...(masters.pmById?.values() ?? []), ...(masters.pmByCode?.values() ?? [])]);
  await Promise.all([
    ...[...rmRows].map((row) => enrichRmMaster(row).catch(() => row)),
    ...[...pmRows].map((row) => enrichPmMaster(row).catch(() => row)),
  ]);
  return masters;
}

module.exports = { applyQualitySpecRulesToQcMasters, hasOwnQualityRows };
