import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readHandoff, resumeStage, validateHandoff, writeHandoff } from '../.harness/bin/lib/workspace.mjs';
import { makeTask, repoCtx, tempHarness } from './helpers.mjs';

function withSchema() {
  const { ctx, cleanup } = tempHarness({ tasks: [makeTask()] });
  fs.copyFileSync(
    path.join(repoCtx().harnessDir, 'schema', 'handoff.schema.json'),
    path.join(ctx.harnessDir, 'schema', 'handoff.schema.json'),
  );
  return { ctx, cleanup };
}

const VALID = {
  task: 'FEAT-0001',
  stage: 'implemented',
  by: 'implementer',
  at: '2026-08-20T00:00:00Z',
  summary: 'Endpoint y servicio de tokens, con cuatro tests.',
};

test('a well-formed handoff validates', () => {
  const { ctx, cleanup } = withSchema();
  try {
    assert.deepEqual(validateHandoff(ctx, VALID), []);
  } finally {
    cleanup();
  }
});

test('an invented stage is rejected, because /implement skips work based on it', () => {
  const { ctx, cleanup } = withSchema();
  try {
    const errors = validateHandoff(ctx, { ...VALID, stage: 'casi-terminado' });
    assert.ok(errors.some((e) => e.path === 'stage'));
  } finally {
    cleanup();
  }
});

test('a summary too short to be useful is rejected', () => {
  const { ctx, cleanup } = withSchema();
  try {
    assert.ok(validateHandoff(ctx, { ...VALID, summary: 'listo' }).length > 0);
  } finally {
    cleanup();
  }
});

test('writing an invalid handoff is refused rather than saved', () => {
  const { ctx, cleanup } = withSchema();
  try {
    assert.throws(
      () => writeHandoff(ctx, 'FEAT-0001', { stage: 'inventada', summary: 'Suficientemente largo aqui.' }),
      /refusing to write an invalid handoff/,
    );
    assert.ok(!fs.existsSync(path.join(ctx.harnessDir, 'workspace', 'FEAT-0001', 'handoff.json')));
  } finally {
    cleanup();
  }
});

test('writing merges into what was already there and stamps the time', () => {
  const { ctx, cleanup } = withSchema();
  try {
    writeHandoff(ctx, 'FEAT-0001', { stage: 'claimed', by: 'implementer', summary: 'Rama creada y tarea reclamada.', branch: 'feat/0001-x' });
    const second = writeHandoff(ctx, 'FEAT-0001', { stage: 'implemented', summary: 'Implementado con cuatro tests nuevos.' });
    assert.equal(second.stage, 'implemented');
    assert.equal(second.branch, 'feat/0001-x', 'earlier fields survive');
    assert.equal(second.by, 'implementer');
    assert.ok(second.at);
  } finally {
    cleanup();
  }
});

test('a handoff living in the wrong workspace is caught', () => {
  const { ctx, cleanup } = withSchema();
  try {
    const dir = path.join(ctx.harnessDir, 'workspace', 'FEAT-0001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'handoff.json'), JSON.stringify({ ...VALID, task: 'FIX-0009' }));
    const { errors } = readHandoff(ctx, 'FEAT-0001');
    assert.ok(errors.some((e) => /lives in the workspace of/.test(e.message)));
  } finally {
    cleanup();
  }
});

test('no handoff means start from the beginning, which is not an error', () => {
  const { ctx, cleanup } = withSchema();
  try {
    const r = resumeStage(ctx, 'FEAT-0001');
    assert.equal(r.stage, null);
    assert.equal(r.invalid, undefined);
    assert.match(r.reason, /start from the beginning/);
  } finally {
    cleanup();
  }
});

test('a broken handoff refuses to yield a stage instead of guessing one', () => {
  // The dangerous fallback would be "assume the earliest stage": it converts a broken
  // handoff into silently redone work and hides the breakage.
  const { ctx, cleanup } = withSchema();
  try {
    const dir = path.join(ctx.harnessDir, 'workspace', 'FEAT-0001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'handoff.json'), '{ esto no es json');
    const r = resumeStage(ctx, 'FEAT-0001');
    assert.equal(r.invalid, true);
    assert.equal(r.stage, null);
    assert.ok(r.errors.length > 0);
  } finally {
    cleanup();
  }
});

test('red gates are recordable, because an unknown test status is worse than a red one', () => {
  const { ctx, cleanup } = withSchema();
  try {
    const written = writeHandoff(ctx, 'FEAT-0001', {
      stage: 'implemented',
      by: 'implementer',
      summary: 'Implementado, pero la suite esta en rojo por el caso vacio.',
      gates: { lint: 'pass', test: 'fail', typecheck: 'skipped' },
      acceptance: [{ id: 'AC1', status: 'fail', evidence: 'assert falla con lista vacia' }],
      blockers: ['el caso vacio no estaba en los criterios'],
    });
    assert.equal(written.gates.test, 'fail');
    assert.equal(written.acceptance[0].status, 'fail');
  } finally {
    cleanup();
  }
});
