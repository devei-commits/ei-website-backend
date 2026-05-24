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

  // SKU BOM is optional: no per-unit RM lines → skip limit/sum checks (fill size alone must not force SKU lines).
  if (meaningful === 0) {
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

function countMeaningfulFormulaRmLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter((line) => {
    const inci = String(line?.inci_name ?? line?.inciName ?? '').trim();
    const code = String(line?.rm_code ?? line?.rmCode ?? '').trim();
    const pctRaw = line?.pct_w_w ?? line?.pctWw ?? line?.pct;
    const pct =
      pctRaw != null && pctRaw !== ''
        ? parseFloat(String(pctRaw).replace(/[^\d.-]/g, ''))
        : NaN;
    const hasPct = !Number.isNaN(pct) && pct > 0;
    return Boolean(inci || code || hasPct);
  }).length;
}

function skuLineUomForLimit(limitUom) {
  const u = normUom(limitUom);
  if (u === 'KG') return 'KG';
  if (u === 'L') return 'L';
  if (u === 'ML') return 'ML';
  return 'GM';
}

function displayLimitUom(limitUom) {
  const u = normUom(limitUom);
  if (u === 'G') return 'GM';
  if (u === 'KG') return 'KG';
  if (u === 'ML') return 'ML';
  if (u === 'L') return 'L';
  return String(limitUom ?? '').trim().toUpperCase() || 'GM';
}

function collectMeaningfulFormulaLines(formulaLines) {
  const arr = Array.isArray(formulaLines) ? formulaLines : [];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const line = arr[i] || {};
    const inci = String(line.inci_name ?? line.inciName ?? '').trim();
    const code = String(line.rm_code ?? line.rmCode ?? '').trim();
    const pctRaw = line.pct_w_w ?? line.pctWw ?? line.pct;
    const pct =
      pctRaw != null && pctRaw !== ''
        ? parseFloat(String(pctRaw).replace(/[^\d.-]/g, ''))
        : NaN;
    if (!Number.isNaN(pct) && pct > 0 && (inci || code)) {
      const rid = line.raw_material_id ?? line.rawMaterialId;
      out.push({
        inciName: inci,
        rmCode: code,
        rawMaterialId: rid != null && String(rid).trim() !== '' ? String(rid) : undefined,
        pct,
      });
    }
  }
  return out;
}

function flattenFormulaBomPhases(phases) {
  if (!Array.isArray(phases)) return [];
  const out = [];
  for (const ph of phases) {
    const phaseName = String(ph?.phase ?? '').trim();
    const ings = Array.isArray(ph?.ingredients) ? ph.ingredients : [];
    for (const ing of ings) {
      out.push({
        ...ing,
        phase: (ing.phase != null && ing.phase !== '' ? ing.phase : phaseName) || undefined,
      });
    }
  }
  return out;
}

/**
 * Convert Formula BOM (% w/w, total must be 100%) into SKU BOM per-unit quantities.
 * @param {{ formulaLines: unknown[], limitQty: string|number, limitUom: string }}
 */
function formulaRowsToSkuBomLines({ formulaLines, limitQty, limitUom }) {
  const collected = collectMeaningfulFormulaLines(formulaLines);
  if (collected.length === 0) {
    return { ok: false, error: 'No Formula BOM lines with % w/w and INCI/RM code to import.' };
  }

  const pctTotal = collected.reduce((s, x) => s + x.pct, 0);
  if (Math.abs(pctTotal - 100) > 0.001) {
    return {
      ok: false,
      error: `Formula BOM must total 100% w/w before import (current total ${pctTotal.toFixed(4)}%).`,
    };
  }

  const limQ = parseLimitQty(limitQty);
  const limU = limitUom != null && String(limitUom).trim() !== '' ? String(limitUom).trim() : null;
  const dim = limU ? dimensionOfLimitUom(limU) : null;
  if (!limQ || !limU || !dim) {
    return {
      ok: false,
      error: 'Set net per-unit quantity and UOM (e.g. 50 GM or 50 ML) before importing from Formula BOM.',
    };
  }

  try {
    if (dim === 'mass') limitToMg(limQ, limU);
    else limitToMicroL(limQ, limU);
  } catch (e) {
    return { ok: false, error: e.message || 'Invalid limit UOM' };
  }

  const lineUom = skuLineUomForLimit(limU);
  const limitInDisplay = limQ;
  const rawQtys = collected.map((row) => (row.pct / 100) * limitInDisplay);
  const ROUND = 1e6;
  const rounded = rawQtys.map((q) => Math.round(q * ROUND) / ROUND);
  const drift = limitInDisplay - rounded.reduce((a, b) => a + b, 0);
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift) * ROUND) / ROUND;

  const rows = collected.map((row, i) => ({
    inciName: row.inciName,
    rmCode: row.rmCode,
    rawMaterialId: row.rawMaterialId,
    qtyPerUnit: rounded[i],
    uom: lineUom,
  }));

  return { ok: true, rows, limitQty: limitInDisplay, limitUom: displayLimitUom(limU) };
}

const FORMULA_PCT_MAX = 100;
const FORMULA_PCT_TOLERANCE = 0.001;

/** Sum % w/w on meaningful formula lines (INCI or RM code + positive %). */
function sumFormulaPctWw(rmLines) {
  const collected = collectMeaningfulFormulaLines(rmLines);
  return collected.reduce((s, row) => s + row.pct, 0);
}

/** Reject formula BOM when total % w/w exceeds 100. */
function validateFormulaPctNotOver100(rmLines) {
  const total = sumFormulaPctWw(rmLines);
  if (total > FORMULA_PCT_MAX + FORMULA_PCT_TOLERANCE) {
    return {
      ok: false,
      error: `Formula BOM % w/w total cannot exceed 100% (current ${total.toFixed(4)}%).`,
      code: 'FORMULA_PCT_OVER_100',
      total,
    };
  }
  return { ok: true, total };
}

module.exports = {
  normUom,
  countMeaningfulSkuRmLines,
  countMeaningfulFormulaRmLines,
  parseLimitQty,
  validateSkuBomTotals,
  flattenFormulaBomPhases,
  formulaRowsToSkuBomLines,
  sumFormulaPctWw,
  validateFormulaPctNotOver100,
};
