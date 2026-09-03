// Pins the fix for organisation-owned project boards: `user(login:$owner)` only covers half
// the owners a GitHub project can have, and came back "not found" for an organisation. Kept
// in its own file so reverting just this fix fails exactly this file, not the whole suite.

import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_QUERY, discoverProject } from '../.harness/integrations/github/adapter.mjs';
import { withFakeGh } from './helpers.mjs';

test('the discovery query asks repositoryOwner, not user, so it covers organisations', () => {
  assert.match(PROJECT_QUERY, /repositoryOwner/);
  assert.match(PROJECT_QUERY, /ProjectV2Owner/, 'must use the interface both User and Organization implement');
  assert.doesNotMatch(PROJECT_QUERY, /user\(login/, 'the old query only covered a personal account');
});

test('discoverProject resolves a board owned by an organisation', () => {
  const fakeGh = withFakeGh({
    discoverProject: {
      out: {
        data: {
          repositoryOwner: {
            projectV2: {
              id: 'PVT_org1',
              title: 'PlanifAI-EA',
              fields: { nodes: [{ id: 'F_status', name: 'Status', options: [{ id: 'O_backlog', name: 'Backlog' }] }] },
            },
          },
        },
      },
    },
  });
  try {
    const ctx = { root: process.cwd() };
    const ids = discoverProject(ctx, { owner: 'TheNextPangeaSL', number: 1 });
    assert.equal(ids.project_id, 'PVT_org1');
    assert.equal(ids.status_field_id, 'F_status');
    assert.deepEqual(ids.status_options, { Backlog: 'O_backlog' });
  } finally {
    fakeGh.cleanup();
  }
});
