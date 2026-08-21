import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { STAGES, finish } from '../.harness/bin/lib/finish.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

/** A temp harness that is a real git repo on a task branch, with green gates. */
function readyToFinish(taskOverrides = {}, projectOverrides = {}) {
  const task = makeTask({
    id: 'FEAT-0001',
    status: 'in_progress',
    branch: 'feat/0001-una-tarea-de-ejemplo',
    assignee: { kind: 'agent', id: 'implementer' },
    acceptance_criteria: [
      { id: 'AC1', must: 'Algo observable ocurre.', check: { type: 'review', run: null }, status: 'pass' },
    ],
    ...taskOverrides,
  });
  const { ctx, cleanup } = tempHarness({
    tasks: [task],
    project: {
      // A gate that always passes, so the test measures the sequence and not the tooling.
      gates: { test: { run: 'node -e "process.exit(0)"', required: true, status: 'configured' } },
      providers: { claude: false, agents_md: false },
      ...projectOverrides,
    },
  });
  const run = (args) => spawnSync('git', args, { cwd: ctx.root, encoding: 'utf8' });
  run(['init', '-q', '.']);
  run(['config', 'user.email', 't@e.com']);
  run(['config', 'user.name', 'T']);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'inicial']);
  run(['switch', '-q', '-c', task.branch]);
  return { ctx, cleanup, task, git: run };
}

test('one call runs the whole closing sequence', () => {
  const { ctx, cleanup, git } = readyToFinish();
  try {
    fs.writeFileSync(path.join(ctx.root, 'trabajo.txt'), 'el cambio\n');
    const result = finish(ctx, 'FEAT-0001', { push: false });

    assert.equal(result.ok, true, `paró en ${result.stopped}: ${result.problems.join('; ')}`);
    assert.deepEqual(result.done, STAGES, 'las cinco etapas, en orden');
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8')).status, 'in_review');
    assert.match(git(['log', '--oneline', '-2']).stdout, /Una tarea de ejemplo/);
    assert.equal(git(['status', '--porcelain']).stdout.trim(), '', 'y no queda nada suelto');
  } finally {
    cleanup();
  }
});

test('an unresolved criterion stops it before anything else runs, and names the criterion', () => {
  // Naming it matters: "no se puede cerrar" sends somebody reading the whole task to find
  // out which of five things is missing.
  const { ctx, cleanup, git } = readyToFinish({
    acceptance_criteria: [
      { id: 'AC1', must: 'Esto sí está.', check: { type: 'review', run: null }, status: 'pass' },
      { id: 'AC2', must: 'Esto no se ha comprobado.', check: { type: 'review', run: null }, status: 'pending' },
    ],
  });
  try {
    fs.writeFileSync(path.join(ctx.root, 'trabajo.txt'), 'el cambio\n');
    const result = finish(ctx, 'FEAT-0001', { push: false });

    assert.equal(result.ok, false);
    assert.equal(result.stopped, 'criterios');
    assert.equal(result.exit, 3);
    assert.ok(result.problems.some((p) => /AC2/.test(p)), 'dice cuál');
    assert.ok(result.problems.some((p) => /Esto no se ha comprobado/.test(p)), 'y qué pedía');
    assert.deepEqual(result.done, [], 'ninguna etapa posterior se ejecutó');
    assert.match(git(['status', '--porcelain']).stdout, /trabajo\.txt/, 'y no commiteó nada');
  } finally {
    cleanup();
  }
});

test('a failing criterion stops it too, not only a pending one', () => {
  const { ctx, cleanup } = readyToFinish({
    acceptance_criteria: [
      { id: 'AC1', must: 'Esto se comprobó y no pasa.', check: { type: 'command', run: 'node -e "process.exit(1)"' }, status: 'fail' },
    ],
  });
  try {
    fs.writeFileSync(path.join(ctx.root, 'trabajo.txt'), 'x\n');
    const result = finish(ctx, 'FEAT-0001', { push: false });
    assert.equal(result.stopped, 'criterios');
    assert.ok(result.problems.some((p) => /en fallo/.test(p)));
  } finally {
    cleanup();
  }
});

test('a red gate stops it at the gates, with the exit code of a failed check', () => {
  const { ctx, cleanup } = readyToFinish({}, {
    gates: { test: { run: 'node -e "process.exit(1)"', required: true, status: 'configured' } },
  });
  try {
    fs.writeFileSync(path.join(ctx.root, 'trabajo.txt'), 'x\n');
    const result = finish(ctx, 'FEAT-0001', { push: false });
    assert.equal(result.stopped, 'gates');
    assert.equal(result.exit, 1);
    assert.deepEqual(result.done, ['criterios'], 'los criterios sí, el resto no');
  } finally {
    cleanup();
  }
});

test('the status guard is the authority, not a copy of its rules', () => {
  // Duplicating the transition rules here would let the two drift apart, and then one of
  // them would be wrong. A task with no branch is refused by the guard, so finish refuses.
  const { ctx, cleanup } = readyToFinish({ branch: null, assignee: null, status: 'ready' });
  try {
    fs.writeFileSync(path.join(ctx.root, 'trabajo.txt'), 'x\n');
    const result = finish(ctx, 'FEAT-0001', { push: false });
    assert.equal(result.stopped, 'estado');
    assert.ok(result.problems.some((p) => /ready -> in_review|no es permitida|not allowed/i.test(p)));
  } finally {
    cleanup();
  }
});

test('--dry-run reports what would happen and changes nothing', () => {
  const { ctx, cleanup, git } = readyToFinish();
  try {
    fs.writeFileSync(path.join(ctx.root, 'trabajo.txt'), 'x\n');
    const result = finish(ctx, 'FEAT-0001', { dryRun: true, push: false });

    assert.equal(result.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8')).status, 'in_progress');
    assert.match(git(['status', '--porcelain']).stdout, /trabajo\.txt/);
  } finally {
    cleanup();
  }
});
