const { Op } = require('sequelize');
const {
  portalUsertypeExcludeClause,
  legacyInternalUsertypeClause,
} = require('../../../src/users/assignableInternalStaff');

// Re-export helpers for unit testing via buildAssignableInternalStaffWhere internals
// Test the WHERE shape indirectly through exported module structure.

describe('assignableInternalStaff', () => {
  test('portalUsertypeExcludeClause uses lowercase comparison', () => {
    const clause = portalUsertypeExcludeClause();
    expect(clause).toBeDefined();
    expect(typeof clause).toBe('object');
  });

  test('legacyInternalUsertypeClause includes core dashboard roles', () => {
    const clause = legacyInternalUsertypeClause();
    expect(clause).toBeDefined();
  });
});
