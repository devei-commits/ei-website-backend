/**
 * SKU BOM: per-unit RM quantities vs net limit (mass or volume).
 * Limit UOM: G, GM, KG (mass) or ML, L (volume).
 * Line UOMs may be mass or volume even when the limit is the other kind (planning converts via SG).
 * Sum-equals-limit is enforced only when every line matches the limit dimension (no mass/volume mix vs limit).
 */

function normUom(u) {
  const x = String(u ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (['G', 'GM', 'GRAM', 'GRAMS'].includes(x)) return 'G';
  if (['KG', 'KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS'].includes(x)) return 'KG';
  if (['ML', 'MILLILITER', 'MILLILITRE', 'MILLILITERS', 'MILLILITRES'].includes(x)) return 'ML';
  if (['L', 'LITER', 'LITRE', 'LITERS', 'LITRES'].includes(x)) return 'L';
  if (['PCS', 'PC', 'EA', 'EACH', 'UNIT', 'UNITS', 'PIECE', 'PIECES'].includes(x)) return 'PCS';
  return x || 'G';
}

function dimensionOfLimitUom(uom) {
  const u = normUom(uom);
  if (['G', 'KG'].includes(u)) return 'mass';
  if (['ML', 'L'].includes(u)) return 'volume';
  return null;
}

function dimensionOfLineUom(uom) {
  const u = normUom(uom);
  if (['G', 'KG'].includes(u)) return 'mass';
  if (['ML', 'L'].includes(u)) return 'volume';
  if (u === 'PCS') return 'count';
  return null;
}

/** Convert qty to milligrams (internal mass base). */
function toMg(qty, uom) {
  const u = normUom(uom);
  const q = parseFloat(String(qty).replace(/[^\d.-]/g, ''));
  if (Number.isNaN(q) || q < 0) {
    throw new Error(`Invalid SKU BOM quantity: ${qty}`);
  }
  if (u === 'G') return q * 1000;
  if (u === 'KG') return q * 1_000_000;
  throw new Error(`UOM "${uom}" is not a mass unit (use G, GM, or KG)`);
}

/** Convert qty to microliters (internal volume base). */
function toMicroL(qty, uom) {
  const u = normUom(uom);
  const q = parseFloat(String(qty).replace(/[^\d.-]/g, ''));
  if (Number.isNaN(q) || q < 0) {
    throw new Error(`Invalid SKU BOM quantity: ${qty}`);
  }
  if (u === 'ML') return q * 1000;
  if (u === 'L') return q * 1_000_000;
  throw new Error(`UOM "${uom}" is not a volume unit (use ML or L)`);
}

function limitToMg(limitQty, limitUom) {
  return toMg(limitQty, limitUom);
}

function limitToMicroL(limitQty, limitUom) {
  return toMicroL(limitQty, limitUom);
}

function formatMassFromMg(mg, displayUom) {
  const u = normUom(displayUom);
  if (u === 'KG') return mg / 1_000_000;
  return mg / 1000;
}

function formatVolumeFromMicroL(microL, displayUom) {
  const u = normUom(displayUom);
  if (u === 'L') return microL / 1_000_000;
  return microL / 1000;
}

function countMeaningfulSkuRmLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter((line) => {
    const qtyRaw = line?.qty_per_unit ?? line?.qtyPerUnit;
    const qty = parseFloat(String(qtyRaw ?? '').replace(/[^\d.-]/g, ''));
    const hasQty = !Number.isNaN(qty) && qty > 0;
    const name = String(line?.inci_name ?? line?.inciName ?? '').trim();
    const code = String(line?.rm_code ?? line?.rmCode ?? '').trim();
    return hasQty && (name || code);
  }).length;
}

function parseLimitQty(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^\d.-]/g, ''));
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

/**
 * @param {{ lines: unknown[], limitQty: unknown, limitUom: unknown }}
 * @returns {{ ok: boolean, code?: string, error?: string, sumInDisplay?: number, limitInDisplay?: number, displayUom?: string }}
 */
function validateSkuBomTotals({ lines, limitQty, limitUom }) {
  const meaningful = countMeaningfulSkuRmLines(lines);
  const limQ = parseLimitQty(limitQty);
  const limU = limitUom != null && String(limitUom).trim() !== '' ? String(limitUom).trim() : null;
  const dim = limU ? dimensionOfLimitUom(limU) : null;

  if (meaningful === 0 && !limQ && !limU) {
    return { ok: true };
  }
  if (meaningful > 0 && (!limQ || !limU || !dim)) {
    return {
      ok: false,
      code: 'SKU_BOM_LIMIT_REQUIRED',
      error:
        'SKU BOM lines are present: set net per-unit limit quantity and UOM (e.g. 50 GM or 50 ML) so the sum of lines can match exactly.',
    };
  }
  if ((limQ || limU) && meaningful === 0) {
    return {
      ok: false,
      code: 'SKU_BOM_LINES_REQUIRED',
      error: 'SKU BOM net per-unit limit is set: add RM lines whose quantities sum to that limit exactly.',
    };
  }
  if (!dim) {
    return {
      ok: false,
      code: 'SKU_BOM_LIMIT_UOM',
      error: 'Limit UOM must be G, GM, KG, ML, or L.',
    };
  }

  try {
    if (dim === 'mass') limitToMg(limQ, limU);
    else limitToMicroL(limQ, limU);
  } catch (e) {
    return { ok: false, code: 'SKU_BOM_LIMIT_UOM', error: e.message || 'Invalid limit UOM' };
  }

  let sumBase = 0;
  let hasCrossDimensionLine = false;
  const arr = Array.isArray(lines) ? lines : [];
  for (let i = 0; i < arr.length; i += 1) {
    const line = arr[i] || {};
    const qtyRaw = line.qty_per_unit ?? line.qtyPerUnit;
    const qty = parseFloat(String(qtyRaw ?? '').replace(/[^\d.-]/g, ''));
    const name = String(line.inci_name ?? line.inciName ?? '').trim();
    const code = String(line.rm_code ?? line.rmCode ?? '').trim();
    if (!Number.isNaN(qty) && qty > 0 && (name || code)) {
      const lu = line.uom || 'G';
      const lineDim = dimensionOfLineUom(lu);
      if (lineDim === 'count') {
        return {
          ok: false,
          code: 'SKU_BOM_LINE_UOM',
          error: `SKU BOM line ${i + 1}: PCS/count units cannot be mixed with a weight/volume limit. Use G, KG, or ML.`,
        };
      }
      if (lineDim !== 'mass' && lineDim !== 'volume') {
        return {
          ok: false,
          code: 'SKU_BOM_LINE_UOM',
          error: `SKU BOM line ${i + 1}: UOM "${lu}" must be G, GM, KG, ML, or L.`,
        };
      }
      if (lineDim !== dim) {
        hasCrossDimensionLine = true;
        try {
          if (lineDim === 'mass') toMg(qty, lu);
          else toMicroL(qty, lu);
        } catch (e) {
          return {
            ok: false,
            code: 'SKU_BOM_LINE_QTY',
            error: e.message || `Invalid quantity on SKU BOM line ${i + 1}`,
          };
        }
        continue;
      }
      try {
        sumBase += dim === 'mass' ? toMg(qty, lu) : toMicroL(qty, lu);
      } catch (e) {
        return {
          ok: false,
          code: 'SKU_BOM_LINE_QTY',
          error: e.message || `Invalid quantity on SKU BOM line ${i + 1}`,
        };
      }
    }
  }

  if (!hasCrossDimensionLine) {
    const sumInDisplay =
      dim === 'mass' ? formatMassFromMg(sumBase, limU) : formatVolumeFromMicroL(sumBase, limU);
    const limitInDisplay = limQ;
    if (Math.abs(sumInDisplay - limitInDisplay) > 0.001) {
      return {
        ok: false,
        code: 'SKU_BOM_SUM_MISMATCH',
        error: `SKU BOM quantities must equal the net per-unit limit exactly (tolerance 0.001 ${normUom(limU)}). Current total ${sumInDisplay.toFixed(6)} ${normUom(limU)} vs limit ${limitInDisplay} ${normUom(limU)}.`,
        sumInDisplay,
        limitInDisplay,
        displayUom: normUom(limU),
      };
    }
    return {
      ok: true,
      sumInDisplay,
      limitInDisplay,
      displayUom: normUom(limU),
    };
  }

  return {
    ok: true,
    displayUom: normUom(limU),
  };
}

module.exports = {
  normUom,
  countMeaningfulSkuRmLines,
  parseLimitQty,
  validateSkuBomTotals,
};
