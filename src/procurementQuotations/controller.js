const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const ProcurementQuotation = require('./models');
const ProcurementRequest = require('../procurementRequests/models');
const VendorClient = require('../vendorClient/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const { vendorRatesPartyWhere } = require('../itemsList/partyTypeWhere');
const db = require('../../db');
const { parseMoqQuantity, moqValuesEqual } = require('../lib/moqQuantity');

/**
 * Resolve price_per_unit from Items List for a vendor + RM or PM.
 * @param {number} vendorId
 * @param {number|null} rawMaterialId
 * @param {number|null} packMaterialId
 * @returns {Promise<number|null>}
 */
async function getVendorPriceFromItemsList(vendorId, rawMaterialId, packMaterialId) {
  const where = rawMaterialId != null ? { raw_material_id: rawMaterialId } : { pack_material_id: packMaterialId };
  const listRow = await ItemsList.findOne({ where });
  if (!listRow) return null;
  const rateRow = await ItemListVendorRate.findOne({
    where: { items_list_id: listRow.id, vendor_id: vendorId, ...vendorRatesPartyWhere() },
  });
  if (!rateRow) return null;
  const tier = await ItemListTier.findOne({ where: { item_list_vendor_rate_id: rateRow.id }, order: [['moq_min', 'ASC']] });
  if (!tier || tier.price_per_unit == null) return null;
  const n = Number(tier.price_per_unit);
  return Number.isNaN(n) ? null : n;
}

async function getVendorTierPriceFromItemsList(vendorId, rawMaterialId, packMaterialId, qty) {
  const where = rawMaterialId != null ? { raw_material_id: rawMaterialId } : { pack_material_id: packMaterialId };
  const listRow = await ItemsList.findOne({ where });
  if (!listRow) return null;
  const rateRow = await ItemListVendorRate.findOne({
    where: { items_list_id: listRow.id, vendor_id: vendorId, ...vendorRatesPartyWhere() },
  });
  if (!rateRow) return null;
  const tiers = await ItemListTier.findAll({ where: { item_list_vendor_rate_id: rateRow.id }, order: [['moq_min', 'ASC']] });
  if (!tiers || tiers.length === 0) return null;
  const q = Number(qty) || 0;
  const match =
    tiers.find((t) => q >= Number(t.moq_min || 0) && (t.moq_max == null || q <= Number(t.moq_max))) ||
    tiers[tiers.length - 1];
  const n = match && match.price_per_unit != null ? Number(match.price_per_unit) : null;
  return n != null && !Number.isNaN(n) ? n : null;
}

/** Lead time (days) from Items List vendor rate row (not tier-specific). */
async function getVendorLeadFromItemsList(vendorId, rawMaterialId, packMaterialId) {
  const where = rawMaterialId != null ? { raw_material_id: rawMaterialId } : { pack_material_id: packMaterialId };
  const listRow = await ItemsList.findOne({ where });
  if (!listRow) return null;
  const rateRow = await ItemListVendorRate.findOne({
    where: { items_list_id: listRow.id, vendor_id: vendorId, ...vendorRatesPartyWhere() },
  });
  if (!rateRow || rateRow.lead_time_days == null) return null;
  const n = Number(rateRow.lead_time_days);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function enrichQuotationItemsFromItemsList(vendorId, items) {
  const enriched = [];
  for (const it of items) {
    const qty = Number(it.orderQty ?? it.quantity_requested ?? 0) || 0;
    const rawMaterialId = it.raw_material_id ?? null;
    const packMaterialId = it.pack_material_id ?? null;
    const price = await getVendorTierPriceFromItemsList(vendorId, rawMaterialId, packMaterialId, qty);
    const priceNum = price != null ? price : (Number(it.pricePerUnit) || 0);
    const listLead = await getVendorLeadFromItemsList(vendorId, rawMaterialId, packMaterialId);
    const lineLeadRaw = it.leadTimeDays ?? it.lead_time_days;
    const lineLead = lineLeadRaw != null && lineLeadRaw !== '' ? Number(lineLeadRaw) : null;
    const leadTimeDays =
      listLead != null
        ? listLead
        : lineLead != null && Number.isFinite(lineLead) && lineLead >= 0
          ? lineLead
          : null;
    enriched.push({
      ...it,
      orderQty: qty,
      pricePerUnit: priceNum,
      totalValue: qty * priceNum,
      leadTimeDays,
    });
  }
  return enriched;
}

function buildQuotationLineKey(line) {
  const rmId = line?.raw_material_id != null ? Number(line.raw_material_id) : NaN;
  if (Number.isFinite(rmId) && rmId > 0) return `rm:${rmId}`;
  const pmId = line?.pack_material_id != null ? Number(line.pack_material_id) : NaN;
  if (Number.isFinite(pmId) && pmId > 0) return `pm:${pmId}`;
  const itemId = String(line?.itemId ?? '').trim().toLowerCase();
  if (itemId) return `code:${itemId}`;
  const name = String(line?.name ?? '').trim().toLowerCase();
  if (name) return `name:${name}`;
  return `idx:${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePriceHistoryEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const oldPrice = Number(entry.oldPrice);
      const newPrice = Number(entry.newPrice);
      const changedAt = String(entry.changedAt ?? '').trim();
      return {
        oldPrice: Number.isFinite(oldPrice) ? oldPrice : 0,
        newPrice: Number.isFinite(newPrice) ? newPrice : 0,
        changedAt: changedAt || new Date().toISOString(),
        changedBy: String(entry.changedBy ?? '').trim() || null,
        reason: String(entry.reason ?? '').trim() || null,
      };
    })
    .filter(Boolean);
}

function withPriceHistory(items, opts = {}) {
  const previousItems = Array.isArray(opts.previousItems) ? opts.previousItems : [];
  const nowIso = opts.nowIso || new Date().toISOString();
  const actor = opts.actor || null;
  const reason = opts.reason || 'Updated from procurement quotation';
  const previousByKey = new Map();
  for (const prev of previousItems) {
    previousByKey.set(buildQuotationLineKey(prev), prev);
  }
  return (Array.isArray(items) ? items : []).map((line) => {
    const key = buildQuotationLineKey(line);
    const prev = previousByKey.get(key) || null;
    const nextPrice = Number(line.pricePerUnit) || 0;
    const baseHistory = normalizePriceHistoryEntries(line.priceHistory);
    const prevHistory =
      baseHistory.length > 0
        ? baseHistory
        : normalizePriceHistoryEntries(prev?.priceHistory);
    if (!prev) {
      return {
        ...line,
        priceHistory: [
          ...prevHistory,
          {
            oldPrice: nextPrice,
            newPrice: nextPrice,
            changedAt: nowIso,
            changedBy: actor,
            reason: 'Initial quotation price',
          },
        ],
      };
    }
    const prevPrice = Number(prev.pricePerUnit) || 0;
    if (Math.abs(prevPrice - nextPrice) < 1e-9) {
      return { ...line, priceHistory: prevHistory };
    }
    return {
      ...line,
      priceHistory: [
        ...prevHistory,
        {
          oldPrice: prevPrice,
          newPrice: nextPrice,
          changedAt: nowIso,
          changedBy: actor,
          reason,
        },
      ],
    };
  });
}

async function upsertItemsListRateFromQuotationLine(t, vendorId, line, paymentTerms) {
  const rmId = line.raw_material_id != null ? parseInt(String(line.raw_material_id), 10) : null;
  const pmId = line.pack_material_id != null ? parseInt(String(line.pack_material_id), 10) : null;
  if ((rmId == null || Number.isNaN(rmId)) && (pmId == null || Number.isNaN(pmId))) return;
  const qty = parseMoqQuantity(line.orderQty ?? line.quantity_requested ?? 0) ?? 0;
  const price = Number(line.pricePerUnit ?? 0) || 0;
  if (qty <= 0 || price <= 0) return;
  const leadRaw = line.leadTimeDays ?? line.lead_time_days;
  const leadParsed = leadRaw != null && leadRaw !== '' ? parseInt(String(leadRaw), 10) : null;
  const leadDays = leadParsed != null && Number.isFinite(leadParsed) && leadParsed >= 0 ? leadParsed : null;

  const type = rmId != null && !Number.isNaN(rmId) ? 'RM' : 'PM';
  const listWhere = type === 'RM' ? { type: 'RM', raw_material_id: rmId } : { type: 'PM', pack_material_id: pmId };
  let listRow = await ItemsList.findOne({ where: listWhere, transaction: t });
  if (!listRow) {
    listRow = await ItemsList.create(
      {
        type,
        raw_material_id: type === 'RM' ? rmId : null,
        pack_material_id: type === 'PM' ? pmId : null,
        product_id: null,
        status: 'Active',
      },
      { transaction: t }
    );
  }

  let rateRow = await ItemListVendorRate.findOne({
    where: { items_list_id: listRow.id, vendor_id: vendorId, ...vendorRatesPartyWhere() },
    transaction: t,
  });
  if (!rateRow) {
    rateRow = await ItemListVendorRate.create(
      {
        items_list_id: listRow.id,
        vendor_id: vendorId,
        party_type: 'vendor',
        default_rate: price,
        default_moq: qty,
        lead_time_days: leadDays,
        currency: 'INR',
        payment_terms: paymentTerms || null,
        status: 'active',
      },
      { transaction: t }
    );
  } else {
    await rateRow.update(
      {
        default_rate: price,
        default_moq: qty,
        ...(leadDays != null ? { lead_time_days: leadDays } : {}),
        ...(paymentTerms !== undefined ? { payment_terms: paymentTerms || null } : {}),
        status: 'active',
      },
      { transaction: t }
    );
  }

  const tiersForRate = await ItemListTier.findAll({
    where: { item_list_vendor_rate_id: rateRow.id },
    transaction: t,
  });
  const existingTier = tiersForRate.find((tier) => moqValuesEqual(tier.moq_min, qty)) ?? null;
  if (existingTier) {
    await existingTier.update({ price_per_unit: price }, { transaction: t });
  } else {
    await ItemListTier.create(
      {
        item_list_vendor_rate_id: rateRow.id,
        moq_min: qty,
        moq_max: null,
        price_per_unit: price,
        valid_till: null,
        note: 'Synced from Procurement quotation',
      },
      { transaction: t }
    );
  }
}

function formatQuotation(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: d.id,
    procurementRequestId: d.procurement_request_id,
    vendorId: d.vendor_id,
    quoteDate: d.quote_date,
    quotedBy: d.quoted_by,
    attachmentRef: d.attachment_ref,
    attachmentStatus: d.attachment_status,
    items: d.items,
    leadTimeDays: d.lead_time_days,
    paymentTerms: d.payment_terms,
    validTill: d.valid_till,
    totalValue: d.total_value != null ? Number(d.total_value) : null,
    notes: d.notes,
    status: d.status,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    vendorName: d.vendor?.name ?? null,
    procurementRequest: d.procurementRequest
      ? {
          id: d.procurementRequest.id,
          priority: d.procurementRequest.priority,
          requiredByDate: d.procurementRequest.required_by_date ?? d.procurementRequest.requiredByDate,
          status: d.procurementRequest.status,
        }
      : undefined,
  };
}

async function listProcurementQuotations(req, res) {
  try {
    const procurementRequestId =
      req.query.procurement_request_id != null ? parseInt(req.query.procurement_request_id, 10) : null;
    const vendorId = req.query.vendor_id != null ? parseInt(req.query.vendor_id, 10) : null;
    const status = req.query.status || null;
    const filters = {};
    if (procurementRequestId != null && !Number.isNaN(procurementRequestId)) {
      filters.procurement_request_id = procurementRequestId;
    }
    if (vendorId != null && !Number.isNaN(vendorId)) {
      filters.vendor_id = vendorId;
    }
    if (status) {
      filters.status = status;
    }
    const rows = await ProcurementQuotation.findAll({
      where: activeRowWhere(filters),
      order: [['quote_date', 'DESC'], ['created_at', 'DESC']],
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', attributes: ['id', 'priority', 'required_by_date', 'status', 'items'], required: false },
        { model: VendorClient, as: 'vendor', attributes: ['id', 'name', 'entity_code', 'category', 'payment_terms', 'rating'], required: false },
      ],
    });
    const formatted = await Promise.all(
      rows.map(async (r) => {
        const out = formatQuotation(r);
        const items = Array.isArray(out.items) ? out.items : [];
        const enriched = await enrichQuotationItemsFromItemsList(out.vendorId, items);
        const totalValue = enriched.reduce((sum, x) => sum + (Number(x.totalValue) || 0), 0);
        const lineLeads = enriched.map((x) => Number(x.leadTimeDays ?? 0)).filter((n) => Number.isFinite(n) && n > 0);
        const maxLineLead = lineLeads.length ? Math.max(...lineLeads) : 0;
        const headerLead = Number(out.leadTimeDays ?? 0) || 0;
        const leadTimeDays =
          headerLead > 0 ? headerLead : maxLineLead > 0 ? maxLineLead : out.leadTimeDays ?? null;
        return { ...out, items: enriched, totalValue, leadTimeDays };
      })
    );
    const shouldDebug = process.env.NODE_ENV !== 'production';
    if (shouldDebug) {
      try {
        // eslint-disable-next-line no-console
        console.log('[procurementQuotations:list] count=', formatted.length);
        formatted.slice(0, 25).forEach((q) => {
          // eslint-disable-next-line no-console
          console.log('[procurementQuotations:list] quotation', {
            id: q.id,
            procurementRequestId: q.procurementRequestId,
            vendorId: q.vendorId,
            vendorName: q.vendorName,
            status: q.status,
            itemsCount: Array.isArray(q.items) ? q.items.length : 0,
          });
          const items = Array.isArray(q.items) ? q.items : [];
          items.slice(0, 30).forEach((it, idx) => {
            // eslint-disable-next-line no-console
            console.log('[procurementQuotations:list] item', {
              idx,
              itemId: it.itemId,
              name: it.name,
              raw_material_id: it.raw_material_id ?? null,
              pack_material_id: it.pack_material_id ?? null,
              orderQty: it.orderQty,
              pricePerUnit: it.pricePerUnit,
            });
          });
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[procurementQuotations:list] debug log failed', e);
      }
    }
    res.json(formatted);
  } catch (err) {
    console.error('listProcurementQuotations error', err);
    res.status(500).json({ error: 'Failed to list procurement quotations' });
  }
}

/**
 * GET /quote-line-defaults?procurementRequestId=&vendorId=
 * Returns PR items with pricePerUnit and totalValue from Items List for the given vendor.
 */
async function getQuoteLineDefaults(req, res) {
  try {
    const prId = req.query.procurementRequestId != null ? parseInt(req.query.procurementRequestId, 10) : null;
    const vId = req.query.vendorId != null ? parseInt(req.query.vendorId, 10) : null;
    if (prId == null || Number.isNaN(prId) || vId == null || Number.isNaN(vId)) {
      return res.status(400).json({ error: 'procurementRequestId and vendorId are required' });
    }
    const [prRow, vendorRow] = await Promise.all([
      ProcurementRequest.findByPk(prId),
      VendorClient.findByPk(vId),
    ]);
    if (!prRow) return res.status(404).json({ error: 'Procurement request not found' });
    if (!vendorRow) return res.status(404).json({ error: 'Vendor not found' });
    const prItems = Array.isArray(prRow.items) ? prRow.items : [];
    const lines = [];
    for (const it of prItems) {
      const qty = Number(it.quantity_requested ?? it.orderQty ?? 0) || 0;
      const price = await getVendorPriceFromItemsList(vId, it.raw_material_id ?? null, it.pack_material_id ?? null);
      const priceNum = price != null ? price : 0;
      lines.push({
        type: it.type || 'RM',
        raw_material_id: it.raw_material_id ?? null,
        pack_material_id: it.pack_material_id ?? null,
        itemId: it.code ?? it.itemId ?? '',
        name: it.name ?? '',
        orderQty: qty,
        uom: it.unit ?? it.uom ?? 'KG',
        pricePerUnit: priceNum,
        totalValue: qty * priceNum,
      });
    }
    res.json({ items: lines });
  } catch (err) {
    console.error('getQuoteLineDefaults error', err);
    res.status(500).json({ error: 'Failed to get quote line defaults' });
  }
}

async function getProcurementQuotationById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementQuotation.findByPk(id, {
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', required: false },
        { model: VendorClient, as: 'vendor', required: false },
      ],
    });
    if (!row) return res.status(404).json({ error: 'Procurement quotation not found' });
    const out = formatQuotation(row);
    const items = Array.isArray(out.items) ? out.items : [];
    const enriched = await enrichQuotationItemsFromItemsList(out.vendorId, items);
    const totalValue = enriched.reduce((sum, x) => sum + (Number(x.totalValue) || 0), 0);
    const lineLeads = enriched.map((x) => Number(x.leadTimeDays ?? 0)).filter((n) => Number.isFinite(n) && n > 0);
    const maxLineLead = lineLeads.length ? Math.max(...lineLeads) : 0;
    const headerLead = Number(out.leadTimeDays ?? 0) || 0;
    const leadTimeDays =
      headerLead > 0 ? headerLead : maxLineLead > 0 ? maxLineLead : out.leadTimeDays ?? null;
    res.json({ ...out, items: enriched, totalValue, leadTimeDays });
  } catch (err) {
    console.error('getProcurementQuotationById error', err);
    res.status(500).json({ error: 'Failed to fetch procurement quotation' });
  }
}

async function createProcurementQuotation(req, res) {
  try {
    const body = req.body || {};
    const procurementRequestId = body.procurementRequestId ?? body.procurement_request_id;
    const vendorId = body.vendorId ?? body.vendor_id;
    if (vendorId == null) {
      return res.status(400).json({ error: 'vendorId is required' });
    }
    const vId = parseInt(vendorId, 10);
    if (Number.isNaN(vId)) return res.status(400).json({ error: 'Invalid vendorId' });
    const vendorRow = await VendorClient.findByPk(vId);
    if (!vendorRow) return res.status(404).json({ error: 'Vendor not found' });

    let prId = null;
    let prRow = null;
    if (procurementRequestId != null && String(procurementRequestId).trim() !== '') {
      prId = parseInt(procurementRequestId, 10);
      if (!Number.isNaN(prId)) {
        prRow = await ProcurementRequest.findByPk(prId);
        if (!prRow) return res.status(404).json({ error: 'Procurement request not found' });
      }
    }

    const prItems = prRow && Array.isArray(prRow.items) ? prRow.items : [];
    let items = Array.isArray(body.items) && body.items.length > 0 ? body.items : prItems.map((it) => ({
      type: it.type || 'RM',
      raw_material_id: it.raw_material_id ?? null,
      pack_material_id: it.pack_material_id ?? null,
      itemId: it.code ?? it.itemId ?? '',
      name: it.name ?? '',
      orderQty: it.quantity_requested ?? it.orderQty ?? 0,
      uom: it.unit ?? it.uom ?? 'KG',
      pricePerUnit: it.pricePerUnit,
      totalValue: it.totalValue,
    }));

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required. Add items to the quote or select a procurement request to pull items from.' });
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = Number(it.orderQty ?? it.quantity_requested ?? 0) || 0;
      let price = it.pricePerUnit != null ? Number(it.pricePerUnit) : null;
      if (price == null || Number.isNaN(price) || price === 0) {
        price = await getVendorPriceFromItemsList(vId, it.raw_material_id ?? null, it.pack_material_id ?? null);
      }
      const priceNum = price != null && !Number.isNaN(Number(price)) ? Number(price) : 0;
      const totalValue = qty * priceNum;
      const listLead = await getVendorLeadFromItemsList(vId, it.raw_material_id ?? null, it.pack_material_id ?? null);
      const lineLeadRaw = it.leadTimeDays ?? it.lead_time_days;
      const lineLead = lineLeadRaw != null && lineLeadRaw !== '' ? Number(lineLeadRaw) : null;
      const leadTimeDays =
        listLead != null
          ? listLead
          : lineLead != null && Number.isFinite(lineLead) && lineLead >= 0
            ? lineLead
            : null;
      items[i] = {
        ...it,
        itemId: it.itemId ?? it.code ?? '',
        name: it.name ?? '',
        orderQty: qty,
        uom: it.uom ?? 'KG',
        pricePerUnit: priceNum,
        totalValue,
        leadTimeDays,
      };
    }
    const itemsWithHistory = withPriceHistory(items, {
      previousItems: [],
      actor: req.user?.email ?? null,
      reason: 'Initial quotation price',
    });
    const totalValue = itemsWithHistory.reduce((sum, it) => sum + (Number(it.totalValue) || 0), 0);
    const lineLeadsForHeader = items
      .map((it) => Number(it.leadTimeDays ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const maxLineLeadHeader = lineLeadsForHeader.length ? Math.max(...lineLeadsForHeader) : 0;
    let headerLeadDays = body.leadTimeDays ?? body.lead_time_days;
    headerLeadDays = headerLeadDays != null && headerLeadDays !== '' ? parseInt(String(headerLeadDays), 10) : null;
    if (headerLeadDays == null || Number.isNaN(headerLeadDays) || headerLeadDays <= 0) {
      headerLeadDays = maxLineLeadHeader > 0 ? maxLineLeadHeader : null;
    }

    const t = await db.transaction();
    let row;
    try {
      row = await ProcurementQuotation.create({
      procurement_request_id: prId ?? null,
      vendor_id: vId,
      quote_date: body.quoteDate ?? body.quote_date ?? null,
      quoted_by: body.quotedBy ?? body.quoted_by ?? req.user?.email ?? null,
      attachment_ref: body.attachmentRef ?? body.attachment_ref ?? null,
      attachment_status: body.attachmentStatus ?? body.attachment_status ?? 'pending',
      items: itemsWithHistory,
      lead_time_days: headerLeadDays,
      payment_terms: body.paymentTerms ?? body.payment_terms ?? null,
      valid_till: body.validTill ?? body.valid_till ?? null,
      total_value: body.totalValue ?? body.total_value ?? totalValue,
      notes: body.notes ?? null,
      status: body.status ?? 'pending',
      }, { transaction: t });

      // Sync into Items List (single source of truth for vendor rates).
      for (const it of itemsWithHistory) {
        await upsertItemsListRateFromQuotationLine(t, vId, it, body.paymentTerms ?? body.payment_terms);
      }

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
    const shouldDebug = process.env.NODE_ENV !== 'production';
    if (shouldDebug) {
      try {
        // eslint-disable-next-line no-console
        console.log('[procurementQuotations:create] persisted', {
          id: row.id,
          vendorId: vId,
          procurementRequestId: prId,
            itemsCount: Array.isArray(itemsWithHistory) ? itemsWithHistory.length : 0,
        });
        (Array.isArray(itemsWithHistory) ? itemsWithHistory : []).slice(0, 50).forEach((it, idx) => {
          // eslint-disable-next-line no-console
          console.log('[procurementQuotations:create] item', {
            idx,
            itemId: it.itemId,
            name: it.name,
            raw_material_id: it.raw_material_id ?? null,
            pack_material_id: it.pack_material_id ?? null,
            orderQty: it.orderQty,
            pricePerUnit: it.pricePerUnit,
          });
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[procurementQuotations:create] debug log failed', e);
      }
    }
    const created = await ProcurementQuotation.findByPk(row.id, {
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', attributes: ['id', 'priority', 'required_by_date', 'status'], required: false },
        { model: VendorClient, as: 'vendor', attributes: ['id', 'name', 'entity_code'], required: false },
      ],
    });
    res.status(201).json(formatQuotation(created));
  } catch (err) {
    console.error('createProcurementQuotation error', err);
    res.status(500).json({ error: 'Failed to create procurement quotation' });
  }
}

async function updateProcurementQuotation(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementQuotation.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement quotation not found' });
    const body = req.body || {};
    const updates = {};
    if (body.quoteDate !== undefined) updates.quote_date = body.quoteDate;
    if (body.quote_date !== undefined) updates.quote_date = body.quote_date;
    if (body.quotedBy !== undefined) updates.quoted_by = body.quotedBy;
    if (body.quoted_by !== undefined) updates.quoted_by = body.quoted_by;
    if (body.attachmentRef !== undefined) updates.attachment_ref = body.attachmentRef;
    if (body.attachment_ref !== undefined) updates.attachment_ref = body.attachment_ref;
    if (body.attachmentStatus !== undefined) updates.attachment_status = body.attachmentStatus;
    if (body.attachment_status !== undefined) updates.attachment_status = body.attachment_status;
    if (body.items !== undefined) {
      updates.items = withPriceHistory(body.items, {
        previousItems: row.items,
        actor: req.user?.email ?? null,
      });
      updates.total_value = (Array.isArray(updates.items) ? updates.items : []).reduce(
        (sum, it) => sum + (Number(it.totalValue) || 0),
        0
      );
    }
    if (body.leadTimeDays !== undefined) updates.lead_time_days = body.leadTimeDays;
    if (body.lead_time_days !== undefined) updates.lead_time_days = body.lead_time_days;
    if (body.paymentTerms !== undefined) updates.payment_terms = body.paymentTerms;
    if (body.payment_terms !== undefined) updates.payment_terms = body.payment_terms;
    if (body.validTill !== undefined) updates.valid_till = body.validTill;
    if (body.valid_till !== undefined) updates.valid_till = body.valid_till;
    if (body.totalValue !== undefined) updates.total_value = body.totalValue;
    if (body.total_value !== undefined) updates.total_value = body.total_value;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.status !== undefined) updates.status = body.status;
    const t = await db.transaction();
    try {
      if (Object.keys(updates).length > 0) {
        await row.update(updates, { transaction: t });
      }
      // If items/paymentTerms updated, sync latest pricing into Items List.
      const vendorId = row.vendor_id;
      const paymentTerms = updates.payment_terms !== undefined ? updates.payment_terms : row.payment_terms;
      const items = updates.items !== undefined ? updates.items : row.items;
      if (vendorId != null && Array.isArray(items)) {
        for (const it of items) {
          await upsertItemsListRateFromQuotationLine(t, vendorId, it, paymentTerms);
        }
      }
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
    const updated = await ProcurementQuotation.findByPk(id, {
      include: [
        { model: ProcurementRequest, as: 'procurementRequest', attributes: ['id', 'priority', 'required_by_date', 'status'], required: false },
        { model: VendorClient, as: 'vendor', attributes: ['id', 'name', 'entity_code'], required: false },
      ],
    });
    res.json(formatQuotation(updated));
  } catch (err) {
    console.error('updateProcurementQuotation error', err);
    res.status(500).json({ error: 'Failed to update procurement quotation' });
  }
}

async function deleteProcurementQuotation(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ProcurementQuotation.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Procurement quotation not found' });
    await softDeleteInstance(row);
    res.status(204).send();
  } catch (err) {
    console.error('deleteProcurementQuotation error', err);
    res.status(500).json({ error: 'Failed to delete procurement quotation' });
  }
}

module.exports = {
  listProcurementQuotations,
  getQuoteLineDefaults,
  getProcurementQuotationById,
  createProcurementQuotation,
  updateProcurementQuotation,
  deleteProcurementQuotation,
};
