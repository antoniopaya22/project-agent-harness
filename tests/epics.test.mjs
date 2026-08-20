import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveEpicStatus, regenerate } from '../.harness/bin/lib/board.mjs';
import { EXIT } from '../.harness/bin/lib/util.mjs';
import { lintBacklog } from '../.harness/bin/lib/lint.mjs';
import { REPO, makeTask, tempHarness } from './helpers.mjs';

const epic = (over = {}) => makeTask({ id: 'EPIC-0001', type: 'epic', status: 'backlog', ...over });
const child = (id, status) => makeTask({ id, status, parent: 'EPIC-0001' });

test('epic status is derived from its children, not kept by hand', () => {
  const cases = [
    [['backlog', 'backlog'], 'backlog'],
    [['ready', 'backlog'], 'ready'],
    [['done', 'ready'], 'ready'],
    [['in_progress', 'ready'], 'in_progress'],
    [['in_review', 'backlog'], 'in_progress'],
    [['done', 'done'], 'done'],
    [['blocked', 'backlog'], 'blocked'],
    [['blocked', 'ready'], 'ready', 'something workable outweighs something blocked'],
    [['cancelled', 'cancelled'], 'cancelled'],
    [['done', 'cancelled'], 'done', 'a cancelled child does not hold the epic open'],
  ];
  for (const [statuses, expected, why] of cases) {
    const children = statuses.map((s, i) => child(`FEAT-000${i + 1}`, s));
    assert.equal(deriveEpicStatus(epic(), children), expected, why || `${statuses.join('+')} -> ${expected}`);
  }
});

test('an epic with no children keeps whatever it had', () => {
  assert.equal(deriveEpicStatus(epic({ status: 'ready' }), []), 'ready');
});

test('regenerating the index writes the derived status back and logs it', () => {
  const { ctx, cleanup } = tempHarness({
    tasks: [epic({ status: 'backlog' }), child('FEAT-0001', 'done'), child('FEAT-0002', 'done')],
  });
  try {
    const { epics } = regenerate(ctx);
    assert.deepEqual(epics, ['EPIC-0001: backlog -> done']);

    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'EPIC-0001.json'), 'utf8'));
    assert.equal(onDisk.status, 'done');

    const log = fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'worklog', 'EPIC-0001.jsonl'), 'utf8');
    assert.match(log, /derivado de sus hijas/);

    // And it is idempotent: a second pass has nothing to change.
    assert.deepEqual(regenerate(ctx).epics, []);
  } finally {
    cleanup();
  }
});

test('deriving done bypasses the human-only rule, and that is deliberate', () => {
  // Everywhere else only a human closes a task. An epic is the exception because the human
  // decisions already happened one level down: it is only done when every child was closed
  // by a person.
  const { ctx, cleanup } = tempHarness({
    tasks: [epic({ status: 'in_progress' }), child('FEAT-0001', 'done')],
  });
  try {
    assert.deepEqual(regenerate(ctx).epics, ['EPIC-0001: in_progress -> done']);
  } finally {
    cleanup();
  }
});

test('an epic cannot be claimed, because it is a container and not work', () => {
  const { ctx, cleanup } = tempHarness({ tasks: [epic({ status: 'ready' })] });
  try {
    const res = spawnSync(process.execPath, [path.join(REPO, '.harness', 'bin', 'harness.mjs'), 'task', 'claim', 'EPIC-0001'], {
      cwd: ctx.root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, EXIT.PRECONDITION);
    assert.match(res.stdout, /is an epic/);
    assert.match(res.stdout, /children instead/, 'and it says what to do instead');
  } finally {
    cleanup();
  }
});

test('an epic in progress is not required to have a branch or an assignee', () => {
  // The two features collided the first time: derivation puts an epic in_progress because a
  // child is, and the backlog lint demanded a branch — which an epic never has, so the
  // derived status was permanently invalid.
  const { ctx, cleanup } = tempHarness({
    tasks: [epic({ status: 'in_progress' }), child('FEAT-0001', 'in_progress')],
  });
  try {
    const findings = lintBacklog(ctx).filter((f) => f.id === 'EPIC-0001');
    assert.ok(!findings.some((f) => /without a branch|without an assignee/.test(f.message)), JSON.stringify(findings));
  } finally {
    cleanup();
  }
});

test('an epic that somehow has a branch is a warning, because nothing should give it one', () => {
  const { ctx, cleanup } = tempHarness({
    tasks: [epic({ status: 'in_progress', branch: 'chore/0001-x' }), child('FEAT-0001', 'in_progress')],
  });
  try {
    const findings = lintBacklog(ctx).filter((f) => f.id === 'EPIC-0001');
    assert.ok(findings.some((f) => f.level === 'warn' && /neither a branch nor an assignee/.test(f.message)));
  } finally {
    cleanup();
  }
});
