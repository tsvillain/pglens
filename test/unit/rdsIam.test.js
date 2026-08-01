/**
 * Unit test for src/db/rdsIam.js.
 *
 * UNVERIFIED LIVE — there's no AWS account/RDS instance in this environment
 * to actually mint and use a real IAM token against. What *can* be checked
 * without one: that this module correctly delegates to the real, installed
 * @aws-sdk/rds-signer rather than silently swallowing or mis-wiring
 * anything — with no AWS credentials configured, the SDK's own credential
 * chain should reject cleanly, not throw something unrelated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateRdsAuthToken } = require('../../src/db/rdsIam');

test('generateRdsAuthToken delegates to the real AWS SDK credential chain (no creds configured here)', async () => {
  // Neutralize the env-var credential source so this doesn't behave
  // differently on a machine that happens to have AWS_* exported (e.g. a
  // contributor with the AWS CLI configured). Doesn't cover ~/.aws/credentials
  // or an EC2/ECS instance role — a rarer case, not worth guarding against here.
  const AWS_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'];
  const saved = Object.fromEntries(AWS_VARS.map((k) => [k, process.env[k]]));
  for (const k of AWS_VARS) delete process.env[k];

  try {
    await assert.rejects(
      generateRdsAuthToken({ hostname: 'db.example.com', port: 5432, username: 'app', region: 'us-east-1' }),
      (err) => {
        // CredentialsProviderError, specifically — proves this reached the
        // real SDK's credential resolution, not some unrelated failure
        // (e.g. a bad import or a typo in the module's own wiring).
        assert.equal(err.name, 'CredentialsProviderError');
        return true;
      },
    );
  } finally {
    for (const k of AWS_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
