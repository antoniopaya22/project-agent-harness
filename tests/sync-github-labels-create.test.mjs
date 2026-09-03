// Pins the fix for labels that never arrived on a new repository: `gh issue create --label X`
// (and its fallback `issue edit --add-label X`) fail outright if X does not exist yet, and
// the fallback's failure was swallowed by allowFail — so a brand-new repo got zero labels,
// silently, forever. The fix lists what exists and creates what is missing before either call.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureLabels } from '../.harness/integrations/github/adapter.mjs';
import { withFakeGh } from './helpers.mjs';

test('missing labels are created up front; existing ones are left alone and never recreated', () => {
  const fakeGh = withFakeGh({ 'label list': { out: [{ name: 'ya-existe' }] } });
  try {
    const ctx = { root: process.cwd() };
    ensureLabels(ctx, ['ya-existe', 'type:feature']);
    // A second call, partly overlapping: type:feature must not be created twice.
    ensureLabels(ctx, ['type:feature', 'priority:high']);

    const created = fakeGh.calls().filter((a) => a[0] === 'label' && a[1] === 'create').map((a) => a[2]);
    assert.deepEqual(created, ['type:feature', 'priority:high']);
  } finally {
    fakeGh.cleanup();
  }
});
