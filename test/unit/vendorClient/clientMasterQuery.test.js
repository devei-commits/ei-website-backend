const { Op, fn, col, where } = require('sequelize');
const {
  VENDOR_ENTITY_CODE_PATTERN,
  buildActiveClientWhere,
  buildActiveClientWhereByName,
} = require('../../../src/vendorClient/clientMasterQuery');

describe('clientMasterQuery', () => {
  test('buildActiveClientWhere excludes vendors and requires active client type', () => {
    const w = buildActiveClientWhere();
    expect(w[Op.and]).toHaveLength(3);
    expect(w[Op.and][0]).toEqual(where(fn('LOWER', col('type')), 'client'));
    expect(w[Op.and][1]).toEqual({ status: 'active' });
    expect(w[Op.and][2]).toEqual({
      entity_code: { [Op.notILike]: VENDOR_ENTITY_CODE_PATTERN },
    });
  });

  test('buildActiveClientWhereByName adds case-insensitive name match', () => {
    const w = buildActiveClientWhereByName('  Luminos  ');
    expect(w[Op.and]).toHaveLength(4);
    expect(w[Op.and][3]).toEqual({ name: { [Op.iLike]: 'Luminos' } });
  });
});
