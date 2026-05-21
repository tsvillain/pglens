#!/usr/bin/env node
/**
 * Cross-platform test-file discovery for `node --test`.
 *
 * `node --test test/unit/*.test.js` only works where the *shell* expands the
 * glob (POSIX). On Windows npm runs scripts via cmd.exe, which passes the
 * literal `*.test.js`, and node 18/20 don't expand globs in `--test` args
 * either — so the run finds no files and exits 1. This script enumerates the
 * directory itself and hands node an explicit, absolute file list.
 *
 * Usage: node scripts/run-tests.js <dir> [extra node flags...]
 *   node scripts/run-tests.js test/unit
 *   node scripts/run-tests.js test/unit --experimental-test-coverage
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [dir, ...extraFlags] = process.argv.slice(2);
if (!dir) {
  console.error('usage: run-tests.js <dir> [extra node flags...]');
  process.exit(2);
}

const absDir = path.resolve(dir);
const files = fs
  .readdirSync(absDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(absDir, f));

if (files.length === 0) {
  console.error(`no *.test.js files found in ${dir}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--test', ...extraFlags, ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
