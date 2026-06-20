// ─────────────────────────────────────────────────────────────
// EI PRICING ENGINE (DB-driven)
// Ported from ei-quote-generator. Conversion tables stay in code
// (fixed operational rates); overhead now comes from quote_overheads
// via the `ohRows` parameter instead of a hardcoded constant.
// ─────────────────────────────────────────────────────────────

// ── Conversion cost lookup tables (₹/unit) ──
const BT = { '1-1000': { '<=50': 11.15, '<=100': 11.85, '<=200': 12.55 }, '1000-5000': { '<=50': 8.90, '<=100': 9.70, '<=200': 10.30 }, '5000-10000': { '<=50': 8.55, '<=100': 9.35, '<=200': 9.95 }, '10000+': { '<=50': 7.65, '<=100': 8.45, '<=200': 9.05 } };
const TB = { '1-1000': { '<=50': 11.45, '<=100': 12.15 }, '1000-5000': { '<=50': 9.30, '<=100': 10.10 }, '5000-10000': { '<=50': 8.45, '<=100': 9.25 }, '10000+': { '<=50': 7.25, '<=100': 7.65 } };
const SR = { '1-1000': { '<=30': 12.45 }, '1000-5000': { '<=30': 10.65 }, '5000-10000': { '<=30': 9.60 }, '10000+': { '<=30': 8.60 } };
const MONO_DISCOUNT = 0.70;

// Base MOQ scale that overhead band_values are aligned to (grade-agnostic).
const BASE_MOQ_V = [500, 1000, 2500, 5000, 10000, 15000, 25000];

function pf(v) { return parseFloat(v) || 0; }
function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Interpolate total overhead (₹/unit) for a given MOQ from DB overhead rows.
 * @param {number} moq
 * @param {Array<{band_values:number[]}>} ohRows - one row per overhead head,
 *        each band_values aligned to BASE_MOQ_V (7 values).
 */
function interpolateOH(moq, ohRows) {
  let total = 0;
  for (const row of ohRows || []) {
    const vals = Array.isArray(row.band_values) ? row.band_values.map(pf) : [];
    if (vals.length < 7) continue;
    if (moq <= BASE_MOQ_V[0]) {
      total += vals[0];
    } else if (moq >= BASE_MOQ_V[6]) {
      total += vals[6] * (BASE_MOQ_V[6] / moq);
    } else {
      for (let j = 0; j < 6; j++) {
        if (moq >= BASE_MOQ_V[j] && moq <= BASE_MOQ_V[j + 1]) {
          const t = (moq - BASE_MOQ_V[j]) / (BASE_MOQ_V[j + 1] - BASE_MOQ_V[j]);
          total += vals[j] + t * (vals[j + 1] - vals[j]);
          break;
        }
      }
    }
  }
  return r2(total);
}

// Conversion cost lookup for one band using the grade's bmap entry.
function calcConv(pkgType, volKey, monocarton, bmapEntry) {
  const { b: band, f } = bmapEntry || { b: '1-1000', f: 1.0 };
  const table = pkgType === 'Bottle & Jar' ? BT : pkgType === 'Tube' ? TB : SR;
  let base = ((table[band] || {})[volKey]) || 11.0;
  if (!monocarton) base -= MONO_DISCOUNT;
  return r2(base * f);
}

/**
 * Main pricing calculation.
 *
 * @param {object} config
 * @param {Array}  config.rmLines       [{rm_code, inci_name, pct_w_w, price_per_kg, specific_gravity?}]
 * @param {Array}  config.pmLines       [{pm_code, description, qty_per_unit, price_per_pc}]
 * @param {number} config.volumeMl
 * @param {number} config.sg            blended SG (auto-computed or manual)
 * @param {string} config.packagingType 'Bottle & Jar' | 'Tube' | 'Serum with Dropper'
 * @param {string} config.volumeKey     '<=50' | '<=100' | '<=200' | '<=30'
 * @param {boolean} config.monocarton
 * @param {number} config.rmWastage     fraction e.g. 0.03
 * @param {number} config.pmWastage     fraction e.g. 0.02
 * @param {number} config.rmLogistics   ₹/kg
 * @param {number} config.pmLogistics   ₹/unit
 * @param {number} config.freightPct
 * @param {number} config.insurancePct
 * @param {number} config.handlingPct
 * @param {number} config.creditDays
 * @param {number} config.annualRate
 * @param {object} config.grade         resolved grade: {moq_labels[], moq_values[], markups[], zero_pm, bmap[]}
 * @param {Array}  config.ohRows        overhead rows for the detected product category
 * @param {Array|null} config.customMargins 7-element override or null
 * @param {number} config.targetPrice
 */
function calculate(config) {
  const {
    rmLines = [], pmLines = [],
    volumeMl, sg,
    packagingType = 'Bottle & Jar', volumeKey = '<=100', monocarton = false,
    rmWastage = 0.03, pmWastage = 0.02,
    rmLogistics = 5, pmLogistics = 2,
    freightPct = 0.03, insurancePct = 0.01, handlingPct = 0.01,
    creditDays = 30, annualRate = 0.14,
    grade, ohRows = [],
    customMargins = null, targetPrice = 0,
  } = config;

  const moqLabels = grade.moq_labels;
  const moqValues = grade.moq_values;
  const bmap = grade.bmap;
  const zeroPm = !!grade.zero_pm;
  const margins = customMargins && customMargins.length === 7 ? customMargins : grade.markups.slice();

  const landingFactor = 1 + pf(freightPct) + pf(insurancePct) + pf(handlingPct);
  const creditFactor = (pf(annualRate) / 365) * pf(creditDays);
  const weightPerUnit = pf(volumeMl) * pf(sg) / 1000; // kg
  const hasWeight = weightPerUnit > 0;

  // ── RM cost ──
  let blendedRmExWorks = 0;
  let totalPctWW = 0;
  const rmDetail = [];
  for (const item of rmLines) {
    const pct = pf(item.pct_w_w) / 100;
    const priceKg = pf(item.price_per_kg);
    const landedKg = priceKg * landingFactor;
    blendedRmExWorks += pct * priceKg;
    totalPctWW += pf(item.pct_w_w);
    rmDetail.push({
      name: item.inci_name || item.name,
      rm_code: item.rm_code,
      pct_w_w: pf(item.pct_w_w),
      price_per_kg: priceKg,
      landed_per_kg: r2(landedKg),
      weighted_contribution: r2(pct * landedKg),
      missing_price: priceKg === 0,
    });
  }
  const blendedRmLanded = blendedRmExWorks * landingFactor;

  let rmPerUnit, rmWastageAmt, rmLogisticsAmt, totalRm;
  if (hasWeight) {
    rmPerUnit = blendedRmLanded * weightPerUnit;
    rmWastageAmt = rmPerUnit * rmWastage;
    rmLogisticsAmt = rmLogistics * weightPerUnit;
    totalRm = rmPerUnit + rmWastageAmt + rmLogisticsAmt;
  } else {
    rmPerUnit = blendedRmLanded;
    rmWastageAmt = rmPerUnit * rmWastage;
    rmLogisticsAmt = rmLogistics;
    totalRm = rmPerUnit + rmWastageAmt + rmLogisticsAmt;
  }

  // ── PM cost ──
  let pmBaseTotal = 0;
  const pmDetail = [];
  const missingPmPrices = [];
  if (!zeroPm) {
    for (const item of pmLines) {
      const qty = pf(item.qty_per_unit);
      const priceUnit = pf(item.price_per_pc);
      const landedUnit = priceUnit * landingFactor;
      const lineTotal = qty * landedUnit;
      pmBaseTotal += lineTotal;
      if (priceUnit === 0 && item.pack_material_id) missingPmPrices.push(item.description);
      pmDetail.push({
        name: item.pm_description || item.description,
        pm_code: item.pm_code,
        qty_per_unit: qty,
        price_per_pc: priceUnit,
        landed_per_pc: r2(landedUnit),
        line_total: r2(lineTotal),
        missing_price: priceUnit === 0,
      });
    }
  }
  const pmWastageAmt = pmBaseTotal * pmWastage;
  const totalPm = zeroPm ? 0 : pmBaseTotal + pmWastageAmt + pf(pmLogistics);

  // ── 7 MOQ bands ──
  const bands = [];
  for (let bi = 0; bi < 7; bi++) {
    const oh = interpolateOH(moqValues[bi], ohRows);
    const cv = calcConv(packagingType, volumeKey, monocarton, bmap[bi]);
    const costBase = totalRm + totalPm + cv + oh;
    const creditAmt = costBase * creditFactor;
    const totalCost = costBase + creditAmt;
    const markup = margins[bi];
    const marginAmt = totalCost * markup;
    const sellPrice = totalCost + marginAmt;
    const grossMarginPct = sellPrice > 0 ? marginAmt / sellPrice : 0;
    const gap = r2(sellPrice - pf(targetPrice));

    bands.push({
      moq: moqLabels[bi],
      moqv: moqValues[bi],
      conversion: r2(cv),
      overhead: r2(oh),
      rm: r2(totalRm),
      pm: r2(totalPm),
      cost_base: r2(costBase),
      credit: r2(creditAmt),
      total_cost: r2(totalCost),
      markup_pct: markup,
      gross_margin_pct: r4(grossMarginPct),
      margin_amt: r2(marginAmt),
      sell_price: r2(sellPrice),
      target: pf(targetPrice),
      gap,
    });
  }

  // ── Target reverse calc (RM price needed to hit target) ──
  const targetCalc = [];
  if (pf(targetPrice) > 0) {
    for (let bi = 0; bi < 7; bi++) {
      const oh = interpolateOH(moqValues[bi], ohRows);
      const cv = calcConv(packagingType, volumeKey, monocarton, bmap[bi]);
      const mp = margins[bi];
      const rmLogAmt = hasWeight ? rmLogistics * weightPerUnit : rmLogistics;
      const requiredRmUnit = (pf(targetPrice) / (1 + mp) / (1 + creditFactor) - totalPm - cv - oh - rmLogAmt) / (1 + rmWastage);
      const requiredRmKgLanded = hasWeight && weightPerUnit > 0 ? requiredRmUnit / weightPerUnit : requiredRmUnit;
      const requiredRmKgExWorks = landingFactor > 0 ? requiredRmKgLanded / landingFactor : 0;
      const gapVsCurrent = r2(requiredRmKgLanded - blendedRmLanded);
      targetCalc.push({
        moq: moqLabels[bi],
        required_rm_kg_landed: r2(requiredRmKgLanded),
        required_rm_kg_exworks: r2(requiredRmKgExWorks),
        current_rm_kg_landed: r2(blendedRmLanded),
        gap: gapVsCurrent,
        feasible: gapVsCurrent >= 0,
      });
    }
  }

  return {
    grade_name: grade.name,
    has_weight: hasWeight,
    zero_pm: zeroPm,
    volume_ml: pf(volumeMl),
    sg: pf(sg),
    weight_per_unit_kg: r4(weightPerUnit),
    landing_factor: r2(landingFactor),
    credit_factor: creditFactor,
    total_pct_ww: r2(totalPctWW),
    blended_rm_ex_works: r2(blendedRmExWorks),
    blended_rm_landed: r2(blendedRmLanded),
    rm_per_unit: r2(rmPerUnit),
    rm_wastage_amt: r2(rmWastageAmt),
    rm_logistics_amt: r2(rmLogisticsAmt),
    total_rm: r2(totalRm),
    pm_base_total: r2(pmBaseTotal),
    pm_wastage_amt: r2(pmWastageAmt),
    total_pm: r2(totalPm),
    rm_detail: rmDetail,
    pm_detail: pmDetail,
    missing_pm_prices: missingPmPrices,
    bands,
    target_calc: targetCalc,
    warnings: buildWarnings({ totalPctWW, rmLines, hasWeight, missingPmPrices }),
  };
}

function buildWarnings({ totalPctWW, rmLines, hasWeight, missingPmPrices }) {
  const w = [];
  if (Math.abs(totalPctWW - 100) > 0.1) w.push(`RM composition = ${totalPctWW.toFixed(2)}% (must be 100%)`);
  if (!hasWeight) w.push('Volume or SG is 0 — showing per-KG costs, not per-unit');
  const zeroRm = rmLines.filter(r => pf(r.price_per_kg) === 0).length;
  if (zeroRm > 0) w.push(`${zeroRm} RM ingredient(s) have ₹0 price`);
  if (missingPmPrices.length > 0) w.push(`${missingPmPrices.length} PM component(s) have ₹0 price: ${missingPmPrices.join(', ')}`);
  return w;
}

module.exports = { calculate, interpolateOH, BASE_MOQ_V };
