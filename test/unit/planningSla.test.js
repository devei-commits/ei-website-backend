const indiaTime = require('../../src/lib/indiaTime');
const { parseIndiaDateOnlyStart, indiaDateOnlyString } = indiaTime;
const { computePlanningSlaMeta } = require('../../src/lib/planningSla');

describe('planning SLA (India timezone)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parseIndiaDateOnlyStart uses IST midnight', () => {
    const d = parseIndiaDateOnlyStart('2026-05-27');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-05-26T18:30:00.000Z');
  });

  it('SLA starts from created_at not order_date when row is new', () => {
    jest.spyOn(indiaTime, 'backendNow').mockReturnValue(new Date('2026-05-27T14:42:00+05:30'));

    const meta = computePlanningSlaMeta({
      createdAt: '2026-05-27T14:30:00+05:30',
      orderDate: '2026-05-27',
      bomConfirmedAt: null,
      remainingUnits: 1000,
    });

    expect(meta.elapsedHours).toBeCloseTo(0.2, 1);
    expect(meta.label).toBe('0h 12m / 48h');
    expect(meta.sub).toContain('Running');
  });

  it('SLA completed uses short elapsed when created recently and fully planned', () => {
    jest.spyOn(indiaTime, 'backendNow').mockReturnValue(new Date('2026-05-27T14:45:00+05:30'));

    const meta = computePlanningSlaMeta({
      createdAt: '2026-05-27T14:30:00+05:30',
      orderDate: '2026-05-27',
      bomConfirmedAt: null,
      remainingUnits: 0,
    });

    expect(meta.label).toContain('Completed');
    expect(meta.elapsedHours).toBeCloseTo(0.25, 2);
    expect(meta.sub).toBe('Completed on time');
  });

  it('indiaDateOnlyString returns YYYY-MM-DD', () => {
    const d = new Date('2026-05-27T20:00:00+05:30');
    expect(indiaDateOnlyString(d)).toBe('2026-05-27');
  });
});
