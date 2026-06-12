/** PR master tabular quality specs — persisted on BOM text columns as JSON. */

const SECTION_COLUMNS = {
  bulkClearance: 'spec_tests',
  finalClearance: 'spec_fg',
  dispatchSpecs: 'spec_release',
};

const BULK_SUB_COLUMN = 'spec_process';

const SECTION_KEYS = Object.keys(SECTION_COLUMNS);

function parseRowsJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseSubByPathObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, rows] of Object.entries(parsed)) {
    if (Array.isArray(rows) && rows.length > 0) out[key] = rows;
  }
  return out;
}

function parseSubByPathJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    return parseSubByPathObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

function parseCompoundSectionFromColumn(text) {
  const raw = String(text || '').trim();
  if (!raw) return { common: [], subByPath: {} };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { common: parsed, subByPath: {} };
    if (parsed && typeof parsed === 'object') {
      return {
        common: Array.isArray(parsed.common) ? parsed.common : [],
        subByPath: parseSubByPathObject(parsed.subByPath),
      };
    }
  } catch {
    return { common: [], subByPath: {} };
  }
  return { common: [], subByPath: {} };
}

function serializeRowsJson(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return JSON.stringify(rows);
}

function serializeSubByPathJson(byPath) {
  if (!byPath || typeof byPath !== 'object' || Array.isArray(byPath)) return null;
  const out = {};
  for (const [key, rows] of Object.entries(byPath)) {
    if (Array.isArray(rows) && rows.length > 0) out[key] = rows;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

function serializeCompoundSectionToColumn(commonRows, subByPath) {
  const common = Array.isArray(commonRows) ? commonRows : [];
  const sub =
    subByPath && typeof subByPath === 'object' && !Array.isArray(subByPath) ? subByPath : {};
  const hasSub = Object.values(sub).some((rows) => Array.isArray(rows) && rows.length > 0);
  if (!common.length && !hasSub) return null;
  if (!hasSub) return serializeRowsJson(common);
  const outSub = {};
  for (const [key, rows] of Object.entries(sub)) {
    if (Array.isArray(rows) && rows.length > 0) outSub[key] = rows;
  }
  return JSON.stringify({ common, subByPath: outSub });
}

/** Read section-keyed rows + bulk sub-by-path from a BOM plain object. */
function hydratePrQualitySpecRowsBySectionFromBom(bomPlain) {
  const out = {
    bulkClearance: [],
    finalClearance: [],
    dispatchSpecs: [],
  };
  if (!bomPlain || typeof bomPlain !== 'object') return out;
  for (const key of SECTION_KEYS) {
    const col = SECTION_COLUMNS[key];
    if (key === 'finalClearance') {
      out.finalClearance = parseCompoundSectionFromColumn(bomPlain.spec_fg).common;
      continue;
    }
    if (key === 'dispatchSpecs') {
      out.dispatchSpecs = parseCompoundSectionFromColumn(bomPlain.spec_release).common;
      continue;
    }
    out[key] = parseRowsJson(bomPlain[col]);
  }
  return out;
}

function hydratePrQualityBulkSubSpecRowsByPathFromBom(bomPlain) {
  if (!bomPlain || typeof bomPlain !== 'object') return {};
  return parseSubByPathJson(bomPlain[BULK_SUB_COLUMN]);
}

function hydratePrQualityFinalSubSpecRowsByPathFromBom(bomPlain) {
  if (!bomPlain || typeof bomPlain !== 'object') return {};
  return parseCompoundSectionFromColumn(bomPlain.spec_fg).subByPath;
}

function hydratePrQualityDispatchSubSpecRowsByPathFromBom(bomPlain) {
  if (!bomPlain || typeof bomPlain !== 'object') return {};
  return parseCompoundSectionFromColumn(bomPlain.spec_release).subByPath;
}

/** Map section-keyed rows + bulk/final/dispatch sub specs to BOM column updates. */
function prQualitySpecBomColumnPatch(bySection, bulkSubByPath, finalSubByPath, dispatchSubByPath) {
  const patch = {};
  if (bySection && typeof bySection === 'object') {
    for (const key of SECTION_KEYS) {
      const col = SECTION_COLUMNS[key];
      if (key === 'finalClearance') {
        patch[col] = serializeCompoundSectionToColumn(bySection.finalClearance, finalSubByPath);
        continue;
      }
      if (key === 'dispatchSpecs') {
        patch[col] = serializeCompoundSectionToColumn(bySection.dispatchSpecs, dispatchSubByPath);
        continue;
      }
      const rows = bySection[key];
      patch[col] = serializeRowsJson(rows);
    }
  } else {
    if (finalSubByPath !== undefined) {
      patch[SECTION_COLUMNS.finalClearance] = serializeCompoundSectionToColumn([], finalSubByPath);
    }
    if (dispatchSubByPath !== undefined) {
      patch[SECTION_COLUMNS.dispatchSpecs] = serializeCompoundSectionToColumn([], dispatchSubByPath);
    }
  }
  if (bulkSubByPath !== undefined) {
    patch[BULK_SUB_COLUMN] = serializeSubByPathJson(bulkSubByPath);
  }
  return patch;
}

/** Flatten tabular specs for production QC reference panels. */
function flattenPrQualitySpecRowsForDisplay(
  bySection,
  bulkSubByPath,
  finalSubByPath,
  dispatchSubByPath
) {
  const out = {};
  if (bySection && typeof bySection === 'object') {
    for (const key of SECTION_KEYS) {
      const rows = Array.isArray(bySection[key]) ? bySection[key] : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const parameter = String(row.parameter || '').trim();
        const specLimit = String(row.specLimit ?? row.spec_limit ?? '').trim();
        if (!parameter) continue;
        const prefix =
          key === 'bulkClearance' ? 'Bulk' : key === 'finalClearance' ? 'Final' : 'Dispatch';
        out[`${prefix}: ${parameter}`] = specLimit || '—';
      }
    }
  }
  if (bulkSubByPath && typeof bulkSubByPath === 'object') {
    for (const [pathKey, rows] of Object.entries(bulkSubByPath)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const parameter = String(row.parameter || '').trim();
        const specLimit = String(row.specLimit ?? row.spec_limit ?? '').trim();
        if (!parameter) continue;
        out[`Bulk (${pathKey}): ${parameter}`] = specLimit || '—';
      }
    }
  }
  if (finalSubByPath && typeof finalSubByPath === 'object') {
    for (const [pathKey, rows] of Object.entries(finalSubByPath)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const parameter = String(row.parameter || '').trim();
        const specLimit = String(row.specLimit ?? row.spec_limit ?? '').trim();
        if (!parameter) continue;
        out[`Final (${pathKey}): ${parameter}`] = specLimit || '—';
      }
    }
  }
  if (dispatchSubByPath && typeof dispatchSubByPath === 'object') {
    for (const [pathKey, rows] of Object.entries(dispatchSubByPath)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const parameter = String(row.parameter || '').trim();
        const specLimit = String(row.specLimit ?? row.spec_limit ?? '').trim();
        if (!parameter) continue;
        out[`Dispatch (${pathKey}): ${parameter}`] = specLimit || '—';
      }
    }
  }
  return out;
}

module.exports = {
  SECTION_COLUMNS,
  BULK_SUB_COLUMN,
  hydratePrQualitySpecRowsBySectionFromBom,
  hydratePrQualityBulkSubSpecRowsByPathFromBom,
  hydratePrQualityFinalSubSpecRowsByPathFromBom,
  hydratePrQualityDispatchSubSpecRowsByPathFromBom,
  prQualitySpecBomColumnPatch,
  flattenPrQualitySpecRowsForDisplay,
};
