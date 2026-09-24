// The GitHub backlog store (project.json → backlog.store: github), against a fake `gh` that keeps
// one repository and one board in a JSON file. The real transport is `gh` itself; what is tested
// here is everything the harness decides: what it writes, what it reads back, when it refuses.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as gh from '../.harness/bin/lib/store-github.mjs';
import * as tasks from '../.harness/bin/lib/tasks.mjs';
import { runDoctor } from '../.harness/bin/lib/doctor.mjs';
import { migrateToGithub } from '../.harness/bin/lib/migrate-github.mjs';
import { runSink } from '../.harness/bin/lib/sync.mjs';
import * as githubSink from '../.harness/integrations/github/adapter.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.mjs');
const GITHUB = { backlog: { store: 'github', github: { owner: 'acme', project: 1, repo: 'acme/app' } } };

/** A temp harness wired to a fresh fake GitHub. */
function setup({ project = GITHUB, tasks: fileTasks = [] } = {}) {
  const h = tempHarness({ project, tasks: fileTasks });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const env = {
    HARNESS_GH_SCRIPT: process.env.HARNESS_GH_SCRIPT,
    FAKE_GH_STATE: process.env.FAKE_GH_STATE,
    FAKE_GH_LOG: process.env.FAKE_GH_LOG,
    FAKE_GH_FAIL_LIST: process.env.FAKE_GH_FAIL_LIST,
  };
  process.env.HARNESS_GH_SCRIPT = FAKE;
  process.env.FAKE_GH_STATE = path.join(dir, 'state.json');
  process.env.FAKE_GH_LOG = path.join(dir, 'calls.jsonl');
  delete process.env.FAKE_GH_FAIL_LIST;
  gh.forgetIds(h.ctx);
  const calls = () => (fs.existsSync(process.env.FAKE_GH_LOG) ? fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
  const resetCalls = () => fs.rmSync(process.env.FAKE_GH_LOG, { force: true });
  const remote = () => JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
  const writeRemote = (s) => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(s));
  const cleanup = () => {
    gh.forgetIds(h.ctx);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    h.cleanup();
  };
  return { ...h, calls, resetCalls, remote, writeRemote, cleanup };
}

function readyTask(overrides = {}) {
  return makeTask({
    id: 'FEAT-0001',
    status: 'ready',
    acceptance_criteria: [{ id: 'AC1', must: 'Responde 409 si el email está repetido.', check: { type: 'command', run: 'npm test' }, status: 'pending' }],
    ...overrides,
  });
}

test('a saved task reads back identical, and lands as an issue plus a card with its status', () => {
  const s = setup();
  try {
    const task = readyTask({ labels: ['cat-api'], depends_on: [] });
    gh.save(s.ctx, { ...task });
    gh.forgetIds(s.ctx);
    const back = gh.load(s.ctx, 'FEAT-0001');
    for (const k of ['id', 'title', 'status', 'type', 'priority', 'acceptance_criteria', 'context', 'depends_on', 'labels']) {
      assert.deepEqual(back[k], task[k], k);
    }
    assert.equal(back.description, String(task.description).trim());

    const r = s.remote();
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].title, `FEAT-0001 · ${task.title}`);
    assert.deepEqual(r.issues[0].labels, ['area:core', 'cat-api', `priority:${task.priority}`, 'type:feature'].sort());
    assert.equal(r.board.items.length, 1, 'the issue is on the board');
    const statusField = r.board.fields.find((f) => f.name === 'Status');
    const option = statusField.options.find((o) => o.id === r.board.items[0].values[statusField.id]);
    assert.equal(option.name, 'ready');
    assert.ok(r.board.fields.some((f) => f.name === 'Rama') && r.board.fields.some((f) => f.name === 'Reclamada por'), 'the two text fields are created once');
  } finally {
    s.cleanup();
  }
});

test('the description is the free part of the body; the data block below the marker is the harness’s', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask({ description: 'Texto que se edita a mano.' }));
    const body = s.remote().issues[0].body;
    assert.ok(body.startsWith('Texto que se edita a mano.'));
    assert.match(body, /<!-- harness:datos -->/);
    assert.match(body, /```json\n\{/);
    const data = JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.equal('status' in data, false, 'status lives on the board, never in the body');

    // A human edits the description on GitHub: the harness reads it back as the description.
    const r = s.remote();
    r.issues[0].body = r.issues[0].body.replace('Texto que se edita a mano.', 'Descripción corregida en GitHub.');
    s.writeRemote(r);
    assert.equal(gh.load(s.ctx, 'FEAT-0001').description, 'Descripción corregida en GitHub.');
  } finally {
    s.cleanup();
  }
});

test('moving a card by hand on the board is a status change, with no sync of any kind', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    const r = s.remote();
    const status = r.board.fields.find((f) => f.name === 'Status');
    r.board.items[0].values[status.id] = status.options.find((o) => o.name === 'cancelled').id;
    s.writeRemote(r);
    assert.equal(gh.load(s.ctx, 'FEAT-0001').status, 'cancelled');
  } finally {
    s.cleanup();
  }
});

test('saving an unchanged task writes nothing', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    const loaded = gh.load(s.ctx, 'FEAT-0001');
    s.resetCalls();
    gh.save(s.ctx, loaded, { keepDates: true });
    const writes = s.calls().filter((c) => (c.kind === 'rest' && c.method !== 'GET') || (c.kind === 'graphql' && /^(update|clear|add|create|delete)/.test(c.op)));
    assert.deepEqual(writes, []);
  } finally {
    s.cleanup();
  }
});

test('closing a task closes its issue, and the "who and where" fields are cleared on the card', () => {
  const s = setup();
  try {
    const t = readyTask({ status: 'in_progress', branch: 'feat/0001-registro', assignee: { kind: 'agent', id: 'implementer' }, claimed_at: '2026-09-24T08:00:00Z' });
    gh.save(s.ctx, t);
    let r = s.remote();
    const rama = r.board.fields.find((f) => f.name === 'Rama');
    assert.equal(r.board.items[0].values[rama.id], 'feat/0001-registro');
    const loaded = gh.load(s.ctx, 'FEAT-0001');
    loaded.status = 'done';
    gh.save(s.ctx, loaded);
    r = s.remote();
    assert.equal(r.issues[0].state, 'CLOSED');
    assert.equal(r.board.items[0].values[rama.id], undefined);
  } finally {
    s.cleanup();
  }
});

test('an invalid task never leaves the machine', () => {
  const s = setup();
  try {
    const bad = readyTask();
    bad.priority = 'urgentísima';
    assert.throws(() => gh.save(s.ctx, bad), /no cumple el esquema/);
    assert.equal(fs.existsSync(process.env.FAKE_GH_STATE) ? s.remote().issues.length : 0, 0);
  } finally {
    s.cleanup();
  }
});

test('two cards for one id are refused instead of picking one', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    const r = s.remote();
    const copy = { ...r.issues[0], number: 99, nodeId: 'I_99', comments: [] };
    r.issues.push(copy);
    r.board.items.push({ id: 'PVTI_99', issue: 99, values: {} });
    s.writeRemote(r);
    gh.forgetIds(s.ctx);
    process.env.HARNESS_FRESH = '1';
    try {
      assert.throws(() => gh.loadAll(s.ctx), /dos incidencias para FEAT-0001/);
    } finally {
      delete process.env.HARNESS_FRESH;
    }
  } finally {
    s.cleanup();
  }
});

test('ids are allocated over the whole board, not over whatever is on disk', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask({ id: 'FEAT-0007' }));
    assert.equal(gh.allocateId(s.ctx, 'FEAT'), 'FEAT-0008');
    assert.equal(gh.allocateId(s.ctx, 'FIX'), 'FIX-0001');
  } finally {
    s.cleanup();
  }
});

test('two sessions claiming at once: the oldest claim since `ready` wins, the other withdraws', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    const task = gh.load(s.ctx, 'FEAT-0001');
    // Both read `ready`, both comment their claim before either writes.
    const a = gh.logEvent(s.ctx, task, 'sesion-A', 'claimed', 'branch feat/0001-a');
    const b = gh.logEvent(s.ctx, task, 'sesion-B', 'claimed', 'branch feat/0001-b');
    const va = gh.arbitrateClaim(s.ctx, task, a);
    const vb = gh.arbitrateClaim(s.ctx, task, b);
    assert.equal(va.won, true);
    assert.equal(vb.won, false);
    assert.equal(vb.winner.by, 'sesion-A');

    // A later cycle: the task goes back to `ready`, and the old claim no longer counts.
    gh.logEvent(s.ctx, task, 'sesion-A', 'status_changed', 'in_progress -> ready');
    const c = gh.logEvent(s.ctx, task, 'sesion-B', 'claimed', 'branch feat/0001-b');
    assert.equal(gh.arbitrateClaim(s.ctx, task, c).won, true);
  } finally {
    s.cleanup();
  }
});

test('imported history never wins a claim, even though its events are older', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    const task = gh.load(s.ctx, 'FEAT-0001');
    gh.comment(s.ctx, task.__remote.number, gh.renderEventsComment([{ at: '2026-01-01T00:00:00Z', by: 'viejo', event: 'claimed', note: 'branch x' }]));
    const mine = gh.logEvent(s.ctx, task, 'sesion-A', 'claimed', 'branch feat/0001-a');
    assert.equal(gh.arbitrateClaim(s.ctx, task, mine).won, true);
  } finally {
    s.cleanup();
  }
});

test('the worklog is the issue’s comments, readable back in order', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    const task = gh.load(s.ctx, 'FEAT-0001');
    gh.logEvent(s.ctx, task, 'planner', 'groomed', 'AC1 set');
    gh.logEvent(s.ctx, task, 'implementer', 'claimed', 'branch feat/0001-x');
    const events = gh.readWorklog(s.ctx, 'FEAT-0001', 10);
    assert.deepEqual(events.map((e) => e.event), ['groomed', 'claimed']);
    assert.match(s.remote().issues[0].comments[0].body, /\*\*groomed\*\*/, 'the comment is readable by a person too');
  } finally {
    s.cleanup();
  }
});

test('the tasks API dispatches to the store the project declares', () => {
  const s = setup();
  try {
    assert.equal(tasks.usesGithub(s.ctx), true);
    const t = readyTask();
    tasks.save(s.ctx, t);
    assert.equal(tasks.exists(s.ctx, 'FEAT-0001'), true);
    assert.equal(tasks.loadAll(s.ctx).length, 1);
    assert.equal(fs.existsSync(path.join(s.ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json')), false, 'no task file is written');
  } finally {
    s.cleanup();
  }
});

test('plain doctor makes no GitHub call at all: it runs in CI on every push', () => {
  const s = setup();
  try {
    gh.save(s.ctx, readyTask());
    gh.forgetIds(s.ctx);
    s.resetCalls();
    runDoctor(s.ctx, { fix: false });
    assert.deepEqual(s.calls(), []);
    runDoctor(s.ctx, { fix: false, backlog: true });
    assert.ok(s.calls().length > 0, 'with --backlog it does read the tasks');
  } finally {
    s.cleanup();
  }
});

test('the migration moves the file backlog, is resumable, and a second run writes nothing', async () => {
  const fileTasks = [readyTask({ id: 'FEAT-0001' }), readyTask({ id: 'FIX-0002', type: 'fix', status: 'done' })];
  const s = setup({ project: { ...GITHUB, backlog: { ...GITHUB.backlog, store: 'files' } }, tasks: fileTasks });
  try {
    await migrateToGithub(s.ctx, {});
    const r = s.remote();
    assert.equal(r.issues.length, 2);
    assert.equal(r.issues.find((i) => i.title.startsWith('FIX-0002')).state, 'CLOSED');

    s.resetCalls();
    await migrateToGithub(s.ctx, {});
    const writes = s.calls().filter((c) => (c.kind === 'rest' && c.method !== 'GET') || (c.kind === 'graphql' && /^(update|clear|add|create|delete)/.test(c.op)));
    assert.deepEqual(writes, [], 'nothing left to write on the second run');
  } finally {
    s.cleanup();
  }
});

test('the GitHub sink creates nothing when it cannot list the existing issues', async () => {
  const s = setup({ project: {} });
  try {
    process.env.FAKE_GH_FAIL_LIST = '1';
    const result = await runSink(s.ctx, { id: 'github', module: githubSink }, [makeTask({ id: 'FEAT-0001' }), makeTask({ id: 'FEAT-0002' })]);
    assert.equal(result.applied, 0);
    assert.equal(result.failed, 2);
    assert.match(result.errors[0], /refusing to create any/);
    assert.equal(s.calls().filter((c) => c.kind === 'issue-create').length, 0);
    assert.equal(s.calls().filter((c) => c.kind === 'issue-list').length, 1, 'the list is tried once per run, not once per task');
  } finally {
    s.cleanup();
  }
});
