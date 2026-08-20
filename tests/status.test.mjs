import assert from 'node:assert/strict';
import test from 'node:test';
import { logEvent, timeInStatus } from '../.harness/bin/lib/tasks.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

test('time in status comes from the worklog, not from updated_at', () => {
  // `updated_at` moves on any edit, so a task nobody has advanced in nine days would look
  // fresh because somebody fixed a typo in it.
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask({ status: 'in_progress' })] });
  try {
    const task = makeTask({ status: 'in_progress', updated_at: new Date().toISOString() });
    logEvent(ctx, task.id, 'implementer', 'claimed', 'branch feat/0001-x');
    const age = timeInStatus(ctx, task);
    assert.equal(age.days, 0);
    assert.ok(age.since, 'and it says since when');
  } finally {
    cleanup();
  }
});

test('a status change is found by its note, and the latest one wins', () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask({ status: 'in_review' })] });
  try {
    const task = makeTask({ status: 'in_review' });
    logEvent(ctx, task.id, 'planner', 'status_changed', 'backlog -> ready');
    logEvent(ctx, task.id, 'implementer', 'claimed', 'branch x');
    logEvent(ctx, task.id, 'tester', 'status_changed', 'in_progress -> in_review');
    const age = timeInStatus(ctx, task);
    assert.equal(age.days, 0);
  } finally {
    cleanup();
  }
});

test('with no worklog it falls back to when the task was created', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const task = makeTask({ status: 'ready', created_at: '2026-08-01T00:00:00Z' });
    const age = timeInStatus(ctx, task);
    assert.equal(age.since, '2026-08-01T00:00:00Z');
    assert.ok(age.days > 0, 'and the count is real');
  } finally {
    cleanup();
  }
});

test('an unparseable date yields null rather than NaN days', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const age = timeInStatus(ctx, makeTask({ status: 'ready', created_at: 'no es una fecha' }));
    assert.equal(age.days, null);
  } finally {
    cleanup();
  }
});
