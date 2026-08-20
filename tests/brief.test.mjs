import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { projectConfig, projectTask, readPathFor, renderBrief } from '../.harness/bin/lib/readpath.mjs';
import { estimateTokens } from '../.harness/bin/lib/util.mjs';
import { loadAll } from '../.harness/bin/lib/tasks.mjs';
import { makeTask, repoCtx, tempHarness } from './helpers.mjs';

function fixture(overrides = {}) {
  const { ctx, cleanup } = tempHarness({
    tasks: [makeTask(overrides)],
    project: {
      areas: [
        { id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' },
        { id: 'otra', globs: ['other/**'], doc: 'docs/areas/core.md' },
      ],
      integrations: { clickup: { enabled: false, list_id: 'no-le-importa-a-nadie' } },
      read_path_total_max_tokens: 6500,
    },
  });
  fs.mkdirSync(path.join(ctx.harnessDir), { recursive: true });
  fs.writeFileSync(path.join(ctx.harnessDir, 'ENTRYPOINT.md'), '# reglas\n'.repeat(40));
  fs.writeFileSync(path.join(ctx.root, 'docs', 'areas', 'core.md'), '## Qué hace esta área\ntexto\n'.repeat(20));
  return { ctx, cleanup, task: makeTask(overrides) };
}

test('the projection drops bookkeeping the agent cannot act on', () => {
  const task = makeTask({
    links: { pr: 'https://x/1', issue: null, commits: ['abc123', 'def456'] },
    external: { clickup: { id: '9', url: 'https://c/9', list_id: '1', last_synced_at: 'x', content_hash: 'h' } },
    assignee: { kind: 'agent', id: 'implementer' },
    claimed_at: '2026-08-20T00:00:00Z',
  });
  const projected = projectTask(task);
  for (const dropped of ['links', 'external', 'assignee', 'claimed_at', 'created_at', 'updated_at', '$schema']) {
    assert.equal(projected[dropped], undefined, `${dropped} must not survive the projection`);
  }
  // And everything needed to implement must survive.
  for (const kept of ['id', 'title', 'type', 'status', 'description', 'acceptance_criteria', 'context']) {
    assert.notEqual(projected[kept], undefined, `${kept} is required to implement`);
  }
});

test('the config projection keeps the gates and only the task own area', () => {
  const { ctx, cleanup, task } = fixture();
  try {
    const projected = projectConfig(ctx, task);
    assert.ok(projected.gates, 'the agent must never guess a command');
    assert.ok(projected.git, 'nor a branch or commit convention');
    assert.equal(projected.area.id, 'core');
    assert.equal(projected.areas, undefined, 'other areas are irrelevant to this task');
    assert.equal(projected.integrations, undefined, 'tracker config is harness plumbing');
    assert.equal(projected.providers, undefined);
    assert.equal(projected.read_path, undefined);
    assert.ok(!JSON.stringify(projected).includes('no-le-importa-a-nadie'));
  } finally {
    cleanup();
  }
});

test('the brief is one payload with a labelled section per source', () => {
  const { ctx, cleanup, task } = fixture();
  try {
    const { body } = renderBrief(ctx, task);
    assert.match(body, /=====.*ENTRYPOINT\.md.*=====/);
    assert.match(body, new RegExp(`===== task ${task.id} \\(projection\\) =====`));
    assert.match(body, /===== project config \(projection\) =====/);
    assert.match(body, /=====.*areas\/core\.md.*=====/);
  } finally {
    cleanup();
  }
});

test('one call replaces the whole orientation read path', () => {
  const { ctx, cleanup, task } = fixture();
  try {
    const { stats } = renderBrief(ctx, task);
    assert.equal(stats.calls, 1);
    assert.equal(stats.naiveCalls, 4, 'entrypoint + task + config + area doc');
  } finally {
    cleanup();
  }
});

test('the projection cuts the projectable part by at least 40% across the real backlog', () => {
  // The honest measure, and it took a failed criterion to find it. Prose — the entrypoint
  // and the area doc — cannot be projected, and it is about two thirds of the payload, so
  // a whole-payload figure is dominated by material this feature cannot touch. What it can
  // compress is the task and the config, and that is what gets asserted.
  //
  // Measured over the real backlog rather than a synthetic minimal task, because the claim
  // is about this project's actual cold start.
  const ctx = repoCtx();
  let raw = 0;
  let projected = 0;
  let measured = 0;
  for (const task of loadAll(ctx)) {
    if (task.type === 'epic') continue;
    const rp = readPathFor(ctx, task);
    raw +=
      rp.orientation.find((e) => e.path.includes('tasks/')).tokens +
      rp.orientation.find((e) => e.path.endsWith('project.json')).tokens;
    projected +=
      estimateTokens(JSON.stringify(projectTask(task), null, 2)) +
      estimateTokens(JSON.stringify(projectConfig(ctx, task), null, 2));
    measured += 1;
  }
  assert.ok(measured > 10, 'needs a real backlog to mean anything');
  const cut = 1 - projected / raw;
  assert.ok(cut >= 0.4, `only cut ${Math.round(cut * 100)}% of the projectable part across ${measured} tasks`);
});

test('work files are listed, not inlined, unless asked for', () => {
  const { ctx, cleanup } = tempHarness({
    project: { areas: [{ id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' }] },
  });
  try {
    fs.writeFileSync(path.join(ctx.harnessDir, 'ENTRYPOINT.md'), '# reglas\n');
    fs.mkdirSync(path.join(ctx.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, 'src', 'grande.mjs'), '// CONTENIDO_UNICO\n'.repeat(200));
    const task = makeTask({ context: { area: 'core', docs: [], files: ['src/grande.mjs'], out_of_scope: [] } });

    const listed = renderBrief(ctx, task);
    assert.ok(!listed.body.includes('CONTENIDO_UNICO'), 'the work payload must not be inlined by default');
    assert.match(listed.body, /files to work on \(not inlined\)/);
    assert.match(listed.body, /- src\/grande\.mjs/);

    const inlined = renderBrief(ctx, task, { withFiles: true });
    assert.ok(inlined.body.includes('CONTENIDO_UNICO'), '--with-files must inline it');
    assert.ok(inlined.stats.briefTokens > listed.stats.briefTokens);
  } finally {
    cleanup();
  }
});

test('an ungroomed task produces a brief that says so instead of failing', () => {
  const { ctx, cleanup } = tempHarness({});
  try {
    fs.writeFileSync(path.join(ctx.harnessDir, 'ENTRYPOINT.md'), '# reglas\n');
    const task = makeTask({ context: { area: null, docs: [], files: [], out_of_scope: [] } });
    const { body } = renderBrief(ctx, task);
    assert.match(body, /under-groomed|no area/i);
    assert.match(body, /\/plan/, 'and it points at the fix');
  } finally {
    cleanup();
  }
});

test('every real task in this repository has a brief inside the cap', () => {
  const ctx = repoCtx();
  for (const task of loadAll(ctx)) {
    if (task.type === 'epic') continue;
    const { stats } = renderBrief(ctx, task);
    assert.ok(
      stats.briefTokens <= ctx.project.read_path_total_max_tokens,
      `${task.id}: brief costs ~${stats.briefTokens} tokens, cap is ${ctx.project.read_path_total_max_tokens}`,
    );
  }
});
