import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { planNeedsHumanReview, readPlan } from '../.harness/bin/lib/workspace.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

function withPlan(frontMatter) {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  if (frontMatter !== null) {
    const dir = path.join(ctx.harnessDir, 'workspace', 'FEAT-0001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.md'), `${frontMatter}\n\n# Plan\n\nPasos.\n`);
  }
  return { ctx, cleanup };
}

test('a low-risk plan lets implementation proceed', () => {
  const { ctx, cleanup } = withPlan('---\nrisk: low\nareas: [core]\n---');
  try {
    const v = planNeedsHumanReview(ctx, 'FEAT-0001');
    assert.equal(v.stop, false);
    assert.equal(v.risk, 'low');
  } finally {
    cleanup();
  }
});

test('a high-risk plan stops for a human', () => {
  const { ctx, cleanup } = withPlan('---\nrisk: high\nareas: [core]\n---');
  try {
    const v = planNeedsHumanReview(ctx, 'FEAT-0001');
    assert.equal(v.stop, true);
    assert.ok(v.reasons.some((r) => /risk: high/.test(r)));
  } finally {
    cleanup();
  }
});

test('unassessed risk counts as high, so the checkpoint cannot be skipped by omission', () => {
  // While this lived only in a prompt, a plan with no risk field simply carried on. That
  // made the checkpoint decorative.
  const { ctx, cleanup } = withPlan('---\nareas: [core]\n---');
  try {
    const v = planNeedsHumanReview(ctx, 'FEAT-0001');
    assert.equal(v.stop, true);
    assert.ok(v.reasons.some((r) => /no `risk`/.test(r)));
    assert.ok(v.reasons.some((r) => /unassessed risk is treated as high/.test(r)));
  } finally {
    cleanup();
  }
});

test('an invented risk level is not silently accepted', () => {
  const { ctx, cleanup } = withPlan('---\nrisk: medio-alto\n---');
  try {
    const v = planNeedsHumanReview(ctx, 'FEAT-0001');
    assert.equal(v.stop, true);
    assert.ok(v.reasons.some((r) => /expected one of/.test(r)));
  } finally {
    cleanup();
  }
});

test('a plan crossing more than one area stops, even when it claims low risk', () => {
  const { ctx, cleanup } = withPlan('---\nrisk: low\nareas: [core, otra, tercera]\n---');
  try {
    const v = planNeedsHumanReview(ctx, 'FEAT-0001');
    assert.equal(v.stop, true);
    assert.ok(v.reasons.some((r) => /touches 3 areas/.test(r)));
  } finally {
    cleanup();
  }
});

test('no plan at all is not a checkpoint: it is work to do', () => {
  // Running the choreography by hand showed why these must not share an exit code. An
  // agent that reads "no plan" as a checkpoint stops to ask permission when what it should
  // do is go and write the plan.
  const { ctx, cleanup } = withPlan(null);
  try {
    const v = planNeedsHumanReview(ctx, 'FEAT-0001');
    assert.equal(v.missing, true);
    assert.equal(v.stop, false, 'nothing to confirm yet');
    assert.ok(v.reasons.some((r) => /write one/.test(r)));
  } finally {
    cleanup();
  }
});

test('the plan reader reports its problems instead of throwing', () => {
  const { ctx, cleanup } = withPlan('---\nrisk: low\n---');
  try {
    const plan = readPlan(ctx, 'FEAT-0001');
    assert.equal(plan.exists, true);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.areas, []);
  } finally {
    cleanup();
  }
});

test('risk is case-insensitive, because a plan is written by hand', () => {
  const { ctx, cleanup } = withPlan('---\nrisk: HIGH\n---');
  try {
    assert.equal(planNeedsHumanReview(ctx, 'FEAT-0001').risk, 'high');
  } finally {
    cleanup();
  }
});
