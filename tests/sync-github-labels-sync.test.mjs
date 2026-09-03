// Pins the fix for labels that never caught up: an issue created before its labels existed
// had current content forever after (its hash matched), so the engine's "nothing to do here"
// check skipped it and apply() — the only place that applied labels — was never called again.
//
// Each test re-imports the adapter with a cache-busting query so the module-level issue index
// it keeps does not leak between tests in this file.

import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTask, withFakeGh } from './helpers.mjs';

const freshAdapter = () => import(`../.harness/integrations/github/adapter.mjs?probe=${Math.random()}`);

test('an issue missing labels the task now declares is reported incomplete', async () => {
  const { incompleteReason } = await freshAdapter();
  const task = makeTask({
    id: 'FEAT-0042',
    priority: 'high',
    context: { area: 'core', docs: [], files: [], out_of_scope: [] },
    external: { github: { id: '7', url: null, issue: 7, drifted: false, remote_hash: 'x' } },
  });
  const fakeGh = withFakeGh({
    'issue list': { out: [{ number: 7, title: 'FEAT-0042 · algo', state: 'OPEN', body: 'x', id: 'I_7', labels: [] }] },
  });
  try {
    const reason = incompleteReason({ root: process.cwd() }, task);
    assert.ok(reason, 'an issue missing its labels must not read as complete');
    assert.match(reason, /sin etiquetar/);
    assert.match(reason, /type:feature/);
    assert.match(reason, /priority:high/);
  } finally {
    fakeGh.cleanup();
  }
});

test('an issue already carrying every label the task declares is complete', async () => {
  const { incompleteReason } = await freshAdapter();
  const task = makeTask({
    id: 'FEAT-0043',
    priority: 'high',
    context: { area: 'core', docs: [], files: [], out_of_scope: [] },
    external: { github: { id: '8', url: null, issue: 8, drifted: false, remote_hash: 'x' } },
  });
  const fakeGh = withFakeGh({
    'issue list': {
      out: [
        {
          number: 8,
          title: 'FEAT-0043 · algo',
          state: 'OPEN',
          body: 'x',
          id: 'I_8',
          labels: [{ name: 'type:feature' }, { name: 'priority:high' }, { name: 'area:core' }],
        },
      ],
    },
  });
  try {
    assert.equal(incompleteReason({ root: process.cwd() }, task), null);
  } finally {
    fakeGh.cleanup();
  }
});

test('apply() re-syncs labels on update, not only at creation', async () => {
  const { apply } = await freshAdapter();
  const task = makeTask({
    id: 'FEAT-0044',
    priority: 'critical',
    context: { area: 'core', docs: [], files: [], out_of_scope: [] },
    external: { github: { id: '9', url: null, issue: 9, drifted: false, remote_hash: 'stale' } },
  });
  const fakeGh = withFakeGh({
    'issue list': { out: [{ number: 9, title: 'FEAT-0044 · algo', state: 'OPEN', body: 'viejo', id: 'I_9', labels: [] }] },
    'label list': { out: [{ name: 'type:feature' }, { name: 'priority:critical' }] },
  });
  try {
    await apply({ root: process.cwd() }, { op: 'update', task });
    const edit = fakeGh.calls().find((a) => a[0] === 'issue' && a[1] === 'edit');
    assert.ok(edit, 'update must go through issue edit');
    const labelIdx = edit.indexOf('--add-label');
    assert.ok(labelIdx !== -1, 'the update must carry --add-label, not only --title/--body');
    assert.match(edit[labelIdx + 1], /type:feature/);
    assert.match(edit[labelIdx + 1], /priority:critical/);
  } finally {
    fakeGh.cleanup();
  }
});
