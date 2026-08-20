// The GitHub sink's pure half: what it projects. The network half is exercised by
// `harness sync --dry-run` against a real repository, which is the only honest way to test
// a transport, and by the CI workflow.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STATUS_OPTIONS,
  isClosed,
  issueBody,
  issueTitle,
  labelsFor,
} from '../.harness/integrations/github/adapter.mjs';
import { STATUSES } from '../.harness/bin/lib/tasks.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

test('the title leads with the id, so the issue is findable by search and by eye', () => {
  const task = makeTask({ id: 'FEAT-0042', title: 'Registro de usuario con verificación' });
  assert.equal(issueTitle(task), 'FEAT-0042 · Registro de usuario con verificación');
  assert.ok(issueTitle(task).startsWith('FEAT-0042 '), 'the lookup depends on this prefix');
});

test('the body carries the criteria as a checklist reflecting their verdicts', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const task = makeTask({
      acceptance_criteria: [
        { id: 'AC1', must: 'Devuelve 409 con email duplicado.', check: { type: 'command', run: 'x' }, status: 'pass' },
        { id: 'AC2', must: 'Queda documentado en el área.', check: { type: 'review', run: null }, status: 'pending' },
      ],
    });
    const body = issueBody(ctx, task);
    assert.match(body, /- \[x\] \*\*AC1\*\*/);
    assert.match(body, /- \[ \] \*\*AC2\*\*/);
  } finally {
    cleanup();
  }
});

test('the body says the repository is the source of truth, so nobody edits it expecting an effect', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const body = issueBody(ctx, makeTask());
    assert.match(body, /fuente de verdad/);
    assert.match(body, /se sobrescribirá/);
    assert.match(body, /backlog\/tasks\/FEAT-0001\.json/, 'and points at the real task');
  } finally {
    cleanup();
  }
});

test('a task with no criteria still produces a usable body', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const body = issueBody(ctx, { ...makeTask(), acceptance_criteria: [] });
    assert.match(body, /Sin criterios/);
  } finally {
    cleanup();
  }
});

test('labels carry type, priority and area, plus the task own labels', () => {
  const labels = labelsFor(makeTask({ priority: 'high', labels: ['auth'] }));
  assert.deepEqual(labels, ['type:feature', 'priority:high', 'area:core', 'auth']);
});

test('a task without priority or area produces fewer labels, not empty ones', () => {
  const labels = labelsFor({ ...makeTask(), priority: undefined, context: { area: null, docs: [], files: [], out_of_scope: [] } });
  assert.deepEqual(labels, ['type:feature']);
  assert.ok(!labels.some((l) => l.endsWith(':')), 'no dangling label');
});

test('only the closed statuses close the issue', () => {
  for (const status of STATUSES) {
    const expected = status === 'done' || status === 'cancelled';
    assert.equal(isClosed(makeTask({ status })), expected, `${status} should ${expected ? '' : 'not '}close`);
  }
});

test('the board options mirror the harness statuses one to one', () => {
  // The point of creating the project ourselves: the mapping is the identity, so a whole
  // class of translation bugs cannot exist.
  assert.equal(STATUS_OPTIONS.length, STATUSES.length);
  const optionNames = STATUS_OPTIONS.map((o) => o.name);
  for (const status of STATUSES) {
    const expected = status.replace('_', ' ').replace('done', 'complete');
    assert.ok(optionNames.includes(expected), `no board option for status ${status} (expected "${expected}")`);
  }
});

test('every option declares a colour, because the board is read at a glance', () => {
  for (const option of STATUS_OPTIONS) {
    assert.match(option.color, /^[A-Z]+$/, `${option.name} has no colour`);
  }
});
