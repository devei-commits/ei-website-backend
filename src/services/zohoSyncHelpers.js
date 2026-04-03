const zohoEnv = require('./zohoEnv');

/**
 * Heuristic: Zoho Books rejects duplicate item name/SKU with messages like "already exists".
 * @param {Error & { zohoRaw?: unknown }} [err]
 */
function isZohoDuplicateItemError(err) {
  if (!err) return false;
  const raw = err.zohoRaw && typeof err.zohoRaw === 'object' ? err.zohoRaw : {};
  const m1 = String(err.message || '').toLowerCase();
  const m2 = String(raw.message || raw.error || '').toLowerCase();
  const s = `${m1} ${m2}`;
  if (/\balready exists\b/.test(s)) return true;
  if (/\bduplicate\b/.test(s)) return true;
  if (/\balready been taken\b/.test(s)) return true;
  if (s.includes('sku') && (s.includes('already') || s.includes('unique') || s.includes('exists'))) return true;
  if (s.includes('item') && s.includes('already')) return true;
  return false;
}

/**
 * When Books + item sync are on, any failed create (except explicit soft-skip reasons) must roll back local rows.
 * @param {{ synced?: boolean, itemId?: string, error?: string }} zoho
 */
function zohoSyncIsMandatoryFailure(zoho) {
  if (!zohoEnv.booksEnabled || !zohoEnv.syncItems) return false;
  if (zoho && zoho.synced && zoho.itemId) return false;
  const e = zoho && zoho.error;
  if (e === undefined || e === null || e === '') return false;
  if (e === 'zoho_disabled' || e === 'item_sync_disabled') return false;
  if (e === 'already_has_zoho_id' || e === 'already_has_zoho_item_id') return false;
  return true;
}

module.exports = {
  isZohoDuplicateItemError,
  zohoSyncIsMandatoryFailure,
};
