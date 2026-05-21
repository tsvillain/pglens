/**
 * Install diagnostics.
 *
 * Detects the classic "upgrade didn't take" problem: multiple `pglens`
 * binaries on PATH (npm global + a leftover self-install in ~/.pglens),
 * a stale shell command-hash, and orphaned PATH entries.
 *
 * Pure-ish: every function takes injectable fs/exec/env so the logic is
 * unit-testable without touching the real machine. Shared by `pglens
 * doctor` and the postinstall notice — keep its require() graph tiny
 * (no server, no native deps).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SEMVER_RE = /\d+\.\d+\.\d+(?:-[\w.]+)?/;
const RC_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'];

/** Split a PATH string into directories, dropping empties. */
function pathDirs(pathStr = process.env.PATH || '', delimiter = path.delimiter) {
  return pathStr.split(delimiter).filter(Boolean);
}

/**
 * Every `pglens` executable reachable on PATH, in resolution order.
 * Returns [{ file, real }] where `real` is the realpath (symlinks
 * collapsed). Duplicate PATH entries are collapsed to first occurrence.
 */
function findOnPath(name = 'pglens', opts = {}) {
  const {
    pathStr = process.env.PATH || '',
    existsSync = fs.existsSync,
    realpathSync = fs.realpathSync,
    platform = process.platform,
  } = opts;
  const names = platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const seen = new Set();
  const found = [];
  for (const dir of pathDirs(pathStr)) {
    for (const n of names) {
      const file = path.join(dir, n);
      if (!existsSync(file) || seen.has(file)) continue;
      seen.add(file);
      let real = file;
      try { real = realpathSync(file); } catch { /* dangling symlink */ }
      found.push({ file, real });
      break; // one binary per dir
    }
  }
  return found;
}

/** Run `<file> --version` and pull out the semver. null on any failure. */
function probeVersion(file, opts = {}) {
  const { exec = execFileSync, platform = process.platform } = opts;
  try {
    const out = exec(file, ['--version'], {
      timeout: 4000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: platform === 'win32', // .cmd shims need a shell
    });
    const m = String(out).match(SEMVER_RE);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** Numeric semver compare on the release portion. <0, 0, >0. */
function compareVersions(a, b) {
  if (!a || !b) return 0;
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Leftovers from the pre-3.0 curl self-installer: a bash wrapper +
 * local node_modules under ~/.pglens, and PATH lines in shell rc files.
 * The data files (connections.json, token, logs/) are deliberately
 * NOT reported — they stay.
 */
function detectStaleSelfInstall(opts = {}) {
  const {
    home = os.homedir(),
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
  } = opts;
  const dir = path.join(home, '.pglens');
  const binRef = path.join('.pglens', 'bin');
  const pick = (p) => (existsSync(p) ? p : null);

  const rcRefs = [];
  for (const rc of RC_FILES) {
    const p = path.join(home, rc);
    try {
      if (existsSync(p) && readFileSync(p, 'utf8').includes(binRef)) rcRefs.push(p);
    } catch { /* unreadable rc */ }
  }

  return {
    wrapper: pick(path.join(dir, 'bin', 'pglens')),
    nodeModules: pick(path.join(dir, 'node_modules')),
    pkgJson: pick(path.join(dir, 'package.json')),
    pkgLock: pick(path.join(dir, 'package-lock.json')),
    rcRefs,
  };
}

/**
 * Gather the full picture. `selfReal`/`selfVersion` describe the binary
 * doing the asking (the freshly-installed one).
 */
function collectReport(opts = {}) {
  const { selfReal, selfVersion } = opts;
  const copies = findOnPath('pglens', opts).map((c) => ({
    ...c,
    version: probeVersion(c.file, opts),
    isSelf: selfReal != null && c.real === selfReal,
  }));
  return {
    selfReal,
    selfVersion,
    copies,
    staleSelfInstall: detectStaleSelfInstall(opts),
  };
}

/**
 * Classify a report into problems. Pure: takes the report, returns
 * { ok, problems: [{ code, message }] }.
 */
function analyze(report) {
  const { selfVersion, copies, staleSelfInstall } = report;
  const problems = [];

  const first = copies[0];
  if (first && first.version && selfVersion && first.version !== selfVersion) {
    problems.push({
      code: 'shadowed',
      message:
        `PATH resolves pglens to ${first.file} (v${first.version}), ` +
        `not the v${selfVersion} you just installed.`,
    });
  }

  const others = copies.filter((c) => !c.isSelf);
  if (others.length) {
    problems.push({
      code: 'multiple-copies',
      message: `${copies.length} pglens binaries on PATH; only one should remain.`,
    });
  }

  if (staleSelfInstall.wrapper || staleSelfInstall.nodeModules) {
    problems.push({
      code: 'stale-self-install',
      message: 'Old self-install found under ~/.pglens (pre-3.0 curl installer).',
    });
  }
  if (staleSelfInstall.rcRefs.length) {
    problems.push({
      code: 'stale-path-entry',
      message: `Shell rc adds ~/.pglens/bin to PATH: ${staleSelfInstall.rcRefs.join(', ')}.`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/** True if the current user lacks write access to a path's parent dir. */
function needsSudo(file, opts = {}) {
  const { accessSync = fs.accessSync } = opts;
  try {
    accessSync(path.dirname(file), fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

/**
 * Concrete shell commands to remove the cruft, given a report.
 * Data files are never touched.
 */
function buildFixPlan(report, opts = {}) {
  const cmds = [];
  const { copies, staleSelfInstall, selfReal, selfVersion } = report;
  const selfModule = (selfReal || '').replace(/[/\\]bin[/\\]pglens$/, '');

  for (const c of copies) {
    if (c.isSelf) continue;
    // Never delete an equally-new binary (covers dev-checkout / npx, where
    // selfReal is a different path than the installed copy on PATH).
    if (selfVersion && c.version === selfVersion) continue;
    // The ~/.pglens wrapper is handled wholesale by the self-install block.
    if (c.file === staleSelfInstall.wrapper) continue;

    const sudo = needsSudo(c.file, opts) ? 'sudo ' : '';
    cmds.push(`${sudo}rm -f ${c.file}`);
    // npm symlinks point into <prefix>/lib/node_modules/pglens — drop the module too.
    const m = c.real && c.real.match(/^(.*[/\\]node_modules[/\\]pglens)[/\\]/);
    if (m && m[1] !== selfModule) {
      const modSudo = needsSudo(m[1], opts) ? 'sudo ' : '';
      cmds.push(`${modSudo}rm -rf ${m[1]}`);
    }
  }

  const s = staleSelfInstall;
  const selfTargets = [s.wrapper, s.nodeModules, s.pkgJson, s.pkgLock].filter(Boolean);
  if (selfTargets.length) cmds.push(`rm -rf ${selfTargets.join(' ')}`);

  for (const rc of s.rcRefs) {
    cmds.push(`# edit ${rc}: delete the line exporting ~/.pglens/bin to PATH`);
  }

  if (cmds.length) cmds.push('hash -r   # refresh shell command cache (or open a new terminal)');
  return [...new Set(cmds)];
}

module.exports = {
  pathDirs,
  findOnPath,
  probeVersion,
  compareVersions,
  detectStaleSelfInstall,
  collectReport,
  analyze,
  needsSudo,
  buildFixPlan,
};
