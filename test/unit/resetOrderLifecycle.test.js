const { unscopedModel, hardDestroyAll, hardCountAll } = require('../../src/admin/resetOrderLifecycle');

describe('resetOrderLifecycle helpers', () => {
  test('unscopedModel prefers Model.unscoped()', () => {
    const destroy = jest.fn();
    const Model = {
      unscoped: jest.fn(() => ({ destroy, count: jest.fn() })),
      destroy: jest.fn(),
    };
    const scoped = unscopedModel(Model);
    expect(Model.unscoped).toHaveBeenCalledTimes(1);
    expect(scoped.destroy).toBe(destroy);
  });

  test('hardDestroyAll deletes via unscoped destroy', async () => {
    const destroy = jest.fn().mockResolvedValue(4);
    const Model = {
      unscoped: () => ({ destroy, count: jest.fn() }),
    };
    const result = await hardDestroyAll(Model, 'demo_table', null);
    expect(destroy).toHaveBeenCalledWith({ where: {}, transaction: null });
    expect(result).toEqual({ table: 'demo_table', deleted: 4 });
  });

  test('hardCountAll counts via unscoped count', async () => {
    const count = jest.fn().mockResolvedValue(7);
    const Model = {
      unscoped: () => ({ destroy: jest.fn(), count }),
    };
    await expect(hardCountAll(Model, null)).resolves.toBe(7);
    expect(count).toHaveBeenCalledWith({ transaction: null });
  });
});
