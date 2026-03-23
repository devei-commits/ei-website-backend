async function isDbAvailable(db, { timeoutMs = 3000 } = {}) {
  if (!db || typeof db.authenticate !== 'function') return false;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Sequelize's authenticate doesn't accept AbortSignal in all versions,
    // but we still attempt; if ignored, timeout won't abort and we'll fall through quickly anyway.
    await db.authenticate({ signal: controller.signal });
    return true;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { isDbAvailable };

