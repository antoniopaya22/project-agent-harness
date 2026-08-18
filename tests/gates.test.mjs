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
