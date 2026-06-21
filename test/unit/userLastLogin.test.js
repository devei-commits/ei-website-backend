jest.mock('../../src/users/models', () => ({
  User: { update: jest.fn().mockResolvedValue([1]) },
}));

const { User } = require('../../src/users/models');
const { recordUserLastLogin } = require('../../src/lib/userLastLogin');

describe('recordUserLastLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('updates last_login_at for valid user id', async () => {
    await recordUserLastLogin({ userid: 42 });
    expect(User.update).toHaveBeenCalledTimes(1);
    const [fields, opts] = User.update.mock.calls[0];
    expect(fields.last_login_at).toBeInstanceOf(Date);
    expect(fields.updated_at).toBeInstanceOf(Date);
    expect(opts).toEqual({ where: { userid: 42 } });
  });

  test('no-op for invalid id', async () => {
    await recordUserLastLogin(null);
    await recordUserLastLogin({ userid: 0 });
    expect(User.update).not.toHaveBeenCalled();
  });
});
