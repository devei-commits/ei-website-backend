const { Sequelize, DataTypes, Model } = require('sequelize');
const {
  backendNow,
  parseDbDate,
  stampForCreate,
  stampForUpdate,
  registerSequelizeTimestampHooks,
} = require('../../src/lib/backendTimestamps');

describe('backendTimestamps', () => {
  it('backendNow returns a Date', () => {
    const d = backendNow();
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('parseDbDate parses ISO strings', () => {
    const d = parseDbDate('2026-05-25T10:00:00.000Z');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-05-25T10:00:00.000Z');
  });

  it('stampForCreate sets created_at and updated_at on plain rows', () => {
    const model = {
      rawAttributes: { created_at: {}, updated_at: {}, name: {} },
      options: { timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' },
    };
    const row = { name: 'x' };
    stampForCreate(row, model);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('stampForUpdate always refreshes updated_at', () => {
    const model = {
      rawAttributes: { updated_at: {} },
      options: { timestamps: true, updatedAt: 'updated_at' },
    };
    const old = new Date('2020-01-01T00:00:00.000Z');
    const row = { updated_at: old };
    stampForUpdate(row, model);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(row.updated_at.getTime()).toBeGreaterThan(old.getTime());
  });

  it('registerSequelizeTimestampHooks stamps on Model.create', async () => {
    const sequelize = new Sequelize('sqlite::memory:', { logging: false });
    registerSequelizeTimestampHooks(sequelize);

    class Demo extends Model {}
    Demo.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: DataTypes.STRING,
        created_at: DataTypes.DATE,
        updated_at: DataTypes.DATE,
      },
      {
        sequelize,
        tableName: 'demo_ts',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }
    );
    await sequelize.sync({ force: true });

    const row = await Demo.create({ name: 'a' });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);

    const prev = row.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await row.update({ name: 'b' });
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(prev);

    await sequelize.close();
  });
});
