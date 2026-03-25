/**
 * Zoho Books sync for app purchase_orders → Purchase Order + Bill (vendor invoice).
 * Requires vendor (VendorClient) zoho_id, line items mapped to RM/PM zoho_id, ZOHO_DEFAULT_CURRENCY_ID.
 */

const { Op } = require('sequelize');
const { createPurchaseOrderInBooks, createBillInBooks } = require('./zohoBooks');
const zohoEnv = require('./zohoEnv');
const VendorClient = require('../vendorClient/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

function numOrZero(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getAttr(row, key) {
  return row.get ? row.get(key) : row[key];
}

/**
 * @param {*} row - Sequelize PurchaseOrder or plain
 */
function getFormData(row, body) {
  const fd = (body && body.formData) || getAttr(row, 'form_data');
  return fd && typeof fd === 'object' ? fd : {};
}

function getOrderStatus(row, body) {
  const os = (body && body.orderStatus) || getAttr(row, 'order_status');
  return os && typeof os === 'object' ? os : {};
}

/**
 * Resolve Zoho vendor contact_id from Vendor Client (zoho_id on row).
 * Uses formData/body vendorClientId, vendorEntityCode, then name / entity_code heuristics.
 * @param {string} vendorName - PO vendor_name
 * @param {*} row - PurchaseOrder Sequelize row
 * @param {Record<string, unknown>} body - request body
 */
async function findVendorZohoId(vendorName, row, body) {
  const fd = getFormData(row, body || {});
  const b = body || {};
  const byId = fd.vendorClientId ?? b.vendorClientId ?? fd.vendor_client_id;
  if (byId != null && String(byId).trim()) {
    const id = parseInt(String(byId), 10);
    if (Number.isFinite(id) && id > 0) {
      const v = await VendorClient.findOne({ where: { id, type: 'vendor' } });
      if (v) {
        const z = getAttr(v, 'zoho_id');
        if (z && String(z).trim()) return String(z).trim();
      }
    }
  }
  const entityCode = fd.vendorEntityCode ?? fd.entityCode ?? b.vendorEntityCode;
  if (entityCode && String(entityCode).trim()) {
    const v = await VendorClient.findOne({
      where: { type: 'vendor', entity_code: String(entityCode).trim() },
    });
    if (v) {
      const z = getAttr(v, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
  }
  const vn = String(vendorName || '').trim();
  if (/^EI-VEN-/i.test(vn)) {
    const v = await VendorClient.findOne({
      where: { type: 'vendor', entity_code: vn },
    });
    if (v) {
      const z = getAttr(v, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
  }
  if (!vn) return null;
  let vendor = await VendorClient.findOne({
    where: { type: 'vendor', name: { [Op.iLike]: vn } },
  });
  if (!vendor) {
    vendor = await VendorClient.findOne({
      where: { type: 'vendor', name: { [Op.iLike]: `%${vn}%` } },
    });
  }
  if (!vendor) return null;
  const z = getAttr(vendor, 'zoho_id');
  return z && String(z).trim() ? String(z).trim() : null;
}

async function resolveZohoItemIdFromLine(line) {
  const raw = line.raw_material_id != null ? Number(line.raw_material_id) : NaN;
  const pm = line.pack_material_id != null ? Number(line.pack_material_id) : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    const rm = await RawMaterial.findByPk(raw);
    if (rm) {
      const z = getAttr(rm, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
  }
  if (Number.isFinite(pm) && pm > 0) {
    const p = await PackMaterial.findByPk(pm);
    if (p) {
      const z = getAttr(p, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
  }
  const itemCode = String(line.itemCode || '').trim();
  if (itemCode) {
    const rm = await RawMaterial.findOne({ where: { code: itemCode } });
    if (rm) {
      const z = getAttr(rm, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
    const pmRow = await PackMaterial.findOne({ where: { code: itemCode } });
    if (pmRow) {
      const z = getAttr(pmRow, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
  }
  const itemName = String(line.itemName || line.item || '').trim();
  if (itemName) {
    const rm = await RawMaterial.findOne({
      where: {
        [Op.or]: [
          { name: { [Op.iLike]: itemName } },
          { code: { [Op.iLike]: itemName } },
          { inci: { [Op.iLike]: itemName } },
        ],
      },
    });
    if (rm) {
      const z = getAttr(rm, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
    const pmRow = await PackMaterial.findOne({
      where: {
        [Op.or]: [
          { code: { [Op.iLike]: itemName } },
          { description: { [Op.iLike]: `%${itemName}%` } },
        ],
      },
    });
    if (pmRow) {
      const z = getAttr(pmRow, 'zoho_id');
      if (z && String(z).trim()) return String(z).trim();
    }
  }
  return null;
}

async function buildZohoLineItems(items) {
  const arr = Array.isArray(items) ? items : [];
  const rows = [];
  let order = 0;
  for (const line of arr) {
    const itemId = await resolveZohoItemIdFromLine(line);
    if (!itemId) continue;
    const qty = numOrZero(line.quantity ?? line.qty);
    const rate = numOrZero(line.rate ?? line.pricePerUnit);
    const li = {
      item_id: zohoEnv.zohoNumericIdForJson(itemId),
      quantity: qty,
      rate,
      item_order: order,
    };
    const taxId = process.env.ZOHO_DEFAULT_LINE_TAX_ID || process.env.ZOHO_DEFAULT_ITEM_TAX_ID;
    const taxPct = numOrZero(line.tax ?? line.gstPercent);
    if (taxId && String(taxId).trim() && taxPct > 0) {
      const t = zohoEnv.zohoNumericIdForJson(String(taxId).trim());
      if (t !== undefined) li.tax_id = t;
    }
    rows.push(li);
    order += 1;
  }
  return rows;
}

async function buildZohoPurchaseOrderPayload(row, body) {
  const vendorName = getAttr(row, 'vendor_name') || (body && body.vendorName);
  const vendorId = await findVendorZohoId(vendorName, row, body);
  if (!vendorId) {
    throw new Error('vendor_not_found_or_no_zoho_id');
  }

  const currencyId = zohoEnv.defaultCurrencyId;
  if (!currencyId) {
    throw new Error('ZOHO_DEFAULT_CURRENCY_ID is required for Zoho purchase order sync');
  }

  const items = getAttr(row, 'items');
  const lineItems = await buildZohoLineItems(items);
  if (lineItems.length === 0) {
    throw new Error('no_po_lines_with_zoho_item_id');
  }

  const orderDate = getAttr(row, 'order_date') || new Date().toISOString().slice(0, 10);
  const deliveryDate = getAttr(row, 'expected_shipment_date') || orderDate;

  const payload = {
    vendor_id: zohoEnv.zohoNumericIdForJson(vendorId),
    currency_id: zohoEnv.zohoNumericIdForJson(currencyId),
    date: String(orderDate).slice(0, 10),
    delivery_date: String(deliveryDate).slice(0, 10),
    reference_number: String(getAttr(row, 'order_id') || '').slice(0, 200),
    line_items: lineItems,
  };
  const ref = getAttr(row, 'reference');
  if (ref != null && String(ref).trim()) {
    payload.notes = String(ref).slice(0, 5000);
  }

  const loc = zohoEnv.defaultLocationId;
  if (loc && String(loc).trim()) {
    payload.location_id = zohoEnv.zohoNumericIdForJson(String(loc).trim());
  }

  return payload;
}

/**
 * @param {*} row
 * @param {Record<string, unknown>} body
 */
function shouldCreateBill(row, body) {
  if (!zohoEnv.syncPurchaseBills) return false;
  const existing = getAttr(row, 'zoho_bill_id');
  if (existing && String(existing).trim()) return false;
  const poZid = getAttr(row, 'zoho_purchase_order_id');
  if (!poZid || !String(poZid).trim()) return false;

  if (zohoEnv.syncBillWithPo) return true;

  const fd = getFormData(row, body);
  const os = getOrderStatus(row, body);
  const inv = String(fd.invoiceNumber || fd.vendorInvoiceNo || fd.invoice_no || '').trim();
  if (inv) return true;
  const invoiced = String(os.invoiced || '').trim();
  if (invoiced && invoiced.toLowerCase() !== 'no' && invoiced.toLowerCase() !== 'pending') return true;
  return false;
}

async function buildZohoBillPayload(row, body) {
  const vendorName = getAttr(row, 'vendor_name') || (body && body.vendorName);
  const vendorId = await findVendorZohoId(vendorName, row, body);
  if (!vendorId) {
    throw new Error('vendor_not_found_or_no_zoho_id');
  }

  const currencyId = zohoEnv.defaultCurrencyId;
  if (!currencyId) {
    throw new Error('ZOHO_DEFAULT_CURRENCY_ID is required for Zoho bill sync');
  }

  const items = getAttr(row, 'items');
  const lineItems = await buildZohoLineItems(items);
  if (lineItems.length === 0) {
    throw new Error('no_po_lines_with_zoho_item_id');
  }

  const orderDate = getAttr(row, 'order_date') || new Date().toISOString().slice(0, 10);
  const fd = getFormData(row, body);
  const invNo = String(fd.invoiceNumber || fd.vendorInvoiceNo || fd.invoice_no || '').trim();
  const billNumber = invNo || String(getAttr(row, 'order_id') || '').slice(0, 50);

  const payload = {
    vendor_id: zohoEnv.zohoNumericIdForJson(vendorId),
    currency_id: zohoEnv.zohoNumericIdForJson(currencyId),
    date: String(orderDate).slice(0, 10),
    reference_number: String(getAttr(row, 'reference') || getAttr(row, 'order_id') || '').slice(0, 200),
    line_items: lineItems,
  };
  if (billNumber) {
    payload.bill_number = billNumber.slice(0, 50);
  }

  const poId = getAttr(row, 'zoho_purchase_order_id');
  if (poId && String(poId).trim()) {
    const pid = zohoEnv.zohoNumericIdForJson(String(poId).trim());
    if (pid !== undefined) {
      payload.purchaseorder_ids = [pid];
    }
  }

  return payload;
}

/**
 * After PurchaseOrder.create. Non-throwing.
 * @param {*} row
 * @param {Record<string, unknown>} body
 */
async function syncZohoPurchaseOrderForPo(row, body = {}) {
  if (!zohoEnv.booksEnabled) {
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!zohoEnv.syncPurchaseOrders) {
    return { synced: false, error: 'po_sync_disabled' };
  }
  const existing = getAttr(row, 'zoho_purchase_order_id');
  if (existing && String(existing).trim()) {
    return { synced: false, error: 'already_has_zoho_purchase_order' };
  }

  try {
    const payload = await buildZohoPurchaseOrderPayload(row, body);
    const { purchaseorderId, raw } = await createPurchaseOrderInBooks(payload);
    if (!purchaseorderId) {
      return { synced: false, error: 'zoho_missing_purchaseorder_id', zohoMessage: raw && raw.message };
    }
    return { synced: true, purchaseorderId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_po_sync_failed';
    console.error('[Zoho] PO create failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

/**
 * After PurchaseOrder.create/update when PO exists in Zoho. Non-throwing.
 * @param {*} row
 * @param {Record<string, unknown>} body
 */
async function syncZohoBillForPo(row, body = {}) {
  if (!zohoEnv.booksEnabled) {
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!zohoEnv.syncPurchaseBills) {
    return { synced: false, error: 'bill_sync_disabled' };
  }
  const existing = getAttr(row, 'zoho_bill_id');
  if (existing && String(existing).trim()) {
    return { synced: false, error: 'already_has_zoho_bill' };
  }
  if (!shouldCreateBill(row, body)) {
    return { synced: false, error: 'bill_not_eligible' };
  }

  try {
    const payload = await buildZohoBillPayload(row, body);
    const { billId, raw } = await createBillInBooks(payload);
    if (!billId) {
      return { synced: false, error: 'zoho_missing_bill_id', zohoMessage: raw && raw.message };
    }
    return { synced: true, billId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_bill_sync_failed';
    console.error('[Zoho] Bill create failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

module.exports = {
  syncZohoPurchaseOrderForPo,
  syncZohoBillForPo,
  buildZohoLineItems,
  findVendorZohoId,
  getFormData,
};
