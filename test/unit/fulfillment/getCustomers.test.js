const { Op } = require('sequelize');

jest.mock('../../../db', () => {
  const { Sequelize } = require('sequelize');
  return new Sequelize('sqlite::memory:', { logging: false });
});

jest.mock('../../../src/vendorClient/models', () => ({
  findAll: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../../../src/addresses/clientAddressHelpers', () => ({
  loadShippingBillingByUserIds: jest.fn().mockResolvedValue(new Map()),
  loadAddressCityStateCountryByUserIds: jest.fn().mockResolvedValue(new Map()),
}));

const VendorClient = require('../../../src/vendorClient/models');
const { buildActiveClientWhere, buildActiveClientWhereByName } = require('../../../src/vendorClient/clientMasterQuery');
const { getCustomers, createOrder } = require('../../../src/fulfillment/controller');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('fulfillment getCustomers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('queries only active clients via buildActiveClientWhere', async () => {
    VendorClient.findAll.mockResolvedValue([
      {
        get: () => ({
          id: 1,
          entity_code: 'EI-CLI-00001',
          name: 'Luminos',
          city: 'Mumbai',
          location: 'MH',
          country: 'India',
          email: '',
          phone: '',
          category: '',
          notes: '',
          priority: '',
          segment: '',
          payment_terms: '',
          contacts: [],
          data: {},
          user_id: null,
        }),
      },
    ]);

    const res = mockRes();
    await getCustomers({}, res);

    expect(VendorClient.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: buildActiveClientWhere() }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ code: 'EI-CLI-00001', name: 'Luminos' });
  });

  test('buildActiveClientWhere excludes misclassified EI-VEN rows at query level', () => {
    const w = buildActiveClientWhere();
    const codeClause = w[Op.and].find((c) => c.entity_code);
    expect(codeClause.entity_code[Op.notILike]).toBe('EI-VEN-%');
  });
});

describe('fulfillment createOrder client validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects vendor / unknown customer names before creating order', async () => {
    VendorClient.findOne.mockResolvedValue(null);

    const res = mockRes();
    await createOrder(
      {
        body: {
          soNo: 'SO-TEST-001',
          customer: 'Sigma Chemicals Pvt Ltd',
          items: [],
        },
      },
      res,
    );

    expect(VendorClient.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: buildActiveClientWhereByName('Sigma Chemicals Pvt Ltd'),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Select a valid active client from the customer list',
    });
  });
});
