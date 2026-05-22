#!/usr/bin/env node
/**
 * Post-install notice.
 *
 * pglens is curl-managed (install/install.sh, under ~/.pglens). When this
 * runs from the curl installer's `npm install --prefix ~/.pglens` it sits
 * under ~/.pglens and analyze() reports ok — silent. When it runs from a
 * direct `npm i -g pglens`, that's the discouraged channel: analyze()
 * flags it and we steer the user back to the curl script.
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
  line('  ⚠  pglens: install needs attention.');
  for (const p of problems) line(`     • ${p.message}`);
  line();
  line('     Run  pglens doctor  for an exact cleanup, then `hash -r`');
  line('     (or open a new terminal) so your shell picks up v' + selfVersion + '.');
  line();
} catch {
  /* never block install */
}

process.exit(0);
