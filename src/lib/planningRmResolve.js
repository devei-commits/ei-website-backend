/**
 * Resolve RM/PM ids from planning BOM lines and material snapshots.
 * rm_code / pm_code win over raw_material_id so post-swap lines do not keep the replaced ingredient.
 */

/**
 * @param {object} line
 * @param {Map<string, { id: number }>|Record<string, { id: number }>} rmByCode
 * @param {Map<string, { id: number }>|Record<string, { id: number }>} rmByName
 * @returns {number|null}
 */
function resolveRmIdFromPlanningLine(line, rmByCode, rmByName) {
  const l = line && typeof line === 'object' ? line : {};
  const code = String(l.rm_code || l.code || '').trim();
  let idFromCode = null;
  if (code) {
    const rm = rmByCode instanceof Map ? rmByCode.get(code) : rmByCode[code];
    if (rm != null) idFromCode = typeof rm === 'object' ? Number(rm.id) : Number(rm);
    if (Number.isNaN(idFromCode)) idFromCode = null;
  }
  const idField = l.raw_material_id != null ? Number(l.raw_material_id) : null;
  const idFromField = idField != null && !Number.isNaN(idField) ? idField : null;
  if (idFromCode != null) return idFromCode;
  if (idFromField != null) return idFromField;
  const nameKey = String(l.inci_name || l.name || '').trim().toLowerCase();
  if (nameKey) {
    const rm = rmByName instanceof Map ? rmByName.get(nameKey) : rmByName[nameKey];
    if (rm != null) {
      const id = typeof rm === 'object' ? Number(rm.id) : Number(rm);
      if (!Number.isNaN(id)) return id;
    }
  }
  return null;
}

/**
 * @param {object} line
 * @param {Map<string, { id: number }>|Record<string, { id: number }>} pmByCode
 * @param {Map<string, { id: number }>|Record<string, { id: number }>} pmByName
 * @returns {number|null}
 */
function resolvePmIdFromPlanningLine(line, pmByCode, pmByName) {
  const l = line && typeof line === 'object' ? line : {};
  const code = String(l.pm_code || l.code || '').trim();
  let idFromCode = null;
  if (code) {
    const pm = pmByCode instanceof Map ? pmByCode.get(code) : pmByCode[code];
    if (pm != null) idFromCode = typeof pm === 'object' ? Number(pm.id) : Number(pm);
    if (Number.isNaN(idFromCode)) idFromCode = null;
  }
  const idField = l.pack_material_id != null ? Number(l.pack_material_id) : null;
  const idFromField = idField != null && !Number.isNaN(idField) ? idField : null;
  if (idFromCode != null) return idFromCode;
  if (idFromField != null) return idFromField;
  const nameKey = String(l.description || l.name || '').trim().toLowerCase();
  if (nameKey) {
    const pm = pmByName instanceof Map ? pmByName.get(nameKey) : pmByName[nameKey];
    if (pm != null) {
      const id = typeof pm === 'object' ? Number(pm.id) : Number(pm);
      if (!Number.isNaN(id)) return id;
    }
  }
  return null;
}

/**
 * @param {object} row
 * @param {Map<string, { id: number }>|Record<string, { id: number }>} rmByCode
 * @param {Map<string, { id: number }>|Record<string, { id: number }>} rmByName
 * @returns {number|null}
 */
function resolveRmIdFromMaterialSnapshotRow(row, rmByCode, rmByName) {
  const r = row && typeof row === 'object' ? row : {};
  const code = String(r.code || r.rm_code || '').trim();
  let idFromCode = null;
  if (code) {
    const rm = rmByCode instanceof Map ? rmByCode.get(code) : rmByCode[code];
    if (rm != null) idFromCode = typeof rm === 'object' ? Number(rm.id) : Number(rm);
    if (Number.isNaN(idFromCode)) idFromCode = null;
  }
  const idField = r.raw_material_id != null ? Number(r.raw_material_id) : null;
  const idFromField = idField != null && !Number.isNaN(idField) ? idField : null;
  if (idFromCode != null) return idFromCode;
  if (idFromField != null) return idFromField;
  const nameKey = String(r.name || '').trim().toLowerCase();
  if (nameKey) {
    const rm = rmByName instanceof Map ? rmByName.get(nameKey) : rmByName[nameKey];
    if (rm != null) {
      const id = typeof rm === 'object' ? Number(rm.id) : Number(rm);
      if (!Number.isNaN(id)) return id;
    }
  }
  return null;
}

module.exports = {
  resolveRmIdFromPlanningLine,
  resolvePmIdFromPlanningLine,
  resolveRmIdFromMaterialSnapshotRow,
};
