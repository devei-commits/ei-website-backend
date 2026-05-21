const {
  zohoAreaCode,
  zohoWarehouseCode,
  resolveWarehouseParentLocationId,
  mapLocationToAreaFields,
  mapWarehouseToZoneFields,
} = require('../../scripts/lib/zoho-facility-locations-sync');

describe('zoho-facility-locations-sync', () => {
  const sampleLocation = {
    location_id: '1252231000000020035',
    location_name: 'NEW 36AAECE7642R2ZX',
    type: 'general',
    address: {
      street_address1: 'Plot No 45',
      city: 'Hyderabad',
      state: 'Telangana',
      postal_code: '500055',
      country: 'India',
    },
    is_primary_location: true,
    is_location_active: true,
    email: 'shivam@estheticinsights.com',
    tax_reg_no: '36AAECE7642R2ZX',
    warehouses: [
      {
        warehouse_id: '1252231000000015287',
        warehouse_name: 'EI WAREHOUSE JEEDIEMTLA',
        status: 'active',
        city: 'Hyderabad',
      },
    ],
  };

  test('zohoAreaCode is deterministic from location_id', () => {
    expect(zohoAreaCode('1252231000000020035')).toBe('ZL-1252231000000020035');
  });

  test('zohoWarehouseCode is deterministic from warehouse_id', () => {
    expect(zohoWarehouseCode('1252231000000015287')).toBe('ZW-1252231000000015287');
  });

  test('mapLocationToAreaFields stores zoho_location_id and meta', () => {
    const fields = mapLocationToAreaFields(sampleLocation);
    expect(fields.zoho_location_id).toBe('1252231000000020035');
    expect(fields.code).toBe('ZL-1252231000000020035');
    expect(fields.name).toBe('NEW 36AAECE7642R2ZX');
    expect(fields.area_type).toBe('warehouse');
    expect(fields.zoho_meta.location_id).toBe('1252231000000020035');
    expect(fields.zoho_meta.tax_reg_no).toBe('36AAECE7642R2ZX');
  });

  test('mapWarehouseToZoneFields marks inactive warehouses', () => {
    const wh = { warehouse_id: '1', warehouse_name: 'Inactive WH', status: 'inactive' };
    const fields = mapWarehouseToZoneFields(wh, 99, '1252231000000020035');
    expect(fields.area_id).toBe(99);
    expect(fields.zoho_warehouse_id).toBe('1');
    expect(fields.zoho_location_id).toBe('1252231000000020035');
    expect(fields.is_active).toBe(false);
    expect(fields.zoho_meta.status).toBe('inactive');
  });

  test('resolveWarehouseParentLocationId uses branch_id from /warehouses API', () => {
    const wh = {
      warehouse_id: '1252231000009986452',
      branch_id: '1252231000000020035',
      branch_name: 'NEW 36AAECE7642R2ZX',
    };
    expect(resolveWarehouseParentLocationId(wh, null)).toBe('1252231000000020035');
  });

  test('mapWarehouseToZoneFields stores branch and is_primary from /warehouses', () => {
    const wh = {
      warehouse_id: '1252231000009986452',
      warehouse_name: 'ARCHEESH 2',
      branch_id: '1252231000000020035',
      branch_name: 'NEW 36AAECE7642R2ZX',
      is_primary: false,
      status: 'inactive',
      country: 'India',
      state: 'Telangana',
      zip: '500055',
    };
    const fields = mapWarehouseToZoneFields(wh, 10, null);
    expect(fields.zoho_warehouse_id).toBe('1252231000009986452');
    expect(fields.zoho_location_id).toBe('1252231000000020035');
    expect(fields.zone_label).toBe('NEW 36AAECE7642R2ZX');
    expect(fields.is_active).toBe(false);
    expect(fields.is_zoho_primary).toBe(false);
    expect(fields.zoho_meta.branch_id).toBe('1252231000000020035');
    expect(fields.zoho_meta.branch_name).toBe('NEW 36AAECE7642R2ZX');
    expect(fields.zoho_meta.source).toBe('zoho_inventory_warehouses');
  });
});
