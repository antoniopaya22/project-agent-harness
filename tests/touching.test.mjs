import assert from 'node:assert/strict';
import test from 'node:test';
import { touchesPath } from '../.harness/bin/lib/task-cmd.mjs';
import { makeTask, repoCtx, tempHarness } from './helpers.mjs';

function fixture() {
  return tempHarness({
    project: {
      areas: [
        { id: 'api', globs: ['src/api/**'], doc: 'docs/areas/core.md' },
        { id: 'web', globs: ['src/web/**', 'public/**'], doc: 'docs/areas/core.md' },
      ],
    },
  });
}

test('a task is relevant when it names the file', () => {
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: 'api', docs: [], files: ['src/api/users.py'], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src/api/users.py'), true);
  } finally {
    cleanup();
  }
});

test('a task is relevant when the path falls inside its area', () => {
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: 'api', docs: [], files: [], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src/api/nuevo.py'), true);
    assert.equal(touchesPath(ctx, task, 'src/web/page.tsx'), false, 'another area is not relevant');
  } finally {
    cleanup();
  }
});

test('a directory named by the task covers the files under it, and the reverse', () => {
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: null, docs: [], files: ['src/api'], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src/api/users.py'), true, 'the task owns the directory');

    const narrow = makeTask({ context: { area: null, docs: [], files: ['src/api/users.py'], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, narrow, 'src/api'), true, 'asking about the directory finds the file');
  } finally {
    cleanup();
  }
});

test('a partial name prefix is not a match', () => {
  // `src/api` must never match `src/apiary`: comparing raw prefixes would.
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: null, docs: [], files: ['src/api'], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src/apiary/x.py'), false);
    assert.equal(touchesPath(ctx, task, 'src/api2'), false);
  } finally {
    cleanup();
  }
});

test('separators are normalised, so a Windows path still matches', () => {
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: 'api', docs: [], files: [], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src\\api\\users.py'), true);
  } finally {
    cleanup();
  }
});

test('a trailing slash does not change the answer', () => {
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: null, docs: [], files: ['src/api'], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src/api/'), true);
  } finally {
    cleanup();
  }
});

test('a task with neither area nor files is relevant to nothing', () => {
  const { ctx, cleanup } = fixture();
  try {
    const task = makeTask({ context: { area: null, docs: [], files: [], out_of_scope: [] } });
    assert.equal(touchesPath(ctx, task, 'src/api/users.py'), false);
  } finally {
    cleanup();
  }
});

test('it answers a real question about this repository', () => {
  const ctx = repoCtx();
  // Built from the real backlog: the CLI area owns .harness/bin/**, so tasks in it must
  // come back for a file under there.
  const cliTask = makeTask({ context: { area: 'cli', docs: [], files: [], out_of_scope: [] } });
  assert.equal(touchesPath(ctx, cliTask, '.harness/bin/lib/tasks.mjs'), true);
  assert.equal(touchesPath(ctx, cliTask, 'docs/CODEMAP.md'), false);
});
