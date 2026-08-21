import assert from 'node:assert/strict';
import test from 'node:test';
import { TIERS, suggestTier } from '../.harness/bin/lib/tier.mjs';
import { makeTask } from './helpers.mjs';

test('a small mechanical task gets the cheapest tier', () => {
  // The deepest model on a two-line chore is money burnt, which is the whole reason this
  // exists: the tier used to be fixed per role.
  const s = suggestTier(makeTask({ type: 'chore', size: 'S' }));
  assert.equal(s.tier, 'fast');
  assert.ok(s.why.some((w) => /mecánico/.test(w)));
});

test('a large task, or one built on judgement, gets the deepest', () => {
  assert.equal(suggestTier(makeTask({ type: 'spike', size: 'M' })).tier, 'deep');
  assert.equal(suggestTier(makeTask({ type: 'feature', size: 'L' })).tier, 'deep');
});

test('ordinary work gets the middle tier, and says nothing distinguishes it', () => {
  const s = suggestTier(makeTask({ type: 'feature', size: 'M' }));
  assert.equal(s.tier, 'primary');
  assert.ok(s.why.some((w) => /trabajo ordinario/.test(w)));
});

test('blast radius counts: a task others wait on is worth thinking harder about', () => {
  // The cost of a wrong turn lands on everything downstream, not just here.
  const task = makeTask({ id: 'FEAT-0001', type: 'chore', size: 'M' });
  const downstream = ['FEAT-0002', 'FEAT-0003', 'FEAT-0004'].map((id) => makeTask({ id, depends_on: ['FEAT-0001'] }));

  const alone = suggestTier(task, { allTasks: [task] });
  const blocking = suggestTier(task, { allTasks: [task, ...downstream] });
  assert.ok(TIERS.indexOf(blocking.tier) > TIERS.indexOf(alone.tier));
  assert.ok(blocking.why.some((w) => /desbloquea 3/.test(w)));
});

test('criteria nobody can check by running something raise the tier', () => {
  const manual = makeTask({
    type: 'feature',
    size: 'S',
    acceptance_criteria: [
      { id: 'AC1', must: 'La salida se lee bien.', check: { type: 'review', run: null }, status: 'pending' },
      { id: 'AC2', must: 'El tono es el correcto.', check: { type: 'review', run: null }, status: 'pending' },
    ],
  });
  const automated = makeTask({
    type: 'feature',
    size: 'S',
    acceptance_criteria: [
      { id: 'AC1', must: 'Pasa la prueba.', check: { type: 'command', run: 'node --test x' }, status: 'pending' },
      { id: 'AC2', must: 'Pasa la otra.', check: { type: 'command', run: 'node --test y' }, status: 'pending' },
    ],
  });
  assert.ok(TIERS.indexOf(suggestTier(manual).tier) > TIERS.indexOf(suggestTier(automated).tier));
});

test('the tier never falls outside the declared set, however the signals pile up', () => {
  const extreme = makeTask({
    type: 'spike',
    size: 'XL',
    priority: 'critical',
    labels: ['riesgo', 'migracion'],
    acceptance_criteria: Array.from({ length: 6 }, (_, i) => ({
      id: `AC${i + 1}`,
      must: 'Algo sin comprobación automática.',
      check: { type: 'review', run: null },
      status: 'pending',
    })),
  });
  const trivial = makeTask({ type: 'docs', size: 'XS', priority: 'low', acceptance_criteria: [] });
  assert.ok(TIERS.includes(suggestTier(extreme).tier));
  assert.ok(TIERS.includes(suggestTier(trivial).tier));
  assert.equal(suggestTier(extreme).tier, 'deep');
  assert.equal(suggestTier(trivial).tier, 'fast');
});

test('the suggestion says it is a suggestion, and explains itself', () => {
  // A number with no reasoning behind it cannot be argued with, and something you cannot
  // argue with gets either obeyed blindly or ignored entirely.
  const s = suggestTier(makeTask({ type: 'feature', size: 'L' }));
  assert.equal(s.advisory, true);
  assert.ok(s.why.length > 0);
});
