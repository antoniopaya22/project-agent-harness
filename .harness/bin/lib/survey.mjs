// Stage 1 of /adopt: look at a project and report what is actually there.
//
// The rule that makes this useful is that every finding carries its evidence. A gate whose
// command was inferred from a convention rather than read from a file is exactly how an
// adoption produces confident, wrong documentation — so nothing here guesses. Absent means
// absent, and it is reported as absent.
//
// Read-only by construction: no function in this module writes to the surveyed project. The
// gate baseline is separate and opt-in, because running a project's own tooling can create
// artefacts that are not ours.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toPosixPath } from './util.mjs';

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'coverage', '.next', '.nuxt', 'target', 'vendor', '.harness',
]);

function has(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}

function readIfJson(dir, rel) {
  try {
    return has(dir, rel) ? JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) : null;
  } catch {
    return null;
  }
}

function readIfText(dir, rel) {
  try {
    return has(dir, rel) ? fs.readFileSync(path.join(dir, rel), 'utf8') : '';
  } catch {
    return '';
  }
}

function walk(dir, root, acc = [], depth = 0) {
  if (depth > 6) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, acc, depth + 1);
    else acc.push(toPosixPath(path.relative(root, full)));
  }
  return acc;
}

/** Language and real gate commands, each with the file they came from. */
export function detectStack(dir) {
  const stack = { language: null, packageManager: null, gates: {}, evidence: [] };
  const pkg = readIfJson(dir, 'package.json');

  if (pkg) {
    stack.language = has(dir, 'tsconfig.json') ? 'typescript' : 'javascript';
    stack.evidence.push('package.json');
    stack.packageManager = has(dir, 'pnpm-lock.yaml') ? 'pnpm' : has(dir, 'yarn.lock') ? 'yarn' : 'npm';
    const scripts = pkg.scripts || {};
    const runner = stack.packageManager === 'npm' ? 'npm run' : stack.packageManager;
    const candidates = {
      lint: ['lint'],
      test: ['test'],
      typecheck: ['typecheck', 'tsc', 'types'],
      build: ['build'],
      format: ['format', 'fmt'],
      start: ['dev', 'start'],
    };
    for (const [gate, names] of Object.entries(candidates)) {
      const found = names.find((n) => scripts[n]);
      if (found) stack.gates[gate] = { run: `${runner} ${found}`, evidence: `package.json scripts.${found}` };
    }
    return stack;
  }

  if (has(dir, 'pyproject.toml') || has(dir, 'setup.py') || has(dir, 'requirements.txt') || has(dir, 'Pipfile')) {
    stack.language = 'python';
    const source = ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'].find((f) => has(dir, f));
    stack.evidence.push(source);
    const pyproject = readIfText(dir, 'pyproject.toml');
    if (/\[tool\.ruff/.test(pyproject)) stack.gates.lint = { run: 'ruff check .', evidence: 'pyproject.toml [tool.ruff]' };
    else if (/\[tool\.flake8/.test(pyproject) || has(dir, '.flake8')) {
      stack.gates.lint = { run: 'flake8', evidence: has(dir, '.flake8') ? '.flake8' : 'pyproject.toml [tool.flake8]' };
    }
    if (/\[tool\.pytest/.test(pyproject) || has(dir, 'pytest.ini') || has(dir, 'tests')) {
      const evidence = /\[tool\.pytest/.test(pyproject) ? 'pyproject.toml [tool.pytest]' : has(dir, 'pytest.ini') ? 'pytest.ini' : 'tests/ exists';
      stack.gates.test = { run: 'pytest -q', evidence };
    }
    if (/\[tool\.mypy/.test(pyproject) || has(dir, 'mypy.ini')) {
      stack.gates.typecheck = { run: 'mypy .', evidence: has(dir, 'mypy.ini') ? 'mypy.ini' : 'pyproject.toml [tool.mypy]' };
    }
    if (/\[tool\.black/.test(pyproject)) stack.gates.format = { run: 'black .', evidence: 'pyproject.toml [tool.black]' };
    return stack;
  }

  if (has(dir, 'go.mod')) {
    stack.language = 'go';
    stack.evidence.push('go.mod');
    stack.gates.test = { run: 'go test ./...', evidence: 'go.mod' };
    stack.gates.build = { run: 'go build ./...', evidence: 'go.mod' };
    return stack;
  }

  return stack;
}

/** Directories that look like they hold source, from what is on disk. */
export function detectAreas(dir) {
  const candidates = ['src', 'lib', 'app', 'api', 'packages', 'services', 'cmd', 'internal'];
  const found = [];
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
    const children = fs
      .readdirSync(full, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name));
    if (children.length >= 2 && children.length <= 8) {
      for (const child of children) found.push({ id: slug(child.name), globs: [`${name}/${child.name}/**`] });
    } else {
      found.push({ id: slug(name), globs: [`${name}/**`] });
    }
  }
  return found.slice(0, 6);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'core';
}

/** The files git says are touched most: a cheap proxy for where the project actually lives. */
export function hotspots(dir, limit = 20) {
  const res = spawnSync('git', ['log', '--format=', '--name-only', '-n', '2000'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) return [];
  const counts = new Map();
  for (const line of (res.stdout || '').split('\n')) {
    const file = line.trim();
    if (!file) continue;
    if ([...IGNORED_DIRS].some((d) => file.startsWith(`${d}/`))) continue;
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([file, touches]) => ({ file, touches }));
}

export function detectCi(dir) {
  const workflows = path.join(dir, '.github', 'workflows');
  const found = [];
  if (fs.existsSync(workflows)) {
    for (const f of fs.readdirSync(workflows)) {
      if (/\.ya?ml$/.test(f)) found.push({ file: `.github/workflows/${f}`, system: 'github-actions' });
    }
  }
  for (const [file, system] of [['.gitlab-ci.yml', 'gitlab'], ['Jenkinsfile', 'jenkins'], ['.circleci/config.yml', 'circleci']]) {
    if (has(dir, file)) found.push({ file, system });
  }
  return found;
}

export function detectDocs(dir) {
  const files = walk(dir, dir).filter((f) => /\.md$/i.test(f) && !f.includes('/node_modules/'));
  return files.slice(0, 40);
}

export function detectEntryPoints(dir) {
  const pkg = readIfJson(dir, 'package.json');
  const entries = [];
  if (pkg) {
    for (const key of ['main', 'module', 'bin']) {
      if (typeof pkg[key] === 'string') entries.push({ path: pkg[key], evidence: `package.json ${key}` });
      else if (pkg[key] && typeof pkg[key] === 'object') {
        for (const [name, p] of Object.entries(pkg[key])) entries.push({ path: p, evidence: `package.json ${key}.${name}` });
      }
    }
  }
  for (const guess of ['manage.py', 'main.py', 'app.py', 'wsgi.py', 'asgi.py', 'src/main.ts', 'cmd/main.go']) {
    if (has(dir, guess)) entries.push({ path: guess, evidence: 'file exists at a conventional location' });
  }
  return entries;
}

/** Unfinished work the codebase admits to. Seeds the backlog, unrefined. */
export function pendingMarkers(dir, limit = 60) {
  const marks = [];
  for (const rel of walk(dir, dir)) {
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|kt|cs|php|rs|sh)$/i.test(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/);
      if (m && marks.length < limit) {
        marks.push({ kind: m[1], file: rel, line: i + 1, text: m[2].trim().slice(0, 120) });
      }
    });
  }
  return marks;
}

/**
 * The whole read-only survey. Writes nothing.
 */
export function survey(dir) {
  const stack = detectStack(dir);
  return {
    // Adopting a project that already has a harness is almost never what somebody means.
    // Saying so beats starting over on top of it.
    existingHarness: detectExistingHarness(dir),
    root: toPosixPath(dir),
    isGitRepo: spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' }).status === 0,
    stack,
    areas: detectAreas(dir),
    entryPoints: detectEntryPoints(dir),
    ci: detectCi(dir),
    docs: detectDocs(dir),
    hotspots: hotspots(dir),
    pending: pendingMarkers(dir),
    fileCount: walk(dir, dir).length,
  };
}

/** Is the harness already installed here? */
export function detectExistingHarness(dir) {
  const config = path.join(dir, '.harness', 'project.json');
  if (!fs.existsSync(config)) return null;
  try {
    const project = JSON.parse(fs.readFileSync(config, 'utf8'));
    const gates = Object.entries(project.gates || {})
      .filter(([, g]) => g.run)
      .map(([name]) => name);
    return { version: project.harness_version ?? 'desconocida', gates, areas: (project.areas || []).map((a) => a.id) };
  } catch {
    return { version: 'ilegible', gates: [], areas: [] };
  }
}

/**
 * Runs the inferred gates and records what each one does *today*.
 *
 * This is the oracle for everything that comes later: without it there is no way to tell
 * whether moving a file broke something. Separate from `survey` and opt-in, because unlike
 * the rest of the survey this executes the project's own tooling, which can leave artefacts
 * that are not ours to create.
 */
export function gateBaseline(dir, stack, { timeoutMs = 300000 } = {}) {
  const baseline = {};
  for (const [gate, found] of Object.entries(stack.gates)) {
    if (gate === 'start') continue; // not something you pass

    // Checked before running, not after: if the tool is not installed there is nothing to
    // learn from executing it, and the shell would report the miss in the user's own
    // language, which is not something to pattern-match on.
    const exe = leadingExecutable(found.run);
    if (exe && !resolveExecutable(exe)) {
      baseline[gate] = {
        command: found.run,
        evidence: found.evidence,
        state: 'error',
        code: null,
        excerpt: `"${exe}" no está en el PATH: el comando no llega a ejecutarse`,
      };
      continue;
    }

    const res = spawnSync(found.run, { cwd: dir, shell: true, encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe' });
    const timedOut = res.error?.code === 'ETIMEDOUT';
    const output = String(res.stderr || res.stdout || '');
    baseline[gate] = {
      command: found.run,
      evidence: found.evidence,
      state: timedOut
        ? 'timeout'
        : res.status === 0
          ? 'pass'
          : res.status === null || didNotRun(res.status, output)
            ? 'error'
            : 'fail',
      code: res.status,
      excerpt: output.trim().split('\n').slice(-3).join('\n').slice(0, 400),
    };
  }
  return baseline;
}

/**
 * Did the command fail, or never start at all?
 *
 * The two need different answers — a failing test suite is a working gate telling the truth,
 * while a command that does not exist is not a gate at all — but a shell hides the
 * difference. It catches the ENOENT itself, exits with a code of its own (1 under cmd.exe,
 * not the 127 POSIX shells use) and explains itself **in the user's language**. Neither the
 * code nor the message is something to build on.
 *
 * So the executable is resolved against the PATH directly instead, which is locale-free and
 * needs no shell. What remains undetectable is a *wrapped* miss: `npm run lint` where npm
 * exists but the script's own tool does not. npm reports that as a plain failure, and no
 * machine-readable signal separates it from a real lint failure. Those stay `fail`, and the
 * gate stays configured — losing a working safety net is the more expensive mistake.
 */
export function didNotRun(code, output = '') {
  if (code === 127 || code === 126 || code === 9009) return true;
  return /command not found|is not recognized as an internal|no such file or directory|Missing script|Unknown command|executable file not found/i.test(
    output,
  );
}

/** The program a shell command would actually launch, honouring quotes and env prefixes. */
export function leadingExecutable(command) {
  // Quoted first, so `"C:/Program Files/x/tool.exe" --flag` is one token and not three.
  const tokens = String(command).trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const token of tokens) {
    // `FOO=bar cmd` is a prefix, not the program.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const clean = token.replace(/^["']|["']$/g, '');
    if (clean) return clean;
  }
  return null;
}

/**
 * Where the PATH would find this program, or null.
 * A path with a separator in it is checked as a path; a bare name is looked up, extended by
 * PATHEXT on Windows so `ruff` finds `ruff.exe`.
 */
export function resolveExecutable(name, { env = process.env } = {}) {
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = (base) => [base, ...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)];

  if (name.includes('/') || name.includes('\\')) {
    return candidates(name).find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null;
  }
  // A shell builtin is always available and has no file to find.
  if (['cd', 'echo', 'set', 'exit', 'true', 'false', 'test'].includes(name)) return name;

  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const hit = candidates(path.join(dir, name)).find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (hit) return hit;
  }
  return null;
}

/** Is there a safety net? Nothing may be moved without one (D5, condition 6). */
export function hasSafetyNet(baseline) {
  const test = baseline.test;
  if (!test) return { safe: false, reason: 'no test gate was found, so there is nothing to detect a break' };
  if (test.state !== 'pass') return { safe: false, reason: `the test gate is ${test.state} today, so it cannot tell you what you broke` };
  return { safe: true, reason: `the test gate passes today (${test.command}), so it can act as the oracle` };
}
