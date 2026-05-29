const {
  LIFECYCLE_DELETED,
  LIFECYCLE_ACTIVE,
  softDeletePayload,
  activeRowWhere,
  productActiveWhere,
  softDeleteInstance,
  softDeleteWhere,
} = require('../../src/lib/softDelete');

describe('softDelete', () => {
  const mockModel = {
    name: 'MockEntity',
    primaryKeyAttribute: 'id',
    rawAttributes: {
      deleted_at: { type: 'DATE' },
      lifecycle_status: { type: 'STRING' },
      updated_at: { type: 'DATE' },
    },
    update: jest.fn().mockResolvedValue([1]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('softDeletePayload sets deleted_at and lifecycle_status', () => {
    const payload = softDeletePayload(mockModel);
    expect(payload.lifecycle_status).toBe(LIFECYCLE_DELETED);
    expect(payload.deleted_at).toBeInstanceOf(Date);
    expect(payload.updated_at).toBeInstanceOf(Date);
  });

  it('activeRowWhere requires lifecycle_status active', () => {
    const { Op } = require('sequelize');
    const where = activeRowWhere({ id: 5 });
    expect(where[Op.and][0]).toEqual({ id: 5 });
    expect(where[Op.and][1]).toEqual({
      deleted_at: { [Op.is]: null },
      lifecycle_status: LIFECYCLE_ACTIVE,
    });
  });

  it('productActiveWhere excludes deleted products but keeps Draft', () => {
    const { Op } = require('sequelize');
    const where = productActiveWhere({ product_id: 1 });
    expect(where[Op.and][1].lifecycle_status).toEqual({ [Op.ne]: LIFECYCLE_DELETED });
  });

  it('softDeleteInstance calls update with archive payload', async () => {
    const row = {
      constructor: mockModel,
      update: jest.fn().mockResolvedValue(undefined),
    };
    await softDeleteInstance(row);
    expect(row.update).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle_status: LIFECYCLE_DELETED,
        deleted_at: expect.any(Date),
      }),
      {}
    );
  });

  it('softDeleteWhere calls Model.update with active filter', async () => {
    const n = await softDeleteWhere(mockModel, { id: 3 });
    expect(n).toBe(1);
    const { Op } = require('sequelize');
    expect(mockModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_status: LIFECYCLE_DELETED }),
      expect.objectContaining({
        where: {
          [Op.and]: [{ id: 3 }, { deleted_at: { [Op.is]: null }, lifecycle_status: LIFECYCLE_ACTIVE }],
        },
      })
    );
  });
});
