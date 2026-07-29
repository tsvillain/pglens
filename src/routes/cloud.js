/**
 * Loopback OAuth client (RFC 8252, DISTRIBUTION.md §2) + a thin proxy over
 * pglens-cloud's workspace API. The browser never talks to pglens-cloud
 * directly — everything goes through this local server, which is the only
 * thing holding the cloud session tokens (in the keychain, cloud/session.js).
 *
 * `/callback` is deliberately NOT part of this router — it's mounted
 * separately in server.js, before the per-install-token auth middleware.
 * The cloud's redirect back to us is a cross-site top-level navigation, so
 * the pglens_token cookie (SameSite=Strict) never rides along; the `state`
 * check here is what stands in for that (see handleCallback).
 */

const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');

const { getCloudUrl } = require('../cloud/config');
const session = require('../cloud/session');
const client = require('../cloud/client');
const { validate } = require('../http/validate');
const { sendError } = require('../http/errors');
const logger = require('../log');

const router = express.Router();
router.use(express.json());

const STATE_TTL_MS = 5 * 60 * 1000;
// state -> expiresAt. One local server process, in-memory is enough — a
// pending sign-in doesn't need to survive a restart.
const pendingStates = new Map();

function callbackUrl(req) {
  return `${req.protocol}://${req.get('host')}/api/cloud/callback`;
}

router.post('/signin', (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  const url = new URL('/auth', getCloudUrl());
  url.searchParams.set('redirect_uri', callbackUrl(req));
  url.searchParams.set('state', state);
  url.searchParams.set('mode', req.query.mode === 'signup' ? 'signup' : 'login');
  res.json({ authUrl: url.toString() });
});

/**
 * Mounted directly in server.js, ahead of the auth middleware — see the
 * module comment. Authorization here is the single-use, server-generated
 * `state` (deleted on first use), not the per-install token.
 */
async function handleCallback(req, res) {
  const { code, state } = req.query;
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  if (!state || !expiresAt || expiresAt < Date.now()) {
    return res.status(400).send('Sign-in link is invalid or has expired. Try signing in again.');
  }
  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const tokens = await client.publicRequest('/auth/token', { method: 'POST', body: { code } });
    const me = await client.rawRequest('/auth/me', { accessToken: tokens.accessToken });
    if (!me.ok) throw new client.CloudError(me.status, me.json);
    await session.setSession({
      email: me.json.user.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'cloud sign-in callback failed');
    return res.status(502).send('Sign-in failed — could not reach pglens cloud. Try again.');
  }

  res.redirect(302, '/');
}

router.get('/status', async (req, res) => {
  res.json({
    signedIn: await session.isSignedIn(),
    email: session.getEmail(),
    workspaceId: session.getWorkspaceId(),
  });
});

router.post('/signout', async (req, res) => {
  await session.clearSession();
  res.json({ ok: true });
});

function handleCloudError(res, err) {
  if (err instanceof client.CloudError) {
    return sendError(res, err.status, err.code, err.message);
  }
  throw err;
}

router.get('/workspaces', async (req, res) => {
  try {
    res.json(await client.request('/workspaces'));
  } catch (err) {
    handleCloudError(res, err);
  }
});

router.post('/workspaces', validate({ body: z.object({ name: z.string().min(1).max(200) }) }), async (req, res) => {
  try {
    const result = await client.request('/workspaces', { method: 'POST', body: req.body });
    res.status(201).json(result);
  } catch (err) {
    handleCloudError(res, err);
  }
});

router.post('/workspaces/:id/select', validate({ params: z.object({ id: z.string().uuid() }) }), (req, res) => {
  session.setWorkspaceId(req.params.id);
  res.json({ ok: true });
});

router.get('/workspaces/:id/members', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  try {
    res.json(await client.request(`/workspaces/${req.params.id}/members`));
  } catch (err) {
    handleCloudError(res, err);
  }
});

router.patch(
  '/workspaces/:id/members/:userId',
  validate({
    params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }),
    body: z.object({ accessLevel: z.enum(['read', 'write', 'admin', 'owner']) }),
  }),
  async (req, res) => {
    try {
      const result = await client.request(`/workspaces/${req.params.id}/members/${req.params.userId}`, {
        method: 'PATCH',
        body: req.body,
      });
      res.json(result);
    } catch (err) {
      handleCloudError(res, err);
    }
  },
);

router.post('/workspaces/:id/invites', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  try {
    const result = await client.request(`/workspaces/${req.params.id}/invites`, { method: 'POST' });
    res.status(201).json(result);
  } catch (err) {
    handleCloudError(res, err);
  }
});

module.exports = { router, handleCallback };
