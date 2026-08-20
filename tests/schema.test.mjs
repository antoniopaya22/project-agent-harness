import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validate } from '../.harness/bin/lib/schema.mjs';
import { makeTask, repoCtx } from './helpers.mjs';

const ctx = repoCtx();
const schema = ctx.taskSchema;

test('a fully populated task validates', () => {
  const task = makeTask({
    size: 'M',
    parent: 'EPIC-0001',
    estimate_hours: 6,
    depends_on: ['FIX-0031'],
    labels: ['auth', 'email'],
    assignee: { kind: 'agent', id: 'implementer' },
    claimed_at: '2026-08-18T00:00:00Z',
    branch: 'feat/0001-algo',
    acceptance_criteria: [
      { id: 'AC1', must: 'Devuelve 409 con email duplicado.', check: { type: 'command', run: 'pytest -q' }, status: 'pass', evidence: '1 passed' },
    ],
    external: { clickup: { id: null, url: null, list_id: null, last_synced_at: null, content_hash: null } },
  });
  assert.deepEqual(validate(task, schema), []);
});

test('an unknown status is rejected', () => {
  const errors = validate(makeTask({ status: 'doing' }), schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /must be one of/);
  assert.equal(errors[0].path, 'status');
});

test('a malformed id is rejected', () => {
  for (const id of ['TASK-0001', 'FEAT-1', 'feat-0001', 'FEAT_0001']) {
    const errors = validate(makeTask({ id }), schema);
    assert.ok(errors.some((e) => e.path === 'id'), `expected ${id} to be rejected`);
  }
});

test('a task with no acceptance criteria is rejected', () => {
  const errors = validate(makeTask({ acceptance_criteria: [] }), schema);
  assert.ok(errors.some((e) => /at least 1 item/.test(e.message)));
});

test('an acceptance criterion with an unknown check type is rejected', () => {
  const task = makeTask({
    acceptance_criteria: [{ id: 'AC1', must: 'Algo observable ocurre.', check: { type: 'automatic' }, status: 'pending' }],
  });
  const errors = validate(task, schema);
  assert.ok(errors.some((e) => e.path === 'acceptance_criteria[0].check.type'));
});

test('the history is no longer part of the task, because the read path pays for it', () => {
  // It used to be a 20-entry array inside the file an agent reads to implement.
  const errors = validate(makeTask({ worklog: [] }), schema);
  assert.ok(errors.some((e) => /unknown property "worklog"/.test(e.message)));
});

test('unknown properties are rejected rather than silently ignored', () => {
  const errors = validate(makeTask({ owner: 'someone' }), schema);
  assert.ok(errors.some((e) => /unknown property "owner"/.test(e.message)));
});

test('a nullable field accepts both null and its type', () => {
  assert.deepEqual(validate(makeTask({ parent: null }), schema), []);
  assert.deepEqual(validate(makeTask({ parent: 'EPIC-0002' }), schema), []);
  assert.ok(validate(makeTask({ parent: 'FEAT-0002' }), schema).length > 0);
});

test('$ref into $defs resolves', () => {
  const projectSchema = JSON.parse(
    fs.readFileSync(`${ctx.harnessDir}/schema/project.schema.json`, 'utf8'),
  );
  const errors = validate({ run: 'x', required: true, status: 'configured' }, projectSchema.$defs.gate, {
    root: projectSchema,
  });
  assert.deepEqual(errors, []);
});

test('the validator reports schema keywords it does not support', () => {
  const errors = validate('x', { type: 'string', allOf: [] });
  assert.ok(errors.some((e) => /unsupported keyword "allOf"/.test(e.message)));
});
