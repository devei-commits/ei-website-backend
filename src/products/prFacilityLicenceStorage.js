/** PR master — ML1 / ML2 facility licence records on BOM. */

function normalizeApplicable(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'y' || v === 'true') return 'yes';
  if (v === 'no' || v === 'n' || v === 'false') return 'no';
  return '';
}

function normalizeLicenceStatus(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'active') return 'active';
  if (v === 'expired') return 'expired';
  if (v === 'suspended') return 'suspended';
  if (v === 'pending' || v === 'pending renewal' || v === 'pending_renewal') return 'pending';
  return '';
}

function normalizeFacilityCode(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'ML1') return 'ML1';
  if (v === 'ML2') return 'ML2';
  return null;
}

function parseDateOnly(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const dmy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeDateInput(raw) {
  const parsed = parseDateOnly(raw);
  if (!parsed) return String(raw ?? '').trim();
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const SLOT_DEFAULTS = [
  { facilityCode: 'ML1', facilityLabel: 'Hyderabad ML1 · Plot 24' },
  { facilityCode: 'ML2', facilityLabel: 'Hyderabad ML2 · Plot 18' },
];

function emptyLicenceFields() {
  return {
    applicable: '',
    licenceStatus: '',
    licenceType: '',
    licenceNumber: '',
    issuedOn: '',
    validTill: '',
    remarks: '',
  };
}

function parseLicenceRecord(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw;
  const facilityCode =
    normalizeFacilityCode(row.facilityCode ?? row.facility_code) ??
    (idx === 0 ? 'ML1' : idx === 1 ? 'ML2' : null);
  if (!facilityCode) return null;
  const defaultSlot = SLOT_DEFAULTS.find((s) => s.facilityCode === facilityCode);
  return {
    facilityCode,
    facilityLabel: String(row.facilityLabel ?? row.facility_label ?? defaultSlot?.facilityLabel ?? facilityCode).trim(),
    applicable: normalizeApplicable(row.applicable),
    licenceStatus: normalizeLicenceStatus(row.licenceStatus ?? row.licence_status),
    licenceType: String(row.licenceType ?? row.licence_type ?? '').trim(),
    licenceNumber: String(row.licenceNumber ?? row.licence_number ?? '').trim(),
    issuedOn: normalizeDateInput(row.issuedOn ?? row.issued_on ?? ''),
    validTill: normalizeDateInput(row.validTill ?? row.valid_till ?? ''),
    remarks: String(row.remarks ?? '').trim(),
  };
}

function createDefaultRecords() {
  return SLOT_DEFAULTS.map((slot) => ({ ...slot, ...emptyLicenceFields() }));
}

function hydratePrFacilityLicencesFromBom(bomPlain) {
  const raw = bomPlain?.pr_facility_licences ?? bomPlain?.prFacilityLicences;
  if (!Array.isArray(raw)) return createDefaultRecords();
  const parsed = raw.map((item, idx) => parseLicenceRecord(item, idx)).filter(Boolean);
  if (!parsed.length) return createDefaultRecords();
  const byCode = new Map(parsed.map((r) => [r.facilityCode, r]));
  return SLOT_DEFAULTS.map((slot) => byCode.get(slot.facilityCode) ?? { ...slot, ...emptyLicenceFields() });
}

function flattenPrFacilityLicencesForStorage(records) {
  if (!Array.isArray(records)) return null;
  const out = records
    .map((row) => ({
      facilityCode: row.facilityCode,
      facilityLabel: String(row.facilityLabel ?? '').trim(),
      applicable: normalizeApplicable(row.applicable),
      licenceStatus: normalizeLicenceStatus(row.licenceStatus ?? row.licence_status),
      licenceType: String(row.licenceType ?? row.licence_type ?? '').trim(),
      licenceNumber: String(row.licenceNumber ?? row.licence_number ?? '').trim(),
      issuedOn: normalizeDateInput(row.issuedOn ?? row.issued_on ?? ''),
      validTill: normalizeDateInput(row.validTill ?? row.valid_till ?? ''),
      remarks: String(row.remarks ?? '').trim(),
    }))
    .filter(
      (row) =>
        row.applicable ||
        row.licenceStatus ||
        (row.licenceType && row.licenceType !== 'Other') ||
        row.licenceNumber ||
        row.issuedOn ||
        row.validTill ||
        row.remarks
    );
  return out.length ? out : null;
}

function facilityCodeFromMuZone(zoneCode) {
  const z = String(zoneCode || '').trim().toUpperCase();
  if (z.includes('ML2') || z === 'LOC-ML2' || z.includes('MU02')) return 'ML2';
  return 'ML1';
}

function isLicenceCurrentlyValid(record, asOf = new Date()) {
  if (record.licenceStatus !== 'active') return false;
  const till = parseDateOnly(record.validTill);
  if (!till) return false;
  const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate(), 12, 0, 0);
  return till.getTime() >= today.getTime();
}

function facilityRecordIsComplete(record) {
  if (record.applicable !== 'yes') return true;
  const typeOk = Boolean(record.licenceType && record.licenceType !== 'Other');
  return Boolean(
    record.licenceStatus &&
      typeOk &&
      record.licenceNumber &&
      record.issuedOn &&
      record.validTill
  );
}

function evaluatePrFacilityLicenceForMuZone(records, muZoneCode, asOf = new Date()) {
  const list = Array.isArray(records) ? records : [];
  const facilityCode = facilityCodeFromMuZone(muZoneCode);
  const record = list.find((r) => r.facilityCode === facilityCode);
  if (!record || record.applicable !== 'yes') {
    return {
      ok: false,
      message: `PR is not licensed for production at ${facilityCode}. Update Licensing in PR Master.`,
    };
  }
  if (!facilityRecordIsComplete(record)) {
    return {
      ok: false,
      message: `PR ${facilityCode} licence details are incomplete. Complete Licensing in PR Master.`,
    };
  }
  if (!isLicenceCurrentlyValid(record, asOf)) {
    return {
      ok: false,
      message: `PR ${facilityCode} licence is not active or has expired. Update Licensing in PR Master.`,
    };
  }
  return { ok: true, message: `Cleared for production at ${facilityCode}.` };
}

module.exports = {
  hydratePrFacilityLicencesFromBom,
  flattenPrFacilityLicencesForStorage,
  evaluatePrFacilityLicenceForMuZone,
  facilityCodeFromMuZone,
};
