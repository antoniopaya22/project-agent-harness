import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../.harness/bin/lib/doctor.mjs';
import * as generate from '../.harness/bin/lib/generate.mjs';
import { AGENT_FIXTURE, COMMAND_FIXTURE, tempHarness } from './helpers.mjs';

function generated() {
  const { ctx, cleanup } = tempHarness({
    agents: [{ id: 'worker', content: AGENT_FIXTURE }],
    commands: [{ id: 'do-thing', content: COMMAND_FIXTURE }],
    project: { providers: { claude: true, agents_md: true } },
  });
  fs.writeFileSync(path.join(ctx.harnessDir, 'ENTRYPOINT.md'), '# reglas\n');
  generate.apply(ctx);
  return { ctx, cleanup };
}

const orphans = (ctx) => runDoctor(ctx).issues.filter((i) => i.check === 'orphans');

test('a freshly generated tree has no orphans', () => {
  const { ctx, cleanup } = generated();
  try {
    assert.deepEqual(orphans(ctx), []);
  } finally {
    cleanup();
  }
});

test('a generated file whose source vanished is an error', () => {
  // Deleting or re-identifying an agent leaves its old projection behind for ever.
  // `generate` does not delete, so a ghost role stays available to the provider with nobody
  // maintaining it.
  const { ctx, cleanup } = generated();
  try {
    fs.rmSync(path.join(ctx.harnessDir, 'agents', 'worker.md'));
    const found = orphans(ctx);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /agents\/worker\.md/);
    assert.match(found[0].message, /renamed or deleted/, 'and it says why');
  } finally {
    cleanup();
  }
});

test('renaming only the file is not an orphan, because the id decides the output name', () => {
  const { ctx, cleanup } = generated();
  try {
    fs.renameSync(
      path.join(ctx.harnessDir, 'agents', 'worker.md'),
      path.join(ctx.harnessDir, 'agents', 'obrero.md'),
    );
    generate.apply(ctx);
    assert.deepEqual(orphans(ctx), [], 'the front matter id still says worker, so the projection is unchanged');
  } finally {
    cleanup();
  }
});

test('an orphan runbook is caught too, not only an agent', () => {
  const { ctx, cleanup } = generated();
  try {
    fs.writeFileSync(path.join(ctx.root, 'docs', 'runbooks', 'inventado.md'), '# fantasma\n');
    assert.ok(orphans(ctx).some((i) => /inventado\.md/.test(i.message)));
  } finally {
    cleanup();
  }
});

test('--fix removes the orphans, and only the orphans', () => {
  const { ctx, cleanup } = generated();
  try {
    const ghost = path.join(ctx.root, '.claude', 'agents', 'fantasma.md');
    const real = path.join(ctx.root, '.claude', 'agents', 'worker.md');
    fs.copyFileSync(real, ghost);

    const { fixed } = runDoctor(ctx, { fix: true });
    assert.ok(fixed.some((f) => /fantasma\.md/.test(f)));
    assert.ok(!fs.existsSync(ghost), 'the orphan is gone');
    assert.ok(fs.existsSync(real), 'and the real one is untouched');
    assert.deepEqual(orphans(ctx), []);
  } finally {
    cleanup();
  }
});

test('a hand-written file outside the generated directories is never touched', () => {
  const { ctx, cleanup } = generated();
  try {
    const mine = path.join(ctx.root, 'docs', 'MIO.md');
    fs.writeFileSync(mine, 'contenido propio');
    runDoctor(ctx, { fix: true });
    assert.equal(fs.readFileSync(mine, 'utf8'), 'contenido propio');
    assert.deepEqual(orphans(ctx), [], 'and it is not reported either');
  } finally {
    cleanup();
  }
});

test('a provider turned off does not make its previous output an orphan by surprise', () => {
  // Turning claude off stops producing .claude/**, so those files *are* orphans now. The
  // check must say so rather than leaving a stale instruction set in place.
  const { ctx, cleanup } = generated();
  try {
    ctx.project.providers.claude = false;
    const found = orphans(ctx);
    assert.ok(found.length > 0);
    assert.ok(found.every((i) => i.message.includes('.claude/')), 'only the disabled provider output');
  } finally {
    cleanup();
  }
});
