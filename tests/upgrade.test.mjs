import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MIGRATIONS,
  compareVersions,
  parseVersion,
  pending,
  upgrade,
  versions,
} from '../.harness/bin/lib/upgrade.mjs';
import { HARNESS_VERSION } from '../.harness/bin/lib/util.mjs';
import { repoCtx, tempHarness } from './helpers.mjs';

/** A project stuck on an older version, with the keys that version did not have. */
function oldProject(version = '1.0.0') {
  const { ctx, cleanup } = tempHarness({ project: { harness_version: version } });
  const configPath = path.join(ctx.harnessDir, 'project.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete config.hooks;
  delete config.doc_freshness_threshold;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  ctx.project = config;
  return { ctx, cleanup, configPath };
}

test('versions are compared as numbers, not as strings', () => {
  // '1.10.0' < '1.9.0' as strings, which would skip a migration and leave a project on a
  // config the code no longer understands.
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.deepEqual(parseVersion('1.2.3-beta'), [1, 2, 3]);
  assert.equal(parseVersion('no es una versión'), null);
});

test('a migration applies, and applying it twice is applying it once', () => {
  // The second run always happens: after an interrupted upgrade, after a merge, or because
  // somebody ran it again just in case. A migration that appends corrupts on that run.
  const { ctx, cleanup, configPath } = oldProject();
  try {
    const first = upgrade(ctx, { target: '1.1.0' });
    assert.equal(first.from, '1.0.0');
    assert.ok(first.applied.some((a) => a.changed), 'la primera vez sí hace algo');

    const afterFirst = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(afterFirst);
    assert.deepEqual(config.hooks, { enabled: true });
    assert.equal(config.doc_freshness_threshold, 15);
    assert.equal(config.harness_version, '1.1.0');

    ctx.project = config;
    const second = upgrade(ctx, { target: '1.1.0' });
    assert.equal(second.upToDate, true, 'la segunda no tiene nada que hacer');
    assert.equal(fs.readFileSync(configPath, 'utf8'), afterFirst, 'y el fichero no cambia ni un byte');
  } finally {
    cleanup();
  }
});

test('a deliberate choice is not overwritten by the migration that introduced the key', () => {
  // Absent means "never configured"; `false` means somebody turned it off. Treating the two
  // the same would silently re-enable something a project decided against.
  const { ctx, cleanup, configPath } = oldProject();
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.hooks = { enabled: false };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    ctx.project = config;

    upgrade(ctx, { target: '1.1.0' });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks, { enabled: false });
  } finally {
    cleanup();
  }
});

test('what the migration cannot do itself is reported, not guessed', () => {
  const { ctx, cleanup } = oldProject();
  try {
    // The fixture's area doc has no verification marker, and no migration can read a
    // document against the code on somebody's behalf.
    const result = upgrade(ctx, { target: '1.1.0' });
    assert.ok(result.manual.some((m) => /harness doc verified core/.test(m)));
  } finally {
    cleanup();
  }
});

test('a project already up to date is left alone', () => {
  const { ctx, cleanup } = tempHarness({ project: { harness_version: HARNESS_VERSION } });
  try {
    const before = fs.readFileSync(path.join(ctx.harnessDir, 'project.json'), 'utf8');
    const result = upgrade(ctx);
    assert.equal(result.upToDate, true);
    assert.equal(fs.readFileSync(path.join(ctx.harnessDir, 'project.json'), 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('a project ahead of the CLI is refused, never downgraded', () => {
  // Somebody pulled a branch, or their shims are stale. Rewriting their config to an older
  // version in silence would be the worst possible response.
  const { ctx, cleanup } = tempHarness({ project: { harness_version: '99.0.0' } });
  try {
    const before = fs.readFileSync(path.join(ctx.harnessDir, 'project.json'), 'utf8');
    const result = upgrade(ctx);
    assert.equal(result.ahead, true);
    assert.deepEqual(result.applied, []);
    assert.equal(fs.readFileSync(path.join(ctx.harnessDir, 'project.json'), 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('--dry-run says what would happen and writes nothing', () => {
  const { ctx, cleanup, configPath } = oldProject();
  try {
    const before = fs.readFileSync(configPath, 'utf8');
    const result = upgrade(ctx, { dryRun: true, target: '1.1.0' });
    assert.ok(result.applied.length > 0);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('migrations are declared in order and none targets a version the CLI does not have', () => {
  // Migration 3 assumes 2 ran, so the order in the list is the order they apply.
  for (let i = 1; i < MIGRATIONS.length; i += 1) {
    assert.equal(compareVersions(MIGRATIONS[i - 1].to, MIGRATIONS[i].to), -1, 'en orden ascendente');
  }
  for (const m of MIGRATIONS) {
    assert.ok(compareVersions(m.to, HARNESS_VERSION) <= 0, `${m.to} es posterior al CLI (${HARNESS_VERSION})`);
    assert.ok(m.title, 'cada migración dice qué hace');
  }
});

test('this repository is on the version its CLI declares, with nothing pending', () => {
  const v = versions(repoCtx());
  assert.equal(v.project, v.cli);
  assert.deepEqual(v.pending, []);
});

test('a project two versions behind gets every migration in between', () => {
  const behind = pending('0.9.0', { target: HARNESS_VERSION });
  assert.equal(behind.length, MIGRATIONS.length);
  assert.deepEqual(pending(HARNESS_VERSION), []);
});
