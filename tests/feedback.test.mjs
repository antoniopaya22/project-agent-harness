import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { aggregate, diagnose, logFile, readLog, record, unexpected } from '../.harness/bin/lib/feedback.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

const PROJECT = {
  areas: [
    { id: 'api', globs: ['src/api/**'], doc: 'docs/areas/api.md' },
    { id: 'web', globs: ['src/web/**'], doc: 'docs/areas/web.md' },
  ],
  read_path: [{ path: '.harness/ENTRYPOINT.md', max_tokens: 1800 }],
};

test('only the readings the task failed to predict are recorded', () => {
  // Recording the ones it did name would drown the signal in the part that already worked.
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    const task = makeTask({
      context: { area: 'api', docs: ['docs/decisiones.md'], files: ['src/api/users.js'], out_of_scope: [] },
    });
    const beyond = unexpected(ctx, task, [
      'src/api/users.js',
      'docs/decisiones.md',
      'docs/areas/api.md',
      '.harness/ENTRYPOINT.md',
      'src/api/auth.js',
    ]);
    assert.deepEqual(beyond, ['src/api/auth.js']);
  } finally {
    cleanup();
  }
});

test('the log survives on disk, append-only, with the task and the area on every row', () => {
  // Two agents in two worktrees both append, and neither has to read the file first.
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    record(ctx, 'FEAT-0001', ['src/api/auth.js'], { area: 'api' });
    record(ctx, 'FEAT-0002', ['src/api/auth.js'], { area: 'api', note: 'el token no está documentado' });

    const rows = readLog(ctx);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].task, 'FEAT-0001');
    assert.equal(rows[1].note, 'el token no está documentado');
    for (const r of rows) assert.ok(r.at, 'cada lectura lleva cuándo fue');
  } finally {
    cleanup();
  }
});

test('a corrupt line is skipped instead of losing the whole history', () => {
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    record(ctx, 'FEAT-0001', ['src/api/a.js'], { area: 'api' });
    fs.appendFileSync(logFile(ctx), '{ esto no es json\n');
    record(ctx, 'FEAT-0002', ['src/api/b.js'], { area: 'api' });
    assert.equal(readLog(ctx).length, 2);
  } finally {
    cleanup();
  }
});

test('the same file read from several tasks means the area document is missing something', () => {
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    for (const id of ['FEAT-0001', 'FEAT-0002', 'FEAT-0003']) {
      record(ctx, id, ['src/api/auth.js'], { area: 'api' });
    }
    const report = aggregate(ctx);
    const api = report.areas.find((a) => a.area === 'api');
    assert.equal(api.tasks, 3);
    assert.equal(api.verdict, 'documentacion-insuficiente');
    assert.equal(api.repeated[0].file, 'src/api/auth.js');

    const findings = diagnose(report);
    assert.equal(findings[0].kind, 'documentacion-insuficiente');
    assert.match(findings[0].action, /docs\/areas\/api\.md/, 'y dice qué documento arreglar');
    assert.match(findings[0].action, /harness doc verified api/, 'y cómo sellarlo después');
  } finally {
    cleanup();
  }
});

test('many scattered files from one task means that task was under-groomed', () => {
  // The distinction decides what to fix: rewriting a document when one task was never
  // refined fixes nothing, and the reverse leaves everybody paying for the same gap.
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    record(ctx, 'FEAT-0009', ['src/api/a.js', 'src/api/b.js', 'src/api/c.js', 'src/web/d.js', 'src/web/e.js'], {});
    const report = aggregate(ctx);
    const findings = diagnose(report);

    assert.ok(findings.some((f) => f.kind === 'tarea-mal-refinada' && f.subject === 'FEAT-0009'));
    assert.ok(!findings.some((f) => f.kind === 'documentacion-insuficiente'), 'una sola tarea no acusa a un documento');
  } finally {
    cleanup();
  }
});

test('a reading is attributed to an area even when the caller did not say which', () => {
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    record(ctx, 'FEAT-0001', ['src/web/page.js'], {});
    assert.equal(aggregate(ctx).areas[0].area, 'web');
  } finally {
    cleanup();
  }
});

test('a file in no declared area is grouped as such rather than dropped', () => {
  // Dropping it would hide readings of exactly the code nobody has assigned an owner to.
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    record(ctx, 'FEAT-0001', ['scripts/deploy.sh'], {});
    assert.equal(aggregate(ctx).areas[0].area, '(sin área)');
  } finally {
    cleanup();
  }
});

test('the report says out loud when it does not have enough data to mean anything', () => {
  // Presenting an anecdote as a measurement is how this kind of report starts driving bad
  // decisions, and it is the failure mode a feedback loop is most prone to.
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    record(ctx, 'FEAT-0001', ['src/api/a.js'], {});
    assert.equal(aggregate(ctx).confident, false);

    for (let i = 0; i < 25; i += 1) record(ctx, `FEAT-${String(i).padStart(4, '0')}`, ['src/api/a.js'], {});
    assert.equal(aggregate(ctx).confident, true);
  } finally {
    cleanup();
  }
});

test('an empty log is an empty report, not a crash', () => {
  const { ctx, cleanup } = tempHarness({ project: PROJECT });
  try {
    const report = aggregate(ctx);
    assert.equal(report.total, 0);
    assert.deepEqual(report.areas, []);
    assert.deepEqual(diagnose(report), []);
  } finally {
    cleanup();
  }
});
