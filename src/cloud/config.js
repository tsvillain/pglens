// Override for local development against a local pglens-cloud checkout —
// e.g. PGLENS_CLOUD_URL=http://localhost:4000. A function, not a frozen
// constant, so it's read fresh on every call — tests set this env var
// after startup, once a fake cloud server's ephemeral port is known.
function getCloudUrl() {
  return process.env.PGLENS_CLOUD_URL || 'https://app.pglens.org';
}

module.exports = { getCloudUrl };
