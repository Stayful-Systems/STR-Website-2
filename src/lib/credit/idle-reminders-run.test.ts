import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditIdleKey, runCreditIdleReminders, type IdleReminderCandidate, type IdleRemindersDeps, type IdleReminderKind } from './idle-reminders-run.ts';

const U = '11111111-2222-4333-8444-555555555555';
const EMAIL = 'member-secret@example.test';
const SINCE = '2026-01-01T00:00:00.000Z';

interface Row {
  userId: string;
  idleSince: string;
  stage: number;
  status: 'sent' | 'skipped';
  sentAt: string | null;
}

interface Sent {
  kind: IdleReminderKind;
  to: string | null;
  key: string;
  data: Record<string, unknown>;
}

/** A fake world: notices table, the cap (one slot per member per day), emails and activity, with counters. */
function world(opts: { alertsOn?: boolean; candidates?: IdleReminderCandidate[]; sendFails?: boolean } = {}) {
  const rows: Row[] = [];
  const capUsed = new Set<string>(); // `${user}|${day}`
  const claims = new Map<string, { key: string; state: 'claimed' | 'sending' | 'done' }>();
  const sent: Sent[] = [];
  const activity: Array<{ userId: string; dedupeKey: string; stage: number }> = [];
  const logs: string[] = [];
  const counts = { writes: 0, claims: 0, sends: 0, activity: 0, released: 0 };
  let candidates: IdleReminderCandidate[] = opts.candidates ?? [{ userId: U, idleSince: SINCE, planRemainingPence: 3800, expirablePence: 1900 }];
  let sendFails = opts.sendFails ?? false;
  let n = 0;
  const day = (d: Date) => d.toISOString().slice(0, 10);

  const deps: IdleRemindersDeps = {
    settings: async () => ({ stages: [3, 6, 12], idleMonths: 12, finalNoticeDays: 30 }),
    candidates: async () => candidates,
    notices: async (ids) => {
      const out = new Map<string, Array<{ idleSince: string; stage: number; status: 'sent' | 'skipped' }>>();
      for (const r of rows) if (ids.includes(r.userId)) out.set(r.userId, [...(out.get(r.userId) ?? []), { idleSince: r.idleSince, stage: r.stage, status: r.status }]);
      return out;
    },
    members: async (ids) => new Map(ids.map((id) => [id, { alertsOn: opts.alertsOn ?? true, email: EMAIL }])),
    slotsUsedToday: async (ids, now) => new Set(ids.filter((id) => capUsed.has(`${id}|${day(now)}`))),
    balancePence: async () => 4800,
    claimSlot: async (userId, _kind, now) => {
      const key = `${userId}|${day(now)}`;
      if (capUsed.has(key)) return { ok: false, reason: 'slot_used' };
      counts.claims += 1;
      capUsed.add(key);
      const id = `c${++n}`;
      claims.set(id, { key, state: 'claimed' });
      return { ok: true, id };
    },
    releaseClaim: async (id) => {
      const c = claims.get(id);
      if (c && c.state === 'claimed') {
        capUsed.delete(c.key);
        claims.delete(id);
        counts.released += 1;
      }
    },
    markSending: async (id) => {
      const c = claims.get(id);
      if (!c) return false;
      c.state = 'sending';
      return true;
    },
    abandonSend: async (id) => {
      const c = claims.get(id);
      if (c && c.state === 'sending') {
        capUsed.delete(c.key);
        claims.delete(id);
        counts.released += 1;
      }
    },
    finishSend: async (id) => {
      const c = claims.get(id);
      if (c) c.state = 'done';
    },
    sendReminder: async (to, data, key) => {
      counts.sends += 1;
      if (sendFails) return { sent: false, reason: 'resend_down' };
      sent.push({ kind: 'credit_idle', to, key, data });
      return { sent: true };
    },
    sendFinalWarning: async (to, data, key) => {
      counts.sends += 1;
      if (sendFails) return { sent: false, reason: 'resend_down' };
      sent.push({ kind: 'credit_idle_final', to, key, data });
      return { sent: true };
    },
    recordSkipped: async (userId, idleSince, stage) => {
      counts.writes += 1;
      if (!rows.some((r) => r.userId === userId && r.idleSince === idleSince && r.stage === stage)) rows.push({ userId, idleSince, stage, status: 'skipped', sentAt: null });
    },
    stampSent: async (userId, idleSince, stage, sentAt) => {
      counts.writes += 1;
      const r = rows.find((x) => x.userId === userId && x.idleSince === idleSince && x.stage === stage);
      if (r) Object.assign(r, { status: 'sent', sentAt: sentAt.toISOString() });
      else rows.push({ userId, idleSince, stage, status: 'sent', sentAt: sentAt.toISOString() });
    },
    recordActivity: async (userId, o) => {
      counts.activity += 1;
      activity.push({ userId, dedupeKey: o.dedupeKey, stage: o.stage });
    },
    log: (line) => logs.push(line),
  };
  return {
    deps,
    rows,
    sent,
    activity,
    logs,
    counts,
    capUsed,
    useCap: (userId: string, d: Date) => capUsed.add(`${userId}|${day(d)}`),
    setCandidates: (c: IdleReminderCandidate[]) => (candidates = c),
    setSendFails: (v: boolean) => (sendFails = v),
  };
}

const at = (iso: string) => new Date(iso);

test('each stage sends once', async () => {
  const w = world();
  const r1 = await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-02T06:43:00Z') });
  assert.equal(r1.status, 200);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].kind, 'credit_idle');
  assert.deepEqual(w.sent[0].data, { months: 3, balancePence: 4800 });
  assert.deepEqual(w.rows.map((r) => [r.stage, r.status]), [[3, 'sent']]);
  assert.equal(w.activity.length, 1);
  // A second run the same day sends nothing.
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-02T09:00:00Z') });
  // And neither does the next day: the stage has its row.
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-03T06:43:00Z') });
  assert.equal(w.sent.length, 1);
  // At 6 months, the 6-month reminder, once.
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-07-02T06:43:00Z') });
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-07-03T06:43:00Z') });
  assert.equal(w.sent.length, 2);
  assert.deepEqual(w.sent[1].data, { months: 6, balancePence: 4800 });
  // At 12 months, the final warning, once.
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2027-01-02T06:43:00Z') });
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2027-01-03T06:43:00Z') });
  assert.equal(w.sent.length, 3);
  assert.equal(w.sent[2].kind, 'credit_idle_final');
  assert.deepEqual(w.rows.map((r) => [r.stage, r.status]), [[3, 'sent'], [6, 'sent'], [12, 'sent']]);
});

test('a cap-skipped reminder sends next day', async () => {
  const w = world();
  const d1 = at('2026-04-02T06:43:00Z');
  w.useCap(U, d1);
  const r1 = await runCreditIdleReminders(w.deps, { dry: false, now: d1 });
  assert.equal(w.sent.length, 0);
  assert.deepEqual(r1.body.waiting, [{ userId: U, stage: 3, kind: 'credit_idle', reason: 'cap_used' }]);
  assert.equal(w.rows.length, 0, 'a wait records nothing');
  const r2 = await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-03T06:43:00Z') });
  assert.equal(w.sent.length, 1);
  assert.deepEqual(r2.body.sent, [{ userId: U, stage: 3, kind: 'credit_idle' }]);
});

test('a spend resets', async () => {
  const w = world();
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-02T06:43:00Z') });
  assert.equal(w.sent.length, 1);
  // A spend on 1 May: a new idle run starts.
  const since2 = '2026-05-01T10:00:00.000Z';
  w.setCandidates([{ userId: U, idleSince: since2, planRemainingPence: 3700, expirablePence: 1800 }]);
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-07-02T06:43:00Z') });
  assert.equal(w.sent.length, 1, 'not yet 3 months into the new run (the old run 6-month stage does not apply)');
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-08-02T06:43:00Z') });
  assert.equal(w.sent.length, 2);
  assert.deepEqual(w.sent[1].data, { months: 3, balancePence: 4800 });
  assert.equal(w.sent[1].key, creditIdleKey(U, since2, 3));
  assert.deepEqual(w.rows.filter((r) => r.idleSince === since2).map((r) => [r.stage, r.status]), [[3, 'sent']]);
});

test('the final warning ignores opt-outs', async () => {
  const w = world({ alertsOn: false });
  const r3 = await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-02T06:43:00Z') });
  assert.deepEqual(r3.body.skipped, [{ userId: U, stage: 3, kind: 'credit_idle', reason: 'alerts_off' }]);
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-07-02T06:43:00Z') });
  assert.equal(w.sent.length, 0);
  const now = at('2027-01-02T06:43:00Z');
  await runCreditIdleReminders(w.deps, { dry: false, now });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].kind, 'credit_idle_final');
  assert.equal(w.sent[0].to, EMAIL);
  assert.deepEqual(w.sent[0].data, { balancePence: 4800, expiringPence: 1900, expiresOn: new Date(now.getTime() + 30 * 86_400_000), months: 12 });
  assert.deepEqual(w.rows.map((r) => [r.stage, r.status]), [[3, 'skipped'], [6, 'skipped'], [12, 'sent']]);
});

test('a member who missed 3 and 6 gets one email and two skipped rows', async () => {
  const w = world();
  const r = await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-07-15T06:43:00Z') });
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0].data, { months: 6, balancePence: 4800 });
  assert.deepEqual(r.body.skipped, [{ userId: U, stage: 3, kind: 'credit_idle', reason: 'missed' }]);
  // A member first seen at 12 months: one final warning, 3 and 6 skipped.
  const w2 = world();
  await runCreditIdleReminders(w2.deps, { dry: false, now: at('2027-01-05T06:43:00Z') });
  assert.equal(w2.sent.length, 1);
  assert.equal(w2.sent[0].kind, 'credit_idle_final');
  assert.deepEqual(w2.rows.map((x) => [x.stage, x.status]), [[3, 'skipped'], [6, 'skipped'], [12, 'sent']]);
});

test('a send failure releases the claim and records nothing', async () => {
  const w = world({ sendFails: true });
  const d1 = at('2026-04-02T06:43:00Z');
  const r = await runCreditIdleReminders(w.deps, { dry: false, now: d1 });
  assert.equal(w.counts.sends, 1);
  assert.equal(w.counts.claims, 1);
  assert.equal(w.counts.released, 1, 'the slot is given back');
  assert.equal(w.capUsed.size, 0);
  assert.equal(w.rows.length, 0);
  assert.equal(w.counts.activity, 0);
  assert.equal((r.body.errors as string[]).length, 1);
  // It tries again (the same day's later run can use the slot; next day too).
  w.setSendFails(false);
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-03T06:43:00Z') });
  assert.equal(w.sent.length, 1);
});

test('the dry run writes nothing', async () => {
  const other = '99999999-2222-4333-8444-555555555555';
  const capped = '88888888-2222-4333-8444-555555555555';
  const w = world({
    candidates: [
      { userId: U, idleSince: SINCE, planRemainingPence: 3800, expirablePence: 1900 },
      { userId: other, idleSince: SINCE, planRemainingPence: 0, expirablePence: 0 },
      { userId: capped, idleSince: SINCE, planRemainingPence: 500, expirablePence: 0 },
    ],
  });
  const now = at('2026-07-15T06:43:00Z');
  w.useCap(capped, now);
  const r = await runCreditIdleReminders(w.deps, { dry: true, now });
  assert.equal(r.body.dry, true);
  assert.deepEqual(r.body.wouldSend, [{ userId: U, stage: 6, kind: 'credit_idle' }]);
  assert.deepEqual(r.body.waiting, [{ userId: capped, stage: 6, kind: 'credit_idle', reason: 'cap_used' }]);
  assert.deepEqual(r.body.skipped, [
    { userId: U, stage: 3, kind: 'credit_idle', reason: 'missed' },
    { userId: other, stage: 3, kind: 'credit_idle', reason: 'missed' },
    { userId: other, stage: 6, kind: 'credit_idle', reason: 'no_credit' },
    { userId: capped, stage: 3, kind: 'credit_idle', reason: 'missed' },
  ]);
  assert.deepEqual(w.counts, { writes: 0, claims: 0, sends: 0, activity: 0, released: 0 });
  assert.equal(w.rows.length, 0);
});

test('the idempotency key is credit-idle:<user>:<idle_since ISO>:<stage>', async () => {
  assert.equal(creditIdleKey(U, '2026-01-01 00:00:00+00', 3), `credit-idle:${U}:2026-01-01T00:00:00.000Z:3`);
  assert.equal(creditIdleKey(U, new Date(SINCE), 12), `credit-idle:${U}:${SINCE}:12`);
  const w = world();
  await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-04-02T06:43:00Z') });
  assert.equal(w.sent[0].key, `credit-idle:${U}:${SINCE}:3`);
  assert.equal(w.activity[0].dedupeKey, w.sent[0].key);
});

test('no PII in the returned lists or the logs', async () => {
  const w = world();
  const live = await runCreditIdleReminders(w.deps, { dry: false, now: at('2026-07-15T06:43:00Z') });
  const dry = await runCreditIdleReminders(world().deps, { dry: true, now: at('2026-07-15T06:43:00Z') });
  for (const out of [JSON.stringify(live.body), JSON.stringify(dry.body), w.logs.join('\n')]) {
    assert.ok(!out.includes(EMAIL), 'no email address');
    assert.ok(!out.includes('@'), 'nothing email-shaped');
    assert.ok(!/subject|html|text/i.test(out), 'no email body');
  }
  for (const list of ['sent', 'waiting', 'skipped'] as const) {
    for (const e of (live.body[list] as Record<string, unknown>[]) ?? []) assert.deepEqual(Object.keys(e).filter((k) => !['userId', 'stage', 'kind', 'reason'].includes(k)), []);
  }
});

test('a missing report function or notices table is an error body, not a throw', async () => {
  const w = world();
  const r1 = await runCreditIdleReminders({ ...w.deps, candidates: async () => { throw new Error('function credit_idle_plan_report(timestamptz, integer) does not exist'); } }, { dry: true, now: at('2026-04-02T06:43:00Z') });
  assert.equal(r1.status, 503);
  assert.match(String(r1.body.error), /credit_idle_plan_report/);
  const r2 = await runCreditIdleReminders({ ...w.deps, notices: async () => { throw new Error('relation "credit_idle_notices" does not exist'); } }, { dry: false, now: at('2026-04-02T06:43:00Z') });
  assert.equal(r2.status, 503);
  assert.equal(w.counts.sends + w.counts.claims + w.counts.writes, 0);
});
