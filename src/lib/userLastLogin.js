/**
 * Persist last successful authentication time on users.last_login_at.
 */
const { User } = require('../users/models');

/**
 * @param {number | { userid?: number }} userOrId
 * @returns {Promise<void>}
 */
async function recordUserLastLogin(userOrId) {
  const userId =
    userOrId != null && typeof userOrId === 'object'
      ? userOrId.userid
      : userOrId;
  const id = parseInt(String(userId ?? ''), 10);
  if (!Number.isFinite(id) || id <= 0) return;
  const now = new Date();
  await User.update(
    { last_login_at: now, updated_at: now },
    { where: { userid: id } }
  );
}

module.exports = { recordUserLastLogin };
