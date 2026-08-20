import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EXIT } from '../.harness/bin/lib/util.mjs';
import { REPO, makeTask, tempHarness } from './helpers.mjs';

const ENTRY = path.join(REPO, '.harness', 'bin', 'harness.mjs');

function run(ctx, args) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function taskWith(checks) {
  return makeTask({
    acceptance_criteria: checks.map((run_, i) => ({
      id: `AC${i + 1}`,
      must: `Criterio observable numero ${i + 1} del caso de prueba.`,
      check: run_ === null ? { type: 'review', run: null } : { type: 'command', run: run_ },
      status: 'pending',
    })),
  });
}

function fixture(checks) {
  const { ctx, cleanup } = tempHarness({ tasks: [taskWith(checks)] });
  return { ctx, cleanup };
}

test('a check that fails today is baselined as evidence', () => {
  const { ctx, cleanup } = fixture(['node -e "process.exit(1)"']);
  try {
    const res = run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    assert.equal(res.status, EXIT.OK, res.stdout);
    assert.match(res.stdout, /FAIL AC1/);
    const task = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8'));
    assert.equal(task.acceptance_criteria[0].baseline, 'fail');
  } finally {
    cleanup();
  }
});

test('a check that already passes is a finding, not a green light', () => {
  // The most common way a green result lies: a test that would pass without the change.
  const { ctx, cleanup } = fixture(['node -e "process.exit(0)"']);
  try {
    const res = run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    assert.equal(res.status, EXIT.CHECK_FAILED, 'it must not exit 0');
    assert.match(res.stdout, /already pass before any change/);
    assert.match(res.stdout, /Regroom before implementing/);
  } finally {
    cleanup();
  }
});

test('a command that cannot even start is recorded as error, not confused with a failure', () => {
  const { ctx, cleanup } = fixture(['este-binario-no-existe-en-ninguna-parte --x']);
  try {
    run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    const task = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json'), 'utf8'));
    assert.ok(['error', 'fail'].includes(task.acceptance_criteria[0].baseline));
  } finally {
    cleanup();
  }
});

test('criteria without a command check are left alone', () => {
  const { ctx, cleanup } = fixture([null]);
  try {
    const res = run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    assert.equal(res.status, EXIT.OK);
    assert.match(res.stdout, /no command checks to baseline/);
  } finally {
    cleanup();
  }
});

test('marking a criterion pass is refused when it already passed before the change', () => {
  const { ctx, cleanup } = fixture(['node -e "process.exit(0)"']);
  try {
    run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    const res = run(ctx, ['task', 'ac', 'FEAT-0001', 'AC1', 'pass', '--evidence', 'exit 0']);
    assert.equal(res.status, EXIT.CHECK_FAILED);
    assert.match(res.stdout, /proves nothing/);
  } finally {
    cleanup();
  }
});

test('the refusal can be overridden deliberately, and only deliberately', () => {
  const { ctx, cleanup } = fixture(['node -e "process.exit(0)"']);
  try {
    run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    const res = run(ctx, ['task', 'ac', 'FEAT-0001', 'AC1', 'pass', '--evidence', 'legitimo porque X', '--force']);
    assert.equal(res.status, EXIT.OK, res.stdout);
  } finally {
    cleanup();
  }
});

test('a criterion that failed at baseline can be marked pass normally', () => {
  const { ctx, cleanup } = fixture(['node -e "process.exit(1)"']);
  try {
    run(ctx, ['task', 'ac-baseline', 'FEAT-0001']);
    const res = run(ctx, ['task', 'ac', 'FEAT-0001', 'AC1', 'pass', '--evidence', 'ahora pasa']);
    assert.equal(res.status, EXIT.OK, res.stdout);
  } finally {
    cleanup();
  }
});
