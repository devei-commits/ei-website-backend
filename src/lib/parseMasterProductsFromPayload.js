/**
 * Resolve linked PR product codes for RM/PM master create & update payloads.
 * Returns `undefined` when the client did not send products (update should preserve DB value).
 */

function payloadFormSlice(b) {
  if (b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data)) {
    return b.form_data;
  }
  return b;
}

function parseAssociateItemsText(raw) {
  const assoc = String(raw ?? '').trim();
  if (!assoc) return [];
  return [...new Set(assoc.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * @param {Record<string, unknown>} b — request body
 * @param {{ preserveWhenUnset?: boolean }} [opts]
 * @returns {string[] | undefined}
 */
function parseMasterProductsFromPayload(b, opts = {}) {
  const { preserveWhenUnset = false } = opts;
  const fd = payloadFormSlice(b);

  if (Array.isArray(b.products)) {
    return b.products.map((c) => String(c).trim()).filter(Boolean);
  }
  if (Array.isArray(fd.products)) {
    return fd.products.map((c) => String(c).trim()).filter(Boolean);
  }

  const assoc =
    fd.rmAssociateItems ??
    fd.pkgAssociateItems ??
    b.rmAssociateItems ??
    b.pkgAssociateItems;
  if (typeof assoc === 'string' && assoc.trim()) {
    return parseAssociateItemsText(assoc);
  }

  if (preserveWhenUnset) return undefined;
  return [];
}

module.exports = {
  parseMasterProductsFromPayload,
  parseAssociateItemsText,
};
