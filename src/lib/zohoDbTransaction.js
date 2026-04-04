/**
 * Helpers for “Postgres + Zoho Books item” atomicity: if the DB transaction rolls back after a Zoho
 * item was created, call deleteItem to avoid orphan Zoho rows.
 */

/**
 * @param {import('sequelize').Transaction | undefined} transaction
 * @param {string | null | undefined} itemId
 * @param {(id: string) => Promise<unknown>} deleteItem
 */
async function compensateZohoItemIfAny(transaction, itemId, deleteItem) {
  const id = itemId != null ? String(itemId).trim() : '';
  if (!id) return;
  try {
    await deleteItem(id);
  } catch {
    /* best-effort */
  }
}

module.exports = {
  compensateZohoItemIfAny,
};
