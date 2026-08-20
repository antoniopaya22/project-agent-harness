import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  AS_IS,
  availableLayouts,
  detectLayout,
  isMovable,
  layoutProblems,
  loadLayout,
  referenceTargets,
  resolveTargetPath,
  summarise,
} from '../.harness/bin/lib/layouts.mjs';
import { repoCtx, tempHarness } from './helpers.mjs';

const ctx = repoCtx();

test('profiles exist for Python and for Node, each with a target structure', () => {
  const available = availableLayouts(ctx);
  assert.ok(available.includes('python'));
  assert.ok(available.includes('node-ts'));
  for (const id of available) {
    const layout = loadLayout(ctx, id);
    assert.deepEqual(layoutProblems(layout), [], `${id} is malformed`);
    assert.ok(layout.target.length > 0);
    assert.ok(layout.moves.length > 0);
    assert.ok(layout.never_move.length > 0, `${id} declares nothing as untouchable`);
  }
});

test('as-is disables movement entirely, and is a first-class value', () => {
  assert.equal(loadLayout(ctx, AS_IS), null);
  assert.equal(isMovable(null, 'src/anything.py'), false, 'nothing is movable with no profile');
  assert.match(summarise(null), /no file will be moved/);
});

test('a project that declares as-is gets no profile', () => {
  const { ctx: temp, cleanup } = tempHarness({ project: { layout: AS_IS } });
  try {
    fs.mkdirSync(path.join(temp.harnessDir, 'layouts'), { recursive: true });
    assert.equal(loadLayout(temp), null);
  } finally {
    cleanup();
  }
});

test('an unknown profile is a usage error listing what is available', () => {
  assert.throws(() => loadLayout(ctx, 'cobol'), /unknown layout "cobol"/);
  assert.throws(() => loadLayout(ctx, 'cobol'), /python/);
  assert.throws(() => loadLayout(ctx, 'cobol'), /as-is/);
});

test('a malformed profile fails loudly instead of half-moving a project', () => {
  assert.deepEqual(layoutProblems(null), ['not an object']);
  assert.ok(layoutProblems({ id: 'x' }).includes('no target structure'));
  assert.ok(layoutProblems({ id: 'x', target: [{ role: 'src' }], moves: [], reference_rewrites: [], never_move: [] })
    .some((p) => /has no path/.test(p)));
  assert.ok(
    layoutProblems({
      id: 'x',
      target: [{ role: 'src', path: 'src' }],
      moves: [{ when: 'algo', to: 'src/', risk: 'enorme' }],
      reference_rewrites: [],
      never_move: [],
    }).some((p) => /declares risk "enorme"/.test(p)),
    'an unrecognised risk level must not pass',
  );
});

test('every declared move carries a risk level, because the caller has to decide', () => {
  for (const id of availableLayouts(ctx)) {
    for (const move of loadLayout(ctx, id).moves) {
      assert.ok(['low', 'medium', 'high'].includes(move.risk), `${id}/${move.when} has risk "${move.risk}"`);
    }
  }
});

test('never_move covers the things a test suite would not catch breaking', () => {
  const python = loadLayout(ctx, 'python');
  for (const pattern of ['migrations/**', 'conftest.py', 'manage.py']) {
    assert.ok(python.never_move.includes(pattern), `python profile allows moving ${pattern}`);
  }
  assert.equal(isMovable(python, 'migrations/0001_inicial.py'), false);
  assert.equal(isMovable(python, 'conftest.py'), false);
  assert.equal(isMovable(python, 'src/app/main.py'), true);

  const node = loadLayout(ctx, 'node-ts');
  assert.equal(isMovable(node, 'dist/bundle.js'), false, 'build output is not source');
  assert.equal(isMovable(node, 'src/index.ts'), true);
});

test('the profile lists the config families a move must fix up', () => {
  const targets = referenceTargets(loadLayout(ctx, 'python'));
  const files = targets.map((t) => t.file);
  for (const expected of ['pyproject.toml', 'Dockerfile', 'MANIFEST.in']) {
    assert.ok(files.includes(expected), `${expected} is not in the rewrite list`);
  }
  assert.ok(targets.every((t) => Array.isArray(t.keys)));
  assert.deepEqual(referenceTargets(null), [], 'as-is rewrites nothing');
});

test('placeholders resolve, and an unresolved one stays visible', () => {
  assert.equal(resolveTargetPath('src/{package}', { package: 'miapp' }), 'src/miapp');
  assert.equal(resolveTargetPath('src/{package}', {}), 'src/{package}', 'a blank would move files to the root');
});

test('the profile is detected from evidence, and absent evidence means as-is', () => {
  const { ctx: temp, cleanup } = tempHarness();
  try {
    fs.cpSync(path.join(ctx.harnessDir, 'layouts'), path.join(temp.harnessDir, 'layouts'), { recursive: true });
    assert.equal(detectLayout(temp, temp.root), AS_IS, 'an empty directory declares nothing');

    fs.writeFileSync(path.join(temp.root, 'pyproject.toml'), '[tool.ruff]\n');
    assert.equal(detectLayout(temp, temp.root), 'python');
  } finally {
    cleanup();
  }
});
