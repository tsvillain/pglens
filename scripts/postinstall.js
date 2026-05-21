#!/usr/bin/env node
/**
 * Post-install notice.
 *
 * npm only updates the binary in *its* prefix. If a user has a leftover
 * copy elsewhere (an old npm prefix, or the pre-3.0 ~/.pglens self-install)
 * the freshly installed version gets shadowed and the upgrade looks like a
 * no-op. We can't fix another channel from here, but we can warn loudly.
 *
 * MUST never fail the install: everything is wrapped, exit is always 0.
 */

try {
  if (process.env.CI || process.env.PGLENS_NO_POSTINSTALL) process.exit(0);

  const fs = require('fs');
  const path = require('path');
  const diag = require('../src/diagnostics');
  const selfVersion = require('../package.json').version;

  let selfReal;
  try { selfReal = fs.realpathSync(path.join(__dirname, '..', 'bin', 'pglens')); } catch {}

  const report = diag.collectReport({ selfReal, selfVersion });
  const { ok, problems } = diag.analyze(report);
  if (ok) process.exit(0);

  const line = (s = '') => console.warn(s);
  line();
  line('  ⚠  pglens: install may be shadowed by an older copy.');
  for (const p of problems) line(`     • ${p.message}`);
  line();
  line('     Run  pglens doctor  for an exact cleanup, then `hash -r`');
  line('     (or open a new terminal) so your shell picks up v' + selfVersion + '.');
  line();
} catch {
  /* never block install */
}

process.exit(0);
