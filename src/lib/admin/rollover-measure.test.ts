import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubEvent } from '../billing/churn.ts';
import { cyclesFromEvents } from '../billing/churn.ts';
import {
  bankedCredit,
  cancellationBeforeAfter,
  guardrailBeforeAfter,
  idleExpiredKey,
  idleExpiringPence,
  idleExpiryDry,
  idleExpiryLists,
  idleExpiryLive,
  idleExpiryViews,
  idlePlanLogLine,
  idlePlanSweepReport,
  type IdleExpiryDeps,
  type IdleExpiryOutcome,
  type IdleNoticeRecord,
  type IdlePlanRowLike,
  rolloverMeasure,
  SMALL_NUMBERS,
  type MeasureGrantRow,
} from './rollover-measure.ts';
import { IdleExpiryUnavailableError, isSchemaMissing } from '../credit/ledger.ts';

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
  assert.match(idlePlanLogLine(ok, true), /^\[credit-sweep dry\] idle plan candidates: 1 member\(s\), 1000p expirable before the final-notice check/);

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

// ── Batch 34b (Phase 13): the no-spend expiry ──

const XNOW = new Date('2026-11-20T03:00:00Z');
const SETTINGS = { idleMonths: 12, finalNoticeDays: 30 };
const DAY_MS = 86_400_000;

function g(user: string, created: string, remaining: number, cycle: boolean, expires: string | null = null): MeasureGrantRow {
  return { user_id: user, amount_pence: remaining, remaining_pence: remaining, created_at: created, plan_cycle: cycle, source_ref: null, expires_at: expires };
}

function notice(user: string, idleSince: string, sentAt: string | null, status: 'sent' | 'skipped' = 'sent', stage = 12): IdleNoticeRecord {
  return { userId: user, idleSince, stage, status, sentAt };
}

function cand(userId: string, idleSince: string): IdlePlanRowLike {
  return { userId, lastSpentAt: null, idleSince, planRemainingPence: 0, expirablePence: 0 };
}

/**
 * The fixture. Each member is an idle candidate (as credit_idle_plan_report
 * lists them); only A and F are due.
 *   A due: notice 50 days ago; 1000 + 500 before it, a 300 top-up after it
 *     (before the newest month: the report's expirable_pence counts it, the
 *     expiry must not), newest month 2000 kept. Expires 1500 in 2 grants.
 *   B no final notice at all.
 *   C notice 19 days ago (warned).
 *   D the final row was recorded 'skipped', never sent.
 *   E spent after the notice: the notice belongs to the old idle run.
 *   F notice exactly 30 days ago (due at the boundary): 700 expires, newest 100 kept.
 *   G notice 30 days minus 1 ms ago (warned at the boundary).
 *   H no cycle grant known: the newest month is unknown, nothing expires.
 */
function fixture() {
  const at30 = new Date(XNOW.getTime() - 30 * DAY_MS).toISOString();
  const at30less = new Date(XNOW.getTime() - 30 * DAY_MS + 1).toISOString();
  const candidates = [
    cand('A', '2025-09-01T10:00:00.000Z'),
    cand('B', '2025-09-01T10:00:00.000Z'),
    cand('C', '2025-10-01T10:00:00.000Z'),
    cand('D', '2025-09-01T10:00:00.000Z'),
    cand('E', '2025-08-01T10:00:00.000Z'),
    cand('F', '2025-09-01T10:00:00.000Z'),
    cand('G', '2025-09-01T10:00:00.000Z'),
    cand('H', '2025-09-01T10:00:00.000Z'),
  ];
  const notices: IdleNoticeRecord[] = [
    notice('A', '2025-09-01T10:00:00+00:00', '2026-10-01T06:43:00.000Z'), // same instant, another format
    notice('C', '2025-10-01T10:00:00.000Z', '2026-11-01T06:43:00.000Z'),
    notice('D', '2025-09-01T10:00:00.000Z', null, 'skipped'),
    notice('E', '2024-06-01T10:00:00.000Z', '2025-07-01T06:43:00.000Z'), // the old run
    notice('F', '2025-09-01T10:00:00.000Z', at30),
    notice('G', '2025-09-01T10:00:00.000Z', at30less),
    notice('H', '2025-09-01T10:00:00.000Z', '2026-09-01T06:43:00.000Z'),
    notice('A', '2025-09-01T10:00:00.000Z', '2026-03-01T06:43:00.000Z', 'sent', 6), // a lower stage never counts
  ];
  const grants: MeasureGrantRow[] = [
    g('A', '2025-08-01T00:00:00Z', 1000, true),
    g('A', '2025-09-01T00:00:00Z', 500, true),
    g('A', '2026-10-10T00:00:00Z', 300, false),
    g('A', '2026-11-01T00:00:00Z', 2000, true),
    g('A', '2025-07-01T00:00:00Z', 900, false, '2025-08-01T00:00:00Z'), // lapsed before launch
    g('B', '2025-08-01T00:00:00Z', 800, true),
    g('B', '2026-11-01T00:00:00Z', 800, true),
    g('C', '2025-08-01T00:00:00Z', 600, true),
    g('C', '2026-11-01T00:00:00Z', 600, true),
    g('D', '2025-08-01T00:00:00Z', 400, true),
    g('D', '2026-11-01T00:00:00Z', 400, true),
    g('E', '2025-06-01T00:00:00Z', 1200, true),
    g('E', '2026-11-01T00:00:00Z', 1200, true),
    g('F', '2025-01-01T00:00:00Z', 700, false),
    g('F', '2026-11-05T00:00:00Z', 100, true),
    g('G', '2025-01-01T00:00:00Z', 650, true),
    g('G', '2026-11-05T00:00:00Z', 100, true),
    g('H', '2025-01-01T00:00:00Z', 550, false),
  ];
  return { candidates, notices, grants };
}

/**
 * A stand-in for credit_expire_idle_plan, written from the SQL (not from
 * idleExpiringPence), over the same fixture: it mutates the grants as the SQL
 * would. Candidates are idle by construction (the report found them).
 */
function fakeSql(world: ReturnType<typeof fixture>) {
  const sinceOf = new Map(world.candidates.map((c) => [c.userId, Date.parse(c.idleSince)]));
  return async (user: string, now: Date): Promise<IdleExpiryOutcome> => {
    const mine = world.grants.filter((r) => r.user_id === user);
    const live = mine.filter((r) => Number(r.remaining_pence) > 0 && (!r.expires_at || Date.parse(r.expires_at) > now.getTime()));
    if (live.length === 0) return { expiredPence: 0, grants: 0, reason: 'no_plan_credit' };
    const n = world.notices.find((x) => x.userId === user && Date.parse(x.idleSince) === sinceOf.get(user) && x.stage === 12 && x.status === 'sent' && x.sentAt);
    if (!n?.sentAt) return { expiredPence: 0, grants: 0, reason: 'no_final_notice' };
    const sent = Date.parse(n.sentAt);
    if (sent > now.getTime() - 30 * DAY_MS) return { expiredPence: 0, grants: 0, reason: 'notice_too_recent' };
    const cycles = mine.filter((r) => r.plan_cycle && Date.parse(r.created_at) <= now.getTime()).map((r) => Date.parse(r.created_at));
    if (cycles.length === 0) return { expiredPence: 0, grants: 0, reason: 'no_cycle_grant' };
    const newest = Math.max(...cycles);
    let total = 0;
    let count = 0;
    for (const r of live) {
      const at = Date.parse(r.created_at);
      if (at < sent && at < newest) {
        total += Number(r.remaining_pence);
        r.remaining_pence = 0;
        count += 1;
      }
    }
    return count === 0 ? { expiredPence: 0, grants: 0, reason: 'none_expirable' } : { expiredPence: total, grants: count };
  };
}

function deps(world: ReturnType<typeof fixture>, over: Partial<IdleExpiryDeps> = {}) {
  const calls = { expire: [] as string[], recorded: [] as Array<{ userId: string; dedupeKey: string; expiredPence: number; grants: number }>, reads: 0, logs: [] as string[] };
  const sql = fakeSql(world);
  const d: IdleExpiryDeps = {
    expire: async (u, now) => {
      calls.expire.push(u);
      return sql(u, now);
    },
    recordExpired: async (u, o) => {
      calls.recorded.push({ userId: u, ...o });
    },
    settings: async () => {
      calls.reads += 1;
      return SETTINGS;
    },
    finalNotices: async (ids, stage) => {
      calls.reads += 1;
      return world.notices.filter((n) => ids.includes(n.userId) && n.stage === stage && n.status === 'sent');
    },
    planGrants: async (ids) => {
      calls.reads += 1;
      return world.grants.filter((r) => ids.includes(r.user_id)).map((r) => ({ ...r }));
    },
    log: (l) => calls.logs.push(l),
    ...over,
  };
  return { d, calls };
}

test('dry and live agree: the dry run lists exactly the members and pence the live run expires', async () => {
  const world = fixture();
  const { d, calls } = deps(world);
  const dry = await idleExpiryDry(world.candidates, d, XNOW);
  assert.equal(calls.expire.length, 0, 'the dry run never calls the expiry');
  assert.equal(calls.recorded.length, 0, 'the dry run records nothing');
  assert.deepEqual(dry.wouldExpireIdle, [
    { userId: 'A', expiringPence: 1500, grants: 2 },
    { userId: 'F', expiringPence: 700, grants: 1 },
  ]);
  assert.equal(dry.wouldExpireIdlePence, 2200);

  const live = await idleExpiryLive(world.candidates, d, XNOW);
  assert.deepEqual(calls.expire, world.candidates.map((c) => c.userId), 'the SQL is asked about every candidate');
  assert.deepEqual(
    live.idleExpired?.map((r) => ({ userId: r.userId, expiringPence: r.expiredPence, grants: r.grants })),
    dry.wouldExpireIdle,
  );
  assert.equal(live.idleExpiredPence, dry.wouldExpireIdlePence);
  assert.deepEqual(live.errors, []);
  assert.deepEqual(calls.recorded, [
    { userId: 'A', dedupeKey: 'credit-idle-expired:A:2025-09-01T10:00:00.000Z', expiredPence: 1500, grants: 2 },
    { userId: 'F', dedupeKey: 'credit-idle-expired:F:2025-09-01T10:00:00.000Z', expiredPence: 700, grants: 1 },
  ]);
  // The rest are counted by the SQL's reason, and the dry run's counts match.
  assert.deepEqual(live.idleExpireSkipped, { no_final_notice: 3, notice_too_recent: 2, no_cycle_grant: 1 });
  assert.deepEqual(dry.idleExpireSkipped, live.idleExpireSkipped);
  // The newest month and the post-notice top-up are still there; a second run expires nothing.
  assert.equal(world.grants.find((r) => r.user_id === 'A' && r.created_at === '2026-11-01T00:00:00Z')?.remaining_pence, 2000);
  assert.equal(world.grants.find((r) => r.user_id === 'A' && r.created_at === '2026-10-10T00:00:00Z')?.remaining_pence, 300);
  const again = await idleExpiryLive(world.candidates, d, XNOW);
  assert.deepEqual(again.idleExpired, []);
  // Logs carry ids and pence only.
  for (const l of calls.logs) assert.doesNotMatch(l, /@/);
});

test('nothing expires without a final notice at least 30 days old', () => {
  const world = fixture();
  const views = idleExpiryViews({ ...world, settings: SETTINGS, now: XNOW });
  const by = new Map(views.map((v) => [v.userId, v]));
  assert.equal(by.get('B')?.state, 'no_final_notice');
  assert.equal(by.get('D')?.state, 'no_final_notice', 'a skipped final row never counts');
  assert.equal(by.get('C')?.state, 'notice_too_recent');
  assert.equal(by.get('G')?.state, 'notice_too_recent', '1 ms short of 30 days is not due');
  assert.equal(by.get('F')?.state, 'due', 'exactly 30 days is due (the SQL refuses only sent_at > now − 30 days)');
  assert.equal(by.get('H')?.state, 'no_cycle_grant');
  // The rule's window follows the setting.
  const longer = idleExpiryViews({ ...world, settings: { idleMonths: 12, finalNoticeDays: 60 }, now: XNOW });
  assert.deepEqual(longer.filter((v) => v.state === 'due').map((v) => v.userId), []);
  // Only the final stage counts: with a 6-month final stage only A's 6-month row matches (and it is old enough).
  const six = idleExpiryViews({ ...world, settings: { idleMonths: 6, finalNoticeDays: 30 }, now: XNOW });
  assert.deepEqual(six.filter((v) => v.state === 'due').map((v) => v.userId), ['A']);
  // Only grants created before the notice: A's notice of 1 Mar 2026 leaves the same two.
  assert.equal(six[0].expiringPence, 1500);
});

test('idleExpiringPence: before the notice and before the newest month, unexpired, with credit left', () => {
  const rows = [g('u', '2025-01-01T00:00:00Z', 100, true), g('u', '2025-02-01T00:00:00Z', 0, false), g('u', '2025-03-01T00:00:00Z', 50, false, '2025-04-01T00:00:00Z'), g('u', '2025-06-01T00:00:00Z', 70, true)];
  assert.deepEqual(idleExpiringPence(rows, '2025-07-01T00:00:00Z', XNOW), { pence: 100, grants: 1, noCycleGrant: false });
  // A spent newest cycle grant still marks the newest month.
  assert.deepEqual(idleExpiringPence([g('u', '2025-01-01T00:00:00Z', 100, false), g('u', '2025-06-01T00:00:00Z', 0, true)], '2025-07-01T00:00:00Z', XNOW), { pence: 100, grants: 1, noCycleGrant: false });
  // A cycle grant after now is not the newest month yet.
  assert.deepEqual(idleExpiringPence([g('u', '2025-01-01T00:00:00Z', 100, false), g('u', '2027-01-01T00:00:00Z', 9, true)], '2025-07-01T00:00:00Z', XNOW), { pence: 0, grants: 0, noCycleGrant: true });
});

test('a spend after the notice expires nothing: the TS passes the SQL reason through and never expires on its own', async () => {
  const world = fixture();
  // E spent after its notice, so its idle run (idle_since) changed: the dry run finds no notice for this run.
  const dry = await idleExpiryDry([world.candidates[4]], deps(world).d, XNOW);
  assert.deepEqual(dry.wouldExpireIdle, []);
  assert.deepEqual(dry.idleExpireSkipped, { no_final_notice: 1 });

  // Live: even for a member the TS reads would call due (A), only the SQL's answer counts.
  const said: string[] = [];
  const { d, calls } = deps(world, {
    expire: async (u) => {
      said.push(u);
      return { expiredPence: 0, grants: 0, reason: 'not_idle' };
    },
  });
  const live = await idleExpiryLive(world.candidates, d, XNOW);
  assert.deepEqual(said, world.candidates.map((c) => c.userId));
  assert.deepEqual(live.idleExpired, []);
  assert.equal(live.idleExpiredPence, 0);
  assert.deepEqual(live.idleExpireSkipped, { not_idle: world.candidates.length });
  assert.equal(calls.recorded.length, 0);
  assert.equal(calls.reads, 0, 'the live run reads nothing to judge expiry itself');
  // Every grant is untouched (only the SQL writes).
  assert.deepEqual(world.grants.map((r) => r.remaining_pence), fixture().grants.map((r) => r.remaining_pence));
});

test('a missing schema does not break the sweep: idleExpireError, nothing expired, no throw', async () => {
  const world = fixture();
  // Live: the function is missing (the ledger wrapper throws IdleExpiryUnavailableError).
  const missing = deps(world, {
    expire: async () => {
      throw new IdleExpiryUnavailableError('Could not find the function public.credit_expire_idle_plan');
    },
  });
  const live = await idleExpiryLive(world.candidates, missing.d, XNOW);
  assert.deepEqual(live.idleExpired, []);
  assert.match(live.idleExpireError ?? '', /unavailable/);
  assert.deepEqual(live.errors, []);
  assert.equal(missing.calls.recorded.length, 0);

  // Dry: the notices table is missing.
  const noTable = deps(world, {
    finalNotices: async () => {
      throw new Error('relation "public.credit_idle_notices" does not exist');
    },
  });
  const dry = await idleExpiryDry(world.candidates, noTable.d, XNOW);
  assert.equal(dry.wouldExpireIdle, null);
  assert.match(dry.idleExpireError ?? '', /does not exist/);

  // The idle report itself unreadable: neither run does anything.
  const none = deps(world);
  assert.match((await idleExpiryLive(null, none.d, XNOW)).idleExpireError ?? '', /idle plan report/);
  assert.equal((await idleExpiryDry(null, none.d, XNOW)).wouldExpireIdle, null);
  assert.equal(none.calls.expire.length + none.calls.reads, 0);

  // One member failing (not the schema) is listed and the others carry on.
  const sql = fakeSql(world);
  const flaky = deps(world, {
    expire: async (u, now) => {
      if (u === 'A') throw new Error('timeout');
      return sql(u, now);
    },
  });
  const r = await idleExpiryLive(world.candidates, flaky.d, XNOW);
  assert.deepEqual(r.errors, ['idle-expire A: timeout']);
  assert.deepEqual(r.idleExpired, [{ userId: 'F', expiredPence: 700, grants: 1 }]);
  assert.ok(flaky.calls.logs.some((l) => l === '[credit-sweep] idle expiry failed for A'));

  // The ledger's schema check.
  assert.ok(isSchemaMissing({ code: 'PGRST202', message: 'x' }));
  assert.ok(isSchemaMissing({ code: '42P01', message: 'x' }));
  assert.ok(!isSchemaMissing({ code: 'P0001', message: 'credit_expire_idle_plan_bad_input' }));
  assert.equal(new IdleExpiryUnavailableError('x').schemaMissing, true);
});

test('admin lists: warned (inside the window, due time shown) vs due, boundary exactly at 30 days', () => {
  const world = fixture();
  const views = idleExpiryViews({ ...world, settings: SETTINGS, now: XNOW });
  const lists = idleExpiryLists(views, new Map([['A', 'a@example.com'], ['C', null]]));
  assert.deepEqual(lists.due.map((r) => [r.userId, r.email, r.expiringPence]), [
    ['A', 'a@example.com', 1500],
    ['F', null, 700],
  ]);
  assert.equal(lists.duePence, 2200);
  // Warned: soonest due first; G becomes due 1 ms after now, C on 1 Dec.
  assert.deepEqual(lists.warned.map((r) => r.userId), ['G', 'C']);
  assert.equal(lists.warned[0].dueAt, new Date(XNOW.getTime() + 1).toISOString());
  assert.equal(lists.warned[1].dueAt, '2026-12-01T06:43:00.000Z');
  assert.equal(lists.warned[1].noticeSentAt, '2026-11-01T06:43:00.000Z');
  assert.equal(lists.warnedPence, 650 + 600);
  // F sits exactly on the boundary: due, with its due time equal to now.
  assert.equal(lists.due[1].dueAt, XNOW.toISOString());
  // Members neither warned nor due are not listed.
  for (const id of ['B', 'D', 'E', 'H']) assert.ok(![...lists.due, ...lists.warned].some((r) => r.userId === id));
  assert.deepEqual(idleExpiryLists([], new Map()), { warned: [], due: [], warnedPence: 0, duePence: 0 });
});

test('idleExpiredKey: one per member per idle run, in ISO form', () => {
  assert.equal(idleExpiredKey('u1', '2025-09-01 10:00:00+00'), 'credit-idle-expired:u1:2025-09-01T10:00:00.000Z');
  assert.equal(idleExpiredKey('u1', 'garbage'), 'credit-idle-expired:u1:garbage');
});
