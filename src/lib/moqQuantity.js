/** Parse MOQ / tier breakpoint quantities (supports decimals, e.g. 0.5 KG). */
function parseMoqQuantity(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10000) / 10000;
}

function moqValuesEqual(a, b) {
  const na = parseMoqQuantity(a);
  const nb = parseMoqQuantity(b);
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 1e-6;
}

module.exports = {
  parseMoqQuantity,
  moqValuesEqual,
};
