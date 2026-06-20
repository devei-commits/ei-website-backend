// ─────────────────────────────────────────────────────────────
// QUOTATION CONTROLLER
// Orchestrates: BOM enrich → load config → pricing + timeline,
// plus CRUD for grades, overheads, timeline rules, and saved quotes.
// All routes are super_admin-gated at the router level.
// ─────────────────────────────────────────────────────────────
const { QueryTypes } = require('sequelize');
const db = require('../../db');
const {
  QuoteGrade, QuoteOverhead, QuoteProcurementRule, QuoteManufacturingRule,
  QuoteQcRule, QuoteDispatchConfig, SavedQuote, QuoteEmail,
} = require('./models');
const { enrichBom } = require('./bomEnrich');
const RawMaterial = require('../rawMaterials/models');
const { calculate } = require('./pricing');
const { estimateTimeline, detectProductType } = require('./timing');
const { loadOverheadRows, loadTimelineConfig } = require('./configLoader');
const { softDeletePayload } = require('../lib/softDelete');

function pf(v) { return parseFloat(v) || 0; }
function plain(rows) { return rows.map(r => (r.get ? r.get({ plain: true }) : r)); }

async function resolveGrade(gradeId) {
  if (gradeId != null && gradeId !== '') {
    const g = await QuoteGrade.findByPk(gradeId);
    if (g) return g.get({ plain: true });
  }
  const sys = await QuoteGrade.findOne({ where: { grade_ref: 'system_1' } });
  return sys ? sys.get({ plain: true }) : null;
}

async function fetchBom(bomId) {
  const rows = await db.query(
    `SELECT b.*, p.product_code, p.brand_name
       FROM boms b LEFT JOIN products p ON b.product_id = p.product_id
      WHERE b.id = :id AND b.deleted_at IS NULL`,
    { replacements: { id: bomId }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// POST /calculate — BOM mode (bom_id) or adhoc mode (rmLines/pmLines)
// ─────────────────────────────────────────────────────────────
async function calculateQuote(req, res) {
  try {
    const b = req.body || {};
    const grade = await resolveGrade(b.grade);
    if (!grade) return res.status(400).json({ error: 'No grade available' });

    let rmLines = [], pmLines = [];
    let finalVolume = pf(b.volumeMl);
    let finalSg = pf(b.sg);
    let bomMeta = { bom_id: null, bom_code: 'NEW', bom_name: b.name || 'New Quote', pack_size: finalVolume ? `${finalVolume} ML` : '—', product_code: null };
    let sgInfo = null;

    if (b.bom_id) {
      const bom = await fetchBom(b.bom_id);
      if (!bom) return res.status(404).json({ error: 'BOM not found' });
      const enriched = await enrichBom(bom, {
        rmOverrides: b.rmOverrides || {}, pmOverrides: b.pmOverrides || {}, sgOverrides: b.sgOverrides || {},
      });
      rmLines = enriched.rm_lines;
      pmLines = enriched.pm_lines;
      bomMeta = { bom_id: bom.id, bom_code: bom.bom_code, bom_name: bom.name, pack_size: bom.pack_size, product_code: enriched.product_code };
      if (!finalVolume) finalVolume = enriched.parsed_volume_ml;
      if (!finalSg) finalSg = enriched.blended_sg || 0; // auto blended SG when complete
      sgInfo = {
        blended_sg: enriched.blended_sg,
        blended_sg_partial: enriched.blended_sg_partial,
        sg_complete: enriched.sg_complete,
        sg_known_pct: enriched.sg_known_pct,
        missing_sg_lines: enriched.missing_sg_lines,
        sg_used: finalSg,
      };
    } else {
      if (!Array.isArray(b.rmLines) || b.rmLines.length === 0) {
        return res.status(400).json({ error: 'Adhoc mode requires at least one RM line' });
      }
      rmLines = b.rmLines.map(l => ({
        raw_material_id: l.raw_material_id || null,
        rm_code: l.rm_code || '',
        inci_name: l.inci_name || l.name || '',
        pct_w_w: pf(l.pct_w_w),
        price_per_kg: pf(l.price_per_kg),
        specific_gravity: l.specific_gravity != null ? pf(l.specific_gravity) : null,
        category: l.category || null,
        lead_time_days: l.lead_time_days != null ? parseInt(l.lead_time_days) : null,
      }));
      pmLines = (b.pmLines || []).map(l => ({
        pack_material_id: l.pack_material_id || null,
        pm_code: l.pm_code || '',
        description: l.description || '',
        qty_per_unit: pf(l.qty_per_unit),
        price_per_pc: pf(l.price_per_pc),
        material: l.material || null,
        lead_time_days: l.lead_time_days != null ? parseInt(l.lead_time_days) : null,
      }));
      bomMeta.bom_name = b.name || 'Adhoc Quote';
      // Blended SG from the adhoc lines (mirror BOM mode); manual b.sg wins.
      let blendedSgKnown = 0, knownPct = 0;
      const missingSgLines = [];
      for (const l of rmLines) {
        if (l.specific_gravity != null && l.specific_gravity > 0) { blendedSgKnown += (l.pct_w_w / 100) * l.specific_gravity; knownPct += l.pct_w_w; }
        else missingSgLines.push({ rm_code: l.rm_code, name: l.inci_name, pct_w_w: l.pct_w_w });
      }
      const sgComplete = missingSgLines.length === 0;
      const blendedSg = sgComplete ? Math.round(blendedSgKnown * 1000) / 1000 : null;
      if (!finalSg) finalSg = blendedSg || 0;
      sgInfo = {
        blended_sg: blendedSg,
        blended_sg_partial: Math.round(blendedSgKnown * 1000) / 1000,
        sg_complete: sgComplete,
        sg_known_pct: Math.round(knownPct * 100) / 100,
        missing_sg_lines: missingSgLines,
        sg_used: finalSg,
      };
    }

    const productType = detectProductType(bomMeta.bom_name);
    const [ohRows, timelineConfig] = await Promise.all([
      loadOverheadRows(productType),
      loadTimelineConfig(),
    ]);

    const result = calculate({
      rmLines, pmLines,
      volumeMl: finalVolume, sg: finalSg,
      packagingType: b.packagingType, volumeKey: b.volumeKey, monocarton: b.monocarton,
      rmWastage: b.rmWastage, pmWastage: b.pmWastage,
      rmLogistics: b.rmLogistics, pmLogistics: b.pmLogistics,
      freightPct: b.freightPct, insurancePct: b.insurancePct, handlingPct: b.handlingPct,
      creditDays: b.creditDays, annualRate: b.annualRate,
      grade, ohRows,
      customMargins: b.customMargins || null, targetPrice: b.targetPrice || 0,
    });

    const gradeRef = grade.grade_ref || `id_${grade.id}`;
    result.bands = result.bands.map((band, i) => ({
      ...band,
      timeline: estimateTimeline({
        bomName: bomMeta.bom_name, rmLines, pmLines, bandIndex: i,
        useBatchLead: !!b.useBatchLead, gradeRef, gradeQcOverride: grade.qc_days,
        productSubtype: b.productSubtype || '', config: timelineConfig,
      }),
    }));

    res.json({
      ...bomMeta,
      grade: grade.id,
      grade_ref: gradeRef,
      product_type: productType,
      overhead_category: ohRows.length ? (ohRows.find(r => r.product_category !== 'all') ? productType : 'all') : 'all',
      sg_info: sgInfo,
      ...result,
    });
  } catch (err) {
    console.error('POST /quotes/calculate error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// GRADES
// ─────────────────────────────────────────────────────────────
async function listGrades(req, res) {
  try {
    const rows = await QuoteGrade.findAll({ order: [['is_system', 'DESC'], ['id', 'ASC']] });
    res.json({ grades: plain(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function validateGradeBody(b) {
  const seven = (a) => Array.isArray(a) && a.length === 7;
  if (!b.name) return 'name is required';
  if (!seven(b.moq_labels)) return 'moq_labels must have 7 values';
  if (!seven(b.moq_values)) return 'moq_values must have 7 values';
  if (!seven(b.markups)) return 'markups must have 7 values';
  if (!seven(b.bmap)) return 'bmap must have 7 entries';
  return null;
}

async function createGrade(req, res) {
  try {
    const b = req.body || {};
    const err = validateGradeBody(b);
    if (err) return res.status(400).json({ error: err });
    const g = await QuoteGrade.create({
      name: b.name, description: b.description || null,
      moq_labels: b.moq_labels, moq_values: b.moq_values, markups: b.markups,
      zero_pm: !!b.zero_pm, bmap: b.bmap,
      qc_days: b.qc_days != null ? parseInt(b.qc_days) : null,
      is_system: false, created_by: req.user?.id || null,
    });
    await g.update({ grade_ref: `custom_${g.id}` });
    res.json({ ok: true, grade: g.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function updateGrade(req, res) {
  try {
    const g = await QuoteGrade.findByPk(req.params.id);
    if (!g) return res.status(404).json({ error: 'Grade not found' });
    if (g.is_system) return res.status(403).json({ error: 'System grades cannot be edited' });
    const b = req.body || {};
    const err = validateGradeBody({ ...g.get({ plain: true }), ...b });
    if (err) return res.status(400).json({ error: err });
    await g.update({
      name: b.name ?? g.name, description: b.description ?? g.description,
      moq_labels: b.moq_labels ?? g.moq_labels, moq_values: b.moq_values ?? g.moq_values,
      markups: b.markups ?? g.markups, zero_pm: b.zero_pm != null ? !!b.zero_pm : g.zero_pm,
      bmap: b.bmap ?? g.bmap, qc_days: b.qc_days != null ? parseInt(b.qc_days) : g.qc_days,
    });
    res.json({ ok: true, grade: g.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function deleteGrade(req, res) {
  try {
    const g = await QuoteGrade.findByPk(req.params.id);
    if (!g) return res.status(404).json({ error: 'Grade not found' });
    if (g.is_system) return res.status(403).json({ error: 'System grades cannot be deleted' });
    await g.update(softDeletePayload(QuoteGrade));
    res.json({ ok: true, id: g.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────
// OVERHEADS  (hard delete; composite unique on category+head)
// ─────────────────────────────────────────────────────────────
async function listOverheads(req, res) {
  try {
    const where = req.query.category ? { product_category: req.query.category } : {};
    const rows = await QuoteOverhead.findAll({ where, order: [['product_category', 'ASC'], ['sort_order', 'ASC']] });
    res.json({ overheads: plain(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function createOverhead(req, res) {
  try {
    const b = req.body || {};
    if (!b.head_name || !Array.isArray(b.band_values) || b.band_values.length !== 7) {
      return res.status(400).json({ error: 'head_name and 7 band_values are required' });
    }
    const row = await QuoteOverhead.create({
      product_category: b.product_category || 'all', head_name: b.head_name,
      band_values: b.band_values.map(pf), sort_order: b.sort_order || 0,
    });
    res.json({ ok: true, overhead: row.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function updateOverhead(req, res) {
  try {
    const row = await QuoteOverhead.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Overhead not found' });
    const b = req.body || {};
    await row.update({
      head_name: b.head_name ?? row.head_name,
      band_values: Array.isArray(b.band_values) && b.band_values.length === 7 ? b.band_values.map(pf) : row.band_values,
      sort_order: b.sort_order != null ? b.sort_order : row.sort_order,
    });
    res.json({ ok: true, overhead: row.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function deleteOverhead(req, res) {
  try {
    const n = await QuoteOverhead.destroy({ where: { id: req.params.id } });
    if (!n) return res.status(404).json({ error: 'Overhead not found' });
    res.json({ ok: true, id: parseInt(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────
// TIMELINE: PROCUREMENT RULES
// ─────────────────────────────────────────────────────────────
async function listProcurement(req, res) {
  try {
    const where = req.query.type ? { material_type: String(req.query.type).toUpperCase() } : {};
    const rows = await QuoteProcurementRule.findAll({ where, order: [['material_type', 'ASC'], ['sort_order', 'ASC']] });
    res.json({ rules: plain(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function createProcurement(req, res) {
  try {
    const b = req.body || {};
    if (!b.material_type || !b.category_or_material || b.individual_lead_days == null) {
      return res.status(400).json({ error: 'material_type, category_or_material, individual_lead_days required' });
    }
    const row = await QuoteProcurementRule.create({
      material_type: String(b.material_type).toUpperCase(), category_or_material: b.category_or_material,
      individual_lead_days: parseInt(b.individual_lead_days),
      batch_lead_days: b.batch_lead_days != null ? parseInt(b.batch_lead_days) : null,
      notes: b.notes || null, sort_order: b.sort_order || 0,
    });
    res.json({ ok: true, rule: row.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function updateProcurement(req, res) {
  try {
    const row = await QuoteProcurementRule.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Rule not found' });
    const b = req.body || {};
    await row.update({
      category_or_material: b.category_or_material ?? row.category_or_material,
      individual_lead_days: b.individual_lead_days != null ? parseInt(b.individual_lead_days) : row.individual_lead_days,
      batch_lead_days: b.batch_lead_days !== undefined ? (b.batch_lead_days != null ? parseInt(b.batch_lead_days) : null) : row.batch_lead_days,
      notes: b.notes ?? row.notes, sort_order: b.sort_order != null ? b.sort_order : row.sort_order,
    });
    res.json({ ok: true, rule: row.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function deleteProcurement(req, res) {
  try {
    const n = await QuoteProcurementRule.destroy({ where: { id: req.params.id } });
    if (!n) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true, id: parseInt(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────
// TIMELINE: MANUFACTURING RULES
// ─────────────────────────────────────────────────────────────
async function listManufacturing(req, res) {
  try {
    const where = req.query.type ? { product_type: req.query.type } : {};
    const rows = await QuoteManufacturingRule.findAll({ where, order: [['product_type', 'ASC'], ['product_subtype', 'ASC'], ['band_index', 'ASC']] });
    res.json({ rules: plain(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function createManufacturing(req, res) {
  try {
    const b = req.body || {};
    if (!b.product_type || b.band_index == null || b.manufacturing_days == null) {
      return res.status(400).json({ error: 'product_type, band_index, manufacturing_days required' });
    }
    const row = await QuoteManufacturingRule.create({
      product_type: b.product_type, product_subtype: b.product_subtype || '',
      band_index: parseInt(b.band_index), manufacturing_days: parseInt(b.manufacturing_days),
      cycle_time_days: b.cycle_time_days != null ? parseInt(b.cycle_time_days) : null, notes: b.notes || null,
    });
    res.json({ ok: true, rule: row.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function updateManufacturing(req, res) {
  try {
    const row = await QuoteManufacturingRule.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Rule not found' });
    const b = req.body || {};
    await row.update({
      manufacturing_days: b.manufacturing_days != null ? parseInt(b.manufacturing_days) : row.manufacturing_days,
      cycle_time_days: b.cycle_time_days !== undefined ? (b.cycle_time_days != null ? parseInt(b.cycle_time_days) : null) : row.cycle_time_days,
      notes: b.notes ?? row.notes,
    });
    res.json({ ok: true, rule: row.get({ plain: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function deleteManufacturing(req, res) {
  try {
    const n = await QuoteManufacturingRule.destroy({ where: { id: req.params.id } });
    if (!n) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true, id: parseInt(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────
// TIMELINE: QC + DISPATCH
// ─────────────────────────────────────────────────────────────
async function listQc(req, res) {
  try { res.json({ rules: plain(await QuoteQcRule.findAll({ order: [['grade_ref', 'ASC']] })) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
}
async function upsertQc(req, res) {
  try {
    const b = req.body || {};
    if (!b.grade_ref || b.qc_days == null) return res.status(400).json({ error: 'grade_ref and qc_days required' });
    const [row] = await QuoteQcRule.upsert({ grade_ref: b.grade_ref, qc_days: parseInt(b.qc_days), notes: b.notes || null });
    res.json({ ok: true, rule: row ? row.get({ plain: true }) : { grade_ref: b.grade_ref, qc_days: parseInt(b.qc_days) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function deleteQc(req, res) {
  try {
    const n = await QuoteQcRule.destroy({ where: { id: req.params.id } });
    if (!n) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true, id: parseInt(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
async function listDispatch(req, res) {
  try { res.json({ rules: plain(await QuoteDispatchConfig.findAll({ order: [['grade_ref', 'ASC']] })) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
}
async function upsertDispatch(req, res) {
  try {
    const b = req.body || {};
    if (!b.grade_ref || b.dispatch_days == null) return res.status(400).json({ error: 'grade_ref and dispatch_days required' });
    const [row] = await QuoteDispatchConfig.upsert({ grade_ref: b.grade_ref, dispatch_days: parseInt(b.dispatch_days), notes: b.notes || null });
    res.json({ ok: true, rule: row ? row.get({ plain: true }) : { grade_ref: b.grade_ref, dispatch_days: parseInt(b.dispatch_days) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────
// SAVED QUOTES
// ─────────────────────────────────────────────────────────────
function makeQuoteRef() {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `EIQ-${y}${m}-${rand}`;
}

async function saveQuote(req, res) {
  try {
    const b = req.body || {};
    if (!b.result || !Array.isArray(b.result.bands)) {
      return res.status(400).json({ error: 'A computed result is required to save a quote.' });
    }
    const mid = b.result.bands[3] || b.result.bands[0] || {};
    const row = await SavedQuote.create({
      quote_ref: makeQuoteRef(),
      quote_name: b.quote_name || b.result.bom_name || 'Untitled Quote',
      customer_name: b.customer_name || null,
      bom_id: b.payload?.bom_id || b.result.bom_id || null,
      bom_code: b.result.bom_code || null,
      grade: b.result.grade || null,
      mode: b.payload?.bom_id ? 'db' : 'adhoc',
      payload: b.payload || {}, result: b.result,
      headline_sell: mid.sell_price || null, headline_moq: mid.moq || null,
      notes: b.notes || null, gst_pct: b.gst_pct != null ? b.gst_pct : 18,
      valid_until: b.valid_until || null, client_id: b.client_id || null,
      prepared_by: b.prepared_by || req.user?.fullName || null,
    });
    res.json({ ok: true, id: row.id, quote_ref: row.quote_ref, created_at: row.created_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function listSaved(req, res) {
  try {
    const { Op } = require('sequelize');
    const { search, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (search) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [{ quote_name: like }, { customer_name: like }, { quote_ref: like }, { bom_code: like }];
    }
    const { count, rows } = await SavedQuote.findAndCountAll({
      where,
      attributes: ['id', 'quote_ref', 'quote_name', 'customer_name', 'bom_id', 'bom_code', 'grade', 'mode', 'headline_sell', 'headline_moq', 'notes', 'created_at'],
      order: [['created_at', 'DESC']], limit: parseInt(limit), offset: parseInt(offset),
    });
    res.json({ quotes: plain(rows), total: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function getSaved(req, res) {
  try {
    const row = await SavedQuote.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Saved quote not found' });
    res.json(row.get({ plain: true }));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function deleteSaved(req, res) {
  try {
    const row = await SavedQuote.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Saved quote not found' });
    await row.update(softDeletePayload(SavedQuote));
    res.json({ ok: true, id: row.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────
// RAW MATERIAL SG — persist manually-entered SG back to the master so
// future quotes auto-compute blended SG (scoped to specific_gravity only).
// ─────────────────────────────────────────────────────────────
async function saveRmSg(req, res) {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ error: 'No SG updates provided' });
    let updated = 0;
    for (const u of updates) {
      const id = parseInt(u.raw_material_id);
      const sg = parseFloat(u.specific_gravity);
      if (!Number.isFinite(id) || !Number.isFinite(sg) || sg <= 0) continue;
      const [count] = await RawMaterial.update({ specific_gravity: sg }, { where: { id } });
      updated += count;
    }
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('POST /quotes/rm-sg error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// EMAIL — stub (to be implemented later)
// ─────────────────────────────────────────────────────────────
async function sendEmail(req, res) {
  return res.status(501).json({ error: 'Email delivery is not implemented yet.', code: 'NOT_IMPLEMENTED' });
}

module.exports = {
  calculateQuote,
  listGrades, createGrade, updateGrade, deleteGrade,
  listOverheads, createOverhead, updateOverhead, deleteOverhead,
  listProcurement, createProcurement, updateProcurement, deleteProcurement,
  listManufacturing, createManufacturing, updateManufacturing, deleteManufacturing,
  listQc, upsertQc, deleteQc, listDispatch, upsertDispatch,
  saveQuote, listSaved, getSaved, deleteSaved, saveRmSg, sendEmail,
};
