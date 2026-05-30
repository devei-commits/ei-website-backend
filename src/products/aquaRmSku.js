/**
 * Excel filler row "AQUA (q.s. to 100%)" → aqua RM master (code 1000612, Zoho SKU often "RM 1000612").
 */
const { findRawMaterialByMasterSku } = require('./masterSkuLookup');

const AQUA_RM_INTERNAL_CODE = '1000612';
const AQUA_RM_ZOHO_SKU = 'RM 1000612';

/** @type {string[]} */
const AQUA_RM_LOOKUP_SKUS = [AQUA_RM_INTERNAL_CODE, AQUA_RM_ZOHO_SKU, 'RM1000612'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isAquaQsFillerName(value) {
  const norm = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[()/\\]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!norm.includes('aqua')) return false;
  return (
    norm.includes('q s') ||
    norm.includes('q.s') ||
    norm.includes('qs to') ||
    (norm.includes('100') && norm.includes('%'))
  );
}

/**
 * @param {unknown} line
 * @returns {boolean}
 */
function isAquaQsStoredFormulaLine(line) {
  if (!line || typeof line !== 'object') return false;
  return (
    isAquaQsFillerName(line.inci_name) ||
    isAquaQsFillerName(line.inciName) ||
    isAquaQsFillerName(line.name)
  );
}

/**
 * @param {unknown} componentSku
 * @param {unknown} componentName
 * @returns {string}
 */
function applyAquaSkuFromQsName(componentSku, componentName) {
  if (!isAquaQsFillerName(componentName)) {
    return String(componentSku ?? '').trim();
  }
  const sku = String(componentSku ?? '').trim();
  if (sku && !isAquaQsFillerName(sku)) {
    return sku;
  }
  return AQUA_RM_INTERNAL_CODE;
}

/**
 * @param {unknown} componentSku
 * @param {unknown} componentName
 * @returns {Promise<import('../rawMaterials/models') | null>}
 */
async function resolveRawMaterialForBomLine(componentSku, componentName) {
  const primary = applyAquaSkuFromQsName(componentSku, componentName);
  if (primary) {
    const rm = await findRawMaterialByMasterSku(primary);
    if (rm) return rm;
  }
  if (isAquaQsFillerName(componentName)) {
    for (const candidate of AQUA_RM_LOOKUP_SKUS) {
      if (candidate === primary) continue;
      const rm = await findRawMaterialByMasterSku(candidate);
      if (rm) return rm;
    }
  }
  return null;
}

/** @param {import('../rawMaterials/models') | null} rm */
function aquaRmDisplayFields(rm) {
  if (!rm) {
    return {
      inci_name: 'Aqua',
      rm_code: AQUA_RM_INTERNAL_CODE,
      zoho_sku_code: AQUA_RM_ZOHO_SKU,
      raw_material_id: null,
    };
  }
  const plain = rm.get ? rm.get({ plain: true }) : rm;
  return {
    inci_name: plain.inci || plain.name || 'Aqua',
    rm_code: plain.code || AQUA_RM_INTERNAL_CODE,
    zoho_sku_code: plain.zoho_sku_code || AQUA_RM_ZOHO_SKU,
    raw_material_id: plain.id ?? null,
  };
}

/**
 * Build one formula % line; never persist the Excel q.s. filler label when aqua master exists.
 * @param {Record<string, unknown>} gr
 * @param {import('../rawMaterials/models') | null} rm
 * @param {number} pct
 * @param {string} lineUom
 */
function buildFormulaPctRmLine(gr, rm, pct, lineUom) {
  const qsAqua = isAquaQsFillerName(gr.component_name);
  const componentSku = applyAquaSkuFromQsName(gr.component_sku, gr.component_name);

  if (rm) {
    const display = qsAqua ? aquaRmDisplayFields(rm) : null;
    return {
      phase: 'Main',
      inci_name: display
        ? display.inci_name
        : rm.inci || rm.name || String(gr.component_name || ''),
      rm_code: display ? display.rm_code : rm.code || '',
      zoho_sku_code: display
        ? display.zoho_sku_code
        : rm.zoho_sku_code || componentSku || null,
      raw_material_id: rm.id,
      pct_w_w: pct,
      uom: lineUom,
    };
  }

  if (qsAqua) {
    const fallback = aquaRmDisplayFields(null);
    return {
      phase: 'Main',
      inci_name: fallback.inci_name,
      rm_code: fallback.rm_code,
      zoho_sku_code: componentSku || fallback.zoho_sku_code,
      raw_material_id: null,
      pct_w_w: pct,
      uom: lineUom,
    };
  }

  return {
    phase: 'Main',
    inci_name: String(gr.component_name || ''),
    rm_code: '',
    zoho_sku_code: componentSku || null,
    raw_material_id: null,
    pct_w_w: pct,
    uom: lineUom,
  };
}

let cachedAquaRm = undefined;

/** @returns {Promise<import('../rawMaterials/models') | null>} */
async function loadAquaRmMaster() {
  if (cachedAquaRm !== undefined) return cachedAquaRm;
  for (const candidate of AQUA_RM_LOOKUP_SKUS) {
    const rm = await findRawMaterialByMasterSku(candidate);
    if (rm) {
      cachedAquaRm = rm;
      return rm;
    }
  }
  cachedAquaRm = null;
  return null;
}

/**
 * Fix legacy rows saved with "AQUA (q.s. to 100%)" for API / UI display.
 * @param {Record<string, unknown>} line
 * @returns {Promise<Record<string, unknown>>}
 */
async function enrichStoredFormulaRmLine(line) {
  if (!isAquaQsStoredFormulaLine(line)) return line;
  let rm = null;
  const rid = line.raw_material_id ?? line.rawMaterialId;
  if (rid != null) {
    const RawMaterial = require('../rawMaterials/models');
    rm = await RawMaterial.findByPk(rid);
  }
  if (!rm) rm = await loadAquaRmMaster();
  const display = aquaRmDisplayFields(rm);
  return {
    ...line,
    inci_name: display.inci_name,
    inciName: display.inci_name,
    name: display.inci_name,
    rm_code: display.rm_code,
    rmCode: display.rm_code,
    zoho_sku_code: display.zoho_sku_code,
    raw_material_id: display.raw_material_id,
    rawMaterialId: display.raw_material_id,
  };
}

module.exports = {
  AQUA_RM_ZOHO_SKU,
  AQUA_RM_INTERNAL_CODE,
  AQUA_RM_LOOKUP_SKUS,
  isAquaQsFillerName,
  isAquaQsStoredFormulaLine,
  applyAquaSkuFromQsName,
  resolveRawMaterialForBomLine,
  buildFormulaPctRmLine,
  enrichStoredFormulaRmLine,
  loadAquaRmMaster,
};
