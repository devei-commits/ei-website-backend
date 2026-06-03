const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const RawMaterial = require('../rawMaterials/models');
const {
  procurementMoqUnitLabel,
  procurementLineQtyInPrimary,
  resolveProcurementLineUnit,
} = require('../lib/rmUnitConversion');
const { buildRmUomById } = require('../lib/procurementQuotationUnits');
const { partyWhereForItemsListRowType } = require('../itemsList/partyTypeWhere');

const EPS = 1e-6;

function tierMinMoq(tiersPlain) {
  if (!Array.isArray(tiersPlain) || !tiersPlain.length) return null;
  const mins = tiersPlain.map((t) => Number(t.moq_min)).filter((n) => Number.isFinite(n) && n > 0);
  return mins.length ? Math.min(...mins) : null;
}

/**
 * Vendor MOQ for procurement: default_moq on the rate, else smallest tier moq_min (Items List).
 * MOQ tiers are stored in the material's standard UoM (same as quotation order qty).
 */
function effectiveMoqForRate(ratePlain, tiersForRate) {
  const fromDefault = Number(ratePlain.default_moq);
  const moq = fromDefault > 0 ? fromDefault : tierMinMoq(tiersForRate);
  return moq != null && moq > 0 ? moq : null;
}

/**
 * Minimum MOQ across active vendor rates for an items_list row (buyer can use the most permissive vendor).
 */
async function getMinMoqForItemsListId(itemsListId) {
  const itemRow = await ItemsList.findByPk(itemsListId);
  if (!itemRow) return null;
  const itemPlain = itemRow.get ? itemRow.get({ plain: true }) : itemRow;
  const partyWhere = partyWhereForItemsListRowType(itemPlain.type);
  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: itemsListId, ...partyWhere },
    order: [['id', 'ASC']],
  });
  const active = rates.filter((r) => String(r.status || '').toLowerCase() !== 'inactive');
  const list = active.length ? active : rates;
  if (!list.length) return null;

  let minM = Infinity;
  for (const rate of list) {
    const plain = rate.get ? rate.get({ plain: true }) : rate;
    const tiers = await ItemListTier.findAll({
      where: { item_list_vendor_rate_id: plain.id },
      order: [['moq_min', 'ASC']],
    });
    const tPlain = tiers.map((t) => (t.get ? t.get({ plain: true }) : t));
    const eff = effectiveMoqForRate(plain, tPlain);
    if (Number.isFinite(eff) && eff > 0) minM = Math.min(minM, eff);
  }
  return minM === Infinity ? null : minM;
}

async function findItemsListIdForLine(line) {
  const rm = line.raw_material_id ?? line.rawMaterialId;
  const pm = line.pack_material_id ?? line.packMaterialId;
  const pr = line.product_id ?? line.productId;
  if (rm != null && Number(rm) > 0) {
    const row = await ItemsList.findOne({
      where: { type: 'RM', raw_material_id: Number(rm) },
      attributes: ['id'],
    });
    return row ? row.id : null;
  }
  if (pm != null && Number(pm) > 0) {
    const row = await ItemsList.findOne({
      where: { type: 'PM', pack_material_id: Number(pm) },
      attributes: ['id'],
    });
    return row ? row.id : null;
  }
  if (pr != null && Number(pr) > 0) {
    const row = await ItemsList.findOne({
      where: { type: 'PR', product_id: Number(pr) },
      attributes: ['id'],
    });
    return row ? row.id : null;
  }
  return null;
}

async function buildRmMetaByIdForLines(items) {
  const rmIds = (items || [])
    .map((line) => (line.raw_material_id != null ? Number(line.raw_material_id) : NaN))
    .filter((id) => Number.isFinite(id) && id > 0);
  const map = new Map();
  if (!rmIds.length) return map;
  const rows = await RawMaterial.findAll({
    where: { id: [...new Set(rmIds)] },
    attributes: ['id', 'uom', 'specific_gravity'],
  });
  for (const r of rows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    map.set(Number(plain.id), {
      uom: plain.uom,
      specific_gravity: plain.specific_gravity,
    });
  }
  return map;
}

/**
 * Validates procurement line quantities against Items List MOQ (standard UoM per material).
 * Optional line.moq_min / line.moqMin = vendor tier MOQ from Planning (Release to Planning).
 */
async function validateProcurementItemsMoq(items) {
  if (!Array.isArray(items)) return { ok: true, errors: [] };
  const errors = [];
  const rmMetaById = await buildRmMetaByIdForLines(items);
  const rmUomById = await buildRmUomById([...rmMetaById.keys()]);

  for (let index = 0; index < items.length; index += 1) {
    const line = items[index] || {};
    const lineType = String(line.type ?? '').trim().toUpperCase();
    const isRm =
      lineType === 'RM' ||
      (line.raw_material_id != null && Number(line.raw_material_id) > 0 && lineType !== 'PM');

    const qtyPrimary = isRm
      ? procurementLineQtyInPrimary(line, rmMetaById.get(Number(line.raw_material_id)))
      : Number(line.quantity_requested) || 0;

    if (!Number.isFinite(qtyPrimary) || qtyPrimary <= 0) {
      errors.push({ index, message: 'Each line needs a positive quantity_requested.' });
      // eslint-disable-next-line no-continue
      continue;
    }

    const explicitMoqRaw = line.moq_min != null ? line.moq_min : line.moqMin;
    const explicitMoq = explicitMoqRaw != null ? Number(explicitMoqRaw) : null;

    const listId = await findItemsListIdForLine(line);
    let requiredMoq = null;
    if (explicitMoq != null && explicitMoq > 0) {
      requiredMoq = explicitMoq;
    } else if (listId != null) {
      requiredMoq = await getMinMoqForItemsListId(listId);
    }

    if (requiredMoq == null || !(requiredMoq > 0)) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const unitLine = { unit: resolveProcurementLineUnit(line, rmUomById) };
    const ok = qtyPrimary + EPS >= requiredMoq;
    if (!ok) {
      const label = line.code || line.name || `Line ${index + 1}`;
      const u = procurementMoqUnitLabel(unitLine);
      errors.push({
        index,
        message: `MOQ not met for ${label}: quantity ${qtyPrimary} is below minimum ${requiredMoq} ${u} (Items List / vendor tier).`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateProcurementItemsMoq,
};
