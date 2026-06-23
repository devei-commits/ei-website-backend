const BOM = require('../bom/models');
const { Product } = require('./models');
const {
  hydratePrFacilityLicencesFromBom,
  evaluatePrFacilityLicenceForMuZone,
} = require('./prFacilityLicenceStorage');
const { scheduleFieldsInBody } = require('../production/scheduleFromPlanning');

async function loadPrFacilityLicencesForProductSku(sku) {
  const code = String(sku ?? '').trim();
  if (!code) return hydratePrFacilityLicencesFromBom(null);
  const product = await Product.findOne({ where: { product_code: code } });
  if (!product) return hydratePrFacilityLicencesFromBom(null);
  const bom = await BOM.findOne({ where: { product_id: product.product_id } });
  const plain = bom ? (bom.get ? bom.get({ plain: true }) : bom) : null;
  return hydratePrFacilityLicencesFromBom(plain);
}

function batchLicenceGateNeeded(prevPlain, nextPlain, body) {
  const prevStatus = String(prevPlain?.bmr_status || '').toLowerCase();
  const nextStatus = String(nextPlain?.bmr_status || '').toLowerCase();
  const prevZone = String(prevPlain?.scheduled_mu_zone || '').trim();
  const nextZone = String(nextPlain?.scheduled_mu_zone || '').trim();
  const zoneSetOrChanged = nextZone && nextZone !== prevZone;
  const scheduleTouch = scheduleFieldsInBody(body || {});
  const confirmingBatch =
    prevStatus === 'draft' && nextStatus === 'batch_confirmed' && Boolean(nextZone || prevZone);
  return zoneSetOrChanged || scheduleTouch || confirmingBatch;
}

/**
 * Block batch schedule / confirm when PR master licence is not cleared for the MU zone.
 * @returns {Promise<string|null>} error message or null if ok / not applicable
 */
async function assertPrLicenceClearForBatchPatch(prevPlain, nextPlain, body) {
  if (!batchLicenceGateNeeded(prevPlain, nextPlain, body)) return null;
  const muZone = String(nextPlain?.scheduled_mu_zone || prevPlain?.scheduled_mu_zone || '').trim();
  if (!muZone) return null;
  const sku = String(nextPlain?.sku || prevPlain?.sku || '').trim();
  if (!sku) return null;
  const licences = await loadPrFacilityLicencesForProductSku(sku);
  const verdict = evaluatePrFacilityLicenceForMuZone(licences, muZone);
  return verdict.ok ? null : verdict.message;
}

module.exports = {
  loadPrFacilityLicencesForProductSku,
  assertPrLicenceClearForBatchPatch,
  batchLicenceGateNeeded,
};
