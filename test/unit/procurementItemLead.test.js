const {
  parseLeadFromLineNotes,
  mergeLeadIntoLineNotes,
} = require('../../src/procurementRequests/procurementItemLead');

describe('procurementItemLead', () => {
  test('parseLeadFromLineNotes reads Planning-style segment', () => {
    expect(parseLeadFromLineNotes('Planned rate ₹10 | Terms: x | Lead: 14d')).toBe(14);
    expect(parseLeadFromLineNotes('lead: 0d')).toBe(0);
    expect(parseLeadFromLineNotes('no lead here')).toBeNull();
  });

  test('mergeLeadIntoLineNotes replaces or appends', () => {
    expect(mergeLeadIntoLineNotes('a | Lead: 5d', 12)).toBe('a | Lead: 12d');
    expect(mergeLeadIntoLineNotes('notes only', 7)).toBe('notes only | Lead: 7d');
    expect(mergeLeadIntoLineNotes('', 3)).toBe('Lead: 3d');
  });
});
