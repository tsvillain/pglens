const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const diag = require('../../src/diagnostics');

test('pathDirs splits on the delimiter and drops empties', () => {
  assert.deepEqual(diag.pathDirs('/a::/b:', ':'), ['/a', '/b']);
});

test('isUnderDir matches the dir itself and descendants, not siblings', () => {
  assert.equal(diag.isUnderDir('/Users/x/.pglens', '/Users/x/.pglens'), true);
  assert.equal(diag.isUnderDir('/Users/x/.pglens/bin/pglens', '/Users/x/.pglens'), true);
  assert.equal(diag.isUnderDir('/Users/x/.pglens-old/pglens', '/Users/x/.pglens'), false);
  assert.equal(diag.isUnderDir('/opt/homebrew/bin/pglens', '/Users/x/.pglens'), false);
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

test('detectInstalls finds the curl install, pre-3.0 source and rc refs', () => {
  const home = '/Users/x';
  const present = new Set([
    path.join(home, '.pglens', 'bin', 'pglens'),
    path.join(home, '.pglens', 'node_modules', 'pglens', 'package.json'),
    path.join(home, '.pglens', 'source'),
    path.join(home, '.zshrc'),
  ]);
  const r = diag.detectInstalls({
    home,
    existsSync: (p) => present.has(p),
    readFileSync: () => 'export PATH="/Users/x/.pglens/bin:$PATH"\n',
  });
  assert.equal(r.curlInstalled, true);
  assert.equal(r.wrapper, path.join(home, '.pglens', 'bin', 'pglens'));
  assert.equal(r.modulePkg, path.join(home, '.pglens', 'node_modules', 'pglens', 'package.json'));
  assert.equal(r.pre3Source, path.join(home, '.pglens', 'source'));
  assert.deepEqual(r.rcRefs, [path.join(home, '.zshrc')]);
});

test('detectInstalls reports nothing on a clean machine', () => {
  const r = diag.detectInstalls({
    home: '/Users/x',
    existsSync: () => false,
    readFileSync: () => '',
  });
  assert.equal(r.curlInstalled, false);
  assert.equal(r.wrapper, null);
  assert.equal(r.modulePkg, null);
  assert.equal(r.pre3Source, null);
  assert.deepEqual(r.rcRefs, []);
});

test('collectReport tags the curl wrapper canonical and an npm copy foreign', () => {
  const home = '/Users/x';
  const present = new Set([
    '/opt/homebrew/bin/pglens',
    path.join(home, '.pglens', 'bin', 'pglens'),
    path.join(home, '.pglens', 'node_modules', 'pglens', 'package.json'),
  ]);
  const realOf = {
    '/opt/homebrew/bin/pglens': '/opt/homebrew/lib/node_modules/pglens/bin/pglens',
  };
  const report = diag.collectReport({
    home,
    selfVersion: '3.0.1',
    pathStr: ['/opt/homebrew/bin', path.join(home, '.pglens', 'bin')].join(':'),
    existsSync: (p) => present.has(p),
    realpathSync: (f) => realOf[f] || f, // the curl wrapper is a plain file -> itself
    exec: () => '3.0.1\n',
    accessSync: () => {},
    platform: 'linux',
    readFileSync: () => '',
  });
  const homebrew = report.copies.find((c) => c.file === '/opt/homebrew/bin/pglens');
  const curl = report.copies.find((c) => c.file === path.join(home, '.pglens', 'bin', 'pglens'));
  assert.equal(homebrew.isCanonical, false);
  assert.equal(homebrew.isNpmGlobal, true);
  assert.equal(curl.isCanonical, true, 'curl wrapper recognized as canonical despite not being a symlink');
  assert.equal(curl.isNpmGlobal, false);
});

test('analyze flags an npm copy that shadows the curl install', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [
      { file: '/opt/homebrew/bin/pglens', real: '/opt/homebrew/lib/node_modules/pglens/bin/pglens', version: '3.0.0', isCanonical: false, isNpmGlobal: true },
      { file: '/Users/x/.pglens/bin/pglens', real: '/Users/x/.pglens/bin/pglens', version: '3.0.1', isCanonical: true, isNpmGlobal: false },
    ],
    installs: { curlInstalled: true, wrapper: '/Users/x/.pglens/bin/pglens', modulePkg: null, pre3Source: null, rcRefs: [] },
  };
  const { ok, problems } = diag.analyze(report);
  assert.equal(ok, false);
  const codes = problems.map((p) => p.code).sort();
  assert.deepEqual(codes, ['npm-install', 'shadowed']);
});

test('analyze reports ok on a single healthy curl install', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [
      { file: '/Users/x/.pglens/bin/pglens', real: '/Users/x/.pglens/bin/pglens', version: '3.0.1', isCanonical: true, isNpmGlobal: false },
    ],
    installs: { curlInstalled: true, wrapper: '/Users/x/.pglens/bin/pglens', modulePkg: null, pre3Source: null, rcRefs: ['/Users/x/.zshrc'] },
  };
  assert.equal(diag.analyze(report).ok, true);
});

test('analyze flags a pre-3.0 leftover even with a healthy curl install', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [
      { file: '/Users/x/.pglens/bin/pglens', real: '/Users/x/.pglens/bin/pglens', version: '3.0.1', isCanonical: true, isNpmGlobal: false },
    ],
    installs: { curlInstalled: true, wrapper: '/Users/x/.pglens/bin/pglens', modulePkg: null, pre3Source: '/Users/x/.pglens/source', rcRefs: [] },
  };
  const { ok, problems } = diag.analyze(report);
  assert.equal(ok, false);
  assert.deepEqual(problems.map((p) => p.code), ['pre3-leftover']);
});

test('analyze flags a curl install that fell off PATH', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [], // nothing resolves on PATH
    installs: { curlInstalled: true, wrapper: '/Users/x/.pglens/bin/pglens', modulePkg: null, pre3Source: null, rcRefs: [] },
  };
  const codes = diag.analyze(report).problems.map((p) => p.code);
  assert.deepEqual(codes, ['not-on-path']);
});

test('analyze reports no-install on a bare machine', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [],
    installs: { curlInstalled: false, wrapper: null, modulePkg: null, pre3Source: null, rcRefs: [] },
  };
  assert.deepEqual(diag.analyze(report).problems.map((p) => p.code), ['no-install']);
});

test('buildFixPlan removes the npm copy + its module, never the curl install', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [
      { file: '/opt/homebrew/bin/pglens', real: '/opt/homebrew/lib/node_modules/pglens/bin/pglens', version: '3.0.0', isCanonical: false, isNpmGlobal: true },
      { file: '/Users/x/.pglens/bin/pglens', real: '/Users/x/.pglens/bin/pglens', version: '3.0.1', isCanonical: true, isNpmGlobal: false },
    ],
    installs: { curlInstalled: true, wrapper: '/Users/x/.pglens/bin/pglens', modulePkg: null, pre3Source: null, rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => {} }); // writable everywhere
  assert.ok(plan.some((c) => c.includes('rm -f /opt/homebrew/bin/pglens')));
  assert.ok(plan.some((c) => c.includes('rm -rf /opt/homebrew/lib/node_modules/pglens')));
  assert.ok(plan.some((c) => c.includes('hash -r')));
  // never proposes touching the canonical curl install
  assert.ok(!plan.some((c) => c.includes('/Users/x/.pglens')));
});

test('buildFixPlan leaves a dev checkout alone (no node_modules/pglens)', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [
      { file: '/repo/pglens/bin/pglens', real: '/repo/pglens/bin/pglens', version: '3.0.1', isCanonical: false, isNpmGlobal: false },
    ],
    installs: { curlInstalled: false, wrapper: null, modulePkg: null, pre3Source: null, rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => {} });
  assert.ok(!plan.some((c) => c.includes('/repo/pglens')), 'must not touch the dev checkout');
});

test('buildFixPlan cleans pre-3.0 source and recommends curl reinstall when nothing is installed', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [],
    installs: { curlInstalled: false, wrapper: null, modulePkg: null, pre3Source: '/Users/x/.pglens/source', rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => {} });
  assert.ok(plan.some((c) => c.includes('rm -rf /Users/x/.pglens/source')));
  assert.ok(plan.some((c) => c.includes('install.sh | bash')));
});

test('buildFixPlan prefixes sudo when the npm copy dir is not writable', () => {
  const report = {
    selfVersion: '3.0.1',
    copies: [
      { file: '/usr/local/bin/pglens', real: '/usr/local/lib/node_modules/pglens/bin/pglens', version: '1.0.0', isCanonical: false, isNpmGlobal: true },
    ],
    installs: { curlInstalled: false, wrapper: null, modulePkg: null, pre3Source: null, rcRefs: [] },
  };
  const plan = diag.buildFixPlan(report, { accessSync: () => { throw new Error('EACCES'); } });
  assert.ok(plan.some((c) => c.startsWith('sudo rm -f /usr/local/bin/pglens')));
});
