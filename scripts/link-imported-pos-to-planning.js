#!/usr/bin/env node
/**
 * Back-link bulk-imported purchase orders to the planning rows the coverage dashboard actually
 * uses, so imported POs show up in "PO Qty" / "Planned" for their items.
 *
 * Why this approach: this DB has no procurement_requests, so there's no PR to link to. The only
 * link that makes qty flow is purchase_orders.reference = "Planning PE-<planningExtractedId>"
 * (consumed by sumPlanningLinkedDraftPoQtyForItem / sumScopedPurchaseOrderQtyForKey). The CORRECT
 * planning row for an item is whatever getItemsInvolved reports in planningExtractedIds for it —
 * NOT any row that merely mentions the material in its snapshot.
 *
 * What it does: for each unlinked imported PO, resolve its line material ids, find which of its
 * items has an active dashboard requirement, and set reference to one of that item's planning PEs.
 * (A PO holds ONE reference, so a multi-item PO links only its primary item; the rest are reported.)
 * With --release it also flips Draft→Released so the qty lands in PO Qty (else it sits in Planned).
 *
 * Usage:
 *   node scripts/link-imported-pos-to-planning.js                 # DRY RUN
 *   node scripts/link-imported-pos-to-planning.js --commit        # link (reference + line ids)
 *   node scripts/link-imported-pos-to-planning.js --commit --release   # also Draft->Released (=> PO Qty)
 *   Flags: --source=excel_purchase_order[,..] (default) | --all-unlinked | --limit=N | --po=<order_id>
 */
require('dotenv').config();

const db = require('../db');
const PurchaseOrder = require('../src/purchaseOrders/models');
const { buildMaterialSkuLookup } = require('../src/purchaseOrders/prRowsExcelImport');
const ctrl = require('../src/planningExtracted/controller');

function arg(name, def) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
const COMMIT = arg('commit', false) === true;
const RELEASE = arg('release', false) === true;
const ALL_UNLINKED = arg('all-unlinked', false) === true;
const LIMIT = Number(arg('limit', 0)) || 0;
const PO_FILTER = arg('po', null) ? String(arg('po')).trim() : null;
const SOURCES = String(arg('source', 'excel_purchase_order'))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '').trim();
const PE_REF_RE = /^Planning\s+PE-(\d+)/i;
function skuLooksLikePackaging(code) {
  const c = up(code);
  return /^5[MLOS]?\d/.test(c) || /^4\d{4,}/.test(c) || /^6[TA]/.test(c);
}
function resolveLine(line, lookup) {
  if (line && line.raw_material_id != null) return { key: `rm-${Number(line.raw_material_id)}`, already: true };
  if (line && line.pack_material_id != null) return { key: `pm-${Number(line.pack_material_id)}`, already: true };
  const k = up(line && (line.code || line.sku || line.itemCode));
  if (!k) return null;
  const rm = lookup.rmBySku.get(k), pm = lookup.pmBySku.get(k);
  const hint = String((line && (line.type || line.category)) || '').trim().toUpperCase();
  let pick = null;
  if (rm && pm) pick = hint === 'PM' ? { t: 'pm', r: pm } : hint === 'RM' ? { t: 'rm', r: rm } : skuLooksLikePackaging(k) ? { t: 'pm', r: pm } : { t: 'rm', r: rm };
  else if (rm) pick = { t: 'rm', r: rm };
  else if (pm) pick = { t: 'pm', r: pm };
  if (!pick) return null;
  return { key: `${pick.t}-${pick.r.id}`, id: pick.r.id, type: pick.t, already: false };
}

/** Fresh getItemsInvolved (bypasses the route cache) → item key -> {peIds, name}. */
async function loadDashboardDemand() {
  let cap = null;
  const req = { query: {}, params: {}, user: { id: 1, role: 'admin' }, headers: {} };
  const res = { status() { return this; }, json(x) { cap = x; return this; }, set() { return this; }, setHeader() { return this; } };
  await ctrl.getItemsInvolved(req, res);
  const rows = Array.isArray(cap) ? cap : (cap && (cap.rows || cap.items)) || [];
  const byKey = new Map();
  for (const r of rows) {
    const key = r.raw_material_id != null ? `rm-${Number(r.raw_material_id)}`
      : r.pack_material_id != null ? `pm-${Number(r.pack_material_id)}` : null;
    const peIds = (Array.isArray(r.planningExtractedIds) ? r.planningExtractedIds : []).map(Number).filter((n) => n > 0);
    if (key && peIds.length) byKey.set(key, { peIds, name: r.name, code: r.code, totalRequired: r.totalRequired, poQtyNow: r.poQty });
  }
  return { byKey, rowCount: rows.length };
}

async function main() {
  await db.authenticate();
  console.log(`Mode: ${COMMIT ? (RELEASE ? 'COMMIT + RELEASE' : 'COMMIT (link only)') : 'DRY RUN'} | sources=${ALL_UNLINKED ? '(any unlinked)' : SOURCES.join(',')}\n`);

  const lookup = await buildMaterialSkuLookup();
  const demand = await loadDashboardDemand();
  console.log(`getItemsInvolved reports ${demand.rowCount} rows; ${demand.byKey.size} have active planning demand.\n`);

  let pos = (await PurchaseOrder.findAll()).map((p) => p.get({ plain: true })).filter((p) => !p.deleted_at);
  if (PO_FILTER) pos = pos.filter((p) => String(p.order_id || '') === PO_FILTER);
  pos = pos.filter((p) => {
    const fd = p.form_data && typeof p.form_data === 'object' ? p.form_data : {};
    const linked = PE_REF_RE.test(String(p.reference || '')) || !!digits(fd.requestId ?? fd.request_id);
    if (linked) return false;
    if (ALL_UNLINKED || PO_FILTER) return true;
    return SOURCES.includes(String(fd.source || '').trim().toLowerCase());
  });
  if (LIMIT > 0) pos = pos.slice(0, LIMIT);

  const buckets = { linked: [], unmatched: [], noItems: [] };
  const tx = COMMIT ? await db.transaction() : null;
  try {
    for (const po of pos) {
      const items = Array.isArray(po.items) ? po.items.map((x) => ({ ...(x || {}) })) : [];
      let changedItems = false;
      const resolvedKeys = [];
      for (const line of items) {
        const r = resolveLine(line, lookup);
        if (!r) continue;
        resolvedKeys.push(r.key);
        if (!r.already) { if (r.type === 'pm') line.pack_material_id = r.id; else line.raw_material_id = r.id; if (!line.type) line.type = r.type.toUpperCase(); changedItems = true; }
      }
      if (!resolvedKeys.length) { buckets.noItems.push({ po }); continue; }

      // Which of the PO's items has active dashboard demand?
      const cands = resolvedKeys.filter((k) => demand.byKey.has(k));
      if (!cands.length) { buckets.unmatched.push({ po, resolvedKeys }); continue; }

      // Primary = candidate with the largest current requirement (deterministic).
      cands.sort((a, b) => (demand.byKey.get(b).totalRequired || 0) - (demand.byKey.get(a).totalRequired || 0));
      const primary = cands[0];
      const d = demand.byKey.get(primary);
      const pe = d.peIds[0];
      const ref = `Planning PE-${pe}`;
      const others = cands.slice(1);
      buckets.linked.push({ po, primary, primaryName: d.name, pe, ref, others, multiItem: resolvedKeys.length > 1, changedItems });

      if (COMMIT) {
        const patch = { reference: ref };
        if (changedItems) patch.items = items;
        if (RELEASE) patch.status = 'Released';
        await PurchaseOrder.update(patch, { where: { id: po.id }, transaction: tx });
      }
    }
    if (tx) await tx.commit();
  } catch (e) {
    if (tx) await tx.rollback();
    console.error('Rolled back:', e && e.message ? e.message : e);
    await db.close(); process.exit(1);
  }

  console.log(`In-scope unlinked POs: ${pos.length}`);
  console.log(`  linked=${buckets.linked.length}  unmatched=${buckets.unmatched.length}  no-resolvable-items=${buckets.noItems.length}\n`);
  const show = (label, arr, fn) => { if (!arr.length) return; console.log(`--- ${label} (${arr.length}) ---`); for (const e of arr.slice(0, 250)) console.log('  ' + fn(e)); if (arr.length > 250) console.log(`  … +${arr.length - 250} more`); console.log(''); };
  show(COMMIT ? 'LINKED' : 'WOULD LINK', buckets.linked, (e) =>
    `${e.po.order_id} → ${e.ref}  [${e.primary} ${e.primaryName || ''}]${e.multiItem ? `  (multi-item: ${e.others.length ? 'also has ' + e.others.join(',') + ' — NOT linked (1 reference/PO)' : 'other lines no active demand'})` : ''}`);
  show('UNMATCHED (no active dashboard demand for any line)', buckets.unmatched, (e) => `${e.po.order_id}  items=[${e.resolvedKeys.join(',')}]`);
  show('NO RESOLVABLE ITEMS', buckets.noItems, (e) => `${e.po.order_id}`);

  console.log(COMMIT
    ? `Committed. Linked ${buckets.linked.length} PO(s)${RELEASE ? ' and set them Released (=> PO Qty)' : ' (Draft => shows in Planned; add --release for PO Qty)'}.`
    : `Dry run — nothing written. Re-run with --commit (add --release to also move Draft→Released so qty lands in PO Qty).`);
  await db.close();
}

main().catch(async (e) => { console.error('FATAL:', e && e.message ? e.message : e); try { await db.close(); } catch (_) {} process.exit(1); });
