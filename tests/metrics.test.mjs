import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { durations, humanDuration, readMetrics, record, report, transitions } from '../.harness/bin/lib/metrics.mjs';
import { logEvent } from '../.harness/bin/lib/tasks.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

/** A task whose worklog says it went through the whole machine, with real timestamps. */
function walked(ctx, id, { created, ready, started, review, done } = {}) {
  const write = (at, event, note) => {
    const file = path.join(ctx.harnessDir, 'backlog', 'worklog', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at, by: 'x', event, note })}\n`);
  };
  if (ready) write(ready, 'status_changed', `backlog -> ready`);
  if (started) write(started, 'claimed', 'branch feat/x');
  if (review) write(review, 'status_changed', `in_progress -> in_review`);
  if (done) write(done, 'completed', `in_review -> done`);
  return makeTask({ id, created_at: created, status: done ? 'done' : 'in_progress' });
}

test('the duration of each stage is derived from the worklog, not declared', () => {
  // Every transition is already stamped. Asking anybody to record the time by hand would be
  // asking for a number that is either wrong or missing.
  const { ctx, cleanup } = tempHarness();
  try {
    const task = walked(ctx, 'FEAT-0001', {
      created: '2026-08-01T10:00:00Z',
      ready: '2026-08-01T11:00:00Z',
      started: '2026-08-01T12:00:00Z',
      review: '2026-08-01T14:00:00Z',
      done: '2026-08-01T14:30:00Z',
    });
    const d = durations(ctx, task);
    assert.equal(d.grooming, 3600, 'de creada a lista');
    assert.equal(d.implementation, 7200, 'de reclamada a revisión');
    assert.equal(d.review, 1800);
    assert.equal(d.total, 16200);
  } finally {
    cleanup();
  }
});

test('a stage that never happened is absent, never zero', () => {
  // Zero says "it took no time", which is a claim. Absent says "this did not happen", which is
  // the truth, and it is what a median has to skip rather than average in.
  const { ctx, cleanup } = tempHarness();
  try {
    const task = walked(ctx, 'FEAT-0002', { created: '2026-08-01T10:00:00Z', started: '2026-08-01T12:00:00Z' });
    const d = durations(ctx, task);
    assert.equal(d.review, undefined);
    assert.equal(d.total, undefined);
    assert.equal(d.grooming, 7200);
  } finally {
    cleanup();
  }
});

test('claiming counts as entering in_progress', () => {
  // `task claim` logs `claimed` rather than a transition, and treating it as something else
  // would lose the start of every implementation.
  const { ctx, cleanup } = tempHarness();
  try {
    walked(ctx, 'FEAT-0003', { started: '2026-08-01T12:00:00Z' });
    assert.deepEqual(transitions(ctx, 'FEAT-0003'), [{ at: '2026-08-01T12:00:00Z', status: 'in_progress' }]);
  } finally {
    cleanup();
  }
});

test('a completion is read even though its event is not status_changed', () => {
  // `done` is logged as `completed`. Reading only `status_changed` loses the end of every task,
  // which is the measurement that matters most.
  const { ctx, cleanup } = tempHarness();
  try {
    walked(ctx, 'FEAT-0004', { review: '2026-08-01T13:00:00Z', done: '2026-08-01T14:00:00Z' });
    const seen = transitions(ctx, 'FEAT-0004').map((t) => t.status);
    assert.deepEqual(seen, ['in_review', 'done']);
  } finally {
    cleanup();
  }
});

test('rows written in the earlier note format are still read', () => {
  // A short-lived format wrote just the destination, so those rows are on disk. Discarding real
  // history to keep a parser tidy is the wrong trade.
  const { ctx, cleanup } = tempHarness();
  try {
    logEvent(ctx, 'FEAT-0005', 'harness', 'status_changed', 'in_review (finish)');
    assert.deepEqual(transitions(ctx, 'FEAT-0005').map((t) => t.status), ['in_review']);
  } finally {
    cleanup();
  }
});

test('a note that is not a transition is not read as one', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    logEvent(ctx, 'FEAT-0006', 'x', 'status_changed', 'unclaimed');
    logEvent(ctx, 'FEAT-0006', 'x', 'status_changed', 'priority=high size=M');
    assert.deepEqual(transitions(ctx, 'FEAT-0006'), []);
  } finally {
    cleanup();
  }
});

test('consumption is declared, accumulates, and survives on disk', () => {
  // Nothing here can observe how many tokens a model spent. Deriving it from diff lines would
  // produce a confident number with no relationship to the thing being measured.
  const { ctx, cleanup } = tempHarness();
  try {
    record(ctx, 'FEAT-0001', { stage: 'implementation', tokens: 12000, model: 'opus' });
    record(ctx, 'FEAT-0001', { stage: 'review', tokens: 3000 });

    const rows = readMetrics(ctx);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, 'opus');
    assert.ok(rows[0].at, 'con marca de tiempo');
    assert.ok(fs.existsSync(path.join(ctx.harnessDir, 'backlog', 'metrics.jsonl')));
  } finally {
    cleanup();
  }
});

test('the report aggregates by area and by type, and counts what nobody measured', () => {
  const { ctx, cleanup } = tempHarness({
    project: { areas: [{ id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' }] },
  });
  try {
    const tasks = [];
    for (const [i, hours] of [1, 2, 30].entries()) {
      const id = `FEAT-000${i + 1}`;
      tasks.push(
        walked(ctx, id, {
          created: '2026-08-01T00:00:00Z',
          started: '2026-08-01T01:00:00Z',
          review: new Date(Date.UTC(2026, 7, 1, 1 + hours)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          done: new Date(Date.UTC(2026, 7, 1, 2 + hours)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      );
    }
    record(ctx, 'FEAT-0001', { tokens: 5000 });

    const r = report(ctx, { tasks });
    assert.equal(r.sample, 3);
    assert.equal(r.unmeasured, 2, 'dos sin consumo declarado: una columna de nulos no es cero');

    const core = r.byArea.find((a) => a.name === 'core');
    assert.equal(core.tasks, 3);
    // The median, not the mean: the thirty-hour task would drag a mean of eleven somewhere
    // meaningless and a single number would hide it.
    assert.equal(core.implementation.median, 7200);
    assert.ok(core.implementation.mean > core.implementation.median);
    assert.equal(r.byType[0].name, 'feature');
  } finally {
    cleanup();
  }
});

test('the report says out loud when the sample is too small to compare anything', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const few = [walked(ctx, 'FEAT-0001', { created: '2026-08-01T00:00:00Z', done: '2026-08-01T01:00:00Z' })];
    assert.equal(report(ctx, { tasks: few }).confident, false);

    const many = [];
    for (let i = 0; i < 25; i += 1) {
      const id = `FEAT-${String(i + 10).padStart(4, '0')}`;
      many.push(walked(ctx, id, { created: '2026-08-01T00:00:00Z', done: '2026-08-01T01:00:00Z' }));
    }
    assert.equal(report(ctx, { tasks: many }).confident, true);
  } finally {
    cleanup();
  }
});

test('epics are excluded: a container is not work and would distort every average', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const epic = walked(ctx, 'EPIC-0001', { created: '2026-08-01T00:00:00Z', done: '2026-08-30T00:00:00Z' });
    epic.type = 'epic';
    assert.equal(report(ctx, { tasks: [epic] }).sample, 0);
  } finally {
    cleanup();
  }
});

test('durations are rendered at a scale a human reads, not in raw seconds', () => {
  assert.equal(humanDuration(null), '—');
  assert.equal(humanDuration(45), '45s');
  assert.equal(humanDuration(600), '10m');
  assert.equal(humanDuration(7200), '2.0h');
  assert.equal(humanDuration(259200), '3.0d');
});
