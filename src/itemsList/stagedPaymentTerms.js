/**
 * Staged payment terms for vendor rates (advance / pre-shipment / post-shipment %).
 * Stored in item_list_vendor_rates.payment_terms as JSON when using structured form.
 */

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * @param {string|null|undefined} raw
 * @returns {{ advance_pct: number; pre_shipment_pct: number; post_shipment_pct: number; credit_days: number }|null}
 */
function parseStagedPaymentTerms(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      const advance_pct = clampPct(o.advance_pct ?? o.advancePct);
      const pre_shipment_pct = clampPct(o.pre_shipment_pct ?? o.preShipmentPct);
      const post_shipment_pct = clampPct(o.post_shipment_pct ?? o.postShipmentPct);
      const cd = o.credit_days ?? o.creditDays;
      const credit_days = cd != null && Number.isFinite(Number(cd)) ? Math.max(0, Math.floor(Number(cd))) : 0;
      return { advance_pct, pre_shipment_pct, post_shipment_pct, credit_days };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Legacy single-line labels → approximate 3-way split (pre-shipment gets remainder).
 */
function legacyPaymentTermsToStaged(raw) {
  const s = String(raw || '').trim();
  if (!s) {
    return { advance_pct: 0, pre_shipment_pct: 100, post_shipment_pct: 0, credit_days: 0 };
  }
  const lower = s.toLowerCase();
  const mAdv = s.match(/(\d+)\s*%/);
  const adv = mAdv ? clampPct(mAdv[1]) : 0;
  if (lower.includes('advance') && adv > 0) {
    const rest = Math.max(0, 100 - adv);
    if (lower.includes('before dispatch') || lower.includes('dispatch')) {
      return { advance_pct: adv, pre_shipment_pct: rest, post_shipment_pct: 0, credit_days: 0 };
    }
    return { advance_pct: adv, pre_shipment_pct: 0, post_shipment_pct: rest, credit_days: 0 };
  }
  if (lower.includes('net') || lower === 'cod' || lower.includes('due on receipt')) {
    return { advance_pct: 0, pre_shipment_pct: 100, post_shipment_pct: 0, credit_days: 0 };
  }
  return { advance_pct: 0, pre_shipment_pct: 100, post_shipment_pct: 0, credit_days: 0 };
}

function resolveStagedPaymentTerms(raw) {
  const parsed = parseStagedPaymentTerms(raw);
  if (parsed) {
    const t = parsed.advance_pct + parsed.pre_shipment_pct + parsed.post_shipment_pct;
    if (t > 100.0001) {
      const k = 100 / t;
      return {
        advance_pct: Math.round(parsed.advance_pct * k * 100) / 100,
        pre_shipment_pct: Math.round(parsed.pre_shipment_pct * k * 100) / 100,
        post_shipment_pct: Math.round(parsed.post_shipment_pct * k * 100) / 100,
        credit_days: parsed.credit_days,
      };
    }
    return parsed;
  }
  return legacyPaymentTermsToStaged(raw);
}

/**
 * @param {{ advance_pct: number; pre_shipment_pct: number; post_shipment_pct: number; credit_days?: number }} p
 */
function serializeStagedPaymentTerms(p) {
  return JSON.stringify({
    advance_pct: clampPct(p.advance_pct),
    pre_shipment_pct: clampPct(p.pre_shipment_pct),
    post_shipment_pct: clampPct(p.post_shipment_pct),
    credit_days: p.credit_days != null ? Math.max(0, Math.floor(Number(p.credit_days))) : 0,
  });
}

module.exports = {
  parseStagedPaymentTerms,
  resolveStagedPaymentTerms,
  serializeStagedPaymentTerms,
  clampPct,
};
