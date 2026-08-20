// The restructure engine. Almost every test here is about a condition refusing to act,
// because that is what the feature mostly is: six reasons not to move your code (D5).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  batches,
  comparedToBaseline,
  derivePackageName,
  movesAsTasks,
  planMoves,
  restructure,
  squashInto,
} from '../.harness/bin/lib/restructure.mjs';
import { loadLayout } from '../.harness/bin/lib/layouts.mjs';
import { repoCtx } from './helpers.mjs';

const base = repoCtx();
let n = 0;

function project(files) {
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-moves-${n}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  for (const args of [['init', '-q', '.'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-q', '-m', 'inicial']]) {
    spawnSync('git', args, { cwd: dir });
  }
  // The engine needs a ctx whose gates it can run; layouts come from the real template.
  const ctx = {
    root: dir,
    harnessDir: path.join(base.harnessDir),
    project: { gates: { test: { run: 'node -e "process.exit(0)"', required: true, status: 'configured' } }, areas: [] },
    taskSchema: base.taskSchema,
  };
  return { dir, ctx, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const GREEN = { safe: true, reason: 'el gate de tests pasa hoy' };
const NO_NET = { safe: false, reason: 'el gate de tests está en fail hoy, así que no puede decirte qué has roto' };
const BASELINE_PASS = { test: { state: 'pass', command: 'node -e "process.exit(0)"' } };

test('loose modules at the root are planned into the package', () => {
  const { dir, cleanup } = project({ 'utils.py': '', 'miapp/__init__.py': '', 'setup.py': '', 'conftest.py': '' });
  try {
    const moves = planMoves(dir, loadLayout(base, 'python'));
    const froms = moves.map((m) => m.from);
    assert.ok(froms.includes('utils.py'));
    assert.ok(!froms.includes('setup.py'), 'setup.py is in never_move');
    assert.ok(!froms.includes('conftest.py'), 'conftest.py is in never_move');
    assert.equal(moves.find((m) => m.from === 'utils.py').to, 'src/miapp/utils.py');
  } finally {
    cleanup();
  }
});

test('the package name comes from the package that exists', () => {
  const withPkg = project({ 'mipaquete/__init__.py': '' });
  try {
    assert.equal(derivePackageName(withPkg.dir, 'fallback'), 'mipaquete');
  } finally {
    withPkg.cleanup();
  }
  const without = project({ 'a.py': '' });
  try {
    assert.equal(derivePackageName(without.dir, 'Mi Proyecto'), 'mi_proyecto', 'and is sanitised when guessed');
  } finally {
    without.cleanup();
  }
});

test('tests at the root are planned into tests/, and generated output is never moved', () => {
  const { dir, cleanup } = project({ 'test_main.py': '', 'app/__init__.py': '' });
  try {
    const moves = planMoves(dir, loadLayout(base, 'python'));
    assert.equal(moves.find((m) => m.from === 'test_main.py').to, 'tests/test_main.py');
  } finally {
    cleanup();
  }

  const node = project({ 'index.ts': '', 'dist/bundle.js': '', 'vite.config.ts': '' });
  try {
    const froms = planMoves(node.dir, loadLayout(base, 'node-ts')).map((m) => m.from);
    assert.ok(froms.includes('index.ts'));
    assert.ok(!froms.includes('dist/bundle.js'), 'build output is not source');
    assert.ok(!froms.includes('vite.config.ts'), 'a config file stays at the root');
  } finally {
    node.cleanup();
  }
});

test('as-is plans no move at all', () => {
  const { dir, cleanup } = project({ 'utils.py': '', 'app/__init__.py': '' });
  try {
    assert.deepEqual(planMoves(dir, null), []);
  } finally {
    cleanup();
  }
});

test('batches are small and grouped by destination, so a failure is attributable', () => {
  const moves = [
    ...Array.from({ length: 12 }, (_, i) => ({ from: `a${i}.py`, to: `src/app/a${i}.py` })),
    { from: 'test_x.py', to: 'tests/test_x.py' },
  ];
  const grouped = batches(moves, 5);
  assert.equal(grouped.length, 4, '12 into 5s plus a separate destination');
  for (const b of grouped) {
    const destinations = new Set(b.map((m) => path.posix.dirname(m.to)));
    assert.equal(destinations.size, 1, 'a batch never mixes destinations');
  }
});

test('a gate that got worse than the baseline is detected; one already red is not', () => {
  const baseline = { test: { state: 'pass' }, lint: { state: 'fail' } };
  assert.deepEqual(comparedToBaseline(baseline, [{ name: 'test', state: 'pass' }, { name: 'lint', state: 'fail' }]), []);
  const worse = comparedToBaseline(baseline, [{ name: 'test', state: 'fail' }, { name: 'lint', state: 'fail' }]);
  assert.equal(worse.length, 1);
  assert.match(worse[0], /^test:/);
});

test('without a safety net nothing moves and the work becomes tasks', () => {
  // Condition 6, the one that matters most: no oracle, no movement.
  const { dir, ctx, cleanup } = project({ 'utils.py': '', 'app/__init__.py': '' });
  try {
    const before = fs.readdirSync(dir).sort();
    const result = restructure(ctx, dir, { layout: loadLayout(base, 'python'), baseline: {}, safetyNet: NO_NET });
    assert.deepEqual(result.moved, []);
    assert.equal(result.aborted.asTasks, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'not one file moved');

    const tasks = movesAsTasks([{ from: 'utils.py', to: 'src/app/utils.py', rule: 'loose_modules_at_root' }], NO_NET);
    assert.equal(tasks[0].type, 'test', 'the first task is getting a safety net');
    assert.match(tasks[0].description, /no se distingue de romperlo/);
    assert.ok(tasks.length > 1, 'and the reorganisation itself follows');
  } finally {
    cleanup();
  }
});

test('a dry run writes the plan and touches nothing', () => {
  const { dir, ctx, cleanup } = project({ 'utils.py': '', 'app/__init__.py': '' });
  try {
    const before = fs.readdirSync(dir).sort();
    const result = restructure(ctx, dir, {
      layout: loadLayout(base, 'python'),
      baseline: BASELINE_PASS,
      safetyNet: GREEN,
      dryRun: true,
    });
    assert.equal(result.commits, 0);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    assert.ok(result.report.some((l) => /utils\.py\s+->\s+src\/app\/utils\.py/.test(l)));
  } finally {
    cleanup();
  }
});

test('a dirty tree is refused, because a revert would be ambiguous', () => {
  const { dir, ctx, cleanup } = project({ 'utils.py': '', 'app/__init__.py': '' });
  try {
    fs.writeFileSync(path.join(dir, 'sucio.txt'), 'sin commitear');
    assert.throws(
      () => restructure(ctx, dir, { layout: loadLayout(base, 'python'), baseline: BASELINE_PASS, safetyNet: GREEN }),
      /sin commitear/,
    );
  } finally {
    cleanup();
  }
});

test('a clean run moves with git mv, so history shows a rename', () => {
  const { dir, ctx, cleanup } = project({ 'utils.py': 'X = 1\n', 'app/__init__.py': '' });
  try {
    const result = restructure(ctx, dir, { layout: loadLayout(base, 'python'), baseline: BASELINE_PASS, safetyNet: GREEN });
    assert.equal(result.aborted, null);
    assert.ok(result.moved.length > 0);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'app', 'utils.py')));
    assert.ok(!fs.existsSync(path.join(dir, 'utils.py')));

    const shown = spawnSync('git', ['show', '--name-status', '--find-renames', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout;
    assert.match(shown, /^R/m, 'the diff must read as a rename, not delete plus create');
  } finally {
    cleanup();
  }
});

test('a batch that breaks a gate is reverted, and the earlier ones survive', () => {
  const { dir, ctx, cleanup } = project({
    'a.py': '', 'b.py': '', 'test_x.py': '', 'app/__init__.py': '',
  });
  try {
    // A gate that goes red as soon as anything lands in tests/.
    ctx.project.gates.test.run = 'node -e "process.exit(require(\'fs\').existsSync(\'tests\') ? 1 : 0)"';
    const result = restructure(ctx, dir, {
      layout: loadLayout(base, 'python'),
      baseline: BASELINE_PASS,
      safetyNet: GREEN,
      batchSize: 5,
    });
    assert.ok(result.aborted, 'it must stop');
    assert.match(result.aborted.reason, /empeoró/);
    assert.ok(!fs.existsSync(path.join(dir, 'tests', 'test_x.py')), 'the bad batch is reverted');
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '', 'and the tree is clean again');
  } finally {
    cleanup();
  }
});

test('the batches are squashed into one revertible commit', () => {
  const { dir, ctx, cleanup } = project({ 'a.py': '', 'b.py': '', 'test_x.py': '', 'app/__init__.py': '' });
  try {
    const result = restructure(ctx, dir, {
      layout: loadLayout(base, 'python'),
      baseline: BASELINE_PASS,
      safetyNet: GREEN,
      batchSize: 1,
    });
    assert.ok(result.commits > 1, 'several batches were committed');
    squashInto(ctx, result.commits, 'chore(restructure): mover al layout declarado');

    const log = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
    assert.equal(log.length, 2, 'the initial commit plus exactly one restructure commit');
    assert.match(log[0], /mover al layout declarado/);
  } finally {
    cleanup();
  }
});

test('a project already in shape reports nothing to do', () => {
  const { dir, ctx, cleanup } = project({ 'src/app/__init__.py': '', 'tests/test_x.py': '' });
  try {
    const result = restructure(ctx, dir, { layout: loadLayout(base, 'python'), baseline: BASELINE_PASS, safetyNet: GREEN });
    assert.deepEqual(result.moved, []);
    assert.ok(result.report.some((l) => /ya sigue el perfil/.test(l)));
  } finally {
    cleanup();
  }
});
