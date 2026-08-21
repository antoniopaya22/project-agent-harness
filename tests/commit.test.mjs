import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildMessage, buildSubject, doCommit, inferScope, renderPrBody } from '../.harness/bin/lib/commit.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

test('the subject follows the conventional grammar and fits in 72 characters', () => {
  const task = makeTask({ id: 'FEAT-0042', title: 'Registro de usuario con verificación por email' });
  assert.equal(buildSubject(task), 'feat: Registro de usuario con verificación por email');
  assert.equal(buildSubject(task, { scope: 'api' }), 'feat(api): Registro de usuario con verificación por email');

  const long = makeTask({ type: 'fix', title: 'x'.repeat(200) });
  const subject = buildSubject(long, { scope: 'cli' });
  assert.ok(subject.length <= 72, `subject is ${subject.length} characters`);
  assert.match(subject, /^fix\(cli\): /);
  assert.match(subject, /…$/, 'truncation is visible');
});

test('a trailing period is dropped, because the convention forbids it', () => {
  assert.equal(buildSubject(makeTask({ title: 'Añadir el validador de sesión.' })), 'feat: Añadir el validador de sesión');
});

test('the task type maps to the conventional commit type', () => {
  const cases = { feature: 'feat', fix: 'fix', chore: 'chore', docs: 'docs', refactor: 'refactor', test: 'test', spike: 'spike' };
  for (const [type, expected] of Object.entries(cases)) {
    assert.match(buildSubject(makeTask({ type, title: 'Un título cualquiera válido' })), new RegExp(`^${expected}:`));
  }
});

test('the message carries a trailer that ties the commit to its task', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const task = makeTask({ id: 'FEAT-0042', description: 'Los usuarios se registran con email y contraseña.' });
    const refs = buildMessage(ctx, task, {});
    assert.match(refs, /\nRefs: FEAT-0042\n$/);
    assert.match(refs, /Los usuarios se registran/, 'the body explains why');

    const closes = buildMessage(ctx, task, { closes: true });
    assert.match(closes, /\nCloses: FEAT-0042\n$/);
  } finally {
    cleanup();
  }
});

test('the subject and the body are separated by a blank line', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const lines = buildMessage(ctx, makeTask(), {}).split('\n');
    assert.equal(lines[1], '', 'git requires a blank second line');
  } finally {
    cleanup();
  }
});

test('--no-verify records itself in the body, so a skipped gate leaves a trace', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const msg = buildMessage(ctx, makeTask(), { body: 'Note: committed with --no-verify; gates were not run.' });
    assert.match(msg, /--no-verify/);
  } finally {
    cleanup();
  }
});

test('the scope is inferred from the areas the staged files belong to', () => {
  const { ctx, cleanup } = tempHarness({
    project: {
      areas: [
        { id: 'api', globs: ['src/api/**'], doc: 'docs/areas/core.md' },
        { id: 'web', globs: ['src/web/**'], doc: 'docs/areas/core.md' },
      ],
      git: { default_branch: 'main', auto_pr: 'ready', commit_scopes: ['api', 'web'] },
    },
  });
  try {
    assert.equal(inferScope(ctx, ['src/api/users.py', 'src/api/auth.py']), 'api');
    // Two areas is ambiguous, and guessing a scope is worse than omitting it.
    assert.equal(inferScope(ctx, ['src/api/users.py', 'src/web/page.tsx']), null);
    assert.equal(inferScope(ctx, ['README.md']), null);
  } finally {
    cleanup();
  }
});

test('a scope outside the declared list is not used', () => {
  const { ctx, cleanup } = tempHarness({
    project: {
      areas: [{ id: 'api', globs: ['src/api/**'], doc: 'docs/areas/core.md' }],
      git: { default_branch: 'main', auto_pr: 'ready', commit_scopes: ['web'] },
    },
  });
  try {
    assert.equal(inferScope(ctx, ['src/api/users.py']), null);
  } finally {
    cleanup();
  }
});

test('the pull request body lists the criteria as a checklist reflecting their verdicts', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const task = makeTask({
      id: 'FEAT-0042',
      acceptance_criteria: [
        { id: 'AC1', must: 'Devuelve 409 con email duplicado.', check: { type: 'command', run: 'pytest -q' }, status: 'pass', evidence: '1 passed' },
        { id: 'AC2', must: 'Queda documentado en el área.', check: { type: 'review', run: null }, status: 'pending' },
      ],
    });
    const body = renderPrBody(ctx, task);
    assert.match(body, /- \[x\] \*\*AC1\*\*/, 'a passing criterion is ticked');
    assert.match(body, /- \[ \] \*\*AC2\*\*/, 'a pending one is not');
    assert.match(body, /FEAT-0042/);
    assert.match(body, /Sin informe de verificación/, 'missing verification is stated, not hidden');
  } finally {
    cleanup();
  }
});

test('the working tree is clean when commit returns', () => {
  // Three things are only knowable after the commit exists: its hash, the worklog entry,
  // and the PR url. Writing them and stopping left the tree dirty every single time, and
  // the next `git checkout` refused to switch.
  const { ctx, cleanup } = tempHarness({
    tasks: [makeTask({ id: 'FEAT-0001', status: 'in_progress', branch: 'feat/0001-algo', assignee: { kind: 'agent', id: 'x' } })],
  });
  try {
    const run = (args, opts = {}) => spawnSync('git', args, { cwd: ctx.root, encoding: 'utf8', ...opts });
    run(['init', '-q', '.']);
    run(['config', 'user.email', 't@e.com']);
    run(['config', 'user.name', 'T']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'inicial']);
    run(['switch', '-q', '-c', 'feat/0001-algo']);
    fs.writeFileSync(path.join(ctx.root, 'src.txt'), 'algo nuevo\n');

    const report = doCommit(ctx, { taskId: 'FEAT-0001', noVerify: true, push: false });
    assert.equal(report.committed, true);
    assert.equal(run(['status', '--porcelain']).stdout.trim(), '', 'nada se queda sin registrar');

    const log = run(['log', '--oneline', '-2']).stdout;
    assert.match(log, /registrar el commit en la tarea/, 'y el registro es un commit propio, no un amend');
  } finally {
    cleanup();
  }
});
