const {
  hydratePrQualitySpecRowsBySectionFromBom,
  hydratePrQualityBulkSubSpecRowsByPathFromBom,
  hydratePrQualityFinalSubSpecRowsByPathFromBom,
  hydratePrQualityDispatchSubSpecRowsByPathFromBom,
  prQualitySpecBomColumnPatch,
  flattenPrQualitySpecRowsForDisplay,
} = require('../../src/products/prQualitySpecStorage');

describe('prQualitySpecStorage', () => {
  test('round-trips section rows and bulk sub-by-path through BOM columns', () => {
    const bySection = {
      bulkClearance: [{ parameter: 'pH', specLimit: 'Per Master' }],
      finalClearance: [],
      dispatchSpecs: [{ parameter: 'COA / Release Document', specLimit: 'On file' }],
    };
    const bulkSubByPath = {
      'Skin Care::Cream': [{ parameter: 'Spreadability', specLimit: 'Per Master' }],
    };
    const patch = prQualitySpecBomColumnPatch(bySection, bulkSubByPath);
    expect(patch.spec_tests).toContain('pH');
    expect(patch.spec_process).toContain('Skin Care::Cream');
    expect(patch.spec_release).toContain('COA');

    const hydratedSection = hydratePrQualitySpecRowsBySectionFromBom({
      spec_tests: patch.spec_tests,
      spec_fg: patch.spec_fg,
      spec_release: patch.spec_release,
    });
    const hydratedSub = hydratePrQualityBulkSubSpecRowsByPathFromBom({
      spec_process: patch.spec_process,
    });
    expect(hydratedSection.bulkClearance[0].parameter).toBe('pH');
    expect(hydratedSub['Skin Care::Cream'][0].parameter).toBe('Spreadability');
  });

  test('round-trips final clearance common + sub-by-path through spec_fg', () => {
    const bySection = {
      bulkClearance: [],
      finalClearance: [{ parameter: 'Fill Volume / Weight', specLimit: 'Per label ±2%' }],
      dispatchSpecs: [],
    };
    const finalSubByPath = {
      'Skin Care::Cream': [{ parameter: 'Cap Torque (Jar Lid)', specLimit: 'Per Master kgf-cm' }],
    };
    const patch = prQualitySpecBomColumnPatch(bySection, undefined, finalSubByPath);
    expect(patch.spec_fg).toContain('Fill Volume / Weight');
    expect(patch.spec_fg).toContain('Cap Torque (Jar Lid)');
    expect(patch.spec_fg).toContain('subByPath');

    const hydratedSection = hydratePrQualitySpecRowsBySectionFromBom({ spec_fg: patch.spec_fg });
    const hydratedFinalSub = hydratePrQualityFinalSubSpecRowsByPathFromBom({ spec_fg: patch.spec_fg });
    expect(hydratedSection.finalClearance[0].parameter).toBe('Fill Volume / Weight');
    expect(hydratedFinalSub['Skin Care::Cream'][0].parameter).toBe('Cap Torque (Jar Lid)');
  });

  test('round-trips dispatch common + sub-by-path through spec_release', () => {
    const bySection = {
      bulkClearance: [],
      finalClearance: [],
      dispatchSpecs: [{ parameter: 'SO + Picking Match', specLimit: 'Exact' }],
    };
    const dispatchSubByPath = {
      'Skin Care::Cream': [{ parameter: 'Storage Temp Indicator', specLimit: '≤ 30°C in transit (typical)' }],
    };
    const patch = prQualitySpecBomColumnPatch(bySection, undefined, undefined, dispatchSubByPath);
    expect(patch.spec_release).toContain('SO + Picking Match');
    expect(patch.spec_release).toContain('Storage Temp Indicator');
    expect(patch.spec_release).toContain('subByPath');

    const hydratedSection = hydratePrQualitySpecRowsBySectionFromBom({ spec_release: patch.spec_release });
    const hydratedDispatchSub = hydratePrQualityDispatchSubSpecRowsByPathFromBom({
      spec_release: patch.spec_release,
    });
    expect(hydratedSection.dispatchSpecs[0].parameter).toBe('SO + Picking Match');
    expect(hydratedDispatchSub['Skin Care::Cream'][0].parameter).toBe('Storage Temp Indicator');
  });

  test('reads legacy flat spec_fg array as final clearance common only', () => {
    const legacy = JSON.stringify([{ parameter: 'Fill Weight', specLimit: '50 g' }]);
    const hydratedSection = hydratePrQualitySpecRowsBySectionFromBom({ spec_fg: legacy });
    const hydratedFinalSub = hydratePrQualityFinalSubSpecRowsByPathFromBom({ spec_fg: legacy });
    expect(hydratedSection.finalClearance[0].parameter).toBe('Fill Weight');
    expect(hydratedFinalSub).toEqual({});
  });

  test('flattens tabular rows for production QC display', () => {
    const display = flattenPrQualitySpecRowsForDisplay(
      { finalClearance: [{ parameter: 'Fill Weight', specLimit: '50 g' }] },
      { 'Skin Care::Cream': [{ parameter: 'Active Assay', specLimit: '90–110% label' }] },
      { 'Skin Care::Cream': [{ parameter: 'Cap Torque (Jar Lid)', specLimit: 'Per Master kgf-cm' }] },
      { 'Skin Care::Cream': [{ parameter: 'Storage Temp Indicator', specLimit: '≤ 30°C in transit (typical)' }] }
    );
    expect(display['Final: Fill Weight']).toBe('50 g');
    expect(display['Bulk (Skin Care::Cream): Active Assay']).toBe('90–110% label');
    expect(display['Final (Skin Care::Cream): Cap Torque (Jar Lid)']).toBe('Per Master kgf-cm');
    expect(display['Dispatch (Skin Care::Cream): Storage Temp Indicator']).toBe(
      '≤ 30°C in transit (typical)'
    );
  });
});
