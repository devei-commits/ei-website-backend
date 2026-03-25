const { Op } = require('sequelize');
const { createInvoice } = require('../services/zohoBooks');
const zohoEnv = require('../services/zohoEnv');
const { Order } = require('../orders/models');
const { User } = require('../users/models');
const VendorClient = require('../vendorClient/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { FulfillmentOrderItem } = require('./models');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function addDays(isoDateStr, days) {
  const d = new Date(`${isoDateStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve Zoho Books customer_id (contact id string).
 * Priority: local DB ids from options → website order user → vendor_client name match → env fallback.
 * @param {*} fulfillmentOrder
 * @param {Record<string, unknown>} [options] — vendorClientId | vendor_client_id, userId | user_id (local PKs → zoho_id / zoho_contact_id)
 */
async function resolveZohoCustomerId(fulfillmentOrder, options = {}) {
  const vcid = options.vendorClientId ?? options.vendor_client_id;
  if (vcid !== undefined && vcid !== null && String(vcid).trim() !== '') {
    const id = parseInt(String(vcid), 10);
    if (!Number.isNaN(id)) {
      const vc = await VendorClient.findByPk(id, { attributes: ['zoho_id', 'type', 'name'] });
      if (vc && vc.zoho_id && String(vc.zoho_id).trim()) {
        return String(vc.zoho_id).trim();
      }
    }
  }

  const uid = options.userId ?? options.user_id;
  if (uid !== undefined && uid !== null && String(uid).trim() !== '') {
    const id = parseInt(String(uid), 10);
    if (!Number.isNaN(id)) {
      const user = await User.findByPk(id, { attributes: ['zoho_contact_id'] });
      if (user && user.zoho_contact_id && String(user.zoho_contact_id).trim()) {
        return String(user.zoho_contact_id).trim();
      }
    }
  }

  const soNo = fulfillmentOrder.so_no;
  if (soNo) {
    const webOrder = await Order.findOne({ where: { so_no: soNo } });
    if (webOrder) {
      const user = await User.findByPk(webOrder.user_id, { attributes: ['zoho_contact_id'] });
      if (user && user.zoho_contact_id) return String(user.zoho_contact_id).trim();
    }
  }
  const name = fulfillmentOrder.customer_name && String(fulfillmentOrder.customer_name).trim();
  if (name) {
    const vc = await VendorClient.findOne({
      where: { type: 'client', name: { [Op.iLike]: name } },
      attributes: ['zoho_id'],
    });
    if (vc && vc.zoho_id) return String(vc.zoho_id).trim();
  }
  const fb = zohoEnv.fallbackCustomerId;
  return fb || null;
}

/**
 * @param {Array<Record<string, unknown>>|null|undefined} lineItemsFromBody
 * @param {number} fulfillmentOrderId
 */
async function buildZohoLineItems(lineItemsFromBody, fulfillmentOrderId) {
  let rows = Array.isArray(lineItemsFromBody) && lineItemsFromBody.length > 0
    ? lineItemsFromBody
    : null;

  if (!rows) {
    const foItems = await FulfillmentOrderItem.findAll({
      where: { fulfillment_order_id: fulfillmentOrderId },
      order: [['id', 'ASC']],
    });
    rows = foItems.map((i) => {
      const d = i.get ? i.get({ plain: true }) : i;
      return {
        sku: d.sku,
        product_code: d.item_no,
        name: d.product_name,
        quantity: d.ordered_qty,
        rate: d.rate != null ? d.rate : d.unit_price,
      };
    });
  }

  const out = [];
  let itemOrder = 1;
  for (const line of rows) {
    const sku = line.sku != null ? String(line.sku).trim() : '';
    const code = (line.product_code != null && String(line.product_code).trim())
      || (line.productCode != null && String(line.productCode).trim())
      || '';
    let qty = num(line.quantity ?? line.qty ?? line.ordered_qty, 1);
    let rate = num(line.rate ?? line.unitPrice ?? line.unit_price, 0);
    let name =
      (line.name && String(line.name).trim())
      || (line.product_name && String(line.product_name).trim())
      || (line.description && String(line.description).trim())
      || 'Item';

    const productIdRaw = line.product_id ?? line.productId;
    const rmIdRaw = line.raw_material_id ?? line.rawMaterialId;
    const pmIdRaw = line.pack_material_id ?? line.packMaterialId;

    const hasProd =
      productIdRaw !== undefined && productIdRaw !== null && String(productIdRaw).trim() !== '';
    const hasRm = rmIdRaw !== undefined && rmIdRaw !== null && String(rmIdRaw).trim() !== '';
    const hasPm = pmIdRaw !== undefined && pmIdRaw !== null && String(pmIdRaw).trim() !== '';
    if ((hasProd && hasRm) || (hasProd && hasPm) || (hasRm && hasPm)) {
      const err = new Error('line_item_ambiguous_master_ids');
      err.zohoInvoiceBuildError = 'line_item_ambiguous_master_ids';
      throw err;
    }

    let zohoBooksItemIdStr = null;
    let hsnForLine =
      line.hsn_or_sac != null && String(line.hsn_or_sac).trim() ? line.hsn_or_sac : null;

    let product = null;
    if (hasProd) {
      const pid = parseInt(String(productIdRaw), 10);
      if (Number.isNaN(pid)) {
        const err = new Error('invalid_product_id');
        err.zohoInvoiceBuildError = 'invalid_product_id';
        throw err;
      }
      product = await Product.findByPk(pid);
      if (!product) {
        const err = new Error('product_not_found');
        err.zohoInvoiceBuildError = 'product_not_found';
        throw err;
      }
      if (!product.zoho_item_id || !String(product.zoho_item_id).trim()) {
        const err = new Error('missing_product_zoho_item_id');
        err.zohoInvoiceBuildError = 'missing_product_zoho_item_id';
        throw err;
      }
      zohoBooksItemIdStr = String(product.zoho_item_id).trim();
      const pname = product.product_name && String(product.product_name).trim();
      if (pname && (!line.name || !String(line.name).trim())) name = pname;
      if (rate === 0 && product.mrp_price != null) rate = num(product.mrp_price, 0);
    } else if (hasRm) {
      const rid = parseInt(String(rmIdRaw), 10);
      if (Number.isNaN(rid)) {
        const err = new Error('invalid_raw_material_id');
        err.zohoInvoiceBuildError = 'invalid_raw_material_id';
        throw err;
      }
      const rm = await RawMaterial.findByPk(rid);
      if (!rm) {
        const err = new Error('raw_material_not_found');
        err.zohoInvoiceBuildError = 'raw_material_not_found';
        throw err;
      }
      if (!rm.zoho_id || !String(rm.zoho_id).trim()) {
        const err = new Error('missing_raw_material_zoho_id');
        err.zohoInvoiceBuildError = 'missing_raw_material_zoho_id';
        throw err;
      }
      zohoBooksItemIdStr = String(rm.zoho_id).trim();
      const n = rm.name && String(rm.name).trim();
      if (n && (!line.name || !String(line.name).trim())) name = n;
      if (rate === 0 && rm.price_per_kg != null) rate = num(rm.price_per_kg, 0);
      if (!hsnForLine && rm.hsn_code) hsnForLine = rm.hsn_code;
    } else if (hasPm) {
      const pmid = parseInt(String(pmIdRaw), 10);
      if (Number.isNaN(pmid)) {
        const err = new Error('invalid_pack_material_id');
        err.zohoInvoiceBuildError = 'invalid_pack_material_id';
        throw err;
      }
      const pm = await PackMaterial.findByPk(pmid);
      if (!pm) {
        const err = new Error('pack_material_not_found');
        err.zohoInvoiceBuildError = 'pack_material_not_found';
        throw err;
      }
      if (!pm.zoho_id || !String(pm.zoho_id).trim()) {
        const err = new Error('missing_pack_material_zoho_id');
        err.zohoInvoiceBuildError = 'missing_pack_material_zoho_id';
        throw err;
      }
      zohoBooksItemIdStr = String(pm.zoho_id).trim();
      const label =
        (pm.description && String(pm.description).trim()) ||
        (pm.code && String(pm.code).trim()) ||
        'Pack item';
      if (!line.name || !String(line.name).trim()) name = label;
      if (rate === 0 && pm.price_per_pc != null) rate = num(pm.price_per_pc, 0);
      if (!hsnForLine && pm.hsn_code) hsnForLine = pm.hsn_code;
    } else {
      const orCond = [];
      if (code) orCond.push({ product_code: code });
      if (sku) orCond.push({ product_sku: sku });
      if (orCond.length) {
        product = await Product.findOne({ where: { [Op.or]: orCond } });
      }
      if (product && product.zoho_item_id && String(product.zoho_item_id).trim()) {
        zohoBooksItemIdStr = String(product.zoho_item_id).trim();
        const pname = product.product_name && String(product.product_name).trim();
        if (pname && (!line.name || !String(line.name).trim())) name = pname;
        if (rate === 0 && product.mrp_price != null) rate = num(product.mrp_price, 0);
      }
    }

    const li = {
      item_order: itemOrder++,
      name: name.slice(0, 200),
      rate,
      quantity: qty,
      bcy_rate: rate,
    };

    if (zohoBooksItemIdStr) {
      li.item_id = zohoEnv.zohoNumericIdForJson(zohoBooksItemIdStr) ?? zohoBooksItemIdStr;
    }

    const lineTax = zohoEnv.defaultLineTaxId;
    if (lineTax) {
      const t = String(lineTax).trim();
      const tid = zohoEnv.zohoNumericIdForJson(t);
      if (tid !== undefined) li.tax_id = tid;
    }

    const tds = zohoEnv.defaultTdsTaxId;
    if (tds) {
      const tdsStr = String(tds).trim();
      const tdsId = zohoEnv.zohoNumericIdForJson(tdsStr);
      if (tdsId !== undefined) li.tds_tax_id = tdsId;
    }

    const locLine = zohoEnv.defaultLocationId;
    if (locLine) {
      const lid = zohoEnv.zohoNumericIdForJson(String(locLine).trim());
      if (lid !== undefined) li.location_id = lid;
    }

    if (hsnForLine != null && String(hsnForLine).trim()) {
      const h = hsnForLine;
      li.hsn_or_sac = typeof h === 'number' ? h : String(h).trim();
    }

    out.push(li);
  }

  return out;
}

function buildInvoicePayload(fulfillmentOrder, opts) {
  const {
    customerId,
    invoiceNo,
    invoiceDate,
    dueDate,
    lineItems,
  } = opts;

  const currencyId = zohoEnv.defaultCurrencyId;
  if (!currencyId) throw new Error('ZOHO_DEFAULT_CURRENCY_ID is required for Zoho invoices');

  const pt = zohoEnv.defaultPaymentTermsDays;
  const dateStr = invoiceDate || new Date().toISOString().slice(0, 10);
  const dueStr = dueDate || addDays(dateStr, pt);

  const omitGstFields =
    process.env.ZOHO_INVOICE_OMIT_GST_FIELDS === 'true' ||
    process.env.ZOHO_INVOICE_SKIP_GST === 'true';

  const payload = {
    customer_id: zohoEnv.zohoNumericIdForJson(customerId) ?? customerId,
    currency_id: zohoEnv.zohoNumericIdForJson(currencyId) ?? currencyId,
    ...(zohoEnv.invoiceUseAutoNumber ? {} : { invoice_number: invoiceNo }),
    date: dateStr,
    due_date: dueStr,
    payment_terms: pt,
    payment_terms_label: pt === 15 ? 'Net 15' : `Net ${pt}`,
    is_inclusive_tax: false,
    discount: 0,
    is_discount_before_tax: true,
    discount_type: 'item_level',
    exchange_rate: 1,
    line_items: lineItems,
    reference_number: (fulfillmentOrder.so_no && String(fulfillmentOrder.so_no).trim()) || invoiceNo,
    send: false,
  };

  if (!omitGstFields) {
    const gt = zohoEnv.invoiceGstTreatment;
    if (gt && String(gt).trim()) {
      payload.gst_treatment = String(gt).trim();
    }
    const pos = zohoEnv.invoicePlaceOfSupply;
    if (pos && String(pos).trim()) {
      payload.place_of_supply = String(pos).trim();
    }
    const gstNo = process.env.ZOHO_INVOICE_GST_NO;
    if (gstNo && String(gstNo).trim()) {
      payload.gst_no = String(gstNo).trim();
    }
  }

  const loc = zohoEnv.defaultLocationId;
  if (loc) {
    const lid = zohoEnv.zohoNumericIdForJson(String(loc).trim());
    if (lid !== undefined) payload.location_id = lid;
  }

  return payload;
}

function getZohoErrorMessage(e) {
  if (!e) return '';
  const direct = e.message ? String(e.message) : '';
  const rawMsg =
    e.zohoRaw && e.zohoRaw.message ? String(e.zohoRaw.message) : '';
  return `${direct} ${rawMsg}`.trim().toLowerCase();
}

function isGstFieldValidationError(e) {
  const msg = getZohoErrorMessage(e);
  if (!msg) return false;
  return (
    msg.includes('invalid element gst_treatment') ||
    msg.includes('invalid element place_of_supply') ||
    msg.includes('invalid element gst_no')
  );
}

function stripGstFields(payload) {
  const next = { ...payload };
  delete next.gst_treatment;
  delete next.place_of_supply;
  delete next.gst_no;
  return next;
}

function isInvoiceAutoNumberMismatchError(e) {
  const msg = getZohoErrorMessage(e);
  if (!msg) return false;
  return (
    msg.includes('number entered does not match the auto-generated number') ||
    msg.includes('disable auto-generation and continue')
  );
}

function stripInvoiceNumber(payload) {
  const next = { ...payload };
  delete next.invoice_number;
  return next;
}

/**
 * Push invoice to Zoho Books after internal invoice is created/confirmed.
 * Does not throw; returns { synced, invoiceId?, error? }.
 */
async function syncZohoInvoiceAfterFulfillment({
  fulfillmentOrder,
  lineItemsFromBody,
  invoiceNo,
  invoiceDate,
  dueDate,
  vendorClientId,
  vendor_client_id,
  userId,
  user_id,
}) {
  if (!zohoEnv.booksEnabled || !zohoEnv.syncInvoices) {
    return { synced: false, error: 'zoho_invoices_disabled' };
  }

  try {
    const customerId = await resolveZohoCustomerId(fulfillmentOrder, {
      vendorClientId: vendorClientId ?? vendor_client_id,
      userId: userId ?? user_id,
    });
    if (!customerId) {
      return { synced: false, error: 'missing_zoho_customer_id' };
    }

    let zohoLines;
    try {
      zohoLines = await buildZohoLineItems(lineItemsFromBody, fulfillmentOrder.id);
    } catch (e) {
      if (e && e.zohoInvoiceBuildError) {
        return { synced: false, error: e.zohoInvoiceBuildError };
      }
      throw e;
    }
    if (!zohoLines.length) {
      return { synced: false, error: 'no_line_items_for_zoho' };
    }

    const payload = buildInvoicePayload(fulfillmentOrder, {
      customerId,
      invoiceNo,
      invoiceDate,
      dueDate,
      lineItems: zohoLines,
    });

    let invoiceId = null;
    let raw = null;
    let activePayload = payload;

    try {
      const result = await createInvoice(activePayload);
      invoiceId = result.invoiceId;
      raw = result.raw;
    } catch (e1) {
      if (isGstFieldValidationError(e1)) {
        activePayload = stripGstFields(activePayload);
        console.warn(
          '[Zoho] invoice retry without GST fields after validation error',
          {
            invoiceNo,
            soNo: fulfillmentOrder && fulfillmentOrder.so_no,
            reason: e1 && e1.message ? String(e1.message) : 'unknown',
          }
        );
        try {
          const retry1 = await createInvoice(activePayload);
          invoiceId = retry1.invoiceId;
          raw = retry1.raw;
        } catch (e2) {
          if (isInvoiceAutoNumberMismatchError(e2)) {
            activePayload = stripInvoiceNumber(activePayload);
            console.warn(
              '[Zoho] invoice retry without invoice_number due to auto-number policy',
              {
                invoiceNo,
                soNo: fulfillmentOrder && fulfillmentOrder.so_no,
                reason: e2 && e2.message ? String(e2.message) : 'unknown',
              }
            );
            const retry2 = await createInvoice(activePayload);
            invoiceId = retry2.invoiceId;
            raw = retry2.raw;
          } else {
            throw e2;
          }
        }
      } else if (isInvoiceAutoNumberMismatchError(e1)) {
        activePayload = stripInvoiceNumber(activePayload);
        console.warn(
          '[Zoho] invoice retry without invoice_number due to auto-number policy',
          {
            invoiceNo,
            soNo: fulfillmentOrder && fulfillmentOrder.so_no,
            reason: e1 && e1.message ? String(e1.message) : 'unknown',
          }
        );
        const retry = await createInvoice(activePayload);
        invoiceId = retry.invoiceId;
        raw = retry.raw;
      } else {
        throw e1;
      }
    }
    if (!invoiceId) {
      return { synced: false, error: 'zoho_missing_invoice_id', zohoMessage: raw && raw.message };
    }
    return { synced: true, invoiceId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_invoice_sync_failed';
    console.error('[Zoho] create invoice failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

/**
 * One-shot demo invoice for seed: customer contact id + catalogue product_id (FG) with zoho_item_id.
 * Does not persist a fulfillment row; uses a stub order for reference_number only.
 * @param {object} opts
 * @param {number} [opts.vendorClientId] — vendor_clients.id (loads zoho_id from DB; preferred)
 * @param {string} [opts.customerContactId] — raw Zoho contact id (legacy if vendorClientId omitted)
 * @param {number} opts.productId — products.product_id (loads zoho_item_id from DB)
 * @param {string} opts.invoiceNo
 * @param {number} [opts.quantity]
 * @param {number} [opts.rate] — falls back to product MRP when omitted/zero
 * @param {string} [opts.invoiceDate]
 * @param {string|null} [opts.dueDate]
 */
async function pushZohoSeedDemoInvoice({
  vendorClientId,
  customerContactId,
  productId,
  invoiceNo,
  quantity = 48,
  rate,
  invoiceDate,
  dueDate,
}) {
  if (!zohoEnv.booksEnabled || !zohoEnv.syncInvoices) {
    return { synced: false, error: 'zoho_invoices_disabled' };
  }

  let cid = '';
  if (vendorClientId != null && String(vendorClientId).trim() !== '') {
    const vid = parseInt(String(vendorClientId), 10);
    if (!Number.isNaN(vid)) {
      const vc = await VendorClient.findByPk(vid, { attributes: ['zoho_id'] });
      if (vc && vc.zoho_id && String(vc.zoho_id).trim()) {
        cid = String(vc.zoho_id).trim();
      }
    }
  }
  if (!cid && customerContactId != null && String(customerContactId).trim()) {
    cid = String(customerContactId).trim();
  }
  if (!cid) {
    return { synced: false, error: 'missing_zoho_customer_id' };
  }

  const stubOrder = { id: 0, so_no: 'EI-SEED-DEMO' };
  const lineItemsFromBody = [{ productId, quantity }];
  if (rate != null && Number(rate) > 0) {
    lineItemsFromBody[0].rate = Number(rate);
  }

  try {
    const zohoLines = await buildZohoLineItems(lineItemsFromBody, stubOrder.id);
    if (!zohoLines.length) {
      return { synced: false, error: 'no_line_items_for_zoho' };
    }

    const payload = buildInvoicePayload(stubOrder, {
      customerId: cid,
      invoiceNo,
      invoiceDate,
      dueDate,
      lineItems: zohoLines,
    });

    const { invoiceId, raw } = await createInvoice(payload);
    if (!invoiceId) {
      return { synced: false, error: 'zoho_missing_invoice_id', zohoMessage: raw && raw.message };
    }
    console.log('[Zoho] seed demo invoice created:', invoiceNo, 'invoice_id:', invoiceId);
    return { synced: true, invoiceId };
  } catch (e) {
    if (e && e.zohoInvoiceBuildError) {
      return { synced: false, error: e.zohoInvoiceBuildError };
    }
    const msg = e && e.message ? String(e.message) : 'zoho_invoice_sync_failed';
    console.error('[Zoho] seed demo invoice failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

module.exports = {
  resolveZohoCustomerId,
  buildZohoLineItems,
  buildInvoicePayload,
  syncZohoInvoiceAfterFulfillment,
  pushZohoSeedDemoInvoice,
};
