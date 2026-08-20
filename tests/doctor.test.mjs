import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../.harness/bin/lib/doctor.mjs';
import { AGENT_FIXTURE, COMMAND_FIXTURE, makeTask, repoCtx, tempHarness } from './helpers.mjs';

function gitInit(root) {
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) {
    spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  }
}

function issuesFor(ctx) {
  return runDoctor(ctx).issues;
}

test('a file the harness needs but git ignores is an error, naming the rule and the fix', () => {
  // This is the failure that reached CI once: an unanchored `lib/` in a Python .gitignore
  // template swallowed .harness/bin/lib/, and `git add` skipped it without a word.
  const { ctx, cleanup } = tempHarness();
  try {
    gitInit(ctx.root);
    fs.mkdirSync(path.join(ctx.harnessDir, 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(ctx.harnessDir, 'bin', 'lib', 'util.mjs'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(ctx.root, '.gitignore'), 'lib/\n');

    const found = issuesFor(ctx).filter((i) => i.check === 'git-visibility');
    assert.equal(found.length, 1);
    assert.equal(found[0].level, 'error');
    assert.match(found[0].message, /util\.mjs is ignored by git/);
    assert.match(found[0].message, /matched by \.gitignore/, 'it must name the offending rule');
    assert.match(found[0].message, /Anchor the pattern/, 'and say how to fix it');
  } finally {
    cleanup();
  }
});

test('anchoring the pattern clears the finding', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    gitInit(ctx.root);
    fs.mkdirSync(path.join(ctx.harnessDir, 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(ctx.harnessDir, 'bin', 'lib', 'util.mjs'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(ctx.root, '.gitignore'), '/lib/\n');

    assert.deepEqual(issuesFor(ctx).filter((i) => i.check === 'git-visibility'), []);
  } finally {
    cleanup();
  }
});

test('deliberately ignored scratch files are not reported', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    gitInit(ctx.root);
    const ws = path.join(ctx.harnessDir, 'workspace', 'FEAT-0001');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'COMMIT_MSG.txt'), 'wip\n');
    fs.writeFileSync(path.join(ctx.root, '.gitignore'), '.harness/workspace/*/COMMIT_MSG.txt\n');

    assert.deepEqual(issuesFor(ctx).filter((i) => i.check === 'git-visibility'), []);
  } finally {
    cleanup();
  }
});

test('outside a git repository the check stays silent rather than inventing a problem', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    assert.deepEqual(issuesFor(ctx).filter((i) => i.check === 'git-visibility'), []);
  } finally {
    cleanup();
  }
});

test('a read-path file over budget is an error that says not to raise the budget', () => {
  const { ctx, cleanup } = tempHarness({
    project: { read_path: [{ path: 'docs/areas/core.md', max_lines: 3 }] },
  });
  try {
    fs.writeFileSync(path.join(ctx.root, 'docs', 'areas', 'core.md'), 'x\n'.repeat(20));
    const found = issuesFor(ctx).filter((i) => i.check === 'read-path');
    assert.equal(found.length, 1);
    assert.match(found[0].message, /is 20 lines, budget is 3/);
  } finally {
    cleanup();
  }
});

test('a declared area without its document is an error', () => {
  const { ctx, cleanup } = tempHarness({
    project: { areas: [{ id: 'ghost', globs: ['src/**'], doc: 'docs/areas/ghost.md' }] },
  });
  try {
    const found = issuesFor(ctx).filter((i) => i.check === 'areas');
    assert.ok(found.some((i) => /ghost\.md, which does not exist/.test(i.message)));
  } finally {
    cleanup();
  }
});

test('an agent with an empty forbidden list is an error', () => {
  const { ctx, cleanup } = tempHarness({
    agents: [{ id: 'toothless', content: '---\nid: toothless\npurpose: Do anything at all with no limits.\n---\n\nBody.\n' }],
  });
  try {
    const found = issuesFor(ctx).filter((i) => i.check === 'definitions');
    assert.ok(found.some((i) => /declares nothing in `forbidden`/.test(i.message)));
  } finally {
    cleanup();
  }
});

test('something shaped like a credential in a task file is an error', () => {
  const { ctx, cleanup } = tempHarness({
    tasks: [makeTask({ description: 'Configurar el cliente con api_key: pk_a1b2c3d4e5f6g7h8i9 y probarlo.' })],
  });
  try {
    const found = issuesFor(ctx).filter((i) => i.check === 'secrets');
    assert.equal(found.length, 1);
  } finally {
    cleanup();
  }
});

test('stale generated views are reported, and --fix regenerates them', () => {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  try {
    assert.ok(issuesFor(ctx).some((i) => i.check === 'index'));

    const { fixed } = runDoctor(ctx, { fix: true });
    assert.ok(fixed.some((f) => /regenerated backlog/.test(f)));
    assert.ok(!issuesFor(ctx).some((i) => i.check === 'index'), 'and then it is clean');
  } finally {
    cleanup();
  }
});

test('--fix never touches a task, a doc or any source file', () => {
  const { ctx, cleanup } = tempHarness({
    tasks: [makeTask({ status: 'ready', context: { area: null, docs: [], files: [], out_of_scope: [] } })],
    agents: [{ id: 'worker', content: AGENT_FIXTURE }],
    commands: [{ id: 'do-thing', content: COMMAND_FIXTURE }],
  });
  try {
    const taskFile = path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json');
    const before = fs.readFileSync(taskFile, 'utf8');
    runDoctor(ctx, { fix: true });
    assert.equal(fs.readFileSync(taskFile, 'utf8'), before, 'a broken task needs judgement, not a machine');
    // And the problem is still reported rather than silently swallowed.
    assert.ok(issuesFor(ctx).some((i) => i.check === 'backlog'));
  } finally {
    cleanup();
  }
});

test('this repository is healthy', () => {
  const { counts } = runDoctor(repoCtx());
  assert.equal(counts.error, 0);
});
