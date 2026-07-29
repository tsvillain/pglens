/**
 * HTTP client for pglens-cloud's API. Handles bearer-token auth and a
 * single automatic retry after refreshing an expired access token —
 * callers never think about tokens.
 */

const { getCloudUrl } = require('./config');
const session = require('./session');

class CloudError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Cloud request failed (HTTP ${status})`);
    this.status = status;
    this.code = body?.error?.code || 'CLOUD_ERROR';
  }
}

async function rawRequest(path, { method = 'GET', body, accessToken } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${getCloudUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** Unauthenticated request — signup/login/token exchange, before a session exists. */
async function publicRequest(path, opts = {}) {
  const res = await rawRequest(path, opts);
  if (!res.ok) throw new CloudError(res.status, res.json);
  return res.json;
}

/** Authenticated request. Retries once after a token refresh on 401. */
async function request(path, opts = {}) {
  const tokens = await session.getTokens();
  if (!tokens) {
    throw new CloudError(401, { error: { code: 'NOT_SIGNED_IN', message: 'Not signed in to pglens cloud' } });
  }

  let res = await rawRequest(path, { ...opts, accessToken: tokens.accessToken });
  if (res.status === 401) {
    const refreshed = await rawRequest('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: tokens.refreshToken },
    });
    if (!refreshed.ok) {
      await session.clearSession();
      throw new CloudError(401, refreshed.json);
    }
    await session.updateTokens(refreshed.json.accessToken, refreshed.json.refreshToken);
    res = await rawRequest(path, { ...opts, accessToken: refreshed.json.accessToken });
  }

  if (!res.ok) throw new CloudError(res.status, res.json);
  return res.json;
}

module.exports = { CloudError, rawRequest, publicRequest, request };
