import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MARKER,
  areaFreshness,
  canHoldMarker,
  commitsSince,
  looksLikeTemplate,
  stampVerified,
  summarise,
  verifiedCommit,
} from '../.harness/bin/lib/freshness.mjs';
import { repoCtx, tempHarness } from './helpers.mjs';

/** A temp harness that is a real repo, with one area whose doc has real content. */
function repoWithArea({ docBody = '---\narea: core\nowner: alguien\n---\n\n# Área: core\n\nContenido real.\n' } = {}) {
  const { ctx, cleanup } = tempHarness({
    project: { areas: [{ id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' }] },
  });
  fs.writeFileSync(path.join(ctx.root, 'docs', 'areas', 'core.md'), docBody);
  fs.mkdirSync(path.join(ctx.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'src', 'a.js'), 'export const a = 1;\n');

  const git = (args) => spawnSync('git', args, { cwd: ctx.root, encoding: 'utf8' });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 't@e.com']);
  git(['config', 'user.name', 'T']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'inicial']);
  return { ctx, cleanup, git };
}

test('every area document in this repository declares the commit it was verified against', () => {
  // The mechanism is inert without the marker, so this is the check that keeps it honest.
  // `doctor` is not enough on its own: it exits 0 on warnings.
  const ctx = repoCtx();
  for (const row of areaFreshness(ctx)) {
    assert.ok(row.verified, `${row.doc} no declara ${MARKER}: sella con \`harness doc verified ${row.area}\``);
  }
});

test('a document with no marker is reported as never verified, not as fresh', () => {
  // Reporting it as fresh would be the worst outcome: nothing to act on and a false claim.
  const { ctx, cleanup } = repoWithArea();
  try {
    const [row] = areaFreshness(ctx);
    assert.equal(row.verified, null);
    assert.equal(row.commits, null);
    assert.equal(row.stale, false, 'obsoleto y sin verificar son problemas distintos');
    assert.match(row.reason, /no dice contra qué commit/);
  } finally {
    cleanup();
  }
});

test('stamping records the current commit, and re-stamping replaces it instead of duplicating', () => {
  const { ctx, cleanup, git } = repoWithArea();
  try {
    const first = stampVerified(ctx, 'core');
    assert.equal(first.ok, true);
    assert.equal(verifiedCommit(ctx, 'docs/areas/core.md'), first.commit);

    fs.writeFileSync(path.join(ctx.root, 'src', 'b.js'), 'export const b = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'otro']);

    const second = stampVerified(ctx, 'core');
    assert.notEqual(second.commit, first.commit);
    const text = fs.readFileSync(path.join(ctx.root, 'docs', 'areas', 'core.md'), 'utf8');
    assert.equal(text.match(new RegExp(`^${MARKER}:`, 'gm')).length, 1, 'una sola marca, no dos');
    assert.match(text, /^area: core$/m, 'y el resto del front matter intacto');
  } finally {
    cleanup();
  }
});

test('the warning fires when the area has changed substantially since it was verified', () => {
  const { ctx, cleanup, git } = repoWithArea();
  try {
    stampVerified(ctx, 'core');
    for (let i = 0; i < 4; i += 1) {
      fs.writeFileSync(path.join(ctx.root, 'src', `f${i}.js`), `export const x${i} = ${i};\n`);
      git(['add', '-A']);
      git(['commit', '-q', '-m', `cambio ${i}`]);
    }

    const quiet = areaFreshness(ctx, { threshold: 10 });
    assert.equal(quiet[0].stale, false, 'cuatro commits no pasan un umbral de diez');
    assert.equal(quiet[0].commits, 4);

    const loud = areaFreshness(ctx, { threshold: 2 });
    assert.equal(loud[0].stale, true);
  } finally {
    cleanup();
  }
});

test('commits outside the area do not count against its document', () => {
  // Otherwise every document goes stale whenever anything anywhere is committed, and a
  // warning that always fires is a warning nobody reads.
  const { ctx, cleanup, git } = repoWithArea();
  try {
    stampVerified(ctx, 'core');
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(ctx.root, `fuera-${i}.txt`), 'nada que ver\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', `fuera ${i}`]);
    }
    assert.equal(areaFreshness(ctx)[0].commits, 0);
  } finally {
    cleanup();
  }
});

test('a commit that is no longer in the history is unknown, never zero', () => {
  // Zero reads as "nothing changed", which is the opposite of what an unresolvable commit
  // means: it means nobody can tell.
  const { ctx, cleanup } = repoWithArea();
  try {
    const { count, reason } = commitsSince(ctx, ['src/**'], 'deadbeefdeadbeef');
    assert.equal(count, null);
    assert.match(reason, /ya no está en el historial/);
  } finally {
    cleanup();
  }
});

test('the warning names the command that fixes it, not just the problem', () => {
  // A warning that only says "this may be stale" leaves somebody to work out both what to
  // read and how to record that they read it, and the second half is what nobody guesses.
  const { ctx, cleanup } = repoWithArea();
  try {
    const [row] = areaFreshness(ctx);
    assert.match(row.action, /harness doc verified core/);
    assert.match(row.action, /git log/, 'y qué mirar para verificarlo');
    assert.match(row.action, /src/, 'acotado a los ficheros del área');
  } finally {
    cleanup();
  }
});

test('an untouched template is a starting condition, not a defect', () => {
  // A brand new project going red on day one teaches everybody to ignore the self-check.
  const { ctx, cleanup } = repoWithArea({
    docBody: '---\narea: <id>\nupdated: AAAA-MM-DD\nowner: <persona o equipo>\n---\n\n# Área: <nombre>\n',
  });
  try {
    assert.equal(looksLikeTemplate(ctx, 'docs/areas/core.md'), true);
    assert.equal(areaFreshness(ctx)[0].template, true);
  } finally {
    cleanup();
  }
});

test('the report separates never-verified from gone-stale, because the fix differs', () => {
  const rows = [
    { area: 'a', verified: null, commits: null, stale: false },
    { area: 'b', verified: 'abc1234', commits: 40, stale: true },
    { area: 'c', verified: 'def5678', commits: 2, stale: false },
    { area: 'd', verified: 'aaa1111', commits: null, stale: false },
  ];
  const g = summarise(rows);
  assert.deepEqual(g.never.map((r) => r.area), ['a']);
  assert.deepEqual(g.stale.map((r) => r.area), ['b']);
  assert.deepEqual(g.fresh.map((r) => r.area), ['c']);
  assert.deepEqual(g.unresolvable.map((r) => r.area), ['d'], 'el primero necesita una lectura; el segundo, un diff');
});

test('a document with no front matter cannot hold the marker, and is not asked to', () => {
  // Demanding a marker where there is nowhere to put one is a check nobody can satisfy,
  // which is worse than no check: it trains people to ignore the output.
  const { ctx, cleanup } = repoWithArea({ docBody: '# core\n\nSin front matter.\n' });
  try {
    assert.equal(canHoldMarker(ctx, 'docs/areas/core.md'), false);
    assert.equal(areaFreshness(ctx)[0].stampable, false);
    assert.equal(stampVerified(ctx, 'core').ok, false, 'y sellarlo falla diciendo por qué');
    assert.match(stampVerified(ctx, 'core').reason, /front matter/);
  } finally {
    cleanup();
  }
});

test('stamping an area that is not declared is refused by name', () => {
  const { ctx, cleanup } = repoWithArea();
  try {
    const r = stampVerified(ctx, 'inventada');
    assert.equal(r.ok, false);
    assert.match(r.reason, /no es un área declarada/);
  } finally {
    cleanup();
  }
});
