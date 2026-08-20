import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectExistingHarness, gateBaseline, hasSafetyNet, survey } from '../.harness/bin/lib/survey.mjs';

let n = 0;
function project(files, { git = true } = {}) {
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-survey-${n}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (git) {
    for (const args of [['init', '-q', '.'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T']]) {
      spawnSync('git', args, { cwd: dir });
    }
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NODE_PROJECT = {
  'package.json': JSON.stringify({
    name: 'demo',
    main: 'src/index.js',
    scripts: { lint: 'eslint .', test: 'vitest run', build: 'tsc -p .' },
  }),
  'tsconfig.json': '{}',
  'src/api/users.ts': '// TODO: validar el email\nexport const x = 1;\n',
  'src/web/page.tsx': 'export const y = 2;\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'README.md': '# demo\n',
};

const PYTHON_PROJECT = {
  'pyproject.toml': '[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.mypy]\nstrict = true\n',
  'src/app/__init__.py': '',
  'src/app/main.py': '# FIXME: esto no maneja el caso vacio\n',
  'tests/test_main.py': 'def test_ok():\n    assert True\n',
};

test('a Node project is detected with its real gate commands and their evidence', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const s = survey(dir);
    assert.equal(s.stack.language, 'typescript');
    assert.equal(s.stack.packageManager, 'npm');
    assert.equal(s.stack.gates.lint.run, 'npm run lint');
    assert.equal(s.stack.gates.lint.evidence, 'package.json scripts.lint');
    assert.equal(s.stack.gates.typecheck, undefined, 'a tsconfig is not a typecheck command');
    assert.deepEqual(s.areas.map((a) => a.id).sort(), ['api', 'web']);
    assert.deepEqual(s.ci.map((x) => x.file), ['.github/workflows/ci.yml']);
    assert.ok(s.entryPoints.some((e) => e.path === 'src/index.js'));
  } finally {
    cleanup();
  }
});

test('a Python project is detected from its own configuration', () => {
  const { dir, cleanup } = project(PYTHON_PROJECT);
  try {
    const s = survey(dir);
    assert.equal(s.stack.language, 'python');
    assert.equal(s.stack.gates.lint.run, 'ruff check .');
    assert.equal(s.stack.gates.test.run, 'pytest -q');
    assert.equal(s.stack.gates.typecheck.run, 'mypy .');
    assert.match(s.stack.gates.typecheck.evidence, /tool\.mypy/);
  } finally {
    cleanup();
  }
});

test('nothing is invented when there is no evidence', () => {
  const { dir, cleanup } = project({ 'notas.txt': 'hola', 'algo.mjs': 'export const x = 1;\n' });
  try {
    const s = survey(dir);
    assert.equal(s.stack.language, null, 'loose .mjs files are not a declared stack');
    assert.deepEqual(s.stack.gates, {});
    assert.deepEqual(s.ci, []);
  } finally {
    cleanup();
  }
});

test('the survey writes nothing at all', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
    const listing = (d) => fs.readdirSync(d, { recursive: true }).sort().join('\n');
    const treeBefore = listing(dir);

    survey(dir);

    assert.equal(listing(dir), treeBefore, 'no file appeared or vanished');
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout, before);
  } finally {
    cleanup();
  }
});

test('unfinished work the code admits to is collected with file and line', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const s = survey(dir);
    const todo = s.pending.find((p) => p.kind === 'TODO');
    assert.ok(todo, 'the TODO in src/api/users.ts was missed');
    assert.equal(todo.file, 'src/api/users.ts');
    assert.equal(todo.line, 1);
    assert.match(todo.text, /validar el email/);
  } finally {
    cleanup();
  }
});

test('the hotspots come from git history, and an absent history is not an error', () => {
  const withGit = project(NODE_PROJECT);
  try {
    spawnSync('git', ['add', '-A'], { cwd: withGit.dir });
    spawnSync('git', ['commit', '-q', '-m', 'inicial'], { cwd: withGit.dir });
    assert.ok(survey(withGit.dir).hotspots.length > 0);
  } finally {
    withGit.cleanup();
  }

  const noGit = project(NODE_PROJECT, { git: false });
  try {
    assert.deepEqual(survey(noGit.dir).hotspots, [], 'no history means no hotspots, not a crash');
    assert.equal(survey(noGit.dir).isGitRepo, false);
  } finally {
    noGit.cleanup();
  }
});

test('the baseline records what each gate does today, before anything changes', () => {
  const { dir, cleanup } = project({
    'package.json': JSON.stringify({ name: 'd', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(1)"' } }),
  });
  try {
    const s = survey(dir);
    const baseline = gateBaseline(dir, s.stack);
    assert.equal(baseline.test.state, 'pass');
    assert.equal(baseline.lint.state, 'fail');
    assert.equal(baseline.lint.code, 1);
    assert.equal(baseline.test.evidence, 'package.json scripts.test');
  } finally {
    cleanup();
  }
});

test('a passing test gate is a safety net; anything else is not', () => {
  assert.equal(hasSafetyNet({ test: { state: 'pass', command: 'pytest' } }).safe, true);
  assert.equal(hasSafetyNet({ test: { state: 'fail', command: 'pytest' } }).safe, false);
  assert.match(hasSafetyNet({ test: { state: 'fail' } }).reason, /cannot tell you what you broke/);
  assert.equal(hasSafetyNet({ lint: { state: 'pass' } }).safe, false, 'lint is not a safety net');
  assert.match(hasSafetyNet({}).reason, /nothing to detect a break/);
});

test('a project that already has a harness is recognised instead of adopted again', () => {
  const { dir, cleanup } = project({
    'package.json': '{"name":"d"}',
    '.harness/project.json': JSON.stringify({
      harness_version: '1.0.0',
      gates: { test: { run: 'pytest' }, lint: { run: null } },
      areas: [{ id: 'core' }],
    }),
  });
  try {
    const existing = detectExistingHarness(dir);
    assert.equal(existing.version, '1.0.0');
    assert.deepEqual(existing.gates, ['test'], 'only gates with a real command count');
    assert.deepEqual(survey(dir).existingHarness.areas, ['core']);
  } finally {
    cleanup();
  }
});

test('a corrupt harness config is reported as unreadable, not treated as absent', () => {
  const { dir, cleanup } = project({ '.harness/project.json': '{ roto' });
  try {
    assert.equal(detectExistingHarness(dir).version, 'ilegible');
  } finally {
    cleanup();
  }
});
