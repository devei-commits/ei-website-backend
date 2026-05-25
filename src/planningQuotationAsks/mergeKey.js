/**
 * Merge key for pending planning quotation asks (material + optional vendor/MOQ hints).
 */

function materialMergeKey(itemType, rawMaterialId, packMaterialId, itemCode) {
  const rm = rawMaterialId != null ? Number(rawMaterialId) : NaN;
  if (itemType === 'RM' && Number.isFinite(rm) && rm > 0) return `rm:${rm}`;
  const pm = packMaterialId != null ? Number(packMaterialId) : NaN;
  if (itemType === 'PM' && Number.isFinite(pm) && pm > 0) return `pm:${pm}`;
  const code = String(itemCode ?? '').trim().toLowerCase();
  return `${itemType}:${code}`;
}

function askMergeKey(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  const mat = materialMergeKey(
    d.item_type,
    d.raw_material_id,
    d.pack_material_id,
    d.item_code
  );
  const vendor = String(d.vendor_hint ?? '').trim().toLowerCase();
  const moq = Number(d.moq_hint) || 0;
  return `${mat}|||${vendor}|||${moq > 0 ? moq : ''}`;
}

module.exports = { materialMergeKey, askMergeKey };
