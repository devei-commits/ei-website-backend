const LogisticsSchedule = require('./models');

function toDateOnly(d) {
  if (!d) return null;
  // Expect YYYY-MM-DD from UI; keep it as-is when possible.
  const s = String(d).trim();
  if (!s) return null;
  return s;
}

function normalizePayload(body = {}) {
  return {
    tracking_no:
      body.trackingNo !== undefined ? body.trackingNo : body.tracking_no,
    transporter:
      body.transporter !== undefined ? body.transporter : body.transporter_no,
    dispatch_date:
      body.dispatchDate !== undefined ? body.dispatchDate : body.dispatch_date,
    eta_date:
      body.etaDate !== undefined ? body.etaDate : body.eta_date,
    vehicle_no:
      body.vehicleNo !== undefined ? body.vehicleNo : body.vehicle_no,
  };
}

function validateRequired(fields) {
  const tracking = String(fields.tracking_no || '').trim();
  const transporter = String(fields.transporter || '').trim();
  const dispatch = String(fields.dispatch_date || '').trim();
  const eta = String(fields.eta_date || '').trim();
  const vehicle = String(fields.vehicle_no || '').trim();

  if (!tracking) return 'Tracking / LR number is required.';
  if (!transporter) return 'Transporter / courier is required.';
  if (!dispatch) return 'Dispatch date is required.';
  if (!eta) return 'ETA is required.';
  if (!vehicle) return 'Vehicle number is required.';
  return null;
}

async function list(req, res) {
  try {
    const status = req.query.status ? String(req.query.status) : 'Active';
    const rows = await LogisticsSchedule.findAll({
      where: { status },
      order: [['id', 'DESC']],
    });
    const out = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      return {
        id: d.id,
        trackingNo: d.tracking_no,
        transporter: d.transporter,
        dispatchDate: d.dispatch_date,
        etaDate: d.eta_date,
        vehicleNo: d.vehicle_no,
        status: d.status,
        createdAt: d.created_at || null,
      };
    });
    res.json(out);
  } catch (err) {
    console.error('[logisticsSchedules] list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list logistics schedules' });
  }
}

async function create(req, res) {
  try {
    const body = req.body || {};
    const fields = normalizePayload(body);
    const err = validateRequired(fields);
    if (err) return res.status(400).json({ error: err });

    const payload = {
      tracking_no: String(fields.tracking_no).trim(),
      transporter: String(fields.transporter).trim(),
      dispatch_date: toDateOnly(fields.dispatch_date),
      eta_date: toDateOnly(fields.eta_date),
      vehicle_no: String(fields.vehicle_no).trim(),
      status: body.status ? String(body.status).trim() : 'Active',
    };

    const row = await LogisticsSchedule.create(payload);
    const d = row.get ? row.get({ plain: true }) : row;
    res.status(201).json({
      id: d.id,
      trackingNo: d.tracking_no,
      transporter: d.transporter,
      dispatchDate: d.dispatch_date,
      etaDate: d.eta_date,
      vehicleNo: d.vehicle_no,
      status: d.status,
      createdAt: d.created_at || null,
    });
  } catch (err) {
    console.error('[logisticsSchedules] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create logistics schedule' });
  }
}

module.exports = { list, create };

