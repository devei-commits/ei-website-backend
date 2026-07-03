/**
 * GRN inbound QC — pull quality-spec rows from RM/PM masters and track pass/fail per test.
 */

const RM_QC_FIELD_META = require('./rmQualitySpecFieldMeta');

const BULK_QUALITY_FORM_KEYS = [
  ['assaySpec', 'Assay / Purity %'],
  ['moistureSpec', 'Moisture %'],
  ['heavyMetalsSpec', 'Heavy metals'],
  ['microbialSpec', 'Microbial'],
  ['odorColorSpec', 'Odor & color'],
  ['otherSpecs', 'Other specifications'],
];

function parseBoolMandatory(raw) {
  return raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes' || raw === 'Yes';
}

function parseQualitySpecRow(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const parameter = String(raw.parameter ?? raw.Parameter ?? '').trim();
  if (!parameter) return null;
  return {
    specId: String(raw.id ?? `qs-${idx}`),
    parameter,
    specLimit: String(raw.specLimit ?? raw.spec_limit ?? '').trim(),
    method: String(raw.method ?? '').trim(),
    mandatory: parseBoolMandatory(raw.mandatory ?? raw.mand),
    tolerance: String(raw.tolerance ?? '').trim(),
    frequency: String(raw.frequency ?? '').trim(),
    sample: String(raw.sample ?? '').trim(),
    acceptance: String(raw.acceptance ?? '').trim(),
    outputType: String(raw.outputType ?? raw.output_type ?? raw.type ?? '').trim() || undefined,
    selectOptions: Array.isArray(raw.selectOptions)
      ? raw.selectOptions.map((o) => String(o ?? '').trim()).filter(Boolean)
      : Array.isArray(raw.select_options)
        ? raw.select_options.map((o) => String(o ?? '').trim()).filter(Boolean)
        : undefined,
  };
}

function parseQualitySpecRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx) => parseQualitySpecRow(item, idx))
    .filter(Boolean);
}

function flattenSubSpecRowsByPath(byPath) {
  if (!byPath || typeof byPath !== 'object' || Array.isArray(byPath)) return [];
  const out = [];
  for (const rows of Object.values(byPath)) {
    out.push(...parseQualitySpecRows(rows));
  }
  return out;
}

/** Prefer EI / parenthesized SKU in display text, then itemCode field. */
function resolveLineItemCode(line) {
  const text = String(line?.item ?? line?.item_text ?? '');
  const ei = text.match(/EI-[A-Z0-9-]+/i);
  if (ei && ei[0]) return String(ei[0]).trim().toUpperCase();
  const paren = text.match(/\(([A-Z0-9-]+)\)/);
  if (paren && paren[1] && /[0-9]/.test(paren[1])) return String(paren[1]).trim().toUpperCase();
  return String(line?.itemCode ?? line?.item_code ?? '').trim();
}

/** Stable line id for GRN QC — legacy rows may lack `id`. */
function resolveLineItemId(line, index) {
  const id = String(line?.id ?? line?.lineItemId ?? line?.line_item_id ?? '').trim();
  if (id) return id;
  const code = resolveLineItemCode(line);
  if (code) return `grn-line-code-${code}`;
  const rmId = line?.raw_material_id;
  const pmId = line?.pack_material_id;
  if (rmId != null && !Number.isNaN(Number(rmId))) return `grn-line-rm-${Number(rmId)}`;
  if (pmId != null && !Number.isNaN(Number(pmId))) return `grn-line-pm-${Number(pmId)}`;
  return `grn-line-idx-${index}`;
}

/** Taxonomy-shared custom specs persisted on master save (`masterSharedQualitySpecs`). */
function extractSharedQualitySpecRowsFromFormData(fd, masterType) {
  const form = fd && typeof fd === 'object' ? fd : {};
  const root = form.masterSharedQualitySpecs;
  if (!root || typeof root !== 'object') return [];
  const entityKey = masterType === 'PM' ? 'PM' : 'RM';
  const bucket = root[entityKey];
  if (!bucket || typeof bucket !== 'object') return [];
  const out = [];
  if (bucket.common && typeof bucket.common === 'object' && !Array.isArray(bucket.common)) {
    for (const rows of Object.values(bucket.common)) {
      out.push(...parseQualitySpecRows(rows));
    }
  }
  if (bucket.sub && typeof bucket.sub === 'object' && !Array.isArray(bucket.sub)) {
    out.push(...flattenSubSpecRowsByPath(bucket.sub));
  }
  return out;
}

function legacyBulkRowsFromFormData(fd) {
  if (!fd || typeof fd !== 'object') return [];
  const out = [];
  for (const [key, label] of BULK_QUALITY_FORM_KEYS) {
    const v = fd[key];
    if (v != null && String(v).trim()) {
      out.push({
        specId: `legacy-${key}`,
        parameter: label,
        specLimit: String(v).trim(),
        method: '',
        mandatory: false,
        tolerance: '',
        frequency: '',
        sample: '',
        acceptance: '',
      });
    }
  }
  return out;
}

function emptyTestTail() {
  return {
    method: '',
    tolerance: '',
    frequency: '',
    sample: '',
    acceptance: '',
  };
}

function legacyFlatRowFromFieldId(id, rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return null;
  const meta = RM_QC_FIELD_META[id];
  return {
    specId: id,
    parameter: meta?.label ?? id,
    specLimit: trimmed,
    mandatory: meta?.mandatory ?? false,
    ...emptyTestTail(),
  };
}

/** Legacy flat qc* fields + rmQualitySpecs map (mirrors RM master hydrate logic). */
function legacyRmFlatQualityRowsFromFormData(fd) {
  if (!fd || typeof fd !== 'object') return [];
  const out = [];
  const seen = new Set();
  const nested = fd.rmQualitySpecs;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [id, val] of Object.entries(nested)) {
      const row = legacyFlatRowFromFieldId(id, val);
      if (row) {
        out.push(row);
        seen.add(id);
      }
    }
  }
  for (const [key, val] of Object.entries(fd)) {
    if (!/^qc[A-Z]/.test(key) || seen.has(key)) continue;
    const row = legacyFlatRowFromFieldId(key, val);
    if (row) out.push(row);
  }
  return out;
}

function scalarQualityRowsFromFormData(fd) {
  if (!fd || typeof fd !== 'object') return [];
  const out = [];
  const min = String(fd.acceptanceSpecMin ?? '').trim();
  const max = String(fd.acceptanceSpecMax ?? '').trim();
  if (min || max) {
    out.push({
      specId: 'acceptance-spec-range',
      parameter: 'Acceptance spec (MIN / MAX)',
      specLimit: [min && `Min: ${min}`, max && `Max: ${max}`].filter(Boolean).join(' · '),
      mandatory: true,
      ...emptyTestTail(),
    });
  }
  const coa = String(fd.coaRequired ?? '').trim();
  if (coa.toLowerCase() === 'yes') {
    out.push({
      specId: 'coa-required',
      parameter: 'COA required',
      specLimit: 'Vendor COA received and matches specification',
      mandatory: true,
      ...emptyTestTail(),
    });
  }
  return out;
}

/** Standard inbound checklist when master has no configured quality specs. */
function defaultInboundGrnQcTests(masterType) {
  const typeLabel = masterType === 'PM' ? 'PM' : 'RM';
  const rows = [
    {
      specId: 'default-inbound-visual',
      parameter: 'Visual / packaging inspection',
      specLimit: 'No damage; labels and batch/MFG/EXP legible',
      mandatory: true,
      ...emptyTestTail(),
    },
    {
      specId: 'default-inbound-qty',
      parameter: `${typeLabel} quantity vs PO / invoice`,
      specLimit: 'Received quantity matches PO and invoice',
      mandatory: true,
      ...emptyTestTail(),
    },
  ];
  if (masterType !== 'PM') {
    rows.push({
      specId: 'default-inbound-3rd-party-microbial',
      parameter: 'Microbial Count (TVC)',
      specLimit: 'Per RM acceptance spec / COA · typical < 100 cfu/g',
      mandatory: true,
      ...emptyTestTail(),
      method: 'External lab · Plate count, 3rd-party NABL',
      frequency: 'Per GRN lot',
      sample: '2 samples × 100 g',
      acceptance: '3rd-party lab COA required',
    });
  }
  return rows;
}

/**
 * @param {Record<string, unknown>} fd
 * @param {'RM'|'PM'} masterType
 */
function extractMasterTestsFromFormData(fd, masterType) {
  const form = fd && typeof fd === 'object' ? fd : {};
  const commonKey = masterType === 'PM' ? 'pmQualitySpecRows' : 'rmQualitySpecRows';
  const subKey = masterType === 'PM' ? 'pmQualitySubSpecRowsByPath' : 'rmQualitySubSpecRowsByPath';
  const common = parseQualitySpecRows(form[commonKey]);
  const sub = flattenSubSpecRowsByPath(form[subKey]);
  const shared = extractSharedQualitySpecRowsFromFormData(form, masterType);
  const legacyBulk = legacyBulkRowsFromFormData(form);
  const legacyFlat = masterType === 'RM' ? legacyRmFlatQualityRowsFromFormData(form) : [];
  const scalar = masterType === 'RM' ? scalarQualityRowsFromFormData(form) : [];
  const merged = [...common, ...sub, ...shared, ...legacyFlat, ...scalar, ...legacyBulk];
  const deduped = [];
  const seenParams = new Set();
  for (const row of merged) {
    const key = `${row.specId}::${row.parameter}`;
    if (seenParams.has(key)) continue;
    seenParams.add(key);
    deduped.push(row);
  }
  return deduped;
}

function testRowKey(lineItemId, specId, parameter) {
  return `${String(lineItemId)}::${String(specId || parameter)}`;
}

function savedResultsMap(savedQcSpecs) {
  const map = new Map();
  if (!savedQcSpecs || typeof savedQcSpecs !== 'object') return map;
  const lines = Array.isArray(savedQcSpecs.lines) ? savedQcSpecs.lines : [];
  for (const line of lines) {
    const lineId = String(line.lineItemId ?? line.line_item_id ?? '');
    const tests = Array.isArray(line.tests) ? line.tests : [];
    for (const t of tests) {
      const key = testRowKey(lineId, t.specId ?? t.spec_id, t.parameter);
      map.set(key, {
        result: String(t.result ?? '').trim(),
        passed: t.passed === true ? true : t.passed === false ? false : null,
        acceptance: String(t.acceptance ?? '').trim(),
        thirdPartyOrder:
          t.thirdPartyOrder && typeof t.thirdPartyOrder === 'object' ? { ...t.thirdPartyOrder } : null,
      });
    }
  }
  return map;
}

function attachResultsToTests(lineItemId, masterTests, savedMap) {
  return masterTests.map((t) => {
    const key = testRowKey(lineItemId, t.specId, t.parameter);
    const saved = savedMap.get(key);
    return {
      ...t,
      result: saved ? saved.result : '',
      passed: saved ? saved.passed : null,
      acceptance: saved && saved.acceptance != null ? saved.acceptance : String(t.acceptance ?? '').trim(),
      thirdPartyOrder: saved && saved.thirdPartyOrder ? saved.thirdPartyOrder : t.thirdPartyOrder ?? undefined,
    };
  });
}

/**
 * Build QC line payloads for a GRN from masters + optional saved results.
 *
 * @param {Array} lineItems
 * @param {'RM'|'PM'|string|null} grnType
 * @param {object|null} savedQcSpecs
 * @param {{ rmById: Map<number, object>, pmById: Map<number, object>, rmByCode: Map<string, object>, pmByCode: Map<string, object> }} masters
 */
function buildGrnQcSpecPayload(lineItems, grnType, savedQcSpecs, masters) {
  const typeU = String(grnType || 'RM').trim().toUpperCase();
  const savedMap = savedResultsMap(savedQcSpecs);
  const lines = [];
  const seenLineIds = new Set();

  for (let idx = 0; idx < (lineItems || []).length; idx += 1) {
    const line = lineItems[idx];
    const lineItemId = resolveLineItemId(line, idx);
    if (!lineItemId || seenLineIds.has(lineItemId)) continue;
    seenLineIds.add(lineItemId);

    let masterRow = null;
    let masterType = typeU === 'PM' ? 'PM' : 'RM';
    const rmId = line.raw_material_id != null ? Number(line.raw_material_id) : null;
    const pmId = line.pack_material_id != null ? Number(line.pack_material_id) : null;
    const code = resolveLineItemCode(line);

    if (typeU === 'PM' && pmId != null && masters.pmById.has(pmId)) {
      masterRow = masters.pmById.get(pmId);
      masterType = 'PM';
    } else if (typeU === 'RM' && rmId != null && masters.rmById.has(rmId)) {
      masterRow = masters.rmById.get(rmId);
      masterType = 'RM';
    } else if (pmId != null && masters.pmById.has(pmId)) {
      masterRow = masters.pmById.get(pmId);
      masterType = 'PM';
    } else if (rmId != null && masters.rmById.has(rmId)) {
      masterRow = masters.rmById.get(rmId);
      masterType = 'RM';
    } else if (code) {
      const codeU = code.toUpperCase();
      if (typeU === 'PM' && (masters.pmByCode.has(code) || masters.pmByCode.has(codeU))) {
        masterRow = masters.pmByCode.get(code) ?? masters.pmByCode.get(codeU);
        masterType = 'PM';
      } else if (masters.rmByCode.has(code) || masters.rmByCode.has(codeU)) {
        masterRow = masters.rmByCode.get(code) ?? masters.rmByCode.get(codeU);
        masterType = 'RM';
      } else if (masters.pmByCode.has(code) || masters.pmByCode.has(codeU)) {
        masterRow = masters.pmByCode.get(code) ?? masters.pmByCode.get(codeU);
        masterType = 'PM';
      }
    }

    const fd = masterRow && masterRow.form_data && typeof masterRow.form_data === 'object'
      ? masterRow.form_data
      : {};
    let masterTests = extractMasterTestsFromFormData(fd, masterType);
    let testsSource = 'master';
    // Default inbound checklist only when the line is not linked to a master.
    // Linked masters with empty GRN Quality Checks should stay empty (no synthetic tests).
    if (masterTests.length === 0 && !masterRow) {
      masterTests = defaultInboundGrnQcTests(masterType);
      testsSource = 'default-inbound';
    }
    const tests = attachResultsToTests(lineItemId, masterTests, savedMap);

    lines.push({
      lineItemId,
      itemCode: code || (masterRow && masterRow.code) || '',
      itemName: String(line.item ?? line.itemName ?? masterRow?.name ?? masterRow?.description ?? '').trim(),
      masterType,
      masterId: masterRow ? Number(masterRow.id) : null,
      testsSource,
      tests,
    });
  }

  return { lines, remarks: String(savedQcSpecs?.remarks ?? '').trim(), attachments: normalizeQcAttachments(savedQcSpecs?.attachments) };
}

function normalizeQcAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((att, idx) => {
      if (!att || typeof att !== 'object') return null;
      const fileName = String(att.fileName ?? att.file_name ?? '').trim();
      if (!fileName) return null;
      return {
        id: String(att.id ?? `qca-${idx}`),
        fileName,
        type: String(att.type ?? 'Other').trim() || 'Other',
        uploadedAt: String(att.uploadedAt ?? att.uploaded_at ?? new Date().toISOString()),
        uploadedBy: String(att.uploadedBy ?? att.uploaded_by ?? '').trim() || undefined,
      };
    })
    .filter(Boolean);
}

function collectAllTests(qcSpecsPayload) {
  const lines = qcSpecsPayload && Array.isArray(qcSpecsPayload.lines) ? qcSpecsPayload.lines : [];
  return lines.flatMap((l) => (Array.isArray(l.tests) ? l.tests : []));
}

function hasMeasuredResult(test) {
  return String(test.result ?? '').trim().length > 0;
}

function isTestReviewed(test) {
  return test.passed === true || test.passed === false;
}

/** Mandatory (Mand) rows must have result + Pass verdict. Optional rows may stay untested. */
function isMandatoryTestComplete(test) {
  if (!test.mandatory) return true;
  return test.passed === true && hasMeasuredResult(test);
}

function isMandatoryTestPending(test) {
  if (!test.mandatory) return false;
  return test.passed !== true || !hasMeasuredResult(test);
}

/**
 * Derive GRN-level qc_status from per-test results.
 * - Rejected: any reviewed test failed (mandatory or optional)
 * - Passed: every mandatory test has result + Pass; optional untested rows are OK
 * - Under test: mandatory tests still incomplete
 */
function deriveGrnQcStatusFromSpecs(qcSpecsPayload) {
  const tests = collectAllTests(qcSpecsPayload);
  if (tests.length === 0) return 'Under test';

  const failed = tests.filter((t) => t.passed === false);
  if (failed.length > 0) return 'Rejected';

  const mandatoryPending = tests.filter((t) => isMandatoryTestPending(t));
  if (mandatoryPending.length > 0) return 'Under test';

  const reviewedWithoutResult = tests.filter((t) => isTestReviewed(t) && !hasMeasuredResult(t));
  if (reviewedWithoutResult.length > 0) return 'Under test';

  return 'Passed';
}

function validateQcSpecsForPassed(qcSpecsPayload) {
  const tests = collectAllTests(qcSpecsPayload);
  if (tests.length === 0) {
    return {
      ok: false,
      message: 'No QC tests available for this GRN. Link line items to an RM/PM master or refresh the GRN.',
    };
  }
  const mandatoryPending = tests.filter((t) => isMandatoryTestPending(t));
  if (mandatoryPending.length > 0) {
    return {
      ok: false,
      message: `${mandatoryPending.length} mandatory QC test(s) still need a measured result and Pass verdict.`,
    };
  }
  const reviewedWithoutResult = tests.filter((t) => isTestReviewed(t) && !hasMeasuredResult(t));
  if (reviewedWithoutResult.length > 0) {
    return { ok: false, message: 'Enter a measured result for each QC test you marked Pass or Fail.' };
  }
  const failed = tests.filter((t) => t.passed === false);
  if (failed.length > 0) {
    return { ok: false, message: `${failed.length} QC test(s) failed — GRN cannot pass QC.` };
  }
  return { ok: true };
}

function normalizeIncomingQcSpecs(body) {
  const raw = body.qcSpecs ?? body.qc_specs;
  if (!raw || typeof raw !== 'object') return null;
  const linesIn = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = linesIn.map((line) => {
    const testsIn = Array.isArray(line.tests) ? line.tests : [];
    return {
      lineItemId: String(line.lineItemId ?? line.line_item_id ?? ''),
      itemCode: String(line.itemCode ?? line.item_code ?? '').trim(),
      itemName: String(line.itemName ?? line.item_name ?? '').trim(),
      masterType: line.masterType === 'PM' ? 'PM' : 'RM',
      masterId: line.masterId != null ? Number(line.masterId) : null,
      tests: testsIn.map((t, idx) => ({
        specId: String(t.specId ?? t.spec_id ?? `qs-${idx}`),
        parameter: String(t.parameter ?? '').trim(),
        specLimit: String(t.specLimit ?? t.spec_limit ?? '').trim(),
        method: String(t.method ?? '').trim(),
        mandatory: parseBoolMandatory(t.mandatory ?? t.mand),
        tolerance: String(t.tolerance ?? '').trim(),
        frequency: String(t.frequency ?? '').trim(),
        sample: String(t.sample ?? '').trim(),
        acceptance: String(t.acceptance ?? '').trim(),
        outputType: String(t.outputType ?? t.output_type ?? '').trim() || undefined,
        selectOptions: Array.isArray(t.selectOptions)
          ? t.selectOptions.map((o) => String(o ?? '').trim()).filter(Boolean)
          : Array.isArray(t.select_options)
            ? t.select_options.map((o) => String(o ?? '').trim()).filter(Boolean)
            : undefined,
        result: String(t.result ?? '').trim(),
        passed: t.passed === true ? true : t.passed === false ? false : null,
        thirdPartyOrder:
          t.thirdPartyOrder && typeof t.thirdPartyOrder === 'object'
            ? t.thirdPartyOrder
            : t.third_party_order && typeof t.third_party_order === 'object'
              ? t.third_party_order
              : undefined,
      })).filter((t) => t.parameter),
    };
  }).filter((l) => l.lineItemId);
  return {
    lines,
    remarks: String(raw.remarks ?? '').trim(),
    attachments: normalizeQcAttachments(raw.attachments),
  };
}

module.exports = {
  extractMasterTestsFromFormData,
  buildGrnQcSpecPayload,
  deriveGrnQcStatusFromSpecs,
  validateQcSpecsForPassed,
  normalizeIncomingQcSpecs,
  collectAllTests,
  defaultInboundGrnQcTests,
  legacyRmFlatQualityRowsFromFormData,
  resolveLineItemId,
};
