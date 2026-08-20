import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TYPE_PREFIX,
  allocateId,
  branchFor,
  idFromBranch,
  pickNext,
  slugify,
  transitionProblems,
} from '../.harness/bin/lib/tasks.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

test('ids use a per-type counter, so different types never collide', () => {
  const { ctx, cleanup } = tempHarness({
    tasks: [makeTask({ id: 'FEAT-0001' }), makeTask({ id: 'FEAT-0002' }), makeTask({ id: 'FIX-0001', type: 'fix' })],
  });
  try {
    assert.equal(allocateId(ctx, 'feature'), 'FEAT-0003');
    assert.equal(allocateId(ctx, 'fix'), 'FIX-0002');
    assert.equal(allocateId(ctx, 'docs'), 'DOCS-0001');
  } finally {
    cleanup();
  }
});

test('every task type has a prefix and every prefix is unique', () => {
  const prefixes = Object.values(TYPE_PREFIX);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test('an illegal transition is refused and says where you may go instead', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const problems = transitionProblems(ctx, makeTask({ status: 'backlog' }), 'done', { allTasks: [] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not allowed/);
    assert.match(problems[0], /ready, blocked, cancelled/);
  } finally {
    cleanup();
  }
});

test('ready requires a real criterion with a check, and an area', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const placeholder = makeTask({
      acceptance_criteria: [
        { id: 'AC1', must: 'Pendiente de refinar por el planner: sustituir.', check: { type: 'manual', run: null }, status: 'pending' },
      ],
    });
    assert.ok(transitionProblems(ctx, placeholder, 'ready', { allTasks: [] }).some((p) => /placeholder/.test(p)));

    const noArea = makeTask({ context: { area: null, docs: [], files: [], out_of_scope: [] } });
    assert.ok(transitionProblems(ctx, noArea, 'ready', { allTasks: [] }).some((p) => /context.area/.test(p)));

    const commandWithoutRun = makeTask({
      acceptance_criteria: [{ id: 'AC1', must: 'Algo observable ocurre.', check: { type: 'command', run: null }, status: 'pending' }],
    });
    assert.ok(transitionProblems(ctx, commandWithoutRun, 'ready', { allTasks: [] }).some((p) => /check.run is empty/.test(p)));

    assert.deepEqual(transitionProblems(ctx, makeTask(), 'ready', { allTasks: [] }), []);
  } finally {
    cleanup();
  }
});

test('an epic may become ready without an area, because it is never implemented', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const epic = makeTask({
      id: 'EPIC-0001',
      type: 'epic',
      context: { area: null, docs: [], files: [], out_of_scope: [] },
    });
    assert.deepEqual(transitionProblems(ctx, epic, 'ready', { allTasks: [] }), []);
  } finally {
    cleanup();
  }
});

test('ready does not require dependencies to be done, but in_progress does', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const dep = makeTask({ id: 'FEAT-0002', status: 'in_progress' });
    const task = makeTask({ status: 'ready', depends_on: ['FEAT-0002'] });
    const all = [dep, task];

    // Grooming ahead of time must stay possible.
    assert.deepEqual(transitionProblems(ctx, { ...task, status: 'backlog' }, 'ready', { allTasks: all }), []);
    // Starting work on it must not.
    assert.ok(transitionProblems(ctx, task, 'in_progress', { allTasks: all }).some((p) => /blocked by FEAT-0002/.test(p)));
  } finally {
    cleanup();
  }
});

test('only a human may set done or cancelled', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const task = makeTask({ status: 'in_review' });
    const asAgent = transitionProblems(ctx, task, 'done', { actorKind: 'agent', allTasks: [task] });
    assert.ok(asAgent.some((p) => /only a human/.test(p)));
    const asHuman = transitionProblems(ctx, task, 'done', { actorKind: 'human', allTasks: [task] });
    assert.deepEqual(asHuman, []);
  } finally {
    cleanup();
  }
});

test('blocked needs a reason and cancelled needs a resolution', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    assert.ok(transitionProblems(ctx, makeTask(), 'blocked', { allTasks: [] }).some((p) => /blocked_reason/.test(p)));
    assert.ok(
      transitionProblems(ctx, makeTask(), 'cancelled', { allTasks: [] }).some((p) => /resolution/.test(p)),
    );
  } finally {
    cleanup();
  }
});

test('in_review refuses while any criterion is unresolved or failing', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const pending = makeTask({ status: 'in_progress' });
    assert.ok(transitionProblems(ctx, pending, 'in_review', { allTasks: [] }).some((p) => /still pending/.test(p)));

    const failing = makeTask({
      status: 'in_progress',
      acceptance_criteria: [{ id: 'AC1', must: 'Algo observable ocurre.', check: { type: 'review', run: null }, status: 'fail' }],
    });
    assert.ok(transitionProblems(ctx, failing, 'in_review', { allTasks: [] }).some((p) => /failing/.test(p)));
  } finally {
    cleanup();
  }
});

test('the branch name does not repeat the type, and maps back to the task', () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask({ id: 'FEAT-0042', title: 'Registro de usuario con verificación' })] });
  try {
    const task = makeTask({ id: 'FEAT-0042', title: 'Registro de usuario con verificación' });
    const branch = branchFor(task);
    assert.equal(branch, 'feat/0042-registro-de-usuario-con-verificacion');
    assert.ok(!branch.includes('FEAT-0042'), 'the type must not appear twice');
    assert.equal(idFromBranch(ctx, branch), 'FEAT-0042');
  } finally {
    cleanup();
  }
});

test('slugify strips accents so Spanish titles produce clean ASCII branches', () => {
  assert.equal(slugify('Añadir validación de sesión'), 'anadir-validacion-de-sesion');
  assert.match(slugify('Corregir el cálculo del IVA (España)'), /^[a-z0-9-]+$/);
});

test('next skips epics, blocked tasks and claimed tasks, and respects priority', () => {
  const done = makeTask({ id: 'FEAT-0009', status: 'done' });
  const epic = makeTask({ id: 'EPIC-0001', type: 'epic', status: 'ready' });
  const blocked = makeTask({ id: 'FEAT-0002', status: 'ready', depends_on: ['FEAT-0003'] });
  const blocker = makeTask({ id: 'FEAT-0003', status: 'ready' });
  const claimed = makeTask({ id: 'FEAT-0004', status: 'ready', assignee: { kind: 'agent', id: 'implementer' } });
  const low = makeTask({ id: 'FEAT-0005', status: 'ready', priority: 'low' });
  const critical = makeTask({ id: 'FEAT-0006', status: 'ready', priority: 'critical' });

  assert.equal(pickNext([done, epic, blocked, claimed, low, critical, blocker]).id, 'FEAT-0006');
  assert.equal(pickNext([epic, blocked, claimed]), null, 'nothing workable means null, not a guess');
});
