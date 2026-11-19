import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIZ_V2_BACKFILL_DONE_KEY, WAITING_FOR_BACKFILL, backfillStamped, rateToSync, syncPlan, syncSummary, ukDay } from './live-rate-sync.ts';

const NOW = new Date('2026-11-14T04:45:00Z');

test('the rate to sync is the cautious live average, to two decimals, on the UK day', () => {
  const r = rateToSync({ fixed2y: { ratePct: 5.286, date: 'Oct 2026' }, fixed3y: { ratePct: 5.41, date: 'Oct 2026' }, variable: null }, NOW);
  assert.deepEqual(r, { ratePct: 5.41, asOf: '2026-11-14' });
  assert.deepEqual(rateToSync({ fixed2y: { ratePct: 5.286, date: null }, fixed3y: null, variable: { ratePct: 7, date: null } }, NOW), { ratePct: 5.29, asOf: '2026-11-14' });
});

test('no usable rate means nothing is written: yesterday’s stays', () => {
  assert.equal(rateToSync(null, NOW), null);
  assert.equal(rateToSync({ fixed2y: null, fixed3y: null, variable: { ratePct: 7, date: null } }, NOW), null);
  assert.equal(rateToSync({ fixed2y: { ratePct: 0, date: null }, fixed3y: null, variable: null }, NOW), null);
  assert.equal(rateToSync({ fixed2y: { ratePct: 40, date: null }, fixed3y: null, variable: null }, NOW), null);
  assert.match(syncSummary(null), /yesterday’s stays/);
});

test('the UK day follows British time, not UTC', () => {
  assert.equal(ukDay(new Date('2026-06-30T23:30:00Z')), '2026-07-01', 'BST is an hour ahead');
  assert.equal(ukDay(new Date('2026-12-30T23:30:00Z')), '2026-12-30');
});

test('the dry run says it would sync and writes nothing; the real one reports its counts', () => {
  const r = { ratePct: 5.4, asOf: '2026-11-14' };
  assert.equal(syncSummary(r, undefined, true), 'would sync 5.4% (2026-11-14) to every profile on today’s average');
  assert.equal(syncSummary(r, { profiles: 12, search_profiles: 15 }), 'synced 5.4% (2026-11-14): 12 profiles, 15 saved searches');
  assert.equal(syncSummary(r, 'failed'), 'failed to sync 5.4%');
});

// Review R4 (R4-33): the sync waits for the quiz v2 backfill's stamp, so a member's chosen rate is never overwritten first.
test('no sync until the backfill stamp exists', () => {
  const r = { ratePct: 5.4, asOf: '2026-11-19' };
  for (const stamp of [null, undefined, '', 'not a date', 42, true]) {
    const plan = syncPlan(r, stamp);
    assert.equal(plan.sync, false, `stamp ${JSON.stringify(stamp)}: no sync`);
    assert.equal(plan.line, WAITING_FOR_BACKFILL, 'and it says why');
  }
  assert.match(WAITING_FOR_BACKFILL, /quiz_v2_backfill_done_at/);
  assert.equal(QUIZ_V2_BACKFILL_DONE_KEY, 'quiz_v2_backfill_done_at');
  // The stamp the backfill writes (an ISO time), and the one schema.sql seeds (to_jsonb(now())).
  assert.deepEqual(syncPlan(r, '2026-11-15T09:00:00.000Z'), { sync: true, line: null });
  assert.equal(syncPlan(r, '2026-11-19T10:23:45.123456+00:00').sync, true);
  assert.equal(backfillStamped('2026-11-15T09:00:00.000Z'), true);
  // No rate: nothing to wait for; yesterday's stays, as before.
  assert.equal(syncPlan(null, '2026-11-15T09:00:00.000Z').sync, false);
  assert.match(syncPlan(null, null).line!, /yesterday’s stays/);
});
