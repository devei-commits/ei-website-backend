const {
  deriveGrnQcStatusFromSpecs,
  validateQcSpecsForPassed,
  extractMasterTestsFromFormData,
} = require('../../src/grn/grnQcSpecs');

describe('grnQcSpecs', () => {
  test('extractMasterTestsFromFormData reads tabular RM rows', () => {
    const rows = extractMasterTestsFromFormData(
      {
        rmQualitySpecRows: [
          { id: 'a1', parameter: 'pH', specLimit: '5–7', mandatory: true },
          { id: 'a2', parameter: 'Assay', specLimit: 'NLT 98%', mandatory: false },
        ],
      },
      'RM'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].parameter).toBe('pH');
    expect(rows[0].mandatory).toBe(true);
  });

  test('deriveGrnQcStatusFromSpecs returns Under test when mandatory pending', () => {
    const status = deriveGrnQcStatusFromSpecs({
      lines: [{
        lineItemId: '1',
        tests: [{ parameter: 'pH', mandatory: true, result: '6.2', passed: null }],
      }],
    });
    expect(status).toBe('Under test');
  });

  test('deriveGrnQcStatusFromSpecs returns Passed when mandatory pass and optional skipped', () => {
    const status = deriveGrnQcStatusFromSpecs({
      lines: [{
        lineItemId: '1',
        tests: [
          { parameter: 'pH', mandatory: true, result: '6.2', passed: true },
          { parameter: 'Assay', mandatory: false, result: '', passed: null },
        ],
      }],
    });
    expect(status).toBe('Passed');
  });

  test('deriveGrnQcStatusFromSpecs returns Passed when all mandatory pass', () => {
    const status = deriveGrnQcStatusFromSpecs({
      lines: [{
        lineItemId: '1',
        tests: [
          { parameter: 'pH', mandatory: true, result: '6.2', passed: true },
          { parameter: 'Assay', mandatory: false, result: '99%', passed: true },
        ],
      }],
    });
    expect(status).toBe('Passed');
  });

  test('deriveGrnQcStatusFromSpecs returns Rejected on mandatory fail', () => {
    const status = deriveGrnQcStatusFromSpecs({
      lines: [{
        lineItemId: '1',
        tests: [{ parameter: 'pH', mandatory: true, result: '4.1', passed: false }],
      }],
    });
    expect(status).toBe('Rejected');
  });

  test('deriveGrnQcStatusFromSpecs returns Rejected when optional test fails', () => {
    const status = deriveGrnQcStatusFromSpecs({
      lines: [{
        lineItemId: '1',
        tests: [
          { parameter: 'pH', mandatory: true, result: '6.2', passed: true },
          { parameter: 'Assay', mandatory: false, result: '90%', passed: false },
        ],
      }],
    });
    expect(status).toBe('Rejected');
  });

  test('validateQcSpecsForPassed blocks incomplete mandatory tests', () => {
    const res = validateQcSpecsForPassed({
      lines: [{
        lineItemId: '1',
        tests: [{ parameter: 'pH', mandatory: true, result: '', passed: null }],
      }],
    });
    expect(res.ok).toBe(false);
  });

  test('extractMasterTestsFromFormData reads legacy flat qc fields', () => {
    const rows = extractMasterTestsFromFormData(
      {
        qcExcChelatorEdtaEddsContent: 'NLT 99%',
        coaRequired: 'Yes',
        acceptanceSpecMin: '98',
        acceptanceSpecMax: '102',
      },
      'RM'
    );
    expect(rows.some((r) => r.parameter.includes('EDTA'))).toBe(true);
    expect(rows.some((r) => r.parameter.includes('COA'))).toBe(true);
    expect(rows.some((r) => r.parameter.includes('Acceptance'))).toBe(true);
  });

  test('defaultInboundGrnQcTests provides mandatory inbound checklist', () => {
    const { defaultInboundGrnQcTests } = require('../../src/grn/grnQcSpecs');
    const rows = defaultInboundGrnQcTests('RM');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.mandatory)).toBe(true);
  });

  test('buildGrnQcSpecPayload uses default inbound when master has no specs', () => {
    const { buildGrnQcSpecPayload } = require('../../src/grn/grnQcSpecs');
    const payload = buildGrnQcSpecPayload(
      [{ id: 'li-1', itemCode: 'CLUB00053', item: 'DISODIUM EDTA - CLUB', raw_material_id: 1 }],
      'RM',
      null,
      {
        rmById: new Map([[1, { id: 1, code: 'CLUB00053', name: 'DISODIUM EDTA - CLUB', form_data: {} }]]),
        pmById: new Map(),
        rmByCode: new Map([['CLUB00053', { id: 1, code: 'CLUB00053', name: 'DISODIUM EDTA - CLUB', form_data: {} }]]),
        pmByCode: new Map(),
      }
    );
    expect(payload.lines[0].testsSource).toBe('default-inbound');
    expect(payload.lines[0].tests.length).toBeGreaterThanOrEqual(2);
  });
});
