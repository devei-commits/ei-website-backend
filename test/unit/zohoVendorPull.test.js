const { isZohoVendor, toVendorPayloadFromZoho } = require('../../src/vendorClient/zohoVendorPull');

describe('zohoVendorPull — isZohoVendor', () => {
  test('contact_type vendor is a vendor', () => {
    expect(isZohoVendor({ contact_type: 'vendor' })).toBe(true);
  });
  test('non-empty vendor_sub_type is a vendor', () => {
    expect(isZohoVendor({ contact_type: 'other', vendor_sub_type: 'domestic' })).toBe(true);
  });
  test('customer contact with no vendor_sub_type is not a vendor', () => {
    expect(isZohoVendor({ contact_type: 'customer', vendor_sub_type: '' })).toBe(false);
  });
  test('missing/undefined fields default to not-a-vendor', () => {
    expect(isZohoVendor({})).toBe(false);
    expect(isZohoVendor(null)).toBe(false);
  });
});

describe('zohoVendorPull — toVendorPayloadFromZoho', () => {
  const zohoId = 'zc-1000901';

  test('maps a realistic Zoho Books vendor contact into the vendor_clients payload shape', () => {
    const row = {
      contact_id: zohoId,
      contact_type: 'vendor',
      contact_name: 'Flychem Private Limited',
      company_name: 'Flychem Private Limited',
      email: 'sales@flychem.example',
      phone: '022-40000000',
      gst_no: '27AAAAA0000A1Z5',
      website: 'flychem.example',
      payment_terms_label: 'Net 30',
      notes: 'Preferred cosmetic RM vendor',
      billing_address: { city: 'Mumbai', state: 'Maharashtra', country: 'India' },
      shipping_address: { city: 'Mumbai', state: 'Maharashtra', country: 'India' },
      contact_persons: [
        { is_primary_contact: true, first_name: 'Asha', last_name: 'Rao', email: 'asha@flychem.example', mobile: '9820000000' },
      ],
    };

    const payload = toVendorPayloadFromZoho(row, zohoId);

    expect(payload.zoho_id).toBe(zohoId);
    expect(payload.name).toBe('Flychem Private Limited');
    // Primary contact person's email/phone win over the company-level fields.
    expect(payload.email).toBe('asha@flychem.example');
    expect(payload.phone).toBe('9820000000');
    expect(payload.city).toBe('Mumbai');
    expect(payload.location).toBe('Maharashtra');
    expect(payload.country).toBe('India');
    expect(payload.category).toBe('Vendor');
    expect(payload.status).toBe('active');
    expect(payload.payment_terms).toBe('Net 30');
    expect(payload.notes).toBe('Preferred cosmetic RM vendor');
    expect(payload.data.tradeName).toBe('Flychem Private Limited');
    expect(payload.data.gstin).toBe('27AAAAA0000A1Z5');
    expect(payload.data.zohoId).toBe(zohoId);
  });

  test('falls back to company-level email/phone when there is no primary contact person', () => {
    const row = {
      contact_id: zohoId,
      company_name: 'No Contact Person Pvt Ltd',
      email: 'accounts@nocontact.example',
      phone: '011-99999999',
    };

    const payload = toVendorPayloadFromZoho(row, zohoId);

    expect(payload.email).toBe('accounts@nocontact.example');
    expect(payload.phone).toBe('011-99999999');
    expect(payload.name).toBe('No Contact Person Pvt Ltd');
  });

  test('rows with neither company_name/contact_name nor a contact person still resolve a display name', () => {
    const row = { contact_id: zohoId };
    const payload = toVendorPayloadFromZoho(row, zohoId);
    expect(payload.name).toBe('Vendor');
    expect(payload.email).toBeNull();
  });

  test('payment_terms falls back to "NET <days>" when only the numeric field is present', () => {
    const row = { contact_id: zohoId, company_name: 'Numeric Terms Co', email: 'x@y.example', payment_terms: 45 };
    const payload = toVendorPayloadFromZoho(row, zohoId);
    expect(payload.payment_terms).toBe('NET 45');
  });
});
