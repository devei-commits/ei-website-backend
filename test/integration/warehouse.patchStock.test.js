/**
 * Integration: PATCH warehouse-inventory :id with wh_stock, ml1_stock, ml2_stock recomputes stock_in_hand.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const app = require('../../app');
const { useStaticJwtSecretsForTests } = require('../helpers/jwtTestEnv');
const RawMaterial = require('../../src/rawMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { User } = require('../../src/users/models');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('warehouse PATCH stock_in_hand', () => {
  let invId;
  let token;
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;

    useStaticJwtSecretsForTests();

    await db.sync({ force: true });
    const rm = await RawMaterial.create({ code: 'RM-PATCH-001', name: 'Test RM', status: 'Active' });
    const inv = await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 10,
      ml1_stock: 5,
      ml2_stock: 0,
      stock_in_hand: 15,
      reserved: 0,
    });
    invId = inv.id;
    const user = await User.create({
      fname: 'Test',
      lname: 'User',
      email: 'warehouse-test@example.com',
      password: 'hash',
      usertype: 'admin',
    });
    token = jwt.sign(
      {
        email: user.email,
        role: user.usertype || 'admin',
        sub: user.userid,
        id: user.userid,
      },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: '7d' }
    );
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('PATCH updates wh_stock and recomputes stock_in_hand = wh + ml1 + ml2', async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .patch(`/api/v1/warehouse-inventory/${invId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ wh_stock: 20, ml1_stock: 10, ml2_stock: 5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.stock_in_hand)).toBe(35);
    const row = await WarehouseInventory.findByPk(invId);
    expect(Number(row.stock_in_hand)).toBe(35);
  });

  test('PATCH with zero ml1 and ml2: stock_in_hand equals wh_stock only', async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .patch(`/api/v1/warehouse-inventory/${invId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ wh_stock: 100, ml1_stock: 0, ml2_stock: 0 });
    expect(res.status).toBe(200);
    expect(Number(res.body.stock_in_hand)).toBe(100);
  });
});
