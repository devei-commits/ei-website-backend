const { createContact } = require('../services/zohoBooks');
const zohoEnv = require('../services/zohoEnv');

function shouldSyncZohoForUsertype(usertype) {
  return zohoEnv.shouldSyncUsertype(usertype);
}

function numOrUndef(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build Zoho Books "Create contact" JSON from app user + optional admin-provided fields.
 * @param {*} user - Sequelize User instance
 * @param {Record<string, unknown>} body - original POST /users/create body
 */
function buildZohoContactPayload(user, body = {}) {
  const display =
    user.display_name ||
    [user.fname, user.lname].filter(Boolean).join(' ').trim() ||
    user.email;

  const companyName =
    (body.companyName != null && String(body.companyName).trim()) ||
    (body.company_name != null && String(body.company_name).trim()) ||
    display;

  const websiteRaw = body.website != null ? String(body.website).trim() : '';
  const website = websiteRaw ? websiteRaw.replace(/^https?:\/\//i, '') : undefined;

  const currencyRaw = zohoEnv.defaultCurrencyId;
  if (!currencyRaw) {
    throw new Error('ZOHO_DEFAULT_CURRENCY_ID is required for Zoho contact sync');
  }
  const currencyId = zohoEnv.zohoNumericIdForJson(currencyRaw);
  if (currencyId === undefined) {
    throw new Error('ZOHO_DEFAULT_CURRENCY_ID is invalid for Zoho contact sync');
  }

  const paymentTerms = numOrUndef(body.payment_terms ?? process.env.ZOHO_DEFAULT_PAYMENT_TERMS) ?? 15;
  const paymentTermsLabel =
    (body.payment_terms_label != null && String(body.payment_terms_label).trim()) ||
    (paymentTerms === 15 ? 'Net 15' : `Net ${paymentTerms}`);

  const legalName =
    (body.legal_name != null && String(body.legal_name).trim()) ||
    (body.legalName != null && String(body.legalName).trim()) ||
    companyName;

  const notesParts = [`EI user id: ${user.userid}`, user.email];
  if (user.mobile) notesParts.push(`Phone: ${user.mobile}`);
  const notes = notesParts.join(' · ');

  const contactPerson = {
    first_name: user.fname || 'Contact',
    last_name: user.lname || '',
    email: user.email,
    phone: user.mobile || '',
    is_primary_contact: true,
    enable_portal: false,
  };
  const sal = body.salutation != null ? String(body.salutation).trim() : '';
  if (sal) contactPerson.salutation = sal;

  const payload = {
    contact_name: companyName,
    company_name: companyName,
    language_code: 'en',
    contact_type: 'customer',
    customer_sub_type: (body.customer_sub_type && String(body.customer_sub_type).trim()) || 'business',
    ignore_auto_number_generation: true,
    contact_number: `EI-${user.userid}`,
    is_portal_enabled: false,
    currency_id: currencyId,
    payment_terms: paymentTerms,
    payment_terms_label: paymentTermsLabel,
    notes,
    contact_persons: [contactPerson],
    legal_name: legalName,
  };

  if (website) payload.website = website;

  const billing = body.billing_address || body.billingAddress;
  const shipping = body.shipping_address || body.shippingAddress;
  if (billing && typeof billing === 'object') payload.billing_address = billing;
  if (shipping && typeof shipping === 'object') payload.shipping_address = shipping;

  const creditLimit = numOrUndef(body.credit_limit);
  if (creditLimit !== undefined) payload.credit_limit = creditLimit;

  const pricebookRaw = body.pricebook_id;
  if (pricebookRaw !== undefined && pricebookRaw !== null && String(pricebookRaw).trim() !== '') {
    const pb = zohoEnv.zohoNumericIdForJson(pricebookRaw);
    if (pb !== undefined) payload.pricebook_id = pb;
  }

  return payload;
}

/**
 * Create Zoho contact for a newly created user. Does not throw: returns result object.
 * @param {*} user - Sequelize User instance
 * @param {Record<string, unknown>} createBody
 */
async function syncZohoContactForNewUser(user, createBody = {}) {
  if (!zohoEnv.booksEnabled) {
    console.warn('[Zoho] contact sync skipped: Zoho Books integration is disabled');
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!zohoEnv.syncUserContacts) {
    console.warn('[Zoho] contact sync skipped: ZOHO_SYNC_CONTACTS=false');
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!shouldSyncZohoForUsertype(user.usertype)) {
    const allowed = [...zohoEnv.syncUsertypes].join(',') || 'customer';
    console.warn(
      `[Zoho] contact sync skipped: usertype "${user.usertype}" is not in ZOHO_SYNC_USERTYPES (effective: ${allowed})`
    );
    return { synced: false, error: 'usertype_not_configured_for_zoho' };
  }

  try {
    const payload = buildZohoContactPayload(user, createBody);
    const { contactId, raw } = await createContact(payload);
    if (!contactId) {
      return { synced: false, error: 'zoho_missing_contact_id', zohoMessage: raw && raw.message };
    }
    console.log('[Zoho] contact created for user', user.userid, 'contact_id:', contactId);
    return { synced: true, contactId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_sync_failed';
    console.error('[Zoho] create contact failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

/**
 * Parse "NET 30" / "NET 45" style strings to days (default 15).
 * @param {string|null|undefined} s
 */
function parsePaymentTermsDays(s) {
  if (s == null || String(s).trim() === '') return 15;
  const m = String(s).match(/NET\s*(\d+)/i);
  if (m) return parseInt(m[1], 10) || 15;
  return 15;
}

function splitContactName(full) {
  const t = full != null ? String(full).trim() : '';
  if (!t) return { first_name: 'Contact', last_name: '' };
  const parts = t.split(/\s+/);
  return { first_name: parts[0] || 'Contact', last_name: parts.slice(1).join(' ') };
}

/**
 * Build Zoho Books create-contact JSON from a vendor_clients row (client or vendor).
 * @param {*} vc - Sequelize VendorClient
 */
function buildZohoContactPayloadFromVendorClient(vc) {
  const d = vc.get ? vc.get({ plain: true }) : vc;
  const companyName = (d.name && String(d.name).trim()) || d.entity_code || 'Contact';
  const currencyRaw = zohoEnv.defaultCurrencyId;
  if (!currencyRaw) {
    throw new Error('ZOHO_DEFAULT_CURRENCY_ID is required for Zoho contact sync');
  }
  const currencyId = zohoEnv.zohoNumericIdForJson(currencyRaw);
  if (currencyId === undefined) {
    throw new Error('ZOHO_DEFAULT_CURRENCY_ID is invalid for Zoho contact sync');
  }

  const paymentTerms = parsePaymentTermsDays(d.payment_terms);
  const paymentTermsLabel = paymentTerms === 15 ? 'Net 15' : `Net ${paymentTerms}`;

  const contactsArr = Array.isArray(d.contacts) ? d.contacts : [];
  const primary = contactsArr[0] && contactsArr[0].name ? String(contactsArr[0].name).trim() : '';
  const { first_name, last_name } = primary
    ? splitContactName(primary)
    : { first_name: 'Contact', last_name: '' };

  const email = (d.email && String(d.email).trim()) || '';
  const phone = (d.phone && String(d.phone).trim()) || '';

  const notesParts = [`EI vendor_client id: ${d.id}`, `entity_code: ${d.entity_code}`];
  if (email) notesParts.push(email);
  if (phone) notesParts.push(phone);

  const contactType = d.type === 'vendor' ? 'vendor' : 'customer';

  const cp = {
    first_name: first_name || 'Contact',
    last_name: last_name || '',
    phone: phone || '',
    is_primary_contact: true,
    enable_portal: false,
  };
  if (email) cp.email = email;

  const payload = {
    contact_name: companyName,
    company_name: companyName,
    language_code: 'en',
    contact_type: contactType,
    ignore_auto_number_generation: true,
    contact_number: String(d.entity_code || `EI-VC-${d.id}`).slice(0, 100),
    is_portal_enabled: false,
    currency_id: currencyId,
    payment_terms: paymentTerms,
    payment_terms_label: paymentTermsLabel,
    notes: notesParts.join(' · '),
    contact_persons: [cp],
    legal_name: companyName,
  };
  if (contactType === 'customer') {
    payload.customer_sub_type = 'business';
  }

  const nameFromParts = [first_name, last_name].filter((x) => x && String(x).trim()).join(' ').trim();
  const attention =
    primary ||
    (nameFromParts && nameFromParts !== 'Contact' ? nameFromParts : '') ||
    companyName;

  const data = d.data && typeof d.data === 'object' ? d.data : {};
  const shipStr = data.shipping_address != null ? String(data.shipping_address).trim() : '';
  if (shipStr) {
    payload.shipping_address = {
      attention: String(attention).slice(0, 200),
      address: shipStr.slice(0, 500),
      city: (d.city && String(d.city).trim()) || undefined,
      state: (d.location && String(d.location).trim()) || undefined,
      country: (d.country && String(d.country).trim()) || 'India',
    };
  } else if (d.city || d.country) {
    payload.billing_address = {
      attention: String(attention).slice(0, 200),
      address: [d.location, d.city].filter(Boolean).join(', ') || companyName,
      city: (d.city && String(d.city).trim()) || undefined,
      state: (d.location && String(d.location).trim()) || undefined,
      country: (d.country && String(d.country).trim()) || 'India',
    };
  }

  return payload;
}

/**
 * Create Zoho contact from vendor_clients row (seed or future API). Non-throwing.
 * @param {*} vc - Sequelize VendorClient instance
 */
async function syncZohoContactForVendorClient(vc) {
  if (!zohoEnv.booksEnabled) {
    return { synced: false, error: 'zoho_disabled' };
  }
  const d = vc.get ? vc.get({ plain: true }) : vc;
  const t = d.type === 'client' ? 'client' : 'vendor';
  if (t === 'vendor' && !zohoEnv.syncVendorContacts) {
    return { synced: false, error: 'vendor_contact_sync_disabled' };
  }
  if (t === 'client' && !zohoEnv.syncClientContacts) {
    return { synced: false, error: 'client_contact_sync_disabled' };
  }
  try {
    const payload = buildZohoContactPayloadFromVendorClient(vc);
    const { contactId, raw } = await createContact(payload);
    if (!contactId) {
      return { synced: false, error: 'zoho_missing_contact_id', zohoMessage: raw && raw.message };
    }
    console.log('[Zoho] contact created for vendor_client', vc.id, vc.entity_code, 'contact_id:', contactId);
    return { synced: true, contactId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_sync_failed';
    console.error('[Zoho] vendor_client create contact failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

module.exports = {
  shouldSyncZohoForUsertype,
  buildZohoContactPayload,
  buildZohoContactPayloadFromVendorClient,
  syncZohoContactForNewUser,
  syncZohoContactForVendorClient,
};
