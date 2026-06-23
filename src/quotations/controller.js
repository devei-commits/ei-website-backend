// ─────────────────────────────────────────────────────────────
// QUOTATION CONTROLLER
// Orchestrates: BOM enrich → load config → pricing + timeline,
// plus CRUD for grades, overheads, timeline rules, and saved quotes.
// All routes are super_admin-gated at the router level.
// ─────────────────────────────────────────────────────────────
const { QueryTypes, Op } = require('sequelize');
const db = require('../../db');
const {
  QuoteGrade, QuoteOverhead, QuoteProcurementRule, QuoteManufacturingRule,
  QuoteQcRule, QuoteDispatchConfig, SavedQuote, QuoteEmail, QuoteAuditLog,
  QuoteConversionRate, QuoteCategoryRate, QuoteActuals,
} = require('./models');
const { enrichBom } = require('./bomEnrich');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const SalesOrder = require('../salesOrders/models');
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
    let autoDetected = null;

    if (b.bom_id) {
      const bom = await fetchBom(b.bom_id);
      if (!bom) return res.status(404).json({ error: 'BOM not found' });
      const enriched = await enrichBom(bom, {
        rmOverrides: b.rmOverrides || {}, pmOverrides: b.pmOverrides || {}, sgOverrides: b.sgOverrides || {},
        pricingSource: b.pricingSource === 'vendor' ? 'vendor' : 'master',
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
      autoDetected = enriched.auto_detected || null;
    } else {
      const qs = ['rm_only', 'pm_only'].includes(b.quoteScope) ? b.quoteScope : 'full';
      if (qs !== 'pm_only' && (!Array.isArray(b.rmLines) || b.rmLines.length === 0)) {
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

    // Packaging config: user selection wins; auto_detected is first-load fallback only
    const packagingType = b.packagingType || (autoDetected && autoDetected.packaging_type) || 'Bottle & Jar';
    const volumeKey = b.volumeKey || (autoDetected && autoDetected.volume_key) || '<=100';
    const monocarton = (b.monocarton != null) ? b.monocarton : (autoDetected ? autoDetected.has_monocarton : true);

    const productType = detectProductType(bomMeta.bom_name);
    const [ohRows, timelineConfig] = await Promise.all([
      loadOverheadRows(productType),
      loadTimelineConfig(),
    ]);

    const quoteScope = ['rm_only', 'pm_only'].includes(b.quoteScope) ? b.quoteScope : 'full';
    const batchYieldPct = (b.batchYieldPct != null && b.batchYieldPct > 0 && b.batchYieldPct <= 100) ? parseFloat(b.batchYieldPct) : 100;

    // Load rate tables from DB; seed defaults on first use
    const [convRows, catRows] = await Promise.all([
      QuoteConversionRate.count().then(async n => { if (n === 0) await seedDefaultConversionRates(); return QuoteConversionRate.findAll(); }),
      QuoteCategoryRate.count().then(async n => { if (n === 0) await seedDefaultCategoryRates(); return QuoteCategoryRate.findAll(); }),
    ]);
    const conversionRates = buildConversionRatesObj(plain(convRows));
    const categoryRates = buildCategoryRatesObj(plain(catRows));

    const result = calculate({
      rmLines, pmLines,
      volumeMl: finalVolume, sg: finalSg,
      packagingType, volumeKey, monocarton,
      rmWastage: b.rmWastage, pmWastage: b.pmWastage,
      rmLogistics: b.rmLogistics, pmLogistics: b.pmLogistics,
      freightPct: b.freightPct, insurancePct: b.insurancePct, handlingPct: b.handlingPct,
      creditDays: b.creditDays, annualRate: b.annualRate,
      grade, ohRows,
      customMargins: b.customMargins || null, targetPrice: b.targetPrice || 0,
      quoteScope, batchYieldPct, conversionRates, categoryRates,
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
      pricing_source: b.bom_id ? (b.pricingSource === 'vendor' ? 'vendor' : 'master') : 'manual',
      auto_detected: autoDetected,
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
// Quote lifecycle state machine. Keys = current status, values = allowed next.
const STATUS_FLOW = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected', 'draft'],
  approved: ['sent', 'draft'],
  sent: ['accepted', 'rejected'],
  accepted: [],
  rejected: ['draft'],
};

async function changeStatus(req, res) {
  try {
    const row = await SavedQuote.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Saved quote not found' });
    const to = String(req.body?.status || '');
    const from = row.status || 'draft';
    const allowed = STATUS_FLOW[from] || [];
    if (!allowed.includes(to)) {
      return res.status(400).json({ error: `Cannot move a quote from "${from}" to "${to}".` });
    }
    const history = Array.isArray(row.status_history) ? row.status_history.slice() : [];
    history.push({ from, to, by: req.user?.id || null, by_name: req.user?.fullName || null, note: req.body?.note || null, at: new Date().toISOString() });
    await row.update({ status: to, status_history: history });
    res.json({ ok: true, status: to, status_history: history });
  } catch (err) {
    console.error('POST /quotes/saved/:id/status error:', err);
    res.status(500).json({ error: err.message });
  }
}

// POST /quotes/saved/:id/revise — create a new draft version that supersedes the source.
async function reviseQuote(req, res) {
  try {
    const src = await SavedQuote.findByPk(req.params.id);
    if (!src) return res.status(404).json({ error: 'Saved quote not found' });
    if (src.superseded_by) return res.status(400).json({ error: 'This quote already has a newer version.' });

    const newVersion = (src.version || 1) + 1;
    const rootId = src.root_quote_id || src.id;
    const ref = makeQuoteRef();
    const history = [{ from: null, to: 'draft', by: req.user?.id || null, by_name: req.user?.fullName || null, note: `Revised from ${src.quote_ref} (v${src.version || 1})`, at: new Date().toISOString() }];

    const dup = await SavedQuote.create({
      quote_ref: ref,
      quote_name: src.quote_name,
      customer_name: src.customer_name,
      bom_id: src.bom_id, bom_code: src.bom_code, grade: src.grade, mode: src.mode,
      payload: src.payload, result: src.result,
      headline_sell: src.headline_sell, headline_moq: src.headline_moq,
      notes: src.notes, gst_pct: src.gst_pct, valid_until: src.valid_until,
      client_id: src.client_id, prepared_by: req.user?.fullName || src.prepared_by,
      status: 'draft', status_history: history,
      version: newVersion, root_quote_id: rootId,
      quote_type: src.quote_type || 'full',
      quote_category: src.quote_category || 'pre_production',
      job_ref: src.job_ref || null,
      pre_quote_id: src.pre_quote_id || null,
    });
    await src.update({ superseded_by: dup.id });
    res.json({ ok: true, id: dup.id, quote_ref: ref, version: newVersion });
  } catch (err) {
    console.error('POST /quotes/saved/:id/revise error:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /quotes/saved/:id/versions — full revision lineage, ordered by version.
async function listVersions(req, res) {
  try {
    const { Op } = require('sequelize');
    const src = await SavedQuote.findByPk(req.params.id);
    if (!src) return res.status(404).json({ error: 'Saved quote not found' });
    const rootId = src.root_quote_id || src.id;
    const rows = await SavedQuote.findAll({
      where: { [Op.or]: [{ id: rootId }, { root_quote_id: rootId }] },
      attributes: ['id', 'quote_ref', 'version', 'status', 'headline_sell', 'superseded_by', 'created_at'],
      order: [['version', 'ASC']],
    });
    res.json({ versions: plain(rows) });
  } catch (err) {
    console.error('GET /quotes/saved/:id/versions error:', err);
    res.status(500).json({ error: err.message });
  }
}

// Next SO-NNNNN order id (5-digit zero-padded, max+1).
async function nextSoOrderId() {
  const rows = await db.query(`SELECT order_id FROM sales_orders WHERE order_id ~ '^SO-[0-9]+$'`, { type: QueryTypes.SELECT });
  let max = 0;
  for (const r of rows) { const n = parseInt(String(r.order_id).replace('SO-', '')); if (Number.isFinite(n) && n > max) max = n; }
  return 'SO-' + String(max + 1).padStart(5, '0');
}

// POST /quotes/saved/:id/convert — accepted quote → sales order (one line for the chosen band).
async function convertToSalesOrder(req, res) {
  try {
    const row = await SavedQuote.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Saved quote not found' });
    if ((row.status || 'draft') !== 'accepted') return res.status(400).json({ error: 'Only accepted quotes can be converted to a sales order.' });
    if (row.sales_order_id) return res.status(400).json({ error: `Already converted to ${row.sales_order_ref}.` });

    const result = row.result || {};
    const bands = Array.isArray(result.bands) ? result.bands : [];
    const bi = parseInt(req.body?.band_index);
    const band = bands[Number.isFinite(bi) ? bi : 3];
    if (!band) return res.status(400).json({ error: 'Invalid band selected.' });

    const qty = req.body?.quantity != null ? parseInt(req.body.quantity) : band.moqv;
    const unitPrice = req.body?.unit_price != null ? parseFloat(req.body.unit_price) : band.sell_price;
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Invalid quantity.' });

    const orderId = await nextSoOrderId();
    const item = {
      sku: result.product_code || result.bom_code || '',
      productName: row.quote_name || result.bom_name || '',
      pack: result.pack_size || '',
      quantity: qty, unitPrice, orderedQty: qty, openQty: qty,
      itemTotal: Math.round(qty * unitPrice * 100) / 100, hsnCode: '',
    };
    const so = await SalesOrder.create({
      order_id: orderId,
      customer_name: row.customer_name || null,
      order_date: new Date(),
      reference: row.quote_ref,
      status: 'Draft',
      items: [item],
      created_by: req.user?.fullName || null,
      form_data: { source: 'quotation', quote_id: row.id, quote_ref: row.quote_ref, band_moq: band.moq },
    });

    const history = Array.isArray(row.status_history) ? row.status_history.slice() : [];
    history.push({ from: row.status, to: row.status, by: req.user?.id || null, by_name: req.user?.fullName || null, note: `Converted to sales order ${orderId}`, at: new Date().toISOString() });
    await row.update({ sales_order_id: so.id, sales_order_ref: orderId, status_history: history });

    res.json({ ok: true, sales_order_id: so.id, order_id: orderId });
  } catch (err) {
    console.error('POST /quotes/saved/:id/convert error:', err);
    res.status(500).json({ error: err.message });
  }
}

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
      quote_type: b.quote_type || b.payload?.quoteScope || 'full',
      quote_category: b.quote_category || 'pre_production',
      job_ref: b.job_ref || null,
      pre_quote_id: b.pre_quote_id || null,
    });
    res.json({ ok: true, id: row.id, quote_ref: row.quote_ref, created_at: row.created_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Client typeahead for linking quotes to a vendor_clients record (type='client').
async function listClients(req, res) {
  try {
    const search = (req.query.search || '').trim();
    const conds = ['deleted_at IS NULL', "type = 'client'"];
    const bind = [];
    if (search) { bind.push(`%${search}%`); conds.push(`(name ILIKE $${bind.length} OR entity_code ILIKE $${bind.length} OR email ILIKE $${bind.length})`); }
    const rows = await db.query(
      `SELECT id, entity_code, name, email, segment, payment_terms, city
         FROM vendor_clients WHERE ${conds.join(' AND ')} ORDER BY name LIMIT 30`,
      { bind, type: QueryTypes.SELECT }
    );
    res.json({ clients: rows });
  } catch (err) {
    console.error('GET /quotes/clients error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function quoteStats(req, res) {
  try {
    const { Op } = require('sequelize');
    const rows = await SavedQuote.findAll({
      attributes: ['status', [db.fn('COUNT', db.col('id')), 'count']],
      group: ['status'], raw: true,
    });
    const byStatus = {};
    let total = 0;
    for (const r of rows) {
      const s = r.status || 'draft';
      byStatus[s] = (byStatus[s] || 0) + parseInt(r.count);
      total += parseInt(r.count);
    }
    const converted = await SavedQuote.count({ where: { sales_order_id: { [Op.ne]: null } } });
    res.json({ total, by_status: byStatus, converted });
  } catch (err) {
    console.error('GET /quotes/stats error:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /quotes/analytics — aggregate metrics for the dashboard.
async function quoteAnalytics(req, res) {
  try {
    const where = "deleted_at IS NULL AND COALESCE(lifecycle_status,'active') <> 'deleted'";
    const [byStatus, totals, topBoms, byMonth, recent] = await Promise.all([
      db.query(`SELECT COALESCE(status,'draft') s, COUNT(*)::int c FROM saved_quotes WHERE ${where} GROUP BY 1`, { type: QueryTypes.SELECT }),
      db.query(`SELECT COUNT(*)::int total, COUNT(sales_order_id)::int converted, AVG(headline_sell)::float avg_sell FROM saved_quotes WHERE ${where}`, { type: QueryTypes.SELECT }),
      db.query(`SELECT bom_code, MAX(quote_name) name, COUNT(*)::int c FROM saved_quotes WHERE ${where} AND bom_code IS NOT NULL GROUP BY bom_code ORDER BY c DESC LIMIT 6`, { type: QueryTypes.SELECT }),
      db.query(`SELECT to_char(created_at,'YYYY-MM') m, COUNT(*)::int c FROM saved_quotes WHERE ${where} AND created_at > NOW() - INTERVAL '6 months' GROUP BY 1 ORDER BY 1`, { type: QueryTypes.SELECT }),
      db.query(`SELECT id, quote_ref, quote_name, COALESCE(status,'draft') status, headline_sell, created_at FROM saved_quotes WHERE ${where} ORDER BY created_at DESC LIMIT 6`, { type: QueryTypes.SELECT }),
    ]);
    const sc = {};
    for (const r of byStatus) sc[r.s] = r.c;
    const accepted = sc.accepted || 0, rejected = sc.rejected || 0;
    const winRate = (accepted + rejected) > 0 ? accepted / (accepted + rejected) : null;
    const convRate = accepted > 0 ? totals[0].converted / accepted : null;
    res.json({
      total: totals[0].total, converted: totals[0].converted, avg_sell: totals[0].avg_sell,
      by_status: sc, win_rate: winRate, conversion_rate: convRate,
      top_boms: topBoms, by_month: byMonth, recent,
    });
  } catch (err) {
    console.error('GET /quotes/analytics error:', err);
    res.status(500).json({ error: err.message });
  }
}

// PUT /quotes/saved/:id — update an existing quote in place (not a new row).
async function updateSavedQuote(req, res) {
  try {
    const row = await SavedQuote.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Saved quote not found' });
    if (row.superseded_by) return res.status(400).json({ error: 'This quote has a newer version — revise that instead.' });
    if (row.sales_order_id) return res.status(400).json({ error: 'This quote is converted to a sales order and cannot be edited.' });

    const b = req.body || {};
    const result = b.result && Array.isArray(b.result.bands) ? b.result : row.result;
    const mid = (result && Array.isArray(result.bands) && (result.bands[3] || result.bands[0])) || {};
    await row.update({
      quote_name: b.quote_name ?? row.quote_name,
      customer_name: b.customer_name !== undefined ? b.customer_name : row.customer_name,
      client_id: b.client_id !== undefined ? b.client_id : row.client_id,
      notes: b.notes !== undefined ? b.notes : row.notes,
      gst_pct: b.gst_pct != null ? b.gst_pct : row.gst_pct,
      valid_until: b.valid_until !== undefined ? (b.valid_until || null) : row.valid_until,
      payload: b.payload || row.payload,
      result,
      bom_id: b.payload?.bom_id ?? row.bom_id,
      bom_code: result?.bom_code ?? row.bom_code,
      grade: result?.grade ?? row.grade,
      mode: b.payload ? (b.payload.bom_id ? 'db' : 'adhoc') : row.mode,
      headline_sell: mid.sell_price ?? row.headline_sell,
      headline_moq: mid.moq ?? row.headline_moq,
      quote_type: b.quote_type ?? row.quote_type,
      quote_category: b.quote_category ?? row.quote_category,
      job_ref: b.job_ref !== undefined ? b.job_ref : row.job_ref,
      pre_quote_id: b.pre_quote_id !== undefined ? b.pre_quote_id : row.pre_quote_id,
    });
    res.json({ ok: true, id: row.id, quote_ref: row.quote_ref });
  } catch (err) {
    console.error('PUT /quotes/saved/:id error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function listSaved(req, res) {
  try {
    const { Op } = require('sequelize');
    const { search, status, client_id, limit = 50, offset = 0 } = req.query;
    const and = [];
    if (search) {
      const like = { [Op.iLike]: `%${search}%` };
      and.push({ [Op.or]: [{ quote_name: like }, { customer_name: like }, { quote_ref: like }, { bom_code: like }] });
    }
    if (status) {
      // null status counts as 'draft'
      and.push(status === 'draft' ? { [Op.or]: [{ status: 'draft' }, { status: null }] } : { status });
    }
    if (client_id) and.push({ client_id: parseInt(client_id) });
    if (req.query.quote_type) and.push({ quote_type: req.query.quote_type });
    if (req.query.quote_category) and.push({ quote_category: req.query.quote_category });
    if (req.query.bom_code) and.push({ bom_code: req.query.bom_code });
    if (req.query.no_actuals === 'true') {
      and.push(db.literal(`(SELECT COUNT(*) FROM quote_actuals WHERE quote_actuals.post_quote_id = "SavedQuote"."id") = 0`));
    }
    const where = and.length ? { [Op.and]: and } : {};
    const { count, rows } = await SavedQuote.findAndCountAll({
      where,
      attributes: ['id', 'quote_ref', 'quote_name', 'customer_name', 'bom_id', 'bom_code', 'grade', 'mode', 'status', 'sales_order_ref', 'headline_sell', 'headline_moq', 'notes', 'quote_type', 'quote_category', 'job_ref', 'pre_quote_id', 'created_at',
        [db.literal(`(SELECT COUNT(*) FROM quote_actuals WHERE quote_actuals.post_quote_id = "SavedQuote"."id")`), 'actuals_count'],
      ],
      order: [['created_at', 'DESC']], limit: parseInt(limit), offset: parseInt(offset),
    });
    const quotes = plain(rows).map((q) => ({ ...q, status: q.status || 'draft' }));
    res.json({ quotes, total: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function computeVariance(actual, estimated) {
  if (actual == null || estimated == null) return null;
  const diff = parseFloat(actual) - parseFloat(estimated);
  const pct = parseFloat(estimated) !== 0 ? (diff / parseFloat(estimated)) * 100 : null;
  return { diff: Math.round(diff * 10000) / 10000, pct: pct != null ? Math.round(pct * 100) / 100 : null };
}

function enrichActuals(row) {
  const q = typeof row.get === 'function' ? row.get({ plain: true }) : row;
  return {
    ...q,
    variance: {
      rm:         computeVariance(q.actual_rm,         q.est_rm),
      pm:         computeVariance(q.actual_pm,         q.est_pm),
      conversion: computeVariance(q.actual_conversion, q.est_conversion),
      overhead:   computeVariance(q.actual_overhead,   q.est_overhead),
      total:      computeVariance(q.actual_total,      q.est_total),
    },
  };
}

async function checkPriceStaleness(q) {
  const warnings = [];
  const savedAt = q.updated_at || q.created_at;
  if (!savedAt) return warnings;
  const rmDetail = (q.result?.rm_detail || []).filter((r) => r.raw_material_id);
  const pmDetail = (q.result?.pm_detail || []).filter((p) => p.pack_material_id);
  if (rmDetail.length) {
    const rmIds = rmDetail.map((r) => r.raw_material_id);
    const current = await db.query(
      `SELECT id, name, price_per_kg FROM raw_materials WHERE id = ANY($1) AND updated_at > $2 AND deleted_at IS NULL`,
      { bind: [rmIds, savedAt], type: QueryTypes.SELECT }
    );
    for (const c of current) {
      const was = rmDetail.find((r) => r.raw_material_id === c.id)?.price_per_kg;
      if (was != null && Math.abs(parseFloat(c.price_per_kg) - parseFloat(was)) > 0.001) {
        const pct = ((parseFloat(c.price_per_kg) - parseFloat(was)) / parseFloat(was)) * 100;
        warnings.push({ type: 'RM', material_id: c.id, name: c.name, was: parseFloat(was), now: parseFloat(c.price_per_kg), pct_change: parseFloat(pct.toFixed(2)) });
      }
    }
  }
  if (pmDetail.length) {
    const pmIds = pmDetail.map((p) => p.pack_material_id);
    const current = await db.query(
      `SELECT id, description, price_per_pc FROM pack_materials WHERE id = ANY($1) AND updated_at > $2 AND deleted_at IS NULL`,
      { bind: [pmIds, savedAt], type: QueryTypes.SELECT }
    );
    for (const c of current) {
      const was = pmDetail.find((p) => p.pack_material_id === c.id)?.price_per_pc;
      if (was != null && Math.abs(parseFloat(c.price_per_pc) - parseFloat(was)) > 0.001) {
        const pct = ((parseFloat(c.price_per_pc) - parseFloat(was)) / parseFloat(was)) * 100;
        warnings.push({ type: 'PM', material_id: c.id, name: c.description, was: parseFloat(was), now: parseFloat(c.price_per_pc), pct_change: parseFloat(pct.toFixed(2)) });
      }
    }
  }
  return warnings;
}

async function getSaved(req, res) {
  try {
    const row = await SavedQuote.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Saved quote not found' });
    const q = row.get({ plain: true });
    q.status = q.status || 'draft';
    q.status_history = Array.isArray(q.status_history) ? q.status_history : [];
    q.price_warnings = await checkPriceStaleness(q);
    res.json(q);
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
// MATERIAL LEAD TIMES — view/edit raw_materials & pack_materials
// lead_time_days. The timing engine prefers these over vendor/rule
// fallbacks, so filling them makes per-material timelines DB-driven.
// ─────────────────────────────────────────────────────────────
async function listLeadTimes(req, res) {
  try {
    const type = String(req.query.type || 'RM').toUpperCase();
    const isPm = type === 'PM';
    const table = isPm ? 'pack_materials' : 'raw_materials';
    const nameCol = isPm ? 'description' : 'name';
    const classCol = isPm ? 'material' : 'category';
    const ilCol = isPm ? 'pack_material_id' : 'raw_material_id';
    const search = (req.query.search || '').trim();
    const missingOnly = req.query.missingOnly === 'true';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const conds = ['m.deleted_at IS NULL'];
    const bind = [];
    if (search) { bind.push(`%${search}%`); conds.push(`(m.code ILIKE $${bind.length} OR m.${nameCol} ILIKE $${bind.length})`); }
    if (missingOnly) conds.push('m.lead_time_days IS NULL');
    const whereSql = conds.join(' AND ');

    const countRows = await db.query(`SELECT COUNT(*)::int AS count FROM ${table} m WHERE ${whereSql}`, { bind, type: QueryTypes.SELECT });
    const total = countRows[0]?.count || 0;

    const items = await db.query(
      `SELECT m.id, m.code, m.${nameCol} AS name, m.${classCol} AS klass, m.lead_time_days, vl.lead AS vendor_lead
         FROM ${table} m
         LEFT JOIN (
           SELECT il.${ilCol} AS mid, MIN(vr.lead_time_days) AS lead
             FROM items_list il
             JOIN item_list_vendor_rates vr ON vr.items_list_id = il.id AND vr.deleted_at IS NULL AND vr.lead_time_days IS NOT NULL
            WHERE il.type = $${bind.length + 1} AND il.deleted_at IS NULL
            GROUP BY il.${ilCol}
         ) vl ON vl.mid = m.id
        WHERE ${whereSql}
        ORDER BY (m.lead_time_days IS NOT NULL), m.code
        LIMIT $${bind.length + 2} OFFSET $${bind.length + 3}`,
      { bind: [...bind, type, limit, offset], type: QueryTypes.SELECT }
    );
    res.json({ items, total });
  } catch (err) {
    console.error('GET /quotes/lead-times error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function saveLeadTimes(req, res) {
  try {
    const type = String(req.body?.type || 'RM').toUpperCase();
    const Model = type === 'PM' ? PackMaterial : RawMaterial;
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ error: 'No updates provided' });
    let updated = 0;
    for (const u of updates) {
      const id = parseInt(u.id);
      if (!Number.isFinite(id)) continue;
      const raw = u.lead_time_days;
      const lt = (raw === null || raw === '' || raw === undefined) ? null : parseInt(raw);
      if (lt !== null && (!Number.isFinite(lt) || lt < 0)) continue;
      const [count] = await Model.update({ lead_time_days: lt }, { where: { id } });
      updated += count;
    }
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('POST /quotes/lead-times error:', err);
    res.status(500).json({ error: err.message });
  }
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
// AUDIT LOG — middleware records successful config mutations; one hook
// instead of instrumenting every handler. GET endpoint lists entries.
// ─────────────────────────────────────────────────────────────
function auditConfig(entityType) {
  return (req, res, next) => {
    if (req.method !== 'GET') {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const action = req.method === 'DELETE' ? 'delete' : (req.params.id ? 'update' : 'create');
        const b = req.body || {};
        const name = b.name || b.head_name || b.category_or_material || b.grade_ref || b.product_type || (Array.isArray(b.updates) ? `${b.updates.length} item(s)` : '');
        QuoteAuditLog.create({
          entity_type: entityType,
          entity_id: req.params.id ? parseInt(req.params.id) : null,
          action,
          summary: `${action} ${entityType}${name ? `: ${name}` : ''}`,
          changed_by: req.user?.id || null,
          changed_by_name: req.user?.fullName || null,
        }).catch((e) => console.error('audit log failed:', e.message));
      });
    }
    next();
  };
}

async function listAudit(req, res) {
  try {
    const where = req.query.entity_type ? { entity_type: req.query.entity_type } : {};
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { count, rows } = await QuoteAuditLog.findAndCountAll({ where, order: [['created_at', 'DESC']], limit, offset });
    res.json({ entries: plain(rows), total: count });
  } catch (err) {
    console.error('GET /quotes/audit error:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /quotes/by-bom/:bom_code — all quotes for a specific BOM, with job grouping.
async function listQuotesByBom(req, res) {
  try {
    const bomCode = String(req.params.bom_code || '').trim();
    if (!bomCode) return res.status(400).json({ error: 'bom_code is required' });
    const { limit = 100, offset = 0 } = req.query;
    const { count, rows } = await SavedQuote.findAndCountAll({
      where: { bom_code: bomCode, deleted_at: null },
      attributes: ['id', 'quote_ref', 'quote_name', 'customer_name', 'bom_id', 'bom_code', 'grade', 'mode', 'status', 'sales_order_ref', 'headline_sell', 'headline_moq', 'notes', 'quote_type', 'quote_category', 'job_ref', 'pre_quote_id', 'version', 'superseded_by', 'created_at'],
      order: [['created_at', 'DESC']],
      limit: Math.min(parseInt(limit), 200),
      offset: parseInt(offset),
    });
    const quotes = plain(rows).map((q) => ({ ...q, status: q.status || 'draft' }));
    const jobs = {};
    for (const q of quotes) {
      const key = q.job_ref || '__ungrouped';
      if (!jobs[key]) jobs[key] = { job_ref: q.job_ref || null, quotes: [] };
      jobs[key].quotes.push(q);
    }
    res.json({ quotes, total: count, jobs: Object.values(jobs) });
  } catch (err) {
    console.error('GET /quotes/by-bom error:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /quotes/bom-stats/:bom_code — aggregate stats for BOM dashboard.
async function bomQuoteStats(req, res) {
  try {
    const bomCode = String(req.params.bom_code || '').trim();
    if (!bomCode) return res.status(400).json({ error: 'bom_code is required' });
    const where = `bom_code = $1 AND deleted_at IS NULL AND COALESCE(lifecycle_status,'active') <> 'deleted'`;
    const [counts, prices, byType, byCategory, byClient] = await Promise.all([
      db.query(`SELECT COUNT(*)::int total, COUNT(sales_order_id)::int converted, COUNT(CASE WHEN status='accepted' THEN 1 END)::int accepted, COUNT(CASE WHEN status='rejected' THEN 1 END)::int rejected FROM saved_quotes WHERE ${where}`, { bind: [bomCode], type: QueryTypes.SELECT }),
      db.query(`SELECT MIN(headline_sell)::float min_price, MAX(headline_sell)::float max_price, AVG(headline_sell)::float avg_price FROM saved_quotes WHERE ${where} AND headline_sell IS NOT NULL`, { bind: [bomCode], type: QueryTypes.SELECT }),
      db.query(`SELECT COALESCE(quote_type,'full') qt, COUNT(*)::int c FROM saved_quotes WHERE ${where} GROUP BY 1`, { bind: [bomCode], type: QueryTypes.SELECT }),
      db.query(`SELECT COALESCE(quote_category,'pre_production') qc, COUNT(*)::int c FROM saved_quotes WHERE ${where} GROUP BY 1`, { bind: [bomCode], type: QueryTypes.SELECT }),
      db.query(`SELECT customer_name, COUNT(*)::int c FROM saved_quotes WHERE ${where} AND customer_name IS NOT NULL GROUP BY customer_name ORDER BY c DESC LIMIT 5`, { bind: [bomCode], type: QueryTypes.SELECT }),
    ]);
    const c = counts[0] || {};
    const p = prices[0] || {};
    const accepted = c.accepted || 0, rejected = c.rejected || 0;
    const win_rate = (accepted + rejected) > 0 ? accepted / (accepted + rejected) : null;
    const by_type = {}; for (const r of byType) by_type[r.qt] = r.c;
    const by_category = {}; for (const r of byCategory) by_category[r.qc] = r.c;
    res.json({ bom_code: bomCode, total: c.total || 0, converted: c.converted || 0, win_rate, min_price: p.min_price, max_price: p.max_price, avg_price: p.avg_price, by_type, by_category, top_clients: byClient });
  } catch (err) {
    console.error('GET /quotes/bom-stats error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// CONVERSION RATES — DB-backed BT/TB/SR filling cost tables
// packaging_type='CONFIG', moq_band='mono_discount' stores the discount value.
// ─────────────────────────────────────────────────────────────

// Seed data: BT = Bottle & Jar, TB = Tube, SR = Serum with Dropper
// Each row: { packaging_type, moq_band, volume_key, rate }
const DEFAULT_CONV_RATES = [
  // Bottle & Jar — 4 bands × 3 vol keys (matching BT table in pricing.js)
  { packaging_type: 'Bottle & Jar', moq_band: '1-1000',     volume_key: '<=50',  rate: 11.15 },
  { packaging_type: 'Bottle & Jar', moq_band: '1-1000',     volume_key: '<=100', rate: 11.85 },
  { packaging_type: 'Bottle & Jar', moq_band: '1-1000',     volume_key: '<=200', rate: 12.55 },
  { packaging_type: 'Bottle & Jar', moq_band: '1000-5000',  volume_key: '<=50',  rate: 8.90 },
  { packaging_type: 'Bottle & Jar', moq_band: '1000-5000',  volume_key: '<=100', rate: 9.70 },
  { packaging_type: 'Bottle & Jar', moq_band: '1000-5000',  volume_key: '<=200', rate: 10.30 },
  { packaging_type: 'Bottle & Jar', moq_band: '5000-10000', volume_key: '<=50',  rate: 8.55 },
  { packaging_type: 'Bottle & Jar', moq_band: '5000-10000', volume_key: '<=100', rate: 9.35 },
  { packaging_type: 'Bottle & Jar', moq_band: '5000-10000', volume_key: '<=200', rate: 9.95 },
  { packaging_type: 'Bottle & Jar', moq_band: '10000+',     volume_key: '<=50',  rate: 7.65 },
  { packaging_type: 'Bottle & Jar', moq_band: '10000+',     volume_key: '<=100', rate: 8.45 },
  { packaging_type: 'Bottle & Jar', moq_band: '10000+',     volume_key: '<=200', rate: 9.05 },
  // Tube — 4 bands × 2 vol keys (matching TB table in pricing.js)
  { packaging_type: 'Tube', moq_band: '1-1000',     volume_key: '<=50',  rate: 11.45 },
  { packaging_type: 'Tube', moq_band: '1-1000',     volume_key: '<=100', rate: 12.15 },
  { packaging_type: 'Tube', moq_band: '1000-5000',  volume_key: '<=50',  rate: 9.30 },
  { packaging_type: 'Tube', moq_band: '1000-5000',  volume_key: '<=100', rate: 10.10 },
  { packaging_type: 'Tube', moq_band: '5000-10000', volume_key: '<=50',  rate: 8.45 },
  { packaging_type: 'Tube', moq_band: '5000-10000', volume_key: '<=100', rate: 9.25 },
  { packaging_type: 'Tube', moq_band: '10000+',     volume_key: '<=50',  rate: 7.25 },
  { packaging_type: 'Tube', moq_band: '10000+',     volume_key: '<=100', rate: 7.65 },
  // Serum with Dropper — 4 bands × 1 vol key (matching SR table in pricing.js)
  { packaging_type: 'Serum with Dropper', moq_band: '1-1000',     volume_key: '<=30', rate: 12.45 },
  { packaging_type: 'Serum with Dropper', moq_band: '1000-5000',  volume_key: '<=30', rate: 10.65 },
  { packaging_type: 'Serum with Dropper', moq_band: '5000-10000', volume_key: '<=30', rate: 9.60 },
  { packaging_type: 'Serum with Dropper', moq_band: '10000+',     volume_key: '<=30', rate: 8.60 },
  // Mono discount CONFIG row — matches hardcoded MONO_DISCOUNT = 0.70 in pricing.js
  { packaging_type: 'CONFIG', moq_band: 'mono_discount', volume_key: 'value', rate: 0.70 },
];

const DEFAULT_CATEGORY_RATES = [
  { category: 'Emollient',     wastage_pct: 3.0, notes: null },
  { category: 'Humectant',     wastage_pct: 2.5, notes: null },
  { category: 'Emulsifier',    wastage_pct: 3.5, notes: null },
  { category: 'Active',        wastage_pct: 2.0, notes: 'High-value — lower buffer' },
  { category: 'Preservative',  wastage_pct: 2.0, notes: null },
];

function buildConversionRatesObj(rows) {
  const obj = {};
  for (const r of rows) {
    if (r.packaging_type === 'CONFIG' && r.moq_band === 'mono_discount') {
      obj.MONO_DISCOUNT = pf(r.rate);
      continue;
    }
    if (!obj[r.packaging_type]) obj[r.packaging_type] = {};
    if (!obj[r.packaging_type][r.moq_band]) obj[r.packaging_type][r.moq_band] = {};
    obj[r.packaging_type][r.moq_band][r.volume_key] = pf(r.rate);
  }
  return obj;
}

function buildCategoryRatesObj(rows) {
  const obj = {};
  for (const r of rows) obj[r.category] = { wastage_pct: pf(r.wastage_pct), notes: r.notes || null };
  return obj;
}

async function seedDefaultConversionRates() {
  for (const row of DEFAULT_CONV_RATES) {
    await QuoteConversionRate.findOrCreate({
      where: { packaging_type: row.packaging_type, moq_band: row.moq_band, volume_key: row.volume_key },
      defaults: { rate: row.rate },
    });
  }
}

async function migrateConversionRateKeys() {
  const oldBands = ['1001-5000', '5001-10000', '>10000'];
  const oldVolKeys = ['101-250', '>250', '>100'];
  const deleted = await QuoteConversionRate.destroy({
    where: {
      [Op.or]: [
        { moq_band: { [Op.in]: oldBands } },
        { volume_key: { [Op.in]: oldVolKeys } },
      ],
    },
  });
  if (deleted > 0) {
    console.log(`[migration] Removed ${deleted} conversion rate rows with old key names — reseeding.`);
    await seedDefaultConversionRates();
  }
}

async function seedDefaultCategoryRates() {
  for (const row of DEFAULT_CATEGORY_RATES) {
    await QuoteCategoryRate.findOrCreate({
      where: { category: row.category },
      defaults: { wastage_pct: row.wastage_pct, notes: row.notes },
    });
  }
}

async function getConversionRates(req, res) {
  try {
    const count = await QuoteConversionRate.count();
    if (count === 0) await seedDefaultConversionRates();
    await migrateConversionRateKeys();
    const rows = await QuoteConversionRate.findAll({ order: [['packaging_type', 'ASC'], ['moq_band', 'ASC'], ['volume_key', 'ASC']] });
    res.json({ rates: plain(rows) });
  } catch (err) {
    console.error('GET /quotes/conversion-rates error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function upsertConversionRate(req, res) {
  try {
    const { packaging_type, moq_band, volume_key, rate } = req.body || {};
    if (!packaging_type || !moq_band || !volume_key || rate == null) return res.status(400).json({ error: 'packaging_type, moq_band, volume_key, rate are required' });
    const [row, created] = await QuoteConversionRate.findOrCreate({
      where: { packaging_type, moq_band, volume_key },
      defaults: { rate },
    });
    if (!created) await row.update({ rate });
    QuoteAuditLog.create({
      entity_type: 'conversion_rate', entity_id: row.id,
      action: created ? 'create' : 'update',
      summary: `${created ? 'created' : 'updated'} conversion rate: ${packaging_type} / ${moq_band} / ${volume_key} = ${rate}`,
      changed_by: req.user?.id || null, changed_by_name: req.user?.fullName || null,
    }).catch(e => console.error('audit log failed:', e.message));
    res.json({ rate: plain([row])[0] });
  } catch (err) {
    console.error('PUT /quotes/conversion-rates error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function getCategoryRates(req, res) {
  try {
    const count = await QuoteCategoryRate.count();
    if (count === 0) await seedDefaultCategoryRates();
    const rows = await QuoteCategoryRate.findAll({ order: [['category', 'ASC']] });
    res.json({ rates: plain(rows) });
  } catch (err) {
    console.error('GET /quotes/category-rates error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function upsertCategoryRate(req, res) {
  try {
    const { category, wastage_pct, notes } = req.body || {};
    if (!category || wastage_pct == null) return res.status(400).json({ error: 'category and wastage_pct are required' });
    const [row, created] = await QuoteCategoryRate.findOrCreate({
      where: { category },
      defaults: { wastage_pct, notes: notes || null },
    });
    if (!created) await row.update({ wastage_pct, notes: notes || null });
    QuoteAuditLog.create({
      entity_type: 'category_rate', entity_id: row.id,
      action: created ? 'create' : 'update',
      summary: `${created ? 'created' : 'updated'} category rate: ${category} = ${wastage_pct}%`,
      changed_by: req.user?.id || null, changed_by_name: req.user?.fullName || null,
    }).catch(e => console.error('audit log failed:', e.message));
    res.json({ rate: plain([row])[0] });
  } catch (err) {
    console.error('PUT /quotes/category-rates error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function deleteCategoryRate(req, res) {
  try {
    const id = parseInt(req.params.id);
    const row = await QuoteCategoryRate.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Category rate not found' });
    const cat = row.category;
    await row.destroy();
    QuoteAuditLog.create({
      entity_type: 'category_rate', entity_id: id, action: 'delete',
      summary: `deleted category rate: ${cat}`,
      changed_by: req.user?.id || null, changed_by_name: req.user?.fullName || null,
    }).catch(e => console.error('audit log failed:', e.message));
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /quotes/category-rates error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── Quote Actuals (v0.9.0) ──

async function createActuals(req, res) {
  try {
    const b = req.body;
    if (!b.bom_code) return res.status(400).json({ error: 'bom_code required' });
    const actual_total = [b.actual_rm, b.actual_pm, b.actual_conversion, b.actual_overhead]
      .reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const est_total = [b.est_rm, b.est_pm, b.est_conversion, b.est_overhead]
      .reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const row = await QuoteActuals.create({
      bom_code:       b.bom_code,
      job_ref:        b.job_ref || null,
      pre_quote_id:   b.pre_quote_id || null,
      post_quote_id:  b.post_quote_id || null,
      batch_size:     b.batch_size ? parseInt(b.batch_size) : null,
      yield_pct:      b.yield_pct != null ? parseFloat(b.yield_pct) : null,
      actual_rm:      b.actual_rm != null ? parseFloat(b.actual_rm) : null,
      actual_pm:      b.actual_pm != null ? parseFloat(b.actual_pm) : null,
      actual_conversion: b.actual_conversion != null ? parseFloat(b.actual_conversion) : null,
      actual_overhead:   b.actual_overhead  != null ? parseFloat(b.actual_overhead)  : null,
      actual_total:   actual_total > 0 ? actual_total : null,
      est_rm:         b.est_rm != null ? parseFloat(b.est_rm) : null,
      est_pm:         b.est_pm != null ? parseFloat(b.est_pm) : null,
      est_conversion: b.est_conversion != null ? parseFloat(b.est_conversion) : null,
      est_overhead:   b.est_overhead   != null ? parseFloat(b.est_overhead)   : null,
      est_total:      est_total > 0 ? est_total : null,
      notes:          b.notes || null,
      entered_by:     req.user?.id || null,
      entered_by_name: req.user?.fullName || null,
    });
    await QuoteAuditLog.create({
      entity_type: 'QuoteActuals', entity_id: row.id, action: 'create',
      summary: `Actuals entered for BOM ${b.bom_code}`,
      changed_by: req.user?.id || null, changed_by_name: req.user?.fullName || null,
    }).catch(e => console.error('audit log failed:', e.message));
    res.status(201).json(enrichActuals(row));
  } catch (err) { console.error('createActuals error:', err); res.status(500).json({ error: err.message }); }
}

async function getActualsByQuote(req, res) {
  try {
    const qid = parseInt(req.params.quote_id);
    const rows = await QuoteActuals.findAll({
      where: { [Op.or]: [{ post_quote_id: qid }, { pre_quote_id: qid }] },
      order: [['created_at', 'DESC']],
    });
    res.json({ actuals: rows.map(enrichActuals) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function getActualsByBom(req, res) {
  try {
    const rows = await QuoteActuals.findAll({
      where: { bom_code: req.params.bom_code },
      order: [['created_at', 'DESC']],
    });
    res.json({ actuals: rows.map(enrichActuals) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function updateActuals(req, res) {
  try {
    const row = await QuoteActuals.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Actuals record not found' });
    const b = req.body;
    const actual_total = [b.actual_rm ?? row.actual_rm, b.actual_pm ?? row.actual_pm, b.actual_conversion ?? row.actual_conversion, b.actual_overhead ?? row.actual_overhead]
      .reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const est_total = [b.est_rm ?? row.est_rm, b.est_pm ?? row.est_pm, b.est_conversion ?? row.est_conversion, b.est_overhead ?? row.est_overhead]
      .reduce((s, v) => s + (parseFloat(v) || 0), 0);
    await row.update({
      batch_size:     b.batch_size != null ? parseInt(b.batch_size) : row.batch_size,
      yield_pct:      b.yield_pct  != null ? parseFloat(b.yield_pct) : row.yield_pct,
      actual_rm:      b.actual_rm  != null ? parseFloat(b.actual_rm) : row.actual_rm,
      actual_pm:      b.actual_pm  != null ? parseFloat(b.actual_pm) : row.actual_pm,
      actual_conversion: b.actual_conversion != null ? parseFloat(b.actual_conversion) : row.actual_conversion,
      actual_overhead:   b.actual_overhead   != null ? parseFloat(b.actual_overhead)   : row.actual_overhead,
      actual_total:   actual_total > 0 ? actual_total : row.actual_total,
      est_rm:         b.est_rm != null ? parseFloat(b.est_rm) : row.est_rm,
      est_pm:         b.est_pm != null ? parseFloat(b.est_pm) : row.est_pm,
      est_conversion: b.est_conversion != null ? parseFloat(b.est_conversion) : row.est_conversion,
      est_overhead:   b.est_overhead   != null ? parseFloat(b.est_overhead)   : row.est_overhead,
      est_total:      est_total > 0 ? est_total : row.est_total,
      notes:          b.notes !== undefined ? b.notes : row.notes,
    });
    res.json(enrichActuals(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function deleteActuals(req, res) {
  try {
    const row = await QuoteActuals.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await row.destroy();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Dashboard Stats (v0.9.1) ──
async function getDashboardStats(req, res) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [totalQuotes, quotesThisMonth, actualsCount, byScope, byCategory, topBomsRaw, recentRaw] = await Promise.all([
      SavedQuote.count({ where: { superseded_by: null } }),
      SavedQuote.count({ where: { superseded_by: null, created_at: { [Op.gte]: startOfMonth } } }),
      QuoteActuals.count(),
      db.query(`SELECT quote_type, COUNT(*) as c FROM saved_quotes WHERE superseded_by IS NULL GROUP BY quote_type`, { type: db.QueryTypes.SELECT }),
      db.query(`SELECT quote_category, COUNT(*) as c FROM saved_quotes WHERE superseded_by IS NULL GROUP BY quote_category`, { type: db.QueryTypes.SELECT }),
      db.query(`SELECT bom_code, COUNT(*) as c FROM saved_quotes WHERE superseded_by IS NULL AND bom_code IS NOT NULL GROUP BY bom_code ORDER BY c DESC LIMIT 5`, { type: db.QueryTypes.SELECT }),
      db.query(`SELECT id, quote_ref, quote_name, status, created_at FROM saved_quotes WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 5`, { type: db.QueryTypes.SELECT }),
    ]);

    let avgAccuracyPct = null;
    if (actualsCount > 0) {
      const rows = await QuoteActuals.findAll({ attributes: ['actual_total', 'est_total'] });
      const variances = rows
        .map(r => r.get({ plain: true }))
        .filter(r => r.actual_total != null && r.est_total != null && parseFloat(r.est_total) !== 0)
        .map(r => Math.abs((parseFloat(r.actual_total) - parseFloat(r.est_total)) / parseFloat(r.est_total) * 100));
      if (variances.length > 0) avgAccuracyPct = Math.round((variances.reduce((s, v) => s + v, 0) / variances.length) * 100) / 100;
    }

    const pendingActuals = await db.query(
      `SELECT COUNT(*) as c FROM saved_quotes sq
       LEFT JOIN quote_actuals qa ON qa.post_quote_id = sq.id
       WHERE sq.quote_category = 'post_production' AND sq.superseded_by IS NULL AND qa.id IS NULL`,
      { type: db.QueryTypes.SELECT }
    );

    res.json({
      total_quotes: totalQuotes,
      quotes_this_month: quotesThisMonth,
      actuals_count: actualsCount,
      pending_actuals: parseInt(pendingActuals[0]?.c ?? 0),
      avg_accuracy_pct: avgAccuracyPct,
      by_scope: Object.fromEntries((byScope || []).map(r => [r.quote_type || 'full', parseInt(r.c)])),
      by_category: Object.fromEntries((byCategory || []).map(r => [r.quote_category || 'pre_production', parseInt(r.c)])),
      top_boms: (topBomsRaw || []).map(r => ({ bom_code: r.bom_code, count: parseInt(r.c) })),
      recent: (recentRaw || []).map(r => ({ id: r.id, quote_ref: r.quote_ref, quote_name: r.quote_name, status: r.status || 'draft', created_at: r.created_at })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  saveQuote, updateSavedQuote, quoteStats, quoteAnalytics, listClients, listSaved, getSaved, deleteSaved, changeStatus, convertToSalesOrder, reviseQuote, listVersions, saveRmSg,
  listQuotesByBom, bomQuoteStats,
  getConversionRates, upsertConversionRate,
  getCategoryRates, upsertCategoryRate, deleteCategoryRate,
  createActuals, getActualsByQuote, getActualsByBom, updateActuals, deleteActuals,
  getDashboardStats,
  listLeadTimes, saveLeadTimes, auditConfig, listAudit, sendEmail,
};
