'use strict';

/**
 * Integration tests sign JWTs with a single static secret. Clear composite env vars that may be
 * loaded from the repo `.env` so `jwtSecrets` uses legacy ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET.
 */
function useStaticJwtSecretsForTests() {
  delete process.env.ACCESS_TOKEN_SECRET_PREFIX;
  delete process.env.ACCESS_TOKEN_SECRET_SUFFIX;
  delete process.env.REFRESH_TOKEN_SECRET_PREFIX;
  delete process.env.REFRESH_TOKEN_SECRET_SUFFIX;
  if (!process.env.ACCESS_TOKEN_SECRET) process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';
  if (!process.env.REFRESH_TOKEN_SECRET) process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret';
}

module.exports = { useStaticJwtSecretsForTests };
