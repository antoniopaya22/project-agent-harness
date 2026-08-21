import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_PER_ROUND,
  findings,
  loadAnswers,
  pendingRounds,
  progress,
  questions,
  recordAnswer,
} from '../.harness/bin/lib/interview.mjs';
import { tempHarness } from './helpers.mjs';

const SURVEY = {
  stack: {
    language: 'python',
    gates: {
      lint: { run: 'ruff check .', evidence: 'pyproject.toml [tool.ruff]' },
      test: { run: 'pytest -q', evidence: 'pyproject.toml [tool.pytest]' },
    },
  },
  areas: [{ id: 'api' }, { id: 'web' }],
  hotspots: [{ file: 'src/api/users.py', touches: 40 }, { file: 'src/web/app.tsx', touches: 22 }, { file: 'x.py', touches: 3 }],
};

test('nothing the survey already found is asked in the open', () => {
  const asked = questions(SURVEY);
  for (const id of ['gate.lint', 'gate.test', 'areas', 'language']) {
    const q = asked.find((x) => x.id === id);
    assert.ok(q, `${id} is missing`);
    assert.equal(q.kind, 'confirm', `${id} should be a confirmation, not an open question`);
    assert.notEqual(q.inferred, undefined, `${id} must carry what was inferred`);
    assert.ok(q.evidence, `${id} must say where the inference came from`);
  }
});

test('a confirmation quotes the actual command, so the answer is one word', () => {
  const q = questions(SURVEY).find((x) => x.id === 'gate.test');
  assert.match(q.question, /pytest -q/);
  assert.match(q.evidence, /tool\.pytest/);
});

test('what no file can answer is asked, and says why it matters', () => {
  const asked = questions(SURVEY);
  for (const id of ['purpose', 'users', 'glossary', 'deprecated', 'pain']) {
    const q = asked.find((x) => x.id === id);
    assert.ok(q, `${id} is missing`);
    assert.equal(q.kind, 'open');
    assert.ok(q.why, `${id} must justify itself: an interview nobody understands is one nobody finishes`);
  }
});

test('a project with no detected gates is not asked to confirm gates', () => {
  const asked = questions({ stack: { language: null, gates: {} }, areas: [], hotspots: [] });
  assert.ok(!asked.some((q) => q.id.startsWith('gate.')));
  assert.ok(!asked.some((q) => q.id === 'areas'));
  assert.ok(asked.some((q) => q.id === 'purpose'), 'but the open questions still stand');
});

test('rounds never exceed four questions', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    for (const round of pendingRounds(SURVEY, loadAnswers(ctx))) {
      assert.ok(round.length <= MAX_PER_ROUND, `a round had ${round.length} questions`);
    }
  } finally {
    cleanup();
  }
});

test('confirmations come before the open questions', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const rounds = pendingRounds(SURVEY, loadAnswers(ctx));
    assert.ok(rounds[0].every((q) => q.kind === 'confirm'), 'the cheap ones first');
  } finally {
    cleanup();
  }
});

test('a second run does not ask what was already answered', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const before = pendingRounds(SURVEY, loadAnswers(ctx)).flat().length;
    recordAnswer(ctx, 'purpose', 'Una tienda interna de pedidos de material.');
    recordAnswer(ctx, 'gate.test', 'pytest -q');

    const after = pendingRounds(SURVEY, loadAnswers(ctx)).flat();
    assert.equal(after.length, before - 2);
    assert.ok(!after.some((q) => q.id === 'purpose'));
    assert.ok(!after.some((q) => q.id === 'gate.test'));
  } finally {
    cleanup();
  }
});

test('"I do not know" is remembered, so it is never asked twice', () => {
  // Asking again next run spends the one resource an interview has, which is patience.
  const { ctx, cleanup } = tempHarness();
  try {
    recordAnswer(ctx, 'glossary', null, { unknown: true });
    const asked = pendingRounds(SURVEY, loadAnswers(ctx)).flat();
    assert.ok(!asked.some((q) => q.id === 'glossary'));

    const state = loadAnswers(ctx);
    assert.ok('glossary' in state.skipped);
    assert.ok(!('glossary' in state.answers));
  } finally {
    cleanup();
  }
});

test('answering something previously unknown clears the unknown mark', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    recordAnswer(ctx, 'pain', null, { unknown: true });
    recordAnswer(ctx, 'pain', 'El importador de CSV se rompe cada cierre de mes.');
    const state = loadAnswers(ctx);
    assert.ok(!('pain' in state.skipped));
    assert.match(state.answers.pain.value, /importador/);
  } finally {
    cleanup();
  }
});

test('the answers survive on disk and each is stamped', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    recordAnswer(ctx, 'purpose', 'Algo con sentido.');
    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.harnessDir, 'adoption', 'interview.json'), 'utf8'));
    assert.equal(onDisk.answers.purpose.value, 'Algo con sentido.');
    assert.ok(onDisk.answers.purpose.at, 'when it was answered');
    assert.ok(onDisk.updated_at);
  } finally {
    cleanup();
  }
});

test('a corrupt interview file is treated as empty rather than fatal', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    fs.mkdirSync(path.join(ctx.harnessDir, 'adoption'), { recursive: true });
    fs.writeFileSync(path.join(ctx.harnessDir, 'adoption', 'interview.json'), '{ roto');
    assert.deepEqual(loadAnswers(ctx), { answers: {}, skipped: {} });
  } finally {
    cleanup();
  }
});

test('progress reaches complete only when nothing is outstanding', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    assert.equal(progress(SURVEY, loadAnswers(ctx)).complete, false);
    for (const q of questions(SURVEY)) recordAnswer(ctx, q.id, 'algo');
    const done = progress(SURVEY, loadAnswers(ctx));
    assert.equal(done.complete, true);
    assert.equal(done.outstanding, 0);
  } finally {
    cleanup();
  }
});

test('what the human did not know comes out as an explicit unverified marker', () => {
  // A gap that looks like an answer is the worst outcome: the proposal would state it as
  // fact and the next agent would build on it.
  const { ctx, cleanup } = tempHarness();
  try {
    recordAnswer(ctx, 'purpose', 'Una tienda interna.');
    recordAnswer(ctx, 'glossary', null, { unknown: true });

    const out = findings(SURVEY, loadAnswers(ctx));
    assert.equal(out.known.purpose, 'Una tienda interna.');
    assert.ok(out.unverified.some((u) => u.id === 'glossary'));
    assert.ok(out.unverified.some((u) => u.id === 'pain' && /sin preguntar/.test(u.note)), 'and never-asked is distinguished');
  } finally {
    cleanup();
  }
});
