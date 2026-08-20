/**
 * Per-item "connecting date" — the date a specific material on a specific PO is expected to connect
 * (arrive), stored on `purchase_orders.form_data.connectingDateByItem` as { itemKey: 'YYYY-MM-DD' }.
 *
 * A material is usually covered by more than one PO, and each can connect on a different date
 * ("Aqua: PO-1 on 10 Aug, PO-3 on 14 Aug"). Rolling those into a single date loses the information
 * that matters for scheduling, so every (PO, date) pair is kept and returned in date order.
 *
 * The stored keys are item codes normalised by the frontend's `normItemKeyForLead` (trimmed,
 * lower-cased). Matching here therefore normalises both sides the same way, and also accepts the
 * material id keys (`rm-12`, `pm-7`) some callers hold.
 */

function normKey(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** Every connecting date a PO declares, as { key, date } — [] when it declares none. */
function connectingDatesOnPo(poPlain) {
  const fd = poPlain && typeof poPlain.form_data === 'object' && poPlain.form_data !== null ? poPlain.form_data : {};
  const raw = fd.connectingDateByItem;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [k, v] of Object.entries(raw)) {
    const date = String(v ?? '').trim();
    const key = normKey(k);
    if (key && date) out.push({ key, date });
  }
  return out;
}

/**
 * Map of `rm-<id>` / `pm-<id>` → [{ poNo, date }], built from every committed PO.
 *
 * PO lines carry the material id, and the connecting-date map is keyed by item CODE, so the line is
 * what joins the two: its id gives the map key, its code looks up the date.
 */
function buildConnectingDatesByMaterialKey(pos, { isCommitted } = {}) {
  const byKey = new Map();
  for (const po of pos || []) {
    const plain = po && po.get ? po.get({ plain: true }) : po;
    if (!plain) continue;
    if (typeof isCommitted === 'function' && !isCommitted(plain)) continue;
    const dates = connectingDatesOnPo(plain);
    if (dates.length === 0) continue;
    const dateByCode = new Map(dates.map((d) => [d.key, d.date]));
    const poNo = String(plain.order_id ?? plain.reference ?? '').trim();
    const items = Array.isArray(plain.items) ? plain.items : [];
    for (const line of items) {
      let key = null;
      if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
      else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
      if (!key) continue;
      const code = normKey(line.itemCode ?? line.code ?? line.sku ?? line.item_code ?? '');
      const date = dateByCode.get(code) ?? dateByCode.get(normKey(key)) ?? null;
      if (!date) continue;
      const list = byKey.get(key) || [];
      // One PO can list the same material on several lines; one entry per PO is enough.
      if (!list.some((e) => e.poNo === poNo && e.date === date)) list.push({ poNo, date });
      byKey.set(key, list);
    }
  }
  for (const [k, list] of byKey) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.poNo.localeCompare(b.poNo));
    byKey.set(k, list);
  }
  return byKey;
}

module.exports = { connectingDatesOnPo, buildConnectingDatesByMaterialKey, normKey };
