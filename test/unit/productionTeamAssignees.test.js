const {
  isProductionTeamEligibleRole,
  inferProductionDepartment,
  teamMemberFromUser,
} = require('../../src/production/productionTeamAssignees');

describe('productionTeamAssignees', () => {
  test('isProductionTeamEligibleRole accepts super admin, admin, and production roles', () => {
    expect(isProductionTeamEligibleRole('super_admin', 'Super Admin')).toBe(true);
    expect(isProductionTeamEligibleRole('admin', 'Admin')).toBe(true);
    expect(isProductionTeamEligibleRole('production', 'Production')).toBe(true);
    expect(isProductionTeamEligibleRole('manufacturing_and_production', 'Manufacturing and Production')).toBe(true);
    expect(isProductionTeamEligibleRole('bd_manager', 'BD Manager')).toBe(false);
  });

  test('inferProductionDepartment maps user department and defaults production staff to Manufacturing', () => {
    expect(inferProductionDepartment('filling', 'production', 'Production')).toBe('Filling');
    expect(inferProductionDepartment(null, 'production', 'Production')).toBe('Manufacturing');
    expect(inferProductionDepartment(null, 'admin', 'Admin')).toBe('Manufacturing');
  });

  test('teamMemberFromUser uses stable U-prefixed ids', () => {
    const row = teamMemberFromUser(
      { userid: 12, display_name: 'Priya Shah', email: 'priya@test.com' },
      'Production',
      'Manufacturing',
    );
    expect(row).toMatchObject({
      id: 'U12',
      userId: 12,
      name: 'Priya Shah',
      role: 'Production',
      dept: 'Manufacturing',
      avail: true,
      _pk: null,
    });
  });
});
