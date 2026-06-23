/**
 * Install diagnostics.
 *
 * pglens is curl-managed: the supported install lives under ~/.pglens
 * (see install/install.sh) with a launcher at ~/.pglens/bin/pglens on
 * PATH. That is the *canonical* copy. Anything else on PATH — most
 * commonly a `npm i -g pglens` — is a foreign copy that shadows the
 * curl one and makes "upgrade didn't take" bugs. Doctor flags those.
 *
 * Detects: foreign npm-global copies, a curl install that fell off
 * PATH, pre-3.0 leftovers (~/.pglens/source), and a missing install.
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
// A real path inside some `node_modules/pglens` — the fingerprint of an
// npm install (global or local), as opposed to a dev checkout or the
// curl launcher. Capture group 1 is the module dir to remove.
const NPM_MODULE_RE = /^(.*[/\\]node_modules[/\\]pglens)(?:[/\\]|$)/;

/** Split a PATH string into directories, dropping empties. */
function pathDirs(pathStr = process.env.PATH || '', delimiter = path.delimiter) {
  return pathStr.split(delimiter).filter(Boolean);
}

/** True if `p` is `dir` itself or lives inside it. */
function isUnderDir(p, dir) {
  if (!p || !dir) return false;
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
 * What's installed under ~/.pglens. The curl launcher + bundled module
 * are the canonical install; ~/.pglens/source is a dead pre-3.0 layout;
 * the rc PATH lines are expected and good (curl needs ~/.pglens/bin on
 * PATH). Data files (connections.json, token, logs/) are never touched.
 */
function detectInstalls(opts = {}) {
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

  const wrapper = pick(path.join(dir, 'bin', 'pglens'));
  const modulePkg = pick(path.join(dir, 'node_modules', 'pglens', 'package.json'));

  return {
    curlInstalled: Boolean(wrapper || modulePkg),
    wrapper,
    modulePkg,
    pre3Source: pick(path.join(dir, 'source')),
    rcRefs,
  };
}

/**
 * Gather the full picture. `selfReal`/`selfVersion` describe the binary
 * doing the asking. Each copy is tagged:
 *   isCanonical — the curl install under ~/.pglens (good)
 *   isNpmGlobal — a foreign `npm i -g` style copy (to remove)
 */
function collectReport(opts = {}) {
  const { selfReal, selfVersion, home = os.homedir() } = opts;
  const curlDir = path.join(home, '.pglens');
  const copies = findOnPath('pglens', opts).map((c) => {
    const isCanonical = isUnderDir(c.file, curlDir) || isUnderDir(c.real, curlDir);
    return {
      ...c,
      version: probeVersion(c.file, opts),
      isCanonical,
      // Foreign only: a node_modules/pglens path that isn't the curl one.
      isNpmGlobal: !isCanonical && NPM_MODULE_RE.test(c.real || ''),
    };
  });
  return {
    selfReal,
    selfVersion,
    copies,
    installs: detectInstalls(opts),
  };
}

/**
 * Classify a report into problems. Pure: takes the report, returns
 * { ok, problems: [{ code, message }] }.
 */
function analyze(report) {
  const { copies, installs } = report;
  const problems = [];

  const npmCopies = copies.filter((c) => c.isNpmGlobal);
  if (npmCopies.length) {
    problems.push({
      code: 'npm-install',
      message:
        `pglens was installed via npm (${npmCopies.map((c) => c.file).join(', ')}). ` +
        `pglens is curl-managed — remove the npm copy and install with the curl script.`,
    });
  }

  // A foreign copy resolving first hides the curl install behind it.
  const first = copies[0];
  if (first && !first.isCanonical && installs.curlInstalled) {
    problems.push({
      code: 'shadowed',
      message: `PATH resolves pglens to ${first.file}, shadowing your curl install in ~/.pglens.`,
    });
  }

  // Curl install on disk but its launcher never made it onto PATH.
  if (installs.curlInstalled && !copies.some((c) => c.isCanonical)) {
    problems.push({
      code: 'not-on-path',
      message: '~/.pglens is installed but ~/.pglens/bin is not on PATH (open a new terminal or re-run the installer).',
    });
  }

  // Nothing anywhere.
  if (!copies.length && !installs.curlInstalled) {
    problems.push({
      code: 'no-install',
      message: 'pglens is not installed. Install it with the curl script.',
    });
  }

  // Dead pre-3.0 layout left behind.
  if (installs.pre3Source) {
    problems.push({
      code: 'pre3-leftover',
      message: `Pre-3.0 leftover at ${installs.pre3Source} (safe to remove; data files untouched).`,
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
 * Concrete shell commands to make the curl install the only one.
 * Removes foreign npm copies and pre-3.0 cruft; never touches the
 * canonical ~/.pglens install, a dev checkout, or data files.
 */
function buildFixPlan(report, opts = {}) {
  const cmds = [];
  const { copies, installs } = report;

  let sawNpm = false;
  for (const c of copies) {
    if (!c.isNpmGlobal) continue; // leave canonical + dev checkouts alone
    sawNpm = true;
    const sudo = needsSudo(c.file, opts) ? 'sudo ' : '';
    cmds.push(`${sudo}rm -f ${c.file}`);
    const m = (c.real || '').match(NPM_MODULE_RE);
    if (m) {
      const modSudo = needsSudo(m[1], opts) ? 'sudo ' : '';
      cmds.push(`${modSudo}rm -rf ${m[1]}`);
    }
  }
  if (sawNpm) cmds.push('# (if it came from a global install you can instead run: npm rm -g pglens)');

  if (installs.pre3Source) cmds.push(`rm -rf ${installs.pre3Source}`);

  const canonicalOnPath = copies.some((c) => c.isCanonical);
  if (!installs.curlInstalled && !canonicalOnPath) {
    cmds.push('curl -fsSL https://pglens.org/install.sh | bash   # install via curl');
  } else if (installs.curlInstalled && !canonicalOnPath) {
    cmds.push('# re-run the installer to restore PATH: curl -fsSL https://pglens.org/install.sh | bash');
  }

  if (cmds.length) cmds.push('hash -r   # refresh shell command cache (or open a new terminal)');
  return [...new Set(cmds)];
}

module.exports = {
  pathDirs,
  isUnderDir,
  findOnPath,
  probeVersion,
  compareVersions,
  detectInstalls,
  collectReport,
  analyze,
  needsSudo,
  buildFixPlan,
};
