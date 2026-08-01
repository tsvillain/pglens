/**
 * AWS RDS IAM authentication: a short-lived (15 min) signed token used
 * *as the password* instead of a stored one. Token
 * generation is local (no network call) — it's a presigned URL, verified
 * by RDS itself when the connection attempt reaches it.
 *
 * AWS credentials are never handled or stored by pglens — @aws-sdk/rds-signer
 * defaults to the AWS SDK's own credential provider chain (env vars, shared
 * config/credentials file, instance/task role, SSO), the same one every
 * other AWS CLI/SDK tool on the machine already uses. `profile` lets a user
 * pick a named profile from that chain instead of the default.
 *
 * UNVERIFIED LIVE: built against the real, installed SDK (its type
 * definitions, not guessed) but never exercised against a real RDS
 * instance — no AWS account/RDS instance was available to test with here.
 * The token must actually be tried against a real IAM-auth-enabled RDS
 * instance before this is trusted in production.
 */

const { Signer } = require('@aws-sdk/rds-signer');

async function generateRdsAuthToken({ hostname, port, username, region, profile }) {
  const signer = new Signer({ hostname, port, username, region, profile });
  return signer.getAuthToken();
}

module.exports = { generateRdsAuthToken };
