/**
 * Normalize Zoho Books contacts → master-map entries (customers / vendors).
 */

function pickPrimaryContactPerson(row) {
  const arr = Array.isArray(row?.contact_persons) ? row.contact_persons : [];
  if (arr.length === 0) return null;
  return arr.find((p) => p && p.is_primary_contact === true) || arr[0];
}

function normalizeEmail(s) {
  const v = String(s || '').trim().toLowerCase();
  return v || '';
}

function resolveEmail(row) {
  const cp = pickPrimaryContactPerson(row);
  return normalizeEmail(cp?.email || row?.email || '');
}

function resolvePhone(row) {
  const cp = pickPrimaryContactPerson(row);
  return String(cp?.mobile || cp?.phone || row?.phone || row?.mobile || '').trim() || null;
}

function displayName(row) {
  const name = String(row?.contact_name || row?.company_name || '').trim();
  if (name) return name;
  const cp = pickPrimaryContactPerson(row);
  const cpName = [cp?.first_name, cp?.last_name].filter(Boolean).join(' ').trim();
  return cpName || 'Contact';
}

function isZohoCustomer(row) {
  const t = String(row?.contact_type || '').trim().toLowerCase();
  if (t === 'customer') return true;
  const cs = String(row?.customer_sub_type || '').trim().toLowerCase();
  return cs.length > 0;
}

function isZohoVendor(row) {
  const t = String(row?.contact_type || '').trim().toLowerCase();
  if (t === 'vendor') return true;
  const vs = String(row?.vendor_sub_type || '').trim().toLowerCase();
  return !!vs;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} zohoContactId
 * @param {'customer'|'vendor'} contactType
 */
function contactToMapEntry(row, zohoContactId, contactType) {
  return {
    zoho_contact_id: zohoContactId,
    contact_type: contactType,
    contact_name: displayName(row),
    company_name: String(row?.company_name || '').trim() || null,
    email: resolveEmail(row) || null,
    phone: resolvePhone(row),
    contact_number: row?.contact_number != null ? String(row.contact_number).trim() : null,
    gst_no: row?.gst_no != null ? String(row.gst_no).trim() : null,
    payment_terms_label:
      row?.payment_terms_label != null && String(row.payment_terms_label).trim()
        ? String(row.payment_terms_label).trim()
        : null,
    dbTargets:
      contactType === 'customer'
        ? [
            { table: 'users', zohoField: 'zoho_contact_id', matchBy: ['email', 'zoho_contact_id'] },
            {
              table: 'vendor_clients',
              zohoField: 'zoho_id',
              matchBy: ['email', 'name', 'entity_code', 'zoho_id'],
              vendorClientType: 'client',
            },
          ]
        : [
            {
              table: 'vendor_clients',
              zohoField: 'zoho_id',
              matchBy: ['email', 'name', 'entity_code', 'zoho_id'],
              vendorClientType: 'vendor',
            },
          ],
  };
}

module.exports = {
  isZohoCustomer,
  isZohoVendor,
  contactToMapEntry,
  resolveEmail,
  displayName,
};
