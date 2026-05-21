const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const diag = require('../../src/diagnostics');

test('pathDirs splits on the delimiter and drops empties', () => {
  assert.deepEqual(diag.pathDirs('/a::/b:', ':'), ['/a', '/b']);
});

test('findOnPath returns one match per dir, in PATH order, deduped', () => {
  const present = new Set([
    '/opt/homebrew/bin/pglens',
    '/usr/local/bin/pglens',
    '/Users/x/.pglens/bin/pglens',
  ]);
  const found = diag.findOnPath('pglens', {
    pathStr: ['/opt/homebrew/bin', '/usr/local/bin', '/Users/x/.pglens/bin', '/Users/x/.pglens/bin']
      .join(':'),
    existsSync: (f) => present.has(f),
    realpathSync: (f) => f,
    platform: 'linux',
  });
  assert.deepEqual(found.map((f) => f.file), [
    '/opt/homebrew/bin/pglens',
    '/usr/local/bin/pglens',
    '/Users/x/.pglens/bin/pglens', // the duplicate PATH entry is collapsed
  ]);
});

test('probeVersion extracts the semver from --version output', () => {
  const v = diag.probeVersion('/x/pglens', { exec: () => '3.0.0\n', platform: 'linux' });
  assert.equal(v, '3.0.0');
});

test('probeVersion returns null when the binary errors', () => {
  const v = diag.probeVersion('/x/pglens', {
    exec: () => { throw new Error('ENOENT'); },
    platform: 'linux',
  });
  assert.equal(v, null);
});

test('compareVersions compares the release portion numerically', () => {
  assert.equal(diag.compareVersions('3.0.0', '1.0.0'), 1);
  assert.equal(diag.compareVersions('1.0.0', '3.0.0'), -1);
  assert.equal(diag.compareVersions('3.0.0', '3.0.0'), 0);
  assert.equal(diag.compareVersions('3.0.10', '3.0.2'), 1);
});

test('detectStaleSelfInstall finds wrapper, node_modules and rc refs', () => {
  const home = '/Users/x';
  const present = new Set([
    path.join(home, '.pglens', 'bin', 'pglens'),
    path.join(home, '.pglens', 'node_modules'),
    path.join(home, '.zshrc'),
  ]);
  const r = diag.detectStaleSelfInstall({
    home,
    existsSync: (p) => present.has(p),
    readFileSync: () => 'export PATH="$PATH:/Users/x/.pglens/bin"\n',
  });
  assert.equal(r.wrapper, path.join(home, '.pglens', 'bin', 'pglens'));
  assert.equal(r.nodeModules, path.join(home, '.pglens', 'node_modules'));
  assert.equal(r.pkgJson, null);
  assert.deepEqual(r.rcRefs, [path.join(home, '.zshrc')]);
});

test('detectStaleSelfInstall reports nothing on a clean machine', () => {
  const r = diag.detectStaleSelfInstall({
    home: '/Users/x',
    existsSync: () => false,
    readFileSync: () => '',
  });
  assert.equal(r.wrapper, null);
  assert.equal(r.nodeModules, null);
  assert.deepEqual(r.rcRefs, []);
});

test('analyze flags shadowing, extra copies and stale install', () => {
  const report = {
    selfVersion: '3.0.0',
    copies: [
      { file: '/usr/local/bin/pglens', real: '/usr/local/bin/pglens', version: '1.0.0', isSelf: false },
      { file: '/opt/homebrew/bin/pglens', real: '/opt/homebrew/lib/node_modules/pglens/bin/pglens', version: '3.0.0', isSelf: true },
    ],
    staleSelfInstall: { wrapper: '/Users/x/.pglens/bin/pglens', nodeModules: null, pkgJson: null, pkgLock: null, rcRefs: ['/Users/x/.zshrc'] },
  };
  const { ok, problems } = diag.analyze(report);
  assert.equal(ok, false);
  const codes = problems.map((p) => p.code).sort();
  assert.deepEqual(codes, ['multiple-copies', 'shadowed', 'stale-path-entry', 'stale-self-install']);
});

test('analyze reports ok on a single up-to-date install', () => {
  const report = {
    selfVersion: '3.0.0',
    copies: [
      { file: '/opt/homebrew/bin/pglens', real: '/opt/homebrew/lib/node_modules/pglens/bin/pglens', version: '3.0.0', isSelf: true },
    ],
    staleSelfInstall: { wrapper: null, nodeModules: null, pkgJson: null, pkgLock: null, rcRefs: [] },
  };
  assert.equal(diag.analyze(report).ok, true);
});

test('buildFixPlan removes stale npm copy + its module and the self-install', () => {
  const report = {
    selfReal: '/opt/homebrew/lib/node_modules/pglens/bin/pglens',
    copies: [
      { file: '/usr/local/bin/pglens', real: '/usr/local/lib/node_modules/pglens/bin/pglens', version: '1.0.0', isSelf: false },
      { file: '/opt/homebrew/bin/pglens', real: '/opt/homebrew/lib/node_modules/pglens/bin/pglens', version: '3.0.0', isSelf: true },
    ],
    staleSelfInstall: { wrapper: '/Users/x/.pglens/bin/pglens', nodeModules: '/Users/x/.pglens/node_modules', pkgJson: null, pkgLock: null, rcRefs: ['/Users/x/.zshrc'] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => {} }); // writable everywhere
  assert.ok(plan.some((c) => c.includes('rm -f /usr/local/bin/pglens')));
  assert.ok(plan.some((c) => c.includes('rm -rf /usr/local/lib/node_modules/pglens')));
  assert.ok(plan.some((c) => c.includes('/Users/x/.pglens/bin/pglens')));
  assert.ok(plan.some((c) => c.includes('hash -r')));
  // never proposes removing the freshly installed copy
  assert.ok(!plan.some((c) => c.includes('/opt/homebrew')));
});

test('buildFixPlan never proposes deleting an equally-new copy (dev/npx case)', () => {
  // selfReal is a dev checkout that does not appear on PATH; the installed
  // copy on PATH has the same version and must be left alone.
  const report = {
    selfReal: '/repo/pglens/bin/pglens',
    selfVersion: '3.0.0',
    copies: [
      { file: '/opt/homebrew/bin/pglens', real: '/opt/homebrew/lib/node_modules/pglens/bin/pglens', version: '3.0.0', isSelf: false },
      { file: '/usr/local/bin/pglens', real: '/usr/local/lib/node_modules/pglens/bin/pglens', version: '1.0.0', isSelf: false },
    ],
    staleSelfInstall: { wrapper: null, nodeModules: null, pkgJson: null, pkgLock: null, rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => {} });
  assert.ok(!plan.some((c) => c.includes('/opt/homebrew')), 'must not touch the v3.0.0 copy');
  assert.ok(plan.some((c) => c.includes('rm -f /usr/local/bin/pglens')));
});

test('buildFixPlan lists the ~/.pglens wrapper once, via the self-install block', () => {
  const wrapper = '/Users/x/.pglens/bin/pglens';
  const report = {
    selfReal: '/opt/homebrew/lib/node_modules/pglens/bin/pglens',
    selfVersion: '3.0.0',
    copies: [
      { file: wrapper, real: wrapper, version: '1.0.0', isSelf: false },
    ],
    staleSelfInstall: { wrapper, nodeModules: '/Users/x/.pglens/node_modules', pkgJson: null, pkgLock: null, rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => {} });
  const mentions = plan.filter((c) => c.includes(wrapper));
  assert.equal(mentions.length, 1, 'wrapper appears exactly once');
  assert.ok(mentions[0].includes('rm -rf'), 'removed together with node_modules');
});

test('buildFixPlan prefixes sudo when the parent dir is not writable', () => {
  const report = {
    selfReal: '/opt/homebrew/lib/node_modules/pglens/bin/pglens',
    copies: [
      { file: '/usr/local/bin/pglens', real: '/usr/local/bin/pglens', version: '1.0.0', isSelf: false },
    ],
    staleSelfInstall: { wrapper: null, nodeModules: null, pkgJson: null, pkgLock: null, rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => { throw new Error('EACCES'); } });
  assert.ok(plan.some((c) => c.startsWith('sudo rm -f /usr/local/bin/pglens')));
});
