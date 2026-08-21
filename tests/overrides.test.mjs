import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as generate from '../.harness/bin/lib/generate.mjs';
import { AGENT_FIXTURE, COMMAND_FIXTURE, REPO, tempHarness } from './helpers.mjs';

function fixture(project = {}) {
  return tempHarness({
    agents: [{ id: 'worker', content: AGENT_FIXTURE }],
    commands: [{ id: 'do-thing', content: COMMAND_FIXTURE }],
    project: { providers: { claude: true, agents_md: true }, ...project },
  });
}

test('a kept region survives regeneration, in the same place', () => {
  // Without this the escape hatch does not exist: anything a project needs and the generator
  // does not know about is destroyed on the next `harness generate`, so people stop running it.
  const { ctx, cleanup } = fixture();
  try {
    generate.apply(ctx);
    const file = path.join(ctx.root, 'CLAUDE.md');
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${before}\n<!-- harness:keep -->\nUna nota que debe sobrevivir.\n<!-- /harness:keep -->\n`);

    generate.apply(ctx);
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /Una nota que debe sobrevivir\./);
    assert.equal((after.match(/harness:keep/g) || []).length, 2, 'una sola región, no dos');
  } finally {
    cleanup();
  }
});

test('a kept region survives many regenerations without accumulating', () => {
  // The interesting failure is not the first regeneration but the tenth: a naive
  // implementation appends the region again each time and nobody notices until the file
  // doubles in size.
  const { ctx, cleanup } = fixture();
  try {
    generate.apply(ctx);
    const file = path.join(ctx.root, 'CLAUDE.md');
    fs.writeFileSync(
      file,
      `${fs.readFileSync(file, 'utf8')}\n<!-- harness:keep -->\nresiste\n<!-- /harness:keep -->\n`,
    );
    for (let i = 0; i < 5; i += 1) generate.apply(ctx);

    const after = fs.readFileSync(file, 'utf8');
    assert.equal((after.match(/resiste/g) || []).length, 1);
    assert.equal((after.match(/harness:keep/g) || []).length, 2);
  } finally {
    cleanup();
  }
});

test('the canonical content still wins outside the kept region', () => {
  // The hatch is for what the generator does not know about, not a way to overrule it. An
  // edit outside the region is drift and must be reverted, or the whole projection is advisory.
  const { ctx, cleanup } = fixture();
  try {
    generate.apply(ctx);
    const file = path.join(ctx.root, 'CLAUDE.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('harness v', 'ARNÉS v'));
    assert.equal(generate.check(ctx).drifted.length, 1, 'la deriva se detecta');

    generate.apply(ctx);
    assert.match(fs.readFileSync(file, 'utf8'), /harness v/);
    assert.deepEqual(generate.check(ctx), { drifted: [], missing: [] });
  } finally {
    cleanup();
  }
});

test('an override file is copied verbatim, and the generator does not touch it', () => {
  const { ctx, cleanup } = fixture();
  try {
    const overrideDir = path.join(ctx.harnessDir, 'overrides', 'claude', '.claude');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, 'local.md'), 'Algo muy específico de este proyecto.\n');

    const item = generate.plan(ctx).find((f) => f.path.includes('local.md'));
    assert.ok(item, 'la anulación entra en el plan');
    assert.equal(item.content, 'Algo muy específico de este proyecto.\n', 'literal, sin cabecera ni plantillas');

    generate.apply(ctx);
    assert.equal(
      fs.readFileSync(path.join(ctx.root, '.claude', 'local.md'), 'utf8'),
      'Algo muy específico de este proyecto.\n',
    );
  } finally {
    cleanup();
  }
});

test('an override wins over a generated file of the same name, because it comes last', () => {
  // Order is the whole mechanism, and it is worth a test: if overrides were merged first, the
  // generated content would silently win and the hatch would appear to do nothing.
  const { ctx, cleanup } = fixture();
  try {
    const overrideDir = path.join(ctx.harnessDir, 'overrides', 'claude');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, 'CLAUDE.md'), 'El mío manda.\n');

    const items = generate.plan(ctx).filter((f) => f.path === 'CLAUDE.md');
    assert.equal(items.length, 2, 'el generado y la anulación');
    assert.equal(items[items.length - 1].content, 'El mío manda.\n', 'la anulación es la última');

    generate.apply(ctx);
    assert.equal(fs.readFileSync(path.join(ctx.root, 'CLAUDE.md'), 'utf8'), 'El mío manda.\n');
  } finally {
    cleanup();
  }
});

test('a provider turned off does not get its overrides either... except it does', () => {
  // Recording real behaviour rather than what would be tidy: overrides are merged for every
  // directory under .harness/overrides/, regardless of whether that provider is enabled. The
  // directory name is not checked against the provider flags.
  //
  // Left as-is deliberately. An override is something a human put there on purpose, and
  // silently dropping it because a flag is false would be the more surprising behaviour of
  // the two. Documented here so nobody "fixes" it by accident.
  const { ctx, cleanup } = fixture({ providers: { claude: false, agents_md: true } });
  try {
    const overrideDir = path.join(ctx.harnessDir, 'overrides', 'claude');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, 'suyo.md'), 'x\n');

    const paths = generate.plan(ctx).map((f) => f.path);
    assert.ok(!paths.includes('CLAUDE.md'), 'el proveedor está apagado');
    assert.ok(paths.includes('suyo.md'), 'y su anulación sigue copiándose');
  } finally {
    cleanup();
  }
});

test('an unterminated keep region is not treated as a region', () => {
  // Otherwise an open marker would swallow the rest of the file into "keep" and freeze the
  // generated content from that point on, which is invisible until something goes stale.
  const { ctx, cleanup } = fixture();
  try {
    generate.apply(ctx);
    const file = path.join(ctx.root, 'CLAUDE.md');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n<!-- harness:keep -->\nsin cerrar\n`);

    generate.apply(ctx);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(!/sin cerrar/.test(after), 'una región sin cerrar no conserva nada');
  } finally {
    cleanup();
  }
});

test('the capability matrix is published, and says what it has not verified', () => {
  // The point of the document is that it can be trusted. Half-remembered syntax produces an
  // adapter that looks like it works and fails silently, which is worse than no adapter.
  const body = fs.readFileSync(path.join(REPO, 'docs', 'PROVIDERS.md'), 'utf8');

  for (const provider of ['Claude Code', 'Cursor', 'Copilot', 'AGENTS.md']) {
    assert.ok(body.includes(provider), `${provider} no aparece en la matriz`);
  }
  // The verified specifics, each of which a wrong guess would have got wrong.
  assert.match(body, /\.cursor\/rules/);
  assert.match(body, /\.mdc/);
  assert.match(body, /alwaysApply/);
  assert.match(body, /\.github\/copilot-instructions\.md/);
  assert.match(body, /applyTo/);
  assert.match(body, /\.instructions\.md/);

  assert.match(body, /\[SIN VERIFICAR\]/, 'y lo que no está confirmado va marcado');
  assert.match(body, /cursor\.com\/docs\/rules/, 'con la fuente oficial');
  assert.match(body, /docs\.github\.com/);
});
