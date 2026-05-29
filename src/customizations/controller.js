const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const Customization = require('./models');

const getAllCustomizations = async (req, res) => {
  try {
    const list = await Customization.findAll({
      where: activeRowWhere(),
      order: [['custom_id', 'ASC']],
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get customizations grouped by care → category. Best for destructuring and direct access.
 * Returns: { "Skin care": { "Moisturizer": [...], "Serum": [...] }, "Hair care": { "Shampoo": [...] } }
 * - data[care][category] = array of items
 * - Object.entries(data) for care list, Object.entries(data[care]) for category list
 */
const GroupedCategory = async (req, res) => {
  try {
    const list = await Customization.findAll({
      order: [
        ['care', 'ASC'],
        ['category', 'ASC'],
        ['custom_id', 'ASC'],
      ],
    });
    const careMap = new Map();
    for (const row of list) {
      const careVal = row.care ?? '(Unspecified)';
      const cat = row.category ?? '(Uncategorized)';
      if (!careMap.has(careVal)) {
        careMap.set(careVal, new Map());
      }
      const catMap = careMap.get(careVal);
      if (!catMap.has(cat)) {
        catMap.set(cat, []);
      }
      catMap.get(cat).push(row);
    }
    const result = {};
    const careKeys = [...careMap.keys()].sort();
    for (const care of careKeys) {
      result[care] = {};
      const catKeys = [...careMap.get(care).keys()].sort();
      for (const category of catKeys) {
        result[care][category] = careMap.get(care).get(category);
      }
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const getCustomizationById = async (req, res) => {
  try {
    const id = req.params.id;
    const row = await Customization.findByPk(id);
    if (!row) {
      return res.status(404).json({ error: 'Customization not found' });
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createCustomization = async (req, res) => {
  try {
    const allowed = [
      'name',
      'concentration',
      'description',
      'active_composition',
      'indications',
      'how_to_use',
      'specifications',
      'cautions',
      'frequently_asked_questions',
      'category',
      'incredients',
      'care',
    ];
    const payload = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        if (
          (key === 'active_composition' || key === 'specifications') &&
          typeof req.body[key] === 'object'
        ) {
          payload[key] = JSON.stringify(req.body[key]);
        } else {
          payload[key] = req.body[key];
        }
      }
    });
    const row = await Customization.create(payload);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateCustomization = async (req, res) => {
  try {
    const id = req.params.id;
    const row = await Customization.findByPk(id);
    if (!row) {
      return res.status(404).json({ error: 'Customization not found' });
    }
    const allowed = [
      'name',
      'concentration',
      'description',
      'active_composition',
      'indications',
      'how_to_use',
      'specifications',
      'cautions',
      'frequently_asked_questions',
      'category',
      'incredients',
      'care',
    ];
    const payload = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        if (
          (key === 'active_composition' || key === 'specifications') &&
          typeof req.body[key] === 'object'
        ) {
          payload[key] = JSON.stringify(req.body[key]);
        } else {
          payload[key] = req.body[key];
        }
      }
    });
    await row.update(payload);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteCustomization = async (req, res) => {
  try {
    const row = await Customization.findByPk(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Customization not found' });
    }
    await softDeleteInstance(row);
    res.json({ message: 'Customization deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getAllCustomizations,
  GroupedCategory,
  getCustomizationById,
  createCustomization,
  updateCustomization,
  deleteCustomization,
};
