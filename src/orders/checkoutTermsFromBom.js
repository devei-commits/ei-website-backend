/**
 * Website sale orders (customer checkout): payment stages are NOT derived from vendor Items List
 * (RM/PM/PR rates, MOQ, payment_terms). Those apply to procurement / PO only.
 *
 * Order amounts due (advance / pre-shipment / post-shipment) use a single non-vendor default below.
 * To drive customer-facing schedules from product or policy later, extend here — not from vendor rows.
 */

const SALE_ORDER_DEFAULT_TERMS = {
  advance_pct: 0,
  pre_shipment_pct: 100,
  post_shipment_pct: 0,
  credit_days: 0,
};

/**
 * @returns {{ terms: object; source: string; breakdown: [] }}
 */
async function computeProductCheckoutTerms(_productId, _quantity, _transaction) {
  return {
    terms: { ...SALE_ORDER_DEFAULT_TERMS },
    source: 'sale_order_default',
    breakdown: [],
  };
}

/**
 * @param {Array<{ product_id: number; quantity: number; line_subtotal?: number }>} orderItems
 */
async function computeCheckoutPreview(orderItems, _transaction) {
  const results = (orderItems || []).map((it) => {
    const productId = Number(it.product_id);
    const qty = Number(it.quantity) || 0;
    return {
      product_id: productId,
      quantity: qty,
      payment_terms: { ...SALE_ORDER_DEFAULT_TERMS },
      source: 'sale_order_default',
      rm_pm_breakdown: [],
    };
  });

  return {
    payment_terms: { ...SALE_ORDER_DEFAULT_TERMS },
    lines: results,
  };
}

module.exports = {
  computeProductCheckoutTerms,
  computeCheckoutPreview,
  SALE_ORDER_DEFAULT_TERMS,
};
