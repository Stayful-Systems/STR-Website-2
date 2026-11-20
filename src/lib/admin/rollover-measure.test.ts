import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubEvent } from '../billing/churn.ts';
import { cyclesFromEvents } from '../billing/churn.ts';
import {
  bankedCredit,
  cancellationBeforeAfter,
  guardrailBeforeAfter,
  idlePlanLogLine,
  idlePlanSweepReport,
  rolloverMeasure,
  SMALL_NUMBERS,
  type MeasureGrantRow,
} from './rollover-measure.ts';

const NOW = new Date('2027-03-15T12:00:00Z');
const LAUNCH = '2026-11-20T10:00:00Z';

function ev(userId: string, kind: SubEvent['kind'], at: string, cycleStartedAt: string): SubEvent {
  return { userId, at, kind, cycleStartedAt, planCode: 'pro', mrrPence: 4900, reason: null, reasonComment: null, source: 'stripe' };
}

/** Four members from June; one cancels in September (before), one in January (after). */
function events(): SubEvent[] {
  const s = '2026-06-01T09:00:00Z';
  return [
    ev('a', 'started', s, s),
    ev('b', 'started', s, s),
    ev('c', 'started', s, s),
    ev('d', 'started', s, s),
    ev('a', 'ended', '2026-09-10T09:00:00Z', s),
    ev('b', 'ended', '2027-01-10T09:00:00Z', s),
    // Cancels in the launch month: in neither rate.
    ev('c', 'ended', '2026-11-25T09:00:00Z', s),
  ];
}

test('cancellation rate: churn.ts monthly rates averaged before and after, launch month in neither', () => {
  const cycles = cyclesFromEvents(events(), NOW);
  const r = cancellationBeforeAfter(cycles, LAUNCH, NOW);
  assert.equal(r.launchMonth, '2026-11');
  // Before: Jul..Oct have members at the start (Jun has none, so no rate). Sep: 1 of 4 = 25%.
  assert.equal(r.before.months, 4);
  assert.equal(r.before.cancelled, 1);
  assert.equal(r.before.ratePct, 6.3); // (0 + 0 + 25 + 0) / 4 = 6.25
  assert.equal(r.before.averageMembers, 3.8); // 4, 4, 4, 3 at the month starts = 3.75
  // After: Dec, Jan, Feb, Mar (in progress). Jan: 1 of 2 = 50%.
  assert.equal(r.after.months, 4);
  assert.equal(r.after.cancelled, 1);
  assert.equal(r.after.ratePct, 12.5);
});

test('cancellation rate: not launched yet (no setting) puts everything before', () => {
  const r = cancellationBeforeAfter(cyclesFromEvents(events(), NOW), null, NOW);
  assert.equal(r.launchMonth, null);
  assert.equal(r.after.months, 0);
  assert.equal(r.after.ratePct, null);
  assert.ok(r.before.months > 0);
});

test('too early below 50 plan members, counted from live cycles', () => {
  const few = rolloverMeasure({ launchAt: LAUNCH, now: NOW, events: events(), members: null, grants: null });
  assert.equal(few.planMembers, 1); // only d is still on a plan
  assert.equal(few.tooEarly, true);
  assert.equal(few.guardrail, null);
  assert.equal(few.credit, null);
  const s = '2026-06-01T09:00:00Z';
  const many = Array.from({ length: SMALL_NUMBERS }, (_, i) => ev(`m${i}`, 'started', s, s));
  assert.equal(rolloverMeasure({ launchAt: LAUNCH, now: NOW, events: many, members: null, grants: null }).tooEarly, false);
});

test('guardrail: weekly active % of plan member-weeks, before vs after, launch week in neither', () => {
  const cycles = cyclesFromEvents(events(), NOW);
  const members = [
    // d: on a plan throughout. Weeks are UK Mondays; 2026-11-16 holds the launch.
    { id: 'd', weeks: [
      { week: '2026-11-02', active: true },
      { week: '2026-11-09', active: false },
      { week: '2026-11-16', active: true },
      { week: '2026-11-23', active: true },
      { week: '2026-11-30', active: false },
    ] },
    // a: left in September, so not a plan member in any of these weeks.
    { id: 'a', weeks: [{ week: '2026-11-02', active: true }, { week: '2026-11-23', active: true }] },
    // never on a plan
    { id: 'z', weeks: [{ week: '2026-11-02', active: true }] },
  ];
  const g = guardrailBeforeAfter(members, cycles, LAUNCH, NOW);
  assert.deepEqual(g.before, { base: 2, active: 1, pct: 50 });
  assert.deepEqual(g.after, { base: 2, active: 1, pct: 50 });
});

test('banked and rolled over: rollover.ts line, expired and spent grants left out', () => {
  const grants: MeasureGrantRow[] = [
    // u1: an old cycle with 1000 left (rolled over), the newest cycle 3000 left
    { user_id: 'u1', amount_pence: 4000, remaining_pence: 1000, created_at: '2026-10-01T00:00:00Z', plan_cycle: true },
    { user_id: 'u1', amount_pence: 4000, remaining_pence: 3000, created_at: '2026-11-01T00:00:00Z', plan_cycle: true },
    // u2: newest cycle fully spent, an older one with 500 left still rolled over
    { user_id: 'u2', amount_pence: 4000, remaining_pence: '500', created_at: '2026-09-01T00:00:00Z', plan_cycle: true },
    { user_id: 'u2', amount_pence: 4000, remaining_pence: 0, created_at: '2026-10-01T00:00:00Z', plan_cycle: true },
    // u3: lapsed before launch (expired): nothing banked
    { user_id: 'u3', amount_pence: 4000, remaining_pence: 2000, created_at: '2026-08-01T00:00:00Z', plan_cycle: false, expires_at: '2026-09-01T00:00:00Z' },
  ];
  assert.deepEqual(bankedCredit(grants, NOW), { holders: 2, bankedPence: 4500, rolledOverPence: 1500 });
  assert.deepEqual(bankedCredit([], NOW), { holders: 0, bankedPence: 0, rolledOverPence: 0 });
});

test('the measure names nobody: counts and pence only', () => {
  const m = rolloverMeasure({
    launchAt: LAUNCH,
    now: NOW,
    events: events(),
    members: [{ id: 'd', weeks: [{ week: '2026-11-02', active: true }] }],
    grants: [{ user_id: 'd', amount_pence: 4000, remaining_pence: 100, created_at: '2026-11-01T00:00:00Z', plan_cycle: true }],
  });
  const text = JSON.stringify(m);
  for (const id of ['"a"', '"b"', '"c"', '"d"']) assert.equal(text.includes(id), false);
});

test('sweep idle report: ids, dates and pence only; a missing SQL function is reported, not thrown', async () => {
  const row = { userId: 'u1', lastSpentAt: null, idleSince: '2026-11-20T10:00:00Z', planRemainingPence: 5000, expirablePence: 1000, email: 'x@example.com' };
  const ok = await idlePlanSweepReport(async () => [row]);
  assert.deepEqual(ok.idlePlanCandidates, [{ userId: 'u1', lastSpentAt: null, idleSince: '2026-11-20T10:00:00Z', planRemainingPence: 5000, expirablePence: 1000 }]);
  assert.equal(ok.idlePlanExpirablePence, 1000);
  assert.match(idlePlanLogLine(ok, true), /^\[credit-sweep dry\] idle plan candidates: 1 member\(s\), 1000p expirable; report only, nothing expires/);

  const missing = await idlePlanSweepReport(async () => {
    throw new Error('credit_idle_plan_report: function does not exist');
  });
  assert.equal(missing.idlePlanCandidates, null);
  assert.match(missing.idlePlanError ?? '', /does not exist/);
  assert.match(idlePlanLogLine(missing, false), /^\[credit-sweep\] idle plan candidates: unavailable/);
});

test('sweep idle report only reads: the loader is the one call it makes', async () => {
  // The route hands it ledger.ts idlePlanReport and nothing else, so neither the
  // dry nor the live run can expire anything through it.
  let calls = 0;
  const r = await idlePlanSweepReport(async () => {
    calls += 1;
    return [];
  });
  assert.equal(calls, 1);
  assert.deepEqual(r.idlePlanCandidates, []);
});
