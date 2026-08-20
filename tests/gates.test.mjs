import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_NAMES, runAllGates, runGate, summarize } from '../.harness/bin/lib/gates.mjs';
import { validate } from '../.harness/bin/lib/schema.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { repoCtx, tempHarness } from './helpers.mjs';

const projectSchema = JSON.parse(
  fs.readFileSync(path.join(repoCtx().harnessDir, 'schema', 'project.schema.json'), 'utf8'),
);

test('a not-configured gate is skipped and never blocks', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { typecheck: { run: null, status: 'not-configured', required: true } } },
  });
  try {
    const result = runGate(ctx, 'typecheck');
    assert.equal(result.state, 'skipped');
    assert.equal(result.reason, 'not-configured');
    // Even declared as required, a gate with no command cannot fail the build.
    assert.equal(summarize([result]).ok, true);
  } finally {
    cleanup();
  }
});

test('a not-configured gate is valid configuration', () => {
  const config = {
    harness_version: '1.0.0',
    project: { name: 'x', purpose: 'Un propósito con la longitud mínima requerida.', output_language: 'es' },
    git: { default_branch: 'main', auto_pr: 'ready' },
    gates: { test: { run: null, status: 'not-configured' } },
    areas: [{ id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' }],
  };
  assert.deepEqual(validate(config, projectSchema), []);
});

test('a gate that is not declared at all reports as missing, not as a failure', () => {
  const { ctx, cleanup } = tempHarness({ project: { gates: {} } });
  try {
    const result = runGate(ctx, 'build');
    assert.equal(result.state, 'missing');
    assert.equal(summarize([result]).ok, true);
  } finally {
    cleanup();
  }
});

test('a passing gate runs its declared command', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { lint: { run: 'node -e "process.exit(0)"', required: true } } },
  });
  try {
    const result = runGate(ctx, 'lint', { capture: true });
    assert.equal(result.state, 'pass');
    assert.equal(result.code, 0);
  } finally {
    cleanup();
  }
});

test('a red required gate blocks, and a red optional gate does not', () => {
  const { ctx, cleanup } = tempHarness({
    project: {
      gates: {
        lint: { run: 'node -e "process.exit(1)"', required: true },
        format: { run: 'node -e "process.exit(1)"', required: false },
      },
    },
  });
  try {
    const required = summarize([runGate(ctx, 'lint', { capture: true })]);
    assert.equal(required.ok, false);
    assert.deepEqual(required.requiredFailed.map((g) => g.name), ['lint']);

    const optional = summarize([runGate(ctx, 'format', { capture: true })]);
    assert.equal(optional.ok, true, 'an optional gate reports but does not block');
    assert.equal(optional.failed.length, 1, 'and it is still reported as failed');
  } finally {
    cleanup();
  }
});

test('the gate vocabulary is fixed, so no agent invents a gate name', () => {
  assert.deepEqual(GATE_NAMES, ['format', 'lint', 'typecheck', 'test', 'build', 'start']);
});

test('running all gates never includes start, which is not something you pass', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { start: { run: 'node -e "process.exit(1)"', required: true } } },
  });
  try {
    const names = runAllGates(ctx, { capture: true }).map((r) => r.name);
    assert.ok(!names.includes('start'));
  } finally {
    cleanup();
  }
});

test('this repository declares the gates it actually uses', () => {
  const ctx = repoCtx();
  assert.equal(ctx.project.gates.lint.required, true);
  assert.equal(ctx.project.gates.test.required, true);
  assert.equal(ctx.project.gates.typecheck.status, 'n/a');
});

// --- caché por huella del árbol y alcance por área ---------------------------

import { spawnSync } from 'node:child_process';

function gitRepo(root) {
  for (const args of [['init'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T']]) {
    spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  }
}

test('a passing gate is cached, and the cache is keyed by the tree', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { lint: { run: 'node -e "process.exit(0)"', required: true } } },
  });
  try {
    gitRepo(ctx.root);
    const first = runGate(ctx, 'lint', { capture: true });
    assert.equal(first.cached, false, 'nothing to hit yet');

    const second = runGate(ctx, 'lint', { capture: true });
    assert.equal(second.state, 'pass');
    assert.equal(second.cached, true, 'unchanged tree must hit the cache');

    // Any change to the tree invalidates it.
    fs.writeFileSync(path.join(ctx.root, 'nuevo.txt'), 'x');
    assert.equal(runGate(ctx, 'lint', { capture: true }).cached, false);
  } finally {
    cleanup();
  }
});

test('two different edits to the same file do not collide in the cache key', () => {
  // A fingerprint built from file *names* would return a stale pass here.
  const { ctx, cleanup } = tempHarness({
    project: { gates: { lint: { run: 'node -e "process.exit(0)"', required: true } } },
  });
  try {
    gitRepo(ctx.root);
    const file = path.join(ctx.root, 'a.txt');
    fs.writeFileSync(file, 'primera version');
    runGate(ctx, 'lint', { capture: true });
    assert.equal(runGate(ctx, 'lint', { capture: true }).cached, true);

    fs.writeFileSync(file, 'segunda version');
    assert.equal(runGate(ctx, 'lint', { capture: true }).cached, false, 'content, not just names');
  } finally {
    cleanup();
  }
});

test('a failing gate is never cached, because a red result must be trustworthy', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { lint: { run: 'node -e "process.exit(1)"', required: true } } },
  });
  try {
    gitRepo(ctx.root);
    runGate(ctx, 'lint', { capture: true });
    const again = runGate(ctx, 'lint', { capture: true });
    assert.equal(again.state, 'fail');
    assert.equal(again.cached, false, 'an environmental failure must not stick to the tree');
  } finally {
    cleanup();
  }
});

test('cache can be bypassed, and is skipped outside a git repository', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { lint: { run: 'node -e "process.exit(0)"', required: true } } },
  });
  try {
    gitRepo(ctx.root);
    runGate(ctx, 'lint', { capture: true });
    assert.equal(runGate(ctx, 'lint', { capture: true, cache: false }).cached, false);
  } finally {
    cleanup();
  }

  const bare = tempHarness({ project: { gates: { lint: { run: 'node -e "process.exit(0)"' } } } });
  try {
    bare.ctx.project.gates.lint.required = true;
    runGate(bare.ctx, 'lint', { capture: true });
    assert.equal(runGate(bare.ctx, 'lint', { capture: true }).cached, false, 'no git, no fingerprint, no cache');
  } finally {
    bare.cleanup();
  }
});

test('a scoped gate runs only over the area files, via its declared template', () => {
  const { ctx, cleanup } = tempHarness({
    project: {
      areas: [
        { id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' },
        { id: 'otra', globs: ['other/**'], doc: 'docs/areas/core.md' },
      ],
      gates: { test: { run: 'node -e "process.exit(0)"', run_scoped: 'node -e "console.log({paths})"', required: true } },
    },
  });
  try {
    gitRepo(ctx.root);
    for (const [dir, name] of [['src', 'a.mjs'], ['src', 'b.mjs'], ['other', 'c.mjs']]) {
      fs.mkdirSync(path.join(ctx.root, dir), { recursive: true });
      fs.writeFileSync(path.join(ctx.root, dir, name), '');
    }
    spawnSync('git', ['add', '-A'], { cwd: ctx.root });

    const scoped = runGate(ctx, 'test', { capture: true, scope: 'core', cache: false });
    assert.equal(scoped.scoped, true);
    assert.match(scoped.command, /src\/a\.mjs/);
    assert.match(scoped.command, /src\/b\.mjs/);
    assert.ok(!scoped.command.includes('other/c.mjs'), 'files outside the area must not be included');
  } finally {
    cleanup();
  }
});

test('a gate without a scoped template runs whole rather than checking less in silence', () => {
  const { ctx, cleanup } = tempHarness({
    project: {
      areas: [{ id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' }],
      gates: { test: { run: 'node -e "process.exit(0)"', required: true } },
    },
  });
  try {
    gitRepo(ctx.root);
    const r = runGate(ctx, 'test', { capture: true, scope: 'core', cache: false });
    assert.equal(r.scoped, false, 'it must not pretend to be scoped');
    assert.equal(r.state, 'pass');
    assert.equal(r.command, 'node -e "process.exit(0)"', 'the full command ran');
  } finally {
    cleanup();
  }
});

test('scoping to an unknown area is a usage error, not a silent full run', () => {
  const { ctx, cleanup } = tempHarness({
    project: { gates: { test: { run: 'x', run_scoped: 'y {paths}', required: true } } },
  });
  try {
    gitRepo(ctx.root);
    assert.throws(() => runGate(ctx, 'test', { capture: true, scope: 'inventada', cache: false }), /unknown area/);
  } finally {
    cleanup();
  }
});
