/**
 * Pure: sum PO line quantities by item key (rm-{id} or pm-{id}).
 * Each line: { raw_material_id?, pack_material_id?, quantity?, qty?, poQty? }.
 * Returns Map<key, number>.
 */
function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function sumPoQuantityByItem(poItems) {
  const map = new Map();
  const items = Array.isArray(poItems) ? poItems : [];
  for (const line of items) {
    const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
    if (qty <= 0) continue;
    let key = null;
    if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
    else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + qty);
  }
  return map;
}

module.exports = { sumPoQuantityByItem };
