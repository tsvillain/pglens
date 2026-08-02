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
const { getToken } = require('../auth');

const router = express.Router();
router.use(express.json());

const STATE_TTL_MS = 5 * 60 * 1000;
// state -> expiresAt. One local server process, in-memory is enough — a
// pending sign-in doesn't need to survive a restart.
const pendingStates = new Map();

function callbackUrl(req) {
  return `${req.protocol}://${req.get('host')}/api/cloud/callback`;
}

// Dodo's redirect back to us after checkout/portal is, same as the OAuth
// callback above, a cross-site top-level navigation — the SameSite=Strict
// pglens_token cookie won't ride along. Unlike the OAuth callback, /cloud
// itself can't be pulled out from behind the auth middleware (it's the
// normal app route, not a one-off endpoint), so the token rides in the URL
// instead — the same mechanism the CLI's own printed URL uses. The auth
// middleware sets the cookie and strips `token` from the URL on arrival,
// leaving `checkout=return` intact for the app to notice.
function billingReturnUrl(req) {
  const url = new URL('/cloud', `${req.protocol}://${req.get('host')}`);
  url.searchParams.set('token', getToken());
  url.searchParams.set('checkout', 'return');
  return url.toString();
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

// Back out of a selected workspace to the picker — there was previously no
// way to do this once a workspace was opened (found live: a workspace
// created before upgrading to Pro had no path back to see other workspaces
// or re-check personal-plan status against the list).
router.post('/workspaces/deselect', (req, res) => {
  session.setWorkspaceId(null);
  res.json({ ok: true });
});

// Which connections are actually shared into this workspace. Sharing itself
// is implicit — whatever workspace is selected when a connection is
// created/edited gets it pushed automatically (src/cloud/sync.js) — but
// nothing previously let you see the *result* of that from the Cloud tab.
// pglens-cloud has had this endpoint since M3; it just was never proxied.
router.get('/workspaces/:id/connections', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  try {
    res.json(await client.request(`/workspaces/${req.params.id}/connections`));
  } catch (err) {
    handleCloudError(res, err);
  }
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

// Metadata-only audit log (statement kind + table, never raw SQL/row data —
// see pglens-cloud's db/schema.sql note on audit_log). Views/saved queries
// need no equivalent read route here: they merge automatically into the
// existing /api/views and /api/saved-queries via the M1 source extension
// points (src/cloud/sync.js), same as connections already do.
router.get(
  '/workspaces/:id/audit',
  validate({
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ limit: z.coerce.number().int().positive().optional() }),
  }),
  async (req, res) => {
    try {
      const qs = req.query.limit ? `?limit=${req.query.limit}` : '';
      res.json(await client.request(`/workspaces/${req.params.id}/audit${qs}`));
    } catch (err) {
      handleCloudError(res, err);
    }
  },
);

// Billing — thin proxy over pglens-cloud's /billing routes, same as
// everything else in this file. checkout/portal return a hosted URL for the
// renderer to navigate to; pglens core never touches card data or Dodo
// credentials directly.
// The workspace is the only billing subject (one plan ladder, per-seat) —
// checkout and portal are always against a specific workspace.
const CheckoutBody = z.object({
  key: z.enum(['pro_monthly', 'pro_yearly']),
  workspaceId: z.string().uuid(),
  seatCount: z.number().int().positive().optional(),
});

router.post('/billing/checkout', validate({ body: CheckoutBody }), async (req, res) => {
  try {
    const body = { ...req.body, returnUrl: billingReturnUrl(req) };
    res.json(await client.request('/billing/checkout', { method: 'POST', body }));
  } catch (err) {
    handleCloudError(res, err);
  }
});

const PortalBody = z.object({ workspaceId: z.string().uuid() });

router.post('/billing/portal', validate({ body: PortalBody }), async (req, res) => {
  try {
    const body = { ...req.body, returnUrl: billingReturnUrl(req) };
    res.json(await client.request('/billing/portal', { method: 'POST', body }));
  } catch (err) {
    handleCloudError(res, err);
  }
});

router.patch(
  '/workspaces/:id/seats',
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({ seatCount: z.number().int().min(1) }),
  }),
  async (req, res) => {
    try {
      const result = await client.request(`/billing/workspaces/${req.params.id}/seats`, {
        method: 'PATCH',
        body: { seatCount: req.body.seatCount },
      });
      res.json(result);
    } catch (err) {
      handleCloudError(res, err);
    }
  },
);

// In-app subscription dashboard — read status, cancel, or resume without
// ever leaving pglens. "Manage billing" (the Dodo portal above) is kept
// only for updating a payment method, which stays on Dodo's hosted page on
// purpose (collecting card details ourselves would be a PCI problem with
// no upside).
router.get(
  '/billing/subscription',
  validate({ query: z.object({ workspaceId: z.string().uuid() }) }),
  async (req, res) => {
    try {
      res.json(await client.request(`/billing/subscription?workspaceId=${req.query.workspaceId}`));
    } catch (err) {
      handleCloudError(res, err);
    }
  },
);

const WorkspaceIdBody = z.object({ workspaceId: z.string().uuid() });

router.post('/billing/cancel', validate({ body: WorkspaceIdBody }), async (req, res) => {
  try {
    res.json(await client.request('/billing/cancel', { method: 'POST', body: req.body }));
  } catch (err) {
    handleCloudError(res, err);
  }
});

router.post('/billing/resume', validate({ body: WorkspaceIdBody }), async (req, res) => {
  try {
    res.json(await client.request('/billing/resume', { method: 'POST', body: req.body }));
  } catch (err) {
    handleCloudError(res, err);
  }
});

// Hosted AI mode — metered NL→SQL against pglens's own key. BYOK AI never
// touches this proxy or pglens-cloud at all; it talks to the user's chosen
// provider directly with the user's own key. This path only exists for the
// hosted, Pro-only alternative.
const AiCompleteBody = z.object({
  workspaceId: z.string().uuid(),
  prompt: z.string().min(1).max(4000),
  schemaContext: z.string().max(64_000),
});

router.post('/ai/complete', validate({ body: AiCompleteBody }), async (req, res) => {
  try {
    res.json(await client.request('/ai/complete', { method: 'POST', body: req.body }));
  } catch (err) {
    handleCloudError(res, err);
  }
});

router.get(
  '/ai/credits',
  validate({ query: z.object({ workspaceId: z.string().uuid() }) }),
  async (req, res) => {
    try {
      res.json(await client.request(`/ai/credits?workspaceId=${req.query.workspaceId}`));
    } catch (err) {
      handleCloudError(res, err);
    }
  },
);

router.get(
  '/ai/credits/history',
  validate({ query: z.object({ workspaceId: z.string().uuid(), limit: z.coerce.number().int().positive().optional() }) }),
  async (req, res) => {
    try {
      const qs = req.query.limit ? `&limit=${req.query.limit}` : '';
      res.json(await client.request(`/ai/credits/history?workspaceId=${req.query.workspaceId}${qs}`));
    } catch (err) {
      handleCloudError(res, err);
    }
  },
);

const AiCreditsCheckoutBody = z.object({
  workspaceId: z.string().uuid(),
  quantity: z.number().int().positive().optional(),
});

router.post('/ai/credits/checkout', validate({ body: AiCreditsCheckoutBody }), async (req, res) => {
  try {
    const body = { ...req.body, returnUrl: billingReturnUrl(req) };
    res.json(await client.request('/ai/credits/checkout', { method: 'POST', body }));
  } catch (err) {
    handleCloudError(res, err);
  }
});

module.exports = { router, handleCallback };
