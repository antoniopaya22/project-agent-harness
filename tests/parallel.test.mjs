import assert from 'node:assert/strict';
import test from 'node:test';
import { conflictsWith, pickParallel } from '../.harness/bin/lib/tasks.mjs';
import { makeTask } from './helpers.mjs';

const ready = (id, context, over = {}) =>
  makeTask({ id, status: 'ready', context: { area: null, docs: [], files: [], out_of_scope: [], ...context }, ...over });

test('more than one next task can be asked for', () => {
  const tasks = [
    ready('FEAT-0001', { area: 'api', files: ['src/api/a.py'] }),
    ready('FEAT-0002', { area: 'web', files: ['src/web/b.tsx'] }),
    ready('FEAT-0003', { area: 'billing', files: ['src/billing/c.py'] }),
  ];
  const { chosen, deferred } = pickParallel(tasks, 3);
  assert.equal(chosen.length, 3);
  assert.deepEqual(deferred, []);
});

test('the queue never exceeds what was asked for', () => {
  const tasks = [1, 2, 3, 4, 5].map((n) => ready(`FEAT-000${n}`, { area: `a${n}`, files: [`src/${n}.py`] }));
  assert.equal(pickParallel(tasks, 2).chosen.length, 2);
});

test('two tasks over the same file are not parallelisable, and it says which file', () => {
  const tasks = [
    ready('FEAT-0001', { area: 'api', files: ['src/api/users.py'] }),
    ready('FEAT-0002', { area: 'web', files: ['src/api/users.py'] }),
  ];
  const { chosen, deferred } = pickParallel(tasks, 2);
  assert.equal(chosen.length, 1);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].against, 'FEAT-0001');
  assert.match(deferred[0].reasons[0], /same files: src\/api\/users\.py/);
});

test('disjoint files in the same area are parallelisable, because the finer signal wins', () => {
  // Without this, a project where one area dominates — as the harness itself does — would
  // report that nothing is ever parallel: true, and useless.
  const tasks = [
    ready('FEAT-0001', { area: 'cli', files: ['src/cli/a.mjs'] }),
    ready('FEAT-0002', { area: 'cli', files: ['src/cli/b.mjs'] }),
  ];
  assert.deepEqual(conflictsWith(tasks[0], tasks[1]), []);
  assert.equal(pickParallel(tasks, 2).chosen.length, 2);
});

test('the same area is a conflict when at least one task does not say which files', () => {
  const named = ready('FEAT-0001', { area: 'cli', files: ['src/cli/a.mjs'] });
  const vague = ready('FEAT-0002', { area: 'cli', files: [] });
  const reasons = conflictsWith(named, vague);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /same area \(cli\)/);
  assert.match(reasons[0], /does not say which files/, 'and it says how to make it parallelisable');
});

test('tasks with no area and no files do not conflict with each other', () => {
  assert.deepEqual(conflictsWith(ready('FEAT-0001', {}), ready('FEAT-0002', {})), []);
});

test('conflict is symmetric', () => {
  const a = ready('FEAT-0001', { area: 'cli', files: ['x.mjs'] });
  const b = ready('FEAT-0002', { area: 'cli', files: [] });
  assert.equal(conflictsWith(a, b).length, conflictsWith(b, a).length);
});

test('what was set aside says what it clashes with, so the answer is actionable', () => {
  const tasks = [
    ready('FEAT-0001', { area: 'cli', files: [] }),
    ready('FEAT-0002', { area: 'cli', files: [] }),
    ready('FEAT-0003', { area: 'docs', files: [] }),
  ];
  const { chosen, deferred } = pickParallel(tasks, 3);
  assert.deepEqual(chosen.map((t) => t.id), ['FEAT-0001', 'FEAT-0003']);
  assert.equal(deferred[0].task.id, 'FEAT-0002');
  assert.equal(deferred[0].against, 'FEAT-0001');
});
