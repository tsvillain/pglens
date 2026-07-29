/**
 * Local cloud-account session: tokens in the keychain (via db/secrets.js's
 * existing backend, same as connection passwords — never a plaintext
 * file), non-secret bits (email, selected workspace) in ~/.pglens/cloud.json.
 */

const fs = require('fs');
const { CLOUD_FILE, ensureLayout } = require('../config/paths');
const { setPassword, getPassword, deletePassword } = require('../db/secrets');

// Pseudo connection-id — the keychain backend is keyed by an opaque string,
// and this one is never a real Postgres connection.
const ACCOUNT = '__pglens_cloud__';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8'));
  } catch {
    return { email: null, workspaceId: null };
  }
}

function saveState(patch) {
  ensureLayout();
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(CLOUD_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

async function getTokens() {
  const raw = await getPassword(ACCOUNT);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setSession({ email, accessToken, refreshToken }) {
  await setPassword(ACCOUNT, JSON.stringify({ accessToken, refreshToken }));
  saveState({ email, workspaceId: null });
}

async function updateTokens(accessToken, refreshToken) {
  const current = await getTokens();
  await setPassword(
    ACCOUNT,
    JSON.stringify({ accessToken, refreshToken: refreshToken ?? current?.refreshToken }),
  );
}

async function clearSession() {
  await deletePassword(ACCOUNT);
  saveState({ email: null, workspaceId: null });
}

async function isSignedIn() {
  return (await getTokens()) != null;
}

function getEmail() {
  return loadState().email;
}

function getWorkspaceId() {
  return loadState().workspaceId;
}

function setWorkspaceId(workspaceId) {
  saveState({ workspaceId });
}

module.exports = {
  getTokens,
  setSession,
  updateTokens,
  clearSession,
  isSignedIn,
  getEmail,
  getWorkspaceId,
  setWorkspaceId,
};
