const {
  deriveScheduleDatesFromMfg,
  mfgDateForBatchSequence,
  buildSchedulePatchFromPlanning,
  validateEquipmentSchedulePatch,
  hasBatchEquipmentReserved,
} = require('../../src/production/scheduleFromPlanning');

describe('scheduleFromPlanning', () => {
  test('deriveScheduleDatesFromMfg uses production stage offsets', () => {
    expect(deriveScheduleDatesFromMfg('2026-06-10')).toEqual({
      fillDate: '2026-06-13',
      packDate: '2026-06-14',
      fgDate: '2026-06-15',
      rmConnectDate: '2026-06-08',
      pmConnectDate: '2026-06-11',
    });
  });

  test('mfgDateForBatchSequence staggers multi-batch plans by 7 days', () => {
    expect(mfgDateForBatchSequence('2026-06-10', 1)).toBe('2026-06-10');
    expect(mfgDateForBatchSequence('2026-06-10', 2)).toBe('2026-06-17');
    expect(mfgDateForBatchSequence('2026-06-10', 3)).toBe('2026-06-24');
  });

  test('buildSchedulePatchFromPlanning skips batches that already have mfg_date', () => {
    const patch = buildSchedulePatchFromPlanning(
      { planned_start_date: '2026-06-10' },
      1,
      { mfg_date: '2026-07-01', bmr_no: 'BMR-1' },
      [],
      { manufacturing: [{ id: 'MV-1', type: 'vessel' }], filling: [{ id: 'FL-1' }], packaging: [{ id: 'PL-1' }] },
    );
    expect(patch).toBeNull();
  });

  test('buildSchedulePatchFromPlanning seeds all stage dates and picks free equipment', () => {
    const patch = buildSchedulePatchFromPlanning(
      { planned_start_date: '2026-06-10' },
      2,
      { bmr_no: 'BMR-2' },
      [{ main_vessel: 'MV-1', mfg_date: '2026-06-17', filling_line: '', fill_date: '', packaging_line: '', pack_date: '' }],
      {
        manufacturing: [{ id: 'MV-1', type: 'vessel' }, { id: 'MV-2', type: 'vessel' }],
        filling: [{ id: 'FL-1' }],
        packaging: [{ id: 'PL-1' }],
      },
    );
    expect(patch).toMatchObject({
      mfg_date: '2026-06-17',
      fill_date: '2026-06-20',
      pack_date: '2026-06-21',
      fg_date: '2026-06-22',
      main_vessel: 'MV-2',
      filling_line: 'FL-1',
      packaging_line: 'PL-1',
    });
  });

  test('validateEquipmentSchedulePatch requires equipment when mfg_date is set', () => {
    const errors = validateEquipmentSchedulePatch(
      { mfg_date: '2026-06-10', main_vessel: '', filling_line: '', packaging_line: '' },
      [],
      'BMR-1',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/must be assigned/i);
  });

  test('validateEquipmentSchedulePatch rejects double-booked vessel', () => {
    const errors = validateEquipmentSchedulePatch(
      {
        bmr_no: 'BMR-2',
        mfg_date: '2026-06-10',
        fill_date: '2026-06-13',
        pack_date: '2026-06-14',
        main_vessel: 'MV-1',
        filling_line: 'FL-1',
        packaging_line: 'PL-1',
      },
      [{ bmr_no: 'BMR-1', main_vessel: 'MV-1', mfg_date: '2026-06-10' }],
      'BMR-2',
    );
    expect(errors.some((e) => e.includes('MV-1'))).toBe(true);
  });

  test('validateEquipmentSchedulePatch allows same batch to keep its equipment', () => {
    const errors = validateEquipmentSchedulePatch(
      {
        bmr_no: 'BMR-1',
        mfg_date: '2026-06-10',
        fill_date: '2026-06-13',
        pack_date: '2026-06-14',
        main_vessel: 'MV-1',
        filling_line: 'FL-1',
        packaging_line: 'PL-1',
      },
      [{ bmr_no: 'BMR-1', main_vessel: 'MV-1', mfg_date: '2026-06-10' }],
      'BMR-1',
    );
    expect(errors).toEqual([]);
  });

  test('hasBatchEquipmentReserved checks all three lines', () => {
    expect(hasBatchEquipmentReserved({ main_vessel: 'MV-1', filling_line: 'FL-1', packaging_line: 'PL-1' })).toBe(true);
    expect(hasBatchEquipmentReserved({ main_vessel: 'MV-1', filling_line: '', packaging_line: 'PL-1' })).toBe(false);
  });
});
