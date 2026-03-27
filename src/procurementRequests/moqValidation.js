const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');

const EPS_KG = 1e-4;

function tierMinMoq(tiersPlain) {
  if (!Array.isArray(tiersPlain) || !tiersPlain.length) return 1;
  const mins = tiersPlain.map((t) => Number(t.moq_min)).filter((n) => Number.isFinite(n) && n > 0);
  return mins.length ? Math.min(...mins) : 1;
}

/**
 * Same basis as orders/checkoutTermsFromBom termsAndMoqForItemsListRow: default_moq or smallest tier moq_min.
 */
function effectiveMoqForRate(ratePlain, tiersForRate) {
  const moq = Number(ratePlain.default_moq) > 0 ? Number(ratePlain.default_moq) : tierMinMoq(tiersForRate);
  return Math.max(1, Math.floor(moq));
}

/**
 * Minimum MOQ across active vendor rates for an items_list row (buyer can use the most permissive vendor).
 */
async function getMinMoqForItemsListId(itemsListId) {
  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: itemsListId },
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

function lineIsKg(line) {
  const u = String(line.unit || '').toUpperCase();
  if (u === 'KG' || u === 'KGS') return true;
  if (line.type === 'RM') return true;
  return false;
}

/**
 * Validates procurement line quantities against Items List MOQ.
 * Optional line.moq_min / line.moqMin = vendor tier MOQ from Planning (Release to Planning); otherwise uses
 * minimum effective MOQ across vendors for that material.
 */
async function validateProcurementItemsMoq(items) {
  if (!Array.isArray(items)) return { ok: true, errors: [] };
  const errors = [];
  for (let index = 0; index < items.length; index += 1) {
    const line = items[index] || {};
    const qty = Number(line.quantity_requested);
    if (!Number.isFinite(qty) || qty <= 0) {
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
      // No Items List row or no MOQ configured — allow.
      // eslint-disable-next-line no-continue
      continue;
    }

    const isKg = lineIsKg(line);
    const ok = isKg ? qty + EPS_KG >= requiredMoq : qty + 1e-6 >= requiredMoq;
    if (!ok) {
      const label = line.code || line.name || `Line ${index + 1}`;
      const u = isKg ? 'kg' : 'units';
      errors.push({
        index,
        message: `MOQ not met for ${label}: quantity ${qty} is below minimum ${requiredMoq} ${u} (Items List / vendor tier).`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateProcurementItemsMoq,
};
