jest.mock('../../src/vendorClient/models', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../src/vendorClient/userLink', () => ({
  allocateNextEntityCode: jest.fn().mockResolvedValue('V-0099'),
}));
jest.mock('../../src/services/zohoBooks', () => ({
  listAllContacts: jest.fn(),
  getContactById: jest.fn(),
  normalizeZohoContactId: (v) => (v == null ? null : String(v).trim() || null),
  getOrgId: () => 'org-1',
}));

const VendorClient = require('../../src/vendorClient/models');
const { listAllContacts, getContactById } = require('../../src/services/zohoBooks');
const { importOneZohoVendor } = require('../../src/vendorClient/zohoVendorPull');

function contactRow(overrides = {}) {
  return {
    contact_id: 'zc-1',
    contact_type: 'vendor',
    company_name: 'Flychem Private Limited',
    email: 'sales@flychem.example',
    ...overrides,
  };
}

describe('importOneZohoVendor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('zohoId path: creates the vendor when no existing row matches', async () => {
    getContactById.mockResolvedValue(contactRow());
    VendorClient.findOne.mockResolvedValue(null);
    VendorClient.create.mockResolvedValue({ id: 42 });

    const result = await importOneZohoVendor({ zohoId: 'zc-1' });

    expect(getContactById).toHaveBeenCalledWith('zc-1');
    expect(VendorClient.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      imported: true,
      action: 'created',
      vendor: { id: 42, name: 'Flychem Private Limited', email: 'sales@flychem.example' },
    });
  });

  test('zohoId path: updates the vendor when an existing row already matches', async () => {
    const existingUpdate = jest.fn().mockResolvedValue(undefined);
    getContactById.mockResolvedValue(contactRow());
    VendorClient.findOne.mockResolvedValue({ id: 7, data: {}, update: existingUpdate });

    const result = await importOneZohoVendor({ zohoId: 'zc-1' });

    expect(existingUpdate).toHaveBeenCalledTimes(1);
    expect(VendorClient.create).not.toHaveBeenCalled();
    expect(result.imported).toBe(true);
    expect(result.action).toBe('updated');
  });

  test('zohoId path: not found in Zoho', async () => {
    getContactById.mockResolvedValue(null);
    const result = await importOneZohoVendor({ zohoId: 'zc-missing' });
    expect(result).toEqual({ imported: false, reason: 'not_found' });
  });

  test('zohoId path: contact exists in Zoho but is not a vendor', async () => {
    getContactById.mockResolvedValue(contactRow({ contact_type: 'customer', vendor_sub_type: '' }));
    const result = await importOneZohoVendor({ zohoId: 'zc-1' });
    expect(result).toEqual({ imported: false, reason: 'not_a_vendor' });
  });

  test('search path: no matches', async () => {
    listAllContacts.mockResolvedValue([]);
    const result = await importOneZohoVendor({ search: 'Nonexistent Co' });
    expect(listAllContacts).toHaveBeenCalledWith({ searchText: 'Nonexistent Co', maxPages: 1, limit: 25 });
    expect(result).toEqual({ imported: false, reason: 'no_match' });
  });

  test('search path: exactly one vendor match imports directly', async () => {
    listAllContacts.mockResolvedValue([contactRow(), { contact_id: 'zc-2', contact_type: 'customer', vendor_sub_type: '' }]);
    VendorClient.findOne.mockResolvedValue(null);
    VendorClient.create.mockResolvedValue({ id: 5 });

    const result = await importOneZohoVendor({ search: 'Flychem' });

    expect(result.imported).toBe(true);
    expect(result.action).toBe('created');
  });

  test('search path: multiple vendor matches return candidates instead of guessing', async () => {
    listAllContacts.mockResolvedValue([
      contactRow({ contact_id: 'zc-1', company_name: 'Flychem Private Limited' }),
      contactRow({ contact_id: 'zc-2', company_name: 'Flychem Exports Pvt Ltd', email: 'exports@flychem.example' }),
    ]);

    const result = await importOneZohoVendor({ search: 'Flychem' });

    expect(result.imported).toBe(false);
    expect(result.reason).toBe('multiple_matches');
    expect(result.matches).toEqual([
      { zohoId: 'zc-1', name: 'Flychem Private Limited', email: 'sales@flychem.example' },
      { zohoId: 'zc-2', name: 'Flychem Exports Pvt Ltd', email: 'exports@flychem.example' },
    ]);
    expect(VendorClient.create).not.toHaveBeenCalled();
  });

  test('throws a 400 when neither zohoId nor search is provided', async () => {
    await expect(importOneZohoVendor({})).rejects.toMatchObject({ statusCode: 400 });
  });
});
