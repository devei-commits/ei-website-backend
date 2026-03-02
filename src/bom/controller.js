const BOM = require('./models');

function formatBOM(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    bomCode: d.bom_code,
    bomSku: d.bom_sku,
    bomCategory: d.bom_category,
    bomUnit: d.bom_unit,
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
  };
}

async function listBOMs(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const { Op } = require('sequelize');
    const where = {};
    if (search.length > 0) {
      where[Op.or] = [
        { bom_code: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
        { client: { [Op.iLike]: `%${search}%` } },
      ];
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
    bom_category: b.bomCategory ?? b.bom_category ?? null,
    bom_unit: b.bomUnit ?? b.bom_unit ?? null,
    bom_hsn: b.bomHsn ?? b.bom_hsn ?? null,
    bom_tax_preference: b.bomTaxPreference ?? b.bom_tax_preference ?? null,
    bom_returnable: b.bomReturnable ?? b.bom_returnable ?? null,
    bom_associate_items: b.bomAssociateItems ?? b.bom_associate_items ?? null,
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
  };
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

module.exports = { listBOMs, getBOMById, createBOM };
