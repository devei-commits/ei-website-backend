const BOM = require('./models');
const { Op } = require('sequelize');

function parseSuffix(code, prefix) {
  if (!code || !prefix || !String(code).startsWith(prefix)) return null;
  const rest = String(code).slice(prefix.length).replace(/^-+/, '');
  const num = parseInt(rest, 10);
  return Number.isNaN(num) ? null : num;
}

function formatBOM(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    bomCode: d.bom_code,
    bomSku: d.bom_sku,
    zohoId: d.zoho_id,
    bomCategory: d.bom_category,
    bomUnit: d.bom_unit,
    bomTaxPreference: d.bom_tax_preference,
    bomReturnable: d.bom_returnable,
    bomAssociateItems: d.bom_associate_items,
    bomCompositeItem: d.bom_composite_item,
    type: d.type,
    status: d.status,
    version: d.version,
    client: d.client,
    name: d.name,
    dosage: d.dosage,
    packSize: d.pack_size,
    site: d.site,
    category: d.category,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    claims: d.claims,
    project: d.project,
    market: d.market,
    createdBy: d.created_by,
    reviewedBy: d.reviewed_by,
    desc: d.desc,
    specBulk: d.spec_bulk,
    specProcess: d.spec_process,
    specFg: d.spec_fg,
    specPack: d.spec_pack,
    specTests: d.spec_tests,
    specRelease: d.spec_release,
    batch: d.batch,
    yield: d.yield_pct,
    overage: d.overage,
    line: d.line,
    notes: d.notes,
    regulatory: d.regulatory,
    phRange: d.ph_range,
    description: d.description,
    rmLines: d.rm_lines,
    pmLines: d.pm_lines,
    productId: d.product_id != null ? d.product_id : null,
  };
}

/**
 * GET /api/v1/bom/next-code?prefix=EI-PR-SKC — next bom_code for series (e.g. EI-PR-SKC-00002).
 */
async function getNextCode(req, res) {
  try {
    const prefix = req.query.prefix != null ? String(req.query.prefix).trim() : '';
    if (!prefix) {
      return res.status(400).json({ error: 'Query parameter "prefix" is required' });
    }
    const rows = await BOM.findAll({
      attributes: ['bom_code'],
      where: { bom_code: { [Op.iLike]: `${prefix}%` } },
    });
    let maxNum = 0;
    for (const row of rows) {
      const code = row.get ? row.get('bom_code') : row.bom_code;
      const n = parseSuffix(code, prefix);
      if (n != null && n > maxNum) maxNum = n;
    }
    const nextNum = maxNum + 1;
    const nextCode = `${prefix}-${String(nextNum).padStart(5, '0')}`;
    res.json({ nextCode });
  } catch (err) {
    console.error('getNextCode (BOM) error', err);
    res.status(500).json({ error: 'Failed to get next code' });
  }
}

async function listBOMs(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const productId = req.query.product_id != null ? parseInt(req.query.product_id, 10) : null;
    const where = {};
    if (search.length > 0) {
      where[Op.or] = [
        { bom_code: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
        { client: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (productId != null && !Number.isNaN(productId)) {
      where.product_id = productId;
    }
    const rows = await BOM.findAll({ where, order: [['bom_code', 'ASC']] });
    res.json(rows.map(formatBOM));
  } catch (err) {
    console.error('listBOMs error', err);
    res.status(500).json({ error: 'Failed to list BOMs' });
  }
}

async function getBOMById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await BOM.findByPk(id);
    if (!row) return res.status(404).json({ error: 'BOM not found' });
    res.json(formatBOM(row));
  } catch (err) {
    console.error('getBOMById error', err);
    res.status(500).json({ error: 'Failed to fetch BOM' });
  }
}

function bodyToBOM(b) {
  return {
    bom_code: b.bomCode ?? b.bom_code ?? '',
    bom_sku: b.bomSku ?? b.bom_sku ?? null,
    zoho_id: b.zohoId ?? b.zoho_id ?? null,
    bom_category: b.bomCategory ?? b.bom_category ?? null,
    bom_unit: b.bomUnit ?? b.bom_unit ?? null,
    bom_hsn: b.bomHsn ?? b.bom_hsn ?? null,
    bom_tax_preference: b.bomTaxPreference ?? b.bom_tax_preference ?? null,
    bom_returnable: b.bomReturnable ?? b.bom_returnable ?? null,
    bom_associate_items: b.bomAssociateItems ?? b.bom_associate_items ?? null,
    bom_composite_item: b.bomCompositeItem ?? b.bom_composite_item ?? null,
    type: b.type ?? null,
    status: b.status ?? null,
    version: b.version ?? null,
    client: b.client ?? null,
    name: b.name ?? null,
    dosage: b.dosage ?? null,
    pack_size: b.packSize ?? b.pack_size ?? null,
    site: b.site ?? null,
    category: b.category ?? null,
    claims: b.claims ?? null,
    project: b.project ?? null,
    market: b.market ?? null,
    created_by: b.createdBy ?? b.created_by ?? null,
    reviewed_by: b.reviewedBy ?? b.reviewed_by ?? null,
    desc: b.desc ?? null,
    spec_bulk: b.specBulk ?? b.spec_bulk ?? null,
    spec_process: b.specProcess ?? b.spec_process ?? null,
    spec_fg: b.specFg ?? b.spec_fg ?? null,
    spec_pack: b.specPack ?? b.spec_pack ?? null,
    spec_tests: b.specTests ?? b.spec_tests ?? null,
    spec_release: b.specRelease ?? b.spec_release ?? null,
    batch: b.batch ?? null,
    yield_pct: b.yield ?? b.yield_pct ?? b.yieldPct ?? null,
    overage: b.overage ?? null,
    line: b.line ?? null,
    notes: b.notes ?? null,
    regulatory: b.regulatory ?? null,
    ph_range: b.phRange ?? b.ph_range ?? null,
    description: b.description ?? null,
    rm_lines: b.rmLines ?? b.rm_lines ?? null,
    pm_lines: b.pmLines ?? b.pm_lines ?? null,
    product_id: b.productId ?? b.product_id ?? null,
  };
}

async function updateBOM(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await BOM.findByPk(id);
    if (!row) return res.status(404).json({ error: 'BOM not found' });
    const b = req.body || {};
    const updates = {};
    if (b.rmLines !== undefined) updates.rm_lines = b.rmLines;
    if (b.pmLines !== undefined) updates.pm_lines = b.pmLines;
    if (Object.keys(updates).length > 0) {
      await row.update(updates);
    }
    const updated = await BOM.findByPk(id);
    res.json(formatBOM(updated));
  } catch (err) {
    console.error('updateBOM error', err);
    res.status(500).json({ error: 'Failed to update BOM' });
  }
}

async function createBOM(req, res) {
  try {
    const body = bodyToBOM(req.body || {});
    if (!body.bom_code || !String(body.bom_code).trim()) {
      return res.status(400).json({ error: 'bomCode is required' });
    }
    const row = await BOM.create(body);
    res.status(201).json(formatBOM(row));
  } catch (err) {
    console.error('createBOM error', err);
    res.status(500).json({ error: 'Failed to create BOM' });
  }
}

module.exports = { listBOMs, getBOMById, getNextCode, createBOM, updateBOM };
