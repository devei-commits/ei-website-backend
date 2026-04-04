'use strict';

/**
 * JWT HMAC secrets: either a single legacy env var, or PREFIX + userId + SUFFIX (per-user signing key).
 * Verification uses `sub` (or `id`) from the payload to rebuild the same secret — tampering with `sub` invalidates the signature.
 */

function normalizeUserId(userId) {
  if (userId == null || userId === '') {
    throw new Error('JWT signing requires a user id (sub)');
  }
  return String(userId);
}

function useCompositeAccess() {
  const pre = process.env.ACCESS_TOKEN_SECRET_PREFIX;
  const suf = process.env.ACCESS_TOKEN_SECRET_SUFFIX;
  return !!(pre && suf && String(pre).trim() && String(suf).trim());
}

function useCompositeRefresh() {
  const pre = process.env.REFRESH_TOKEN_SECRET_PREFIX;
  const suf = process.env.REFRESH_TOKEN_SECRET_SUFFIX;
  return !!(pre && suf && String(pre).trim() && String(suf).trim());
}

/** @param {string|number|undefined|null} [userId] — required when using PREFIX+SUFFIX (composite); ignored for legacy single secret. */
function accessSigningSecret(userId) {
  if (useCompositeAccess()) {
    const id = normalizeUserId(userId);
    return `${process.env.ACCESS_TOKEN_SECRET_PREFIX}${id}${process.env.ACCESS_TOKEN_SECRET_SUFFIX}`;
  }
  const legacy = process.env.ACCESS_TOKEN_SECRET;
  if (legacy && String(legacy).trim()) {
    return String(legacy).replace(/^['"]|['"]$/g, '');
  }
  throw new Error(
    'Set ACCESS_TOKEN_SECRET_PREFIX + ACCESS_TOKEN_SECRET_SUFFIX, or ACCESS_TOKEN_SECRET (legacy).'
  );
}

/** @param {string|number|undefined|null} [userId] — required for composite refresh secrets. */
function refreshSigningSecret(userId) {
  if (useCompositeRefresh()) {
    const id = normalizeUserId(userId);
    return `${process.env.REFRESH_TOKEN_SECRET_PREFIX}${id}${process.env.REFRESH_TOKEN_SECRET_SUFFIX}`;
  }
  const legacy = process.env.REFRESH_TOKEN_SECRET;
  if (legacy && String(legacy).trim()) {
    return String(legacy).replace(/^['"]|['"]$/g, '');
  }
  throw new Error(
    'Set REFRESH_TOKEN_SECRET_PREFIX + REFRESH_TOKEN_SECRET_SUFFIX, or REFRESH_TOKEN_SECRET (legacy).'
  );
}

module.exports = {
  accessSigningSecret,
  refreshSigningSecret,
  useCompositeAccess,
  useCompositeRefresh,
};
