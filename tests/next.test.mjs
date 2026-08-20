import assert from 'node:assert/strict';
import test from 'node:test';
import { pickNext, rankNext, unblockCounts } from '../.harness/bin/lib/tasks.mjs';
import { makeTask } from './helpers.mjs';

const ready = (id, over = {}) => makeTask({ id, status: 'ready', ...over });

test('how many tasks it unblocks is counted transitively', () => {
  // A -> B -> C, D: unblocking A eventually frees three.
  const a = ready('FEAT-0001');
  const b = ready('FEAT-0002', { depends_on: ['FEAT-0001'] });
  const cc = ready('FEAT-0003', { depends_on: ['FEAT-0002'] });
  const d = ready('FEAT-0004', { depends_on: ['FEAT-0001'] });
  const counts = unblockCounts([a, b, cc, d]);
  assert.equal(counts.get('FEAT-0001'), 3);
  assert.equal(counts.get('FEAT-0002'), 1);
  assert.equal(counts.get('FEAT-0003'), 0);
});

test('a closed dependent does not count: only open work is being held up', () => {
  const a = ready('FEAT-0001');
  const doneChild = makeTask({ id: 'FEAT-0002', status: 'done', depends_on: ['FEAT-0001'] });
  assert.equal(unblockCounts([a, doneChild]).get('FEAT-0001'), 0);
});

test('a dependency cycle terminates instead of hanging', () => {
  // A cycle is a lint error, not something this function may loop on.
  const a = ready('FEAT-0001', { depends_on: ['FEAT-0002'] });
  const b = ready('FEAT-0002', { depends_on: ['FEAT-0001'] });
  const counts = unblockCounts([a, b]);
  assert.ok(Number.isInteger(counts.get('FEAT-0001')));
});

test('between equal priorities, the one that unblocks more wins', () => {
  const isolated = ready('FEAT-0001');
  const blocker = ready('FEAT-0002');
  const waiting = ready('FEAT-0003', { depends_on: ['FEAT-0002'] });
  const alsoWaiting = ready('FEAT-0004', { depends_on: ['FEAT-0002'] });
  assert.equal(pickNext([isolated, blocker, waiting, alsoWaiting]).id, 'FEAT-0002');
});

test('priority still outweighs the unblocking count', () => {
  // A critical isolated task must not lose to a medium one that unblocks five: the declared
  // priority is a human decision and the count is a heuristic.
  const critical = ready('FEAT-0001', { priority: 'critical' });
  const hub = ready('FEAT-0002', { priority: 'medium' });
  const waiters = [3, 4, 5, 6, 7].map((n) => ready(`FEAT-000${n}`, { depends_on: ['FEAT-0002'] }));
  const ranked = rankNext([critical, hub, ...waiters]);
  assert.equal(ranked[0].id, 'FEAT-0001');
  assert.equal(ranked[1].id, 'FEAT-0002', 'and the hub comes next');
});

test('ties fall back to the id, so the order is stable', () => {
  const ranked = rankNext([ready('FEAT-0003'), ready('FEAT-0001'), ready('FEAT-0002')]);
  assert.deepEqual(ranked.map((t) => t.id), ['FEAT-0001', 'FEAT-0002', 'FEAT-0003']);
});

test('blocked, claimed and epic tasks never enter the ranking', () => {
  const blocked = ready('FEAT-0001', { depends_on: ['FEAT-0009'] });
  const blocker = makeTask({ id: 'FEAT-0009', status: 'in_progress' });
  const claimed = ready('FEAT-0002', { assignee: { kind: 'agent', id: 'implementer' } });
  const epic = ready('EPIC-0001', { type: 'epic' });
  const good = ready('FEAT-0003');
  assert.deepEqual(rankNext([blocked, blocker, claimed, epic, good]).map((t) => t.id), ['FEAT-0003']);
});

test('nothing workable is null, not a guess', () => {
  assert.equal(pickNext([ready('EPIC-0001', { type: 'epic' })]), null);
});
