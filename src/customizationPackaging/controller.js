const CustomizationPackagingOption = require('./models');

function normalizeSpecs(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    skuVol: d.skuVol != null ? String(d.skuVol) : '',
    material: d.material != null ? String(d.material) : '',
    color: d.color != null ? String(d.color) : '',
    pantone: d.pantone != null ? String(d.pantone) : '',
    dispensing: d.dispensing != null ? String(d.dispensing) : '',
    pumpMaterial: d.pumpMaterial != null ? String(d.pumpMaterial) : '',
    pumpColor: d.pumpColor != null ? String(d.pumpColor) : '',
    capMaterial: d.capMaterial != null ? String(d.capMaterial) : '',
    capColor: d.capColor != null ? String(d.capColor) : '',
    moq: Number(d.moq) || 0,
  };
}

/** Website + admin shared shape (camelCase for JSON clients). */
function formatOption(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const specs = normalizeSpecs(d.specs);
  return {
    id: d.option_id,
    dbId: d.id,
    title: d.title || '',
    subtitle: d.subtitle || '',
    reviewLabel: d.review_label || '',
    skuCode: d.sku_code || '',
    custom: Boolean(d.is_custom),
    sortOrder: d.sort_order ?? 0,
    active: Boolean(d.active),
    specs,
  };
}

async function listPublicCustomizationPackaging(req, res) {
  try {
    const rows = await CustomizationPackagingOption.findAll({
      where: { active: true },
      order: [
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    res.status(200).json({ success: true, data: rows.map(formatOption) });
  } catch (err) {
    console.error('listPublicCustomizationPackaging', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load packaging options' });
  }
}

async function listAdminCustomizationPackaging(req, res) {
  try {
    const rows = await CustomizationPackagingOption.findAll({
      order: [
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    res.status(200).json({ success: true, data: rows.map(formatOption) });
  } catch (err) {
    console.error('listAdminCustomizationPackaging', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load packaging options' });
  }
}

async function getCustomizationPackagingByPk(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const row = await CustomizationPackagingOption.findByPk(id);
    if (!row) return res.status(404).json({ success: false, message: 'Not found' });
    res.status(200).json({ success: true, data: formatOption(row) });
  } catch (err) {
    console.error('getCustomizationPackagingByPk', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load option' });
  }
}

function bodyToCreateValues(b) {
  const optionId = String(b.option_id ?? b.optionId ?? '').trim();
  if (!optionId) {
    const err = new Error('option_id is required');
    err.statusCode = 400;
    throw err;
  }
  return {
    option_id: optionId.slice(0, 80),
    title: String(b.title ?? '').slice(0, 200) || optionId,
    subtitle: b.subtitle != null ? String(b.subtitle).slice(0, 400) : null,
    review_label: b.review_label != null ? String(b.review_label).slice(0, 400) : b.reviewLabel != null ? String(b.reviewLabel).slice(0, 400) : null,
    sku_code: b.sku_code != null ? String(b.sku_code).slice(0, 100) : b.skuCode != null ? String(b.skuCode).slice(0, 100) : null,
    is_custom: Boolean(b.is_custom ?? b.isCustom),
    sort_order: Number(b.sort_order ?? b.sortOrder) || 0,
    active: b.active === undefined || b.active === null ? true : Boolean(b.active),
    specs: normalizeSpecs(b.specs),
  };
}

async function createCustomizationPackaging(req, res) {
  try {
    const values = bodyToCreateValues(req.body || {});
    const row = await CustomizationPackagingOption.create(values);
    res.status(201).json({ success: true, data: formatOption(row) });
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('createCustomizationPackaging', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create' });
  }
}

async function updateCustomizationPackaging(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const row = await CustomizationPackagingOption.findByPk(id);
    if (!row) return res.status(404).json({ success: false, message: 'Not found' });
    const b = req.body || {};
    const patch = {};
    if (b.option_id !== undefined || b.optionId !== undefined) {
      const oid = String(b.option_id ?? b.optionId ?? '').trim();
      if (!oid) return res.status(400).json({ success: false, message: 'option_id cannot be empty' });
      patch.option_id = oid.slice(0, 80);
    }
    if (b.title !== undefined) patch.title = String(b.title).slice(0, 200);
    if (b.subtitle !== undefined) patch.subtitle = b.subtitle == null ? null : String(b.subtitle).slice(0, 400);
    if (b.review_label !== undefined || b.reviewLabel !== undefined) {
      const v = b.review_label ?? b.reviewLabel;
      patch.review_label = v == null ? null : String(v).slice(0, 400);
    }
    if (b.sku_code !== undefined || b.skuCode !== undefined) {
      const v = b.sku_code ?? b.skuCode;
      patch.sku_code = v == null ? null : String(v).slice(0, 100);
    }
    if (b.is_custom !== undefined || b.isCustom !== undefined) patch.is_custom = Boolean(b.is_custom ?? b.isCustom);
    if (b.sort_order !== undefined || b.sortOrder !== undefined) patch.sort_order = Number(b.sort_order ?? b.sortOrder) || 0;
    if (b.active !== undefined) patch.active = Boolean(b.active);
    if (b.specs !== undefined) patch.specs = normalizeSpecs(b.specs);
    await row.update(patch);
    await row.reload();
    res.status(200).json({ success: true, data: formatOption(row) });
  } catch (err) {
    console.error('updateCustomizationPackaging', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to update' });
  }
}

async function deleteCustomizationPackaging(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const row = await CustomizationPackagingOption.findByPk(id);
    if (!row) return res.status(404).json({ success: false, message: 'Not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteCustomizationPackaging', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to delete' });
  }
}

module.exports = {
  formatOption,
  listPublicCustomizationPackaging,
  listAdminCustomizationPackaging,
  getCustomizationPackagingByPk,
  createCustomizationPackaging,
  updateCustomizationPackaging,
  deleteCustomizationPackaging,
};
