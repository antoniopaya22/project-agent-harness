import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectAreas, detectStack, initProject, leakedFromTemplate } from '../.harness/bin/lib/init.mjs';
import { runDoctor } from '../.harness/bin/lib/doctor.mjs';
import { REPO } from './helpers.mjs';

let n = 0;
function project(files) {
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-init-${n}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function ctxFor(dir) {
  const harnessDir = path.join(dir, '.harness');
  return {
    root: dir,
    harnessDir,
    project: JSON.parse(fs.readFileSync(path.join(harnessDir, 'project.json'), 'utf8')),
    taskSchema: JSON.parse(fs.readFileSync(path.join(harnessDir, 'schema', 'task.schema.json'), 'utf8')),
  };
}

test('one command leaves a new project whose self-check is green', () => {
  const { dir, cleanup } = project({
    'package.json': '{"name":"demo","scripts":{"lint":"eslint .","test":"vitest run"}}',
    'src/api/a.js': '',
    'src/web/b.js': '',
  });
  try {
    initProject(REPO, dir, { name: 'demo' });
    const { counts, issues } = runDoctor(ctxFor(dir));
    assert.equal(counts.error, 0, issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
  } finally {
    cleanup();
  }
});

test('gates come from scripts that exist, and absent ones are declared not-configured', () => {
  // A gate whose command was invented is worse than one honestly marked missing.
  const { dir, cleanup } = project({
    'package.json': '{"name":"d","scripts":{"lint":"eslint .","build":"tsc -p ."}}',
    'tsconfig.json': '{}',
  });
  try {
    const { config } = initProject(REPO, dir, {});
    assert.equal(config.gates.lint.run, 'npm run lint');
    assert.equal(config.gates.build.run, 'npm run build');
    assert.equal(config.gates.test.status, 'not-configured');
    assert.equal(config.gates.test.run, null);
    assert.equal(config.gates.typecheck.status, 'not-configured', 'tsconfig alone is not a typecheck command');
  } finally {
    cleanup();
  }
});

test('the package manager is taken from the lockfile, not assumed', () => {
  // pnpm and yarn take a script name directly; only npm needs `run`.
  for (const [lock, expected] of [['pnpm-lock.yaml', 'pnpm lint'], ['yarn.lock', 'yarn lint'], [null, 'npm run lint']]) {
    const files = { 'package.json': '{"name":"d","scripts":{"lint":"x"}}' };
    if (lock) files[lock] = '';
    const { dir, cleanup } = project(files);
    try {
      assert.equal(initProject(REPO, dir, {}).config.gates.lint.run, expected);
    } finally {
      cleanup();
    }
  }
});

test('a python project is detected from its own evidence', () => {
  const { dir, cleanup } = project({
    'pyproject.toml': '[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'src/app/__init__.py': '',
  });
  try {
    const stack = detectStack(dir);
    assert.equal(stack.language, 'python');
    assert.equal(stack.gates.lint.run, 'ruff check .');
    assert.equal(stack.gates.test.run, 'pytest -q');
    assert.equal(stack.gates.typecheck, undefined, 'no mypy config, no typecheck gate');
  } finally {
    cleanup();
  }
});

test('areas come from directories that exist, and every one gets its doc', () => {
  const { dir, cleanup } = project({
    'package.json': '{"name":"d"}',
    'src/api/a.js': '',
    'src/web/b.js': '',
    'src/billing/c.js': '',
  });
  try {
    assert.deepEqual(detectAreas(dir).map((a) => a.id).sort(), ['api', 'billing', 'web']);
    const { config } = initProject(REPO, dir, {});
    for (const area of config.areas) {
      assert.ok(fs.existsSync(path.join(dir, area.doc)), `${area.doc} was not created`);
    }
  } finally {
    cleanup();
  }
});

test('a project with no recognisable source layout still gets one area', () => {
  const { dir, cleanup } = project({ 'README.md': '# nada' });
  try {
    const { config } = initProject(REPO, dir, {});
    assert.equal(config.areas.length, 1);
  } finally {
    cleanup();
  }
});

test('no pre-existing file is overwritten', () => {
  const { dir, cleanup } = project({
    'package.json': '{"name":"d"}',
    'docs/areas/core.md': 'MI CONTENIDO ORIGINAL',
    'harness.ps1': 'MI SHIM ORIGINAL',
  });
  try {
    const { report } = initProject(REPO, dir, {});
    assert.equal(fs.readFileSync(path.join(dir, 'docs/areas/core.md'), 'utf8'), 'MI CONTENIDO ORIGINAL');
    assert.equal(fs.readFileSync(path.join(dir, 'harness.ps1'), 'utf8'), 'MI SHIM ORIGINAL');
    assert.ok(report.skipped.length >= 2, 'and it says what it left alone');
  } finally {
    cleanup();
  }
});

test('installing over an existing harness is refused rather than merged blindly', () => {
  const { dir, cleanup } = project({ 'package.json': '{"name":"d"}' });
  try {
    initProject(REPO, dir, {});
    assert.throws(() => initProject(REPO, dir, {}), /already exists/);
  } finally {
    cleanup();
  }
});

test('nothing from the template project leaks into the new one', () => {
  const { dir, cleanup } = project({ 'package.json': '{"name":"d"}' });
  try {
    initProject(REPO, dir, {});
    assert.deepEqual(leakedFromTemplate(dir), [], 'the backlog and workspace must start empty');
    assert.ok(!fs.existsSync(path.join(dir, 'docs', 'HARNESS-PLAN.md')), "the template's own plan is not the project's");
  } finally {
    cleanup();
  }
});

test('what cannot be deduced is marked for a human, not invented', () => {
  const { dir, cleanup } = project({ 'package.json': '{"name":"d"}' });
  try {
    const { config, report } = initProject(REPO, dir, {});
    assert.match(config.project.purpose, /\[RELLENAR\]/, 'a plausible invented purpose is worse than a visible hole');
    assert.ok(report.unresolved.some((u) => /purpose/.test(u)));
    assert.ok(report.unresolved.some((u) => /gates sin configurar/.test(u)));
  } finally {
    cleanup();
  }
});

test('an explicit purpose is used as given', () => {
  const { dir, cleanup } = project({ 'package.json': '{"name":"d"}' });
  try {
    const purpose = 'Una tienda interna para pedidos de material de oficina, usada por administracion.';
    const { config, report } = initProject(REPO, dir, { purpose });
    assert.equal(config.project.purpose, purpose);
    assert.ok(!report.unresolved.some((u) => /purpose/.test(u)));
  } finally {
    cleanup();
  }
});
