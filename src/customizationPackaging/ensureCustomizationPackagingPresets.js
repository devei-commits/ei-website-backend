const CustomizationPackagingOption = require('./models');
const presetsSeedRows = require('./presetsSeedRows');

/**
 * If the catalog table has no rows, insert canonical presets so the public site and Admin stay aligned.
 * Full reseed still wipes/reloads via `seed.js`.
 */
async function ensureCustomizationPackagingPresets() {
  try {
    const n = await CustomizationPackagingOption.count();
    if (n > 0) return;
    const now = new Date();
    await CustomizationPackagingOption.bulkCreate(
      presetsSeedRows.map((row) => ({
        ...row,
        created_at: now,
        updated_at: now,
      })),
    );
    console.log(
      '[customization-packaging] Inserted default packaging presets (table was empty).',
    );
  } catch (err) {
    console.error(
      '[customization-packaging] ensure defaults failed:',
      err && err.message ? err.message : err,
    );
  }
}

module.exports = { ensureCustomizationPackagingPresets };
