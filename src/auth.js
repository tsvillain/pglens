/**
 * Per-install token + cookie-based auth for the local server.
 *
 * Threat model: prevent other local users / curious browser tabs from
 * driving the database through pglens. The token is written to
 * ~/.pglens/token (mode 0600) on first start. The CLI embeds the token
 * in the URL it prints. On first visit the server sets an HttpOnly cookie
 * and 302s the browser to a clean URL.
 */

const fs = require('fs');
const crypto = require('crypto');
const { TOKEN_FILE, ensureLayout } = require('./config/paths');
const { sendError } = require('./http/errors');

const COOKIE_NAME = 'pglens_token';
let cachedToken = null;

function loadOrCreateToken() {
  ensureLayout();
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (token.length >= 32) {
        cachedToken = token;
        return token;
      }
    } catch {
      // fall through and regenerate
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  cachedToken = token;
  return token;
}

function getToken() {
  return cachedToken ?? loadOrCreateToken();
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Express middleware enforcing the per-install token.
 *
 * Accepts the token from (in order): `?token=` query param,
 * `x-pglens-token` header, or `pglens_token` cookie. On a successful
 * query-string match, sets the cookie and 302s to a token-stripped URL
 * so it doesn't leak into history.
 */
function tokenMiddleware(req, res, next) {
  const expected = getToken();
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = req.get('x-pglens-token');
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;

  if (constantTimeEquals(cookieToken, expected)) return next();
  if (constantTimeEquals(headerToken, expected)) return next();

  if (constantTimeEquals(queryToken, expected)) {
    res.cookie(COOKIE_NAME, expected, {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    // Browser navigations: redirect to a clean URL so the token isn't in history.
    if (req.method === 'GET' && req.accepts('html')) {
      const url = new URL(req.originalUrl, 'http://localhost');
      url.searchParams.delete('token');
      const cleanPath = url.pathname + (url.search ? url.search : '');
      return res.redirect(302, cleanPath);
    }
    return next();
  }

  return sendError(res, 401, 'UNAUTHENTICATED', 'Missing or invalid token', {
    hint:
      'Open pglens via the URL printed by the CLI, or include the token in the x-pglens-token header.',
  });
}

module.exports = { tokenMiddleware, loadOrCreateToken, getToken, COOKIE_NAME };
