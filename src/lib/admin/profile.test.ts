import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProfileStats, cohortStats, pctLabel, questionLabel, type QuizFact } from './profile.ts';

const fact = (over: Partial<QuizFact>): QuizFact => ({ userId: 'u', startedAt: '2026-09-20T09:00:00Z', completedAt: null, lastQuestion: null, percent: 0, complete: false, notSure: [], ...over });

test('completion rate, the middle of the incomplete, and where they stop', () => {
  const stats = aggregateProfileStats(
    [
      fact({ userId: 'a', completedAt: '2026-09-21T09:00:00Z', percent: 100, complete: true, lastQuestion: 'growth_target', notSure: ['bedrooms'] }),
      fact({ userId: 'b', percent: 40, lastQuestion: 'time', notSure: ['bedrooms', 'brrr_work'] }),
      fact({ userId: 'c', percent: 20, lastQuestion: 'time' }),
      fact({ userId: 'd', percent: 60, lastQuestion: 'cash_available' }),
      fact({ userId: 'e', startedAt: null, percent: 0 }),
    ],
    10,
  );
  assert.equal(stats.members, 10);
  assert.equal(stats.started, 4, 'a row with no start is not started');
  assert.equal(stats.completed, 1);
  assert.equal(stats.notStarted, 6);
  assert.equal(stats.completionRate, 0.25);
  assert.equal(stats.medianPercent, 40);
  assert.equal(stats.averagePercent, 40);
  assert.deepEqual(stats.dropOff.map((d) => [d.question, d.count]), [['time', 2], ['cash_available', 1]], 'only the incomplete count as stopped');
  assert.equal(stats.dropOff[0].label, 'About you · Time you can give');
  assert.deepEqual(stats.notSure.map((d) => [d.question, d.count]), [['bedrooms', 2], ['brrr_work', 1]]);
});

test('nobody yet: nothing to divide by', () => {
  const stats = aggregateProfileStats([], 3);
  assert.equal(stats.completionRate, null);
  assert.equal(stats.medianPercent, null);
  assert.equal(stats.averagePercent, null);
  assert.equal(stats.notStarted, 3);
  assert.deepEqual(stats.dropOff, []);
  assert.equal(pctLabel(null), '—');
  assert.equal(pctLabel(0.256), '26%');
  assert.equal(questionLabel('budget'), 'About you · Short-let budget');
});

// ── Batch 30: before and after the shorter quiz ──

test('the shorter quiz: members split at the day it went live, with their average questions and completion', () => {
  const fact = (userId: string, startedAt: string | null, complete: boolean, asked: number, answered: number) => ({ userId, startedAt, completedAt: complete ? startedAt : null, lastQuestion: null, percent: complete ? 100 : 50, complete, notSure: [], questionsAsked: asked, answeredCount: answered });
  const facts = [
    fact('a', '2026-10-01T09:00:00Z', false, 30, 12),
    fact('b', '2026-10-20T09:00:00Z', true, 30, 30),
    fact('c', '2026-11-14T09:00:00Z', true, 12, 12),
    fact('d', '2026-11-20T09:00:00Z', true, 14, 14),
    fact('e', '2026-11-21T09:00:00Z', false, 12, 5),
    fact('f', null, false, 12, 0),
  ];
  const s = aggregateProfileStats(facts, 10, '2026-11-14T09:00:00Z');
  assert.ok(s.shorter);
  assert.deepEqual(s.shorter!.before, { started: 2, completed: 1, completionRate: 0.5, averageAsked: 30, averageAnswered: 21 });
  assert.equal(s.shorter!.after.started, 3, 'a start at the instant counts as after; a row never started counts as neither');
  assert.equal(s.shorter!.after.completed, 2);
  assert.ok(Math.abs(s.shorter!.after.completionRate! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.shorter!.after.averageAsked! - (12 + 14 + 12) / 3) < 1e-9);
  assert.ok(Math.abs(s.shorter!.after.averageAnswered! - (12 + 14 + 5) / 3) < 1e-9);
  assert.equal(aggregateProfileStats(facts, 10).shorter, null, 'no day set: no comparison');
  assert.equal(aggregateProfileStats(facts, 10, 'junk').shorter, null);
  assert.equal(cohortStats([], '2026-11-14T09:00:00Z').after.averageAsked, null, 'nobody on a side: no average, never a division by zero');
});
