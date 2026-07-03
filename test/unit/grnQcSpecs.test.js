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
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.mandatory)).toBe(true);
    const microbial = rows.find((r) => String(r.specId).includes('3rd-party'));
    expect(microbial).toBeTruthy();
    expect(String(microbial.method)).toMatch(/external|3rd/i);
  });

  test('buildGrnQcSpecPayload keeps empty tests when linked master has no specs', () => {
    const { buildGrnQcSpecPayload } = require('../../src/grn/grnQcSpecs');
    const payload = buildGrnQcSpecPayload(
      [{ id: 'li-1', itemCode: '5L00055', item: 'FRAGILE STICKER', pack_material_id: 9 }],
      'PM',
      null,
      {
        rmById: new Map(),
        pmById: new Map([[9, { id: 9, code: '5L00055', name: 'FRAGILE STICKER', form_data: {} }]]),
        rmByCode: new Map(),
        pmByCode: new Map([['5L00055', { id: 9, code: '5L00055', name: 'FRAGILE STICKER', form_data: {} }]]),
      }
    );
    expect(payload.lines[0].testsSource).toBe('master');
    expect(payload.lines[0].tests).toHaveLength(0);
    expect(payload.lines[0].masterId).toBe(9);
  });

  test('buildGrnQcSpecPayload uses default inbound when line is not linked to a master', () => {
    const { buildGrnQcSpecPayload } = require('../../src/grn/grnQcSpecs');
    const payload = buildGrnQcSpecPayload(
      [{ id: 'li-1', itemCode: 'UNKNOWN99', item: 'Unlinked item' }],
      'PM',
      null,
      {
        rmById: new Map(),
        pmById: new Map(),
        rmByCode: new Map(),
        pmByCode: new Map(),
      }
    );
    expect(payload.lines[0].testsSource).toBe('default-inbound');
    expect(payload.lines[0].tests.length).toBeGreaterThanOrEqual(2);
    expect(payload.lines[0].masterId).toBeNull();
  });

  test('buildGrnQcSpecPayload assigns stable line id when line.id is missing', () => {
    const { buildGrnQcSpecPayload } = require('../../src/grn/grnQcSpecs');
    const payload = buildGrnQcSpecPayload(
      [{ itemCode: '1000020', item: 'ALPHA CB', raw_material_id: 42 }],
      'RM',
      null,
      {
        rmById: new Map([[42, {
          id: 42,
          code: 'EI-RM-XXX',
          zoho_sku_code: '1000020',
          form_data: {
            rmQualitySubSpecRowsByPath: {
              'actives|alpha': [{ id: 'sub1', parameter: 'new field', specLimit: 'ok', mandatory: true }],
            },
          },
        }]]),
        pmById: new Map(),
        rmByCode: new Map(),
        pmByCode: new Map(),
      }
    );
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].lineItemId).toBe('grn-line-code-1000020');
    expect(payload.lines[0].tests.some((t) => t.parameter === 'new field')).toBe(true);
  });

  test('extractMasterTestsFromFormData reads masterSharedQualitySpecs', () => {
    const rows = extractMasterTestsFromFormData(
      {
        masterSharedQualitySpecs: {
          RM: {
            common: {
              actives: [{ id: 'c1', parameter: 'Shared common', specLimit: 'pass', mandatory: true }],
            },
            sub: {
              'actives|alpha': [{ id: 's1', parameter: 'Shared sub', specLimit: 'NLT 98%', mandatory: false }],
            },
          },
        },
      },
      'RM'
    );
    expect(rows.some((r) => r.parameter === 'Shared common')).toBe(true);
    expect(rows.some((r) => r.parameter === 'Shared sub')).toBe(true);
  });
});
