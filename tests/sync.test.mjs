import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentHash, describeSinks, planFor, runSink } from '../.harness/bin/lib/sync.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

/** A sink that records what it was asked to do, so the engine can be tested on its own. */
function fakeSink(behaviour = {}) {
  const calls = [];
  return {
    calls,
    sink: {
      id: 'fake',
      module: {
        isEnabled: () => behaviour.enabled ?? { enabled: true, reason: 'test' },
        prepare: behaviour.prepare,
        apply: async (ctx, operation) => {
          calls.push(operation.op);
          if (behaviour.failOn && behaviour.failOn(operation)) throw new Error('boom');
          return { id: `remote-${operation.task.id}`, drifted: Boolean(behaviour.drift) };
        },
      },
    },
  };
}

test('the hash covers what a sink projects and ignores the rest', () => {
  const base = makeTask();
  assert.equal(contentHash(base), contentHash({ ...base }));

  // Bookkeeping churn must not make every task look dirty.
  for (const noise of [
    { updated_at: '2030-01-01T00:00:00Z' },
    { claimed_at: '2030-01-01T00:00:00Z' },
    { branch: 'feat/0001-otra-cosa' },
    { links: { pr: 'https://x/9', issue: null, commits: ['abc'] } },
    { assignee: { kind: 'agent', id: 'tester' } },
  ]) {
    assert.equal(contentHash({ ...base, ...noise }), contentHash(base), `${Object.keys(noise)[0]} must not change the hash`);
  }

  // What a reader would notice must change it.
  for (const real of [{ title: 'Otro titulo bastante distinto' }, { status: 'done' }, { priority: 'critical' }]) {
    assert.notEqual(contentHash({ ...base, ...real }), contentHash(base), `${Object.keys(real)[0]} must change the hash`);
  }
});

test('label order does not change the hash, because it is a set', () => {
  const a = makeTask({ labels: ['auth', 'email'] });
  const b = makeTask({ labels: ['email', 'auth'] });
  assert.equal(contentHash(a), contentHash(b));
});

test('the plan says create, update or skip per task', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const fresh = makeTask({ id: 'FEAT-0001' });
    const synced = makeTask({ id: 'FEAT-0002' });
    synced.external = { fake: { id: 'r2', content_hash: contentHash(synced) } };
    const changed = makeTask({ id: 'FEAT-0003' });
    changed.external = { fake: { id: 'r3', content_hash: 'obsoleto' } };

    const ops = planFor(ctx, fakeSink().sink, [fresh, synced, changed]);
    assert.deepEqual(ops.map((o) => `${o.task.id}:${o.op}`), ['FEAT-0001:create', 'FEAT-0002:skip', 'FEAT-0003:update']);
  } finally {
    cleanup();
  }
});

test('a second run changes nothing, because the state was recorded', async () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const { sink, calls } = fakeSink();
    const tasks = [makeTask()];
    const first = await runSink(ctx, sink, tasks, {});
    assert.equal(first.applied, 1);
    assert.deepEqual(calls, ['create']);

    // Reload from disk: the engine must have written the remote id and the hash.
    const reloaded = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8'));
    assert.equal(reloaded.external.fake.id, 'remote-FEAT-0001');
    const second = await runSink(ctx, sink, [reloaded], {});
    assert.equal(second.applied, 0);
    assert.equal(second.skipped, 1);
  } finally {
    cleanup();
  }
});

test('a dry run touches nothing on disk', async () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const file = path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json');
    const before = fs.readFileSync(file, 'utf8');
    const { sink, calls } = fakeSink();
    const result = await runSink(ctx, sink, [makeTask()], { dryRun: true });
    assert.equal(result.applied, 1, 'it still reports what it would do');
    assert.deepEqual(calls, [], 'but the adapter is never called');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('one task failing does not abort the rest', async () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const { sink } = fakeSink({ failOn: (op) => op.task.id === 'FEAT-0002' });
    const result = await runSink(ctx, sink, [makeTask({ id: 'FEAT-0001' }), makeTask({ id: 'FEAT-0002' }), makeTask({ id: 'FEAT-0003' })], {});
    assert.equal(result.applied, 2);
    assert.equal(result.failed, 1);
    assert.ok(result.errors[0].startsWith('FEAT-0002:'));
  } finally {
    cleanup();
  }
});

test('a sink whose prepare throws is reported, not raised', async () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const { sink } = fakeSink({
      prepare: () => {
        throw new Error('sin credencial');
      },
    });
    const result = await runSink(ctx, sink, [makeTask()], {});
    assert.equal(result.applied, 0);
    assert.match(result.errors[0], /prepare failed: sin credencial/);
  } finally {
    cleanup();
  }
});

test('remote drift is reported and then overwritten, never merged', async () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const { sink } = fakeSink({ drift: true });
    const result = await runSink(ctx, sink, [makeTask()], {});
    assert.deepEqual(result.drifted, ['FEAT-0001']);
    assert.equal(result.applied, 1, 'the repository still wins');
  } finally {
    cleanup();
  }
});

test('a disabled sink explains itself instead of failing', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const { sink } = fakeSink({ enabled: { enabled: false, reason: 'no credential' } });
    assert.deepEqual(describeSinks(ctx, [sink]), [{ id: 'fake', enabled: false, reason: 'no credential' }]);
  } finally {
    cleanup();
  }
});

test('sinks are independent: each keeps its own state on the task', async () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const a = fakeSink().sink;
    const b = { id: 'otro', module: { ...a.module, apply: async (c2, op) => ({ id: `otro-${op.task.id}` }) } };
    await runSink(ctx, a, [makeTask()], {});
    const afterA = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8'));
    await runSink(ctx, b, [afterA], {});
    const afterB = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8'));
    assert.equal(afterB.external.fake.id, 'remote-FEAT-0001', 'the first sink state survives');
    assert.equal(afterB.external.otro.id, 'otro-FEAT-0001');
  } finally {
    cleanup();
  }
});

test('prepare runs before the plan, so the sink can say what is still missing', async () => {
  // The other order made every plan claim there was nothing to do: the sink had not yet
  // learnt what it was connected to when it was asked what it owed.
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const order = [];
    const sink = {
      id: 'fake',
      module: {
        isEnabled: () => ({ enabled: true, reason: 'test' }),
        prepare: () => order.push('prepare'),
        incompleteReason: () => {
          order.push('plan');
          return null;
        },
        apply: async () => ({ id: 'r1' }),
      },
    };
    const task = makeTask();
    task.external = { fake: { id: 'r1', content_hash: contentHash(task) } };
    await runSink(ctx, sink, [task], {});
    assert.deepEqual(order, ['prepare', 'plan']);
  } finally {
    cleanup();
  }
});

test('an unchanged task with incomplete remote state is updated, not skipped', async () => {
  // Half a projection landing before the board existed left those tasks off it for ever,
  // because their content hash was already current.
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const calls = [];
    const sink = {
      id: 'fake',
      module: {
        isEnabled: () => ({ enabled: true, reason: 'test' }),
        incompleteReason: (_c, t) => (t.external?.fake?.extra ? null : 'not on the board yet'),
        apply: async (_c, op) => {
          calls.push(op.op);
          return { id: 'r1', extra: true };
        },
      },
    };
    const task = makeTask();
    task.external = { fake: { id: 'r1', content_hash: contentHash(task) } };

    const result = await runSink(ctx, sink, [task], {});
    assert.equal(result.applied, 1, 'the hash was current, but the state was not complete');
    assert.deepEqual(calls, ['update']);
  } finally {
    cleanup();
  }
});

test('a sink with nothing outstanding still skips', async () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    const sink = {
      id: 'fake',
      module: {
        isEnabled: () => ({ enabled: true, reason: 'test' }),
        incompleteReason: () => null,
        apply: async () => ({ id: 'r1' }),
      },
    };
    const task = makeTask();
    task.external = { fake: { id: 'r1', content_hash: contentHash(task) } };
    const result = await runSink(ctx, sink, [task], {});
    assert.equal(result.applied, 0);
    assert.equal(result.skipped, 1);
  } finally {
    cleanup();
  }
});
