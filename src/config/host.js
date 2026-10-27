/**
 * Where the server listens and the URL people open.
 *
 * Local (default): binds 127.0.0.1 on 54321, or a random port if taken.
 * Server: run behind a TLS reverse proxy on a subdomain, e.g.
 *   PGLENS_BIND=0.0.0.0 PGLENS_PORT=54321 PGLENS_PUBLIC_URL=https://db.example.com
 * The public hostname is added to the Host-header allowlist, the auth cookie
 * becomes Secure, and printed URLs use the public origin.
 */

function parsePort(raw) {
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PGLENS_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

function parsePublicUrl(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch {
    throw new Error(`PGLENS_PUBLIC_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PGLENS_PUBLIC_URL must start with https:// or http://, got "${raw}"`);
  }
  // ponytail: origin only (subdomain hosting). Path prefixes like /pglens need
  // a client base path; add when someone asks.
  if (url.pathname !== '/') {
    throw new Error(`PGLENS_PUBLIC_URL must not include a path, got "${raw}"`);
  }
  return url;
}

function loadHostConfig(env = process.env) {
  const bindHost = env.PGLENS_BIND || '127.0.0.1';
  const fixedPort = parsePort(env.PGLENS_PORT);
  const publicUrl = parsePublicUrl(env.PGLENS_PUBLIC_URL);

  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', bindHost.toLowerCase()]);
  if (publicUrl) allowedHosts.add(publicUrl.hostname.toLowerCase());

  return {
    bindHost,
    fixedPort,
    publicUrl,
    allowedHosts,
    secureCookie: publicUrl?.protocol === 'https:',
    displayUrl(port, token) {
      const base = publicUrl ? publicUrl.origin : `http://${bindHost}:${port}`;
      return token ? `${base}/?token=${token}` : base;
    },
  };
}

module.exports = { loadHostConfig, ...loadHostConfig() };
