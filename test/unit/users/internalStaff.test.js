const { Op } = require('sequelize');
const {
  PORTAL_USERTYPES,
  isPortalUsertype,
  isInternalStaffUsertype,
  buildInternalStaffWhere,
  buildInternalStaffRolesWhere,
} = require('../../../src/users/internalStaff');

describe('internalStaff', () => {
  test('portal usertypes are customer and doctor', () => {
    expect(PORTAL_USERTYPES).toEqual(['customer', 'doctor']);
    expect(isPortalUsertype('customer')).toBe(true);
    expect(isPortalUsertype('Doctor')).toBe(true);
    expect(isPortalUsertype('admin')).toBe(false);
  });

  test('isInternalStaffUsertype accepts team roles only', () => {
    expect(isInternalStaffUsertype('super_admin')).toBe(true);
    expect(isInternalStaffUsertype('bd_manager')).toBe(true);
    expect(isInternalStaffUsertype('accounts_team')).toBe(true);
    expect(isInternalStaffUsertype('customer')).toBe(false);
    expect(isInternalStaffUsertype('doctor')).toBe(false);
    expect(isInternalStaffUsertype('')).toBe(false);
  });

  test('buildInternalStaffWhere excludes portal accounts', () => {
    const w = buildInternalStaffWhere();
    expect(w[Op.and][0]).toEqual({ usertype: { [Op.notIn]: PORTAL_USERTYPES } });
  });

  test('buildInternalStaffRolesWhere excludes portal role codes and client level', () => {
    const w = buildInternalStaffRolesWhere();
    expect(w[Op.and]).toEqual([
      { role_code: { [Op.notIn]: PORTAL_USERTYPES } },
      { level: { [Op.ne]: 'client' } },
    ]);
  });
});
