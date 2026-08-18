import assert from 'node:assert/strict';
import test from 'node:test';
import { lintBacklog } from '../.harness/bin/lib/lint.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

function findings(tasks, project) {
  const { ctx, cleanup } = tempHarness({ tasks, project });
  try {
    return lintBacklog(ctx);
  } finally {
    cleanup();
  }
}

test('a dependency cycle is reported exactly once, not once per entry point', () => {
  const out = findings([
    makeTask({ id: 'FEAT-0001', depends_on: ['FEAT-0002'] }),
    makeTask({ id: 'FEAT-0002', depends_on: ['FEAT-0003'] }),
    makeTask({ id: 'FEAT-0003', depends_on: ['FEAT-0001'] }),
  ]);
  const cycles = out.filter((f) => /cycle/.test(f.message));
  assert.equal(cycles.length, 1, `expected one cycle finding, got ${cycles.length}`);
  assert.equal(cycles[0].level, 'error');
});

test('a dependency on a task that does not exist is an error', () => {
  const out = findings([makeTask({ depends_on: ['FEAT-9999'] })]);
  assert.ok(out.some((f) => f.level === 'error' && /FEAT-9999, which does not exist/.test(f.message)));
});

test('a task marked ready that does not qualify is an error, because /implement trusts ready', () => {
  const out = findings([
    makeTask({
      status: 'ready',
      acceptance_criteria: [
        { id: 'AC1', must: 'Pendiente de refinar por el planner: sustituir.', check: { type: 'manual', run: null }, status: 'pending' },
      ],
    }),
  ]);
  assert.ok(out.some((f) => f.level === 'error' && /marked ready but/.test(f.message)));
});

test('duplicate acceptance criterion ids are caught', () => {
  const out = findings([
    makeTask({
      acceptance_criteria: [
        { id: 'AC1', must: 'Primera cosa observable ocurre.', check: { type: 'review', run: null }, status: 'pending' },
        { id: 'AC1', must: 'Segunda cosa observable ocurre.', check: { type: 'review', run: null }, status: 'pending' },
      ],
    }),
  ]);
  assert.ok(out.some((f) => /duplicate acceptance criterion id AC1/.test(f.message)));
});

test('an id prefix that disagrees with the type is an error only while still in backlog', () => {
  const inBacklog = findings([makeTask({ id: 'FIX-0001', type: 'feature', status: 'backlog' })]);
  assert.ok(inBacklog.some((f) => f.level === 'error' && /retype/.test(f.message)));

  // Once claimed the id is frozen and living in branches and commits: divergence is informational.
  const claimed = findings([
    makeTask({
      id: 'FIX-0001',
      type: 'feature',
      status: 'in_progress',
      branch: 'feat/0001-x',
      assignee: { kind: 'agent', id: 'implementer' },
    }),
  ]);
  const divergence = claimed.filter((f) => /diverges/.test(f.message));
  assert.equal(divergence.length, 1);
  assert.equal(divergence[0].level, 'warn');
});

test('an area not declared in project.json is an error', () => {
  const out = findings([makeTask({ context: { area: 'inventada', docs: [], files: [], out_of_scope: [] } })]);
  assert.ok(out.some((f) => f.level === 'error' && /is not declared in project.json/.test(f.message)));
});

test('a parent that is not an epic is an error', () => {
  const out = findings([
    makeTask({ id: 'FEAT-0001', parent: 'EPIC-0001' }),
    makeTask({ id: 'EPIC-0001', type: 'feature' }),
  ]);
  assert.ok(out.some((f) => /is not an epic/.test(f.message)));
});

test('in_progress without a branch or an assignee is an error', () => {
  const out = findings([makeTask({ status: 'in_progress' })]);
  assert.ok(out.some((f) => /in_progress without a branch/.test(f.message)));
  assert.ok(out.some((f) => /in_progress without an assignee/.test(f.message)));
});

test('a technical-looking title is a warning, because the board is read by non-technical people', () => {
  const out = findings([makeTask({ title: 'Arreglar src/api/users.py en el endpoint' })]);
  assert.ok(out.some((f) => f.level === 'warn' && /title looks technical/.test(f.message)));
});

test('a clean backlog produces no findings at all', () => {
  const out = findings([
    makeTask({ id: 'EPIC-0001', type: 'epic', status: 'ready' }),
    makeTask({ id: 'FEAT-0001', status: 'ready', parent: 'EPIC-0001' }),
  ]);
  assert.deepEqual(out, []);
});
