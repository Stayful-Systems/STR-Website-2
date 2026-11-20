import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentCycleGrants, cycleAllowancePence, idleSince, newestCycleGrant, nextPlanCreditAt, rolledOverPence, type RolloverGrantRow } from './rollover.ts';
import { thisCycleGrants } from '../stripe/plan-credit.ts';

const NOW = new Date('2026-03-10T12:00:00Z');

function g(created_at: string, amount: number, remaining: number, extra: Partial<RolloverGrantRow> = {}): RolloverGrantRow {
  return { created_at, amount_pence: amount, remaining_pence: remaining, plan_cycle: true, source_ref: `inv:${created_at}`, expires_at: null, ...extra };
}

test('currentCycleGrants is the one cycle definition (thisCycleGrants)', () => {
  assert.equal(currentCycleGrants, thisCycleGrants);
});

test('rollover across a month end: a 31 January renewal rolls into 28 February', () => {
  const jan = g('2026-01-31T09:00:00Z', 1900, 1300);
  const feb = g('2026-02-28T09:00:00Z', 1900, 1900);
  const rows = [feb, jan];
  assert.deepEqual(currentCycleGrants(rows), [feb]);
  assert.equal(cycleAllowancePence(rows), 1900);
  assert.equal(rolledOverPence(rows, NOW), 1300);
  // The next credit after 31 January is 28 February (clamped), not 3 March.
  assert.equal(nextPlanCreditAt(jan, null), '2026-02-28T09:00:00.000Z');
  assert.equal(nextPlanCreditAt(feb, null), '2026-03-28T09:00:00.000Z');
});

test('rolled over = what is left in grants older than the cycle; oldest is spent first', () => {
  // £19 + £19, spend £25: the old grant goes to 0, the new one to £13.
  const spentOld = [g('2026-01-10T09:00:00Z', 1900, 0), g('2026-02-10T09:00:00Z', 1900, 1300)];
  assert.equal(rolledOverPence(spentOld, NOW), 0);
  assert.equal(cycleAllowancePence(spentOld), 1900);
  // Spend only £6: £13 of the old grant rolled over, this month's £19 untouched.
  const spentSome = [g('2026-01-10T09:00:00Z', 1900, 1300), g('2026-02-10T09:00:00Z', 1900, 1900)];
  assert.equal(rolledOverPence(spentSome, NOW), 1300);
  // Several months banked.
  const banked = [g('2025-12-10T09:00:00Z', 1900, 1900), ...spentSome];
  assert.equal(rolledOverPence(banked, NOW), 3200);
});

test('a lapsed (pre-launch) grant counts nothing; no cycle grant means nothing rolled over', () => {
  const rows = [g('2025-12-10T09:00:00Z', 1900, 500, { expires_at: '2026-01-10T09:00:00Z' }), g('2026-02-10T09:00:00Z', 1900, 1900)];
  assert.equal(rolledOverPence(rows, NOW), 0);
  const unmarked = [g('2026-01-10T09:00:00Z', 1900, 1900, { plan_cycle: false }), g('2026-02-10T09:00:00Z', 1900, 1900, { plan_cycle: false })];
  assert.equal(rolledOverPence(unmarked, NOW), 0);
  assert.equal(cycleAllowancePence(unmarked), 0);
  assert.equal(newestCycleGrant(unmarked), null);
  assert.equal(nextPlanCreditAt(null, '2026-04-01T00:00:00Z'), null);
});

test('upgrade grouping: the renewal and its upgrade top-up are one cycle; a won dispute restore is not', () => {
  const old = g('2026-01-10T09:00:00Z', 1900, 700);
  const renewal = g('2026-02-10T09:00:00Z', 1900, 1900);
  const upgrade = g('2026-02-20T09:00:00Z', 3000, 3000, { plan_cycle: false, source_ref: 'upgrade:sub_1:2026-02-20' });
  const restore = g('2026-02-25T09:00:00Z', 1900, 1900, { plan_cycle: false, source_ref: 'inv:in_old:dispute_won' });
  const rows = [restore, upgrade, old, renewal];
  assert.deepEqual(currentCycleGrants(rows), [renewal, upgrade]);
  assert.equal(cycleAllowancePence(rows), 4900);
  assert.equal(newestCycleGrant(rows), renewal);
  // Only the grant older than the renewal rolled over; the restore is in neither.
  assert.equal(rolledOverPence(rows, NOW), 700);
});

test("an annual member's next credit is about a month away, not the year-end period end", () => {
  const slot = g('2026-03-05T09:00:00Z', 1900, 1900, { source_ref: 'annual:sub_1:2026-03' });
  const yearEnd = '2027-01-05T09:00:00Z';
  const at = nextPlanCreditAt(slot, yearEnd);
  assert.equal(at, '2026-04-05T09:00:00.000Z');
  const days = (Date.parse(at!) - Date.parse(slot.created_at)) / 86_400_000;
  assert.ok(days >= 28 && days <= 31, `about a month, got ${days} days`);
});

test('a monthly member whose period ends sooner than a calendar month uses the period end; a stale one is ignored', () => {
  const renewal = g('2026-02-10T09:05:00Z', 1900, 1900);
  assert.equal(nextPlanCreditAt(renewal, '2026-03-10T09:00:00Z'), '2026-03-10T09:00:00.000Z');
  assert.equal(nextPlanCreditAt(renewal, '2026-02-01T00:00:00Z'), '2026-03-10T09:05:00.000Z');
  assert.equal(nextPlanCreditAt(renewal, 'not a date'), '2026-03-10T09:05:00.000Z');
});

test('idleSince is the later of the last spend and the launch, null-safe', () => {
  const launch = '2026-11-20T00:00:00Z';
  assert.equal(idleSince('2026-06-01T00:00:00Z', launch)?.toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(idleSince('2026-12-01T00:00:00Z', launch)?.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(idleSince(null, launch)?.toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(idleSince(new Date('2026-12-02T00:00:00Z'), null)?.toISOString(), '2026-12-02T00:00:00.000Z');
  assert.equal(idleSince(null, undefined), null);
  assert.equal(idleSince('garbage', null), null);
});

test('summary view: allowance is this cycle only, banked credit is rolled over, endsAt is the next credit', async () => {
  const { planCycleView } = await import('./rollover.ts');
  const { lowBalanceState } = await import('./pricing.ts');
  const rows = [g('2026-01-10T09:00:00Z', 1900, 1300), g('2026-02-10T09:00:00Z', 1900, 1900)];
  const view = planCycleView(rows, { planMonthlyCreditPence: 1900, currentPeriodEnd: '2026-03-10T09:00:00Z', fallbackEndsAt: null, now: NOW });
  assert.deepEqual(view, { allowancePence: 1900, rolledOverPence: 1300, endsAt: '2026-03-10T09:00:00.000Z' });
  // Low = plan credit below 20% of ONE month's: £32 of plan credit is not low…
  const used = (planPence: number) => Math.max(0, view.allowancePence - planPence);
  assert.equal(lowBalanceState({ cycleAllowancePence: 1900, cycleUsedPence: used(3200), spendableBasePence: 3200 }), 'ok');
  // …£3.80 (20% of £19) is.
  assert.equal(lowBalanceState({ cycleAllowancePence: 1900, cycleUsedPence: used(380), spendableBasePence: 380 }), 'low');
  assert.equal(lowBalanceState({ cycleAllowancePence: 1900, cycleUsedPence: used(400), spendableBasePence: 400 }), 'ok');
});

test('summary view: an annual member gets a monthly endsAt; unreadable grants fall back', async () => {
  const { planCycleView } = await import('./rollover.ts');
  const annual = planCycleView([g('2026-03-05T09:00:00Z', 1900, 1900, { source_ref: 'annual:sub_1:2026-03' })], { planMonthlyCreditPence: 1900, currentPeriodEnd: '2027-01-05T09:00:00Z', fallbackEndsAt: '2027-01-05T09:00:00Z', now: NOW });
  assert.equal(annual.endsAt, '2026-04-05T09:00:00.000Z');
  const unread = planCycleView(null, { planMonthlyCreditPence: 4900, currentPeriodEnd: '2026-04-01T00:00:00Z', fallbackEndsAt: '2026-04-01T00:00:00Z', now: NOW });
  assert.deepEqual(unread, { allowancePence: 4900, rolledOverPence: 0, endsAt: '2026-04-01T00:00:00Z' });
});

// ---- Batch 34b (Phase 11): reminders, the final warning and expiry ----

const STAGES = [3, 6, 12];
const SINCE = '2026-11-20T00:00:00Z';
const at = (iso: string) => new Date(iso);
const base = { finalStage: 12, alertsOn: true, capUsedToday: false, planCreditPence: 3800, expirablePence: 1900 };

test('idleStages: clean, sorted, unique, always ends with the final stage', async () => {
  const { idleStages } = await import('./rollover.ts');
  assert.deepEqual(idleStages([3, 6, 12], 12), [3, 6, 12]);
  assert.deepEqual(idleStages([6, '3', 3, 24, -1, 'x', null], 12), [3, 6, 12]);
  assert.deepEqual(idleStages([3, 6], 12), [3, 6, 12]);
  assert.deepEqual(idleStages(null, 12), [12]);
  assert.deepEqual(idleStages([3], 0), []);
});

test('each stage sends once', async () => {
  const { idleStageDue } = await import('./rollover.ts');
  // Before 3 months nothing is due.
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-02-19T23:59:00Z'), stages: STAGES, existing: [] }), { due: null, skipped: [] });
  // At 3 months the 3-month stage is due…
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-02-20T06:43:00Z'), stages: STAGES, existing: [] }), { due: 3, skipped: [] });
  // …and once recorded (sent or skipped) it is never due again.
  for (const status of ['sent', 'skipped'] as const) {
    assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-03-20T06:43:00Z'), stages: STAGES, existing: [{ stage: 3, status }] }), { due: null, skipped: [] });
  }
  // 6 then 12, each once.
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-05-20T06:43:00Z'), stages: STAGES, existing: [{ stage: 3, status: 'sent' }] }), { due: 6, skipped: [] });
  const all = [{ stage: 3, status: 'sent' as const }, { stage: 6, status: 'sent' as const }];
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-11-20T06:43:00Z'), stages: STAGES, existing: all }), { due: 12, skipped: [] });
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2028-06-01T06:43:00Z'), stages: STAGES, existing: [...all, { stage: 12, status: 'sent' }] }), { due: null, skipped: [] });
});

test('a member who missed 3 and 6 gets only the highest due stage; the lower ones are skipped', async () => {
  const { idleStageDue } = await import('./rollover.ts');
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-11-21T06:43:00Z'), stages: STAGES, existing: [] }), { due: 12, skipped: [3, 6] });
  // 3 was sent, 6 was missed: only 6 is skipped.
  assert.deepEqual(idleStageDue({ idleSince: SINCE, now: at('2027-11-21T06:43:00Z'), stages: STAGES, existing: [{ stage: 3, status: 'sent' }] }), { due: 12, skipped: [6] });
  // Month ends are clamped: idle since 31 August, 6 months is 28 February.
  assert.deepEqual(idleStageDue({ idleSince: '2027-08-31T10:00:00Z', now: at('2028-02-29T10:00:00Z'), stages: STAGES, existing: [{ stage: 3, status: 'sent' }] }), { due: 6, skipped: [] });
});

test('a cap-skipped reminder sends next day', async () => {
  const { idleStageDue, reminderDecision } = await import('./rollover.ts');
  const existing: { stage: number; status: 'sent' | 'skipped' }[] = [];
  const day1 = idleStageDue({ idleSince: SINCE, now: at('2027-02-20T06:43:00Z'), stages: STAGES, existing });
  assert.equal(day1.due, 3);
  const d1 = reminderDecision({ ...base, stage: day1.due!, capUsedToday: true });
  assert.deepEqual(d1, { decision: 'wait', reason: 'cap_used' });
  // A wait records nothing, so the same stage is due the next day, and goes.
  const day2 = idleStageDue({ idleSince: SINCE, now: at('2027-02-21T06:43:00Z'), stages: STAGES, existing });
  assert.deepEqual(day2, { due: 3, skipped: [] });
  assert.deepEqual(reminderDecision({ ...base, stage: day2.due!, capUsedToday: false }), { decision: 'send', reason: 'ok' });
  // The final warning waits for the cap too.
  assert.deepEqual(reminderDecision({ ...base, stage: 12, alertsOn: false, capUsedToday: true }), { decision: 'wait', reason: 'cap_used' });
});

test('a spend resets', async () => {
  const { idleStageDue } = await import('./rollover.ts');
  const oldRun = [{ stage: 3, status: 'sent' as const }, { stage: 6, status: 'sent' as const }];
  // The member spent on 1 June 2027: a new idle run, whose rows are none yet.
  const newSince = idleSince('2027-06-01T09:00:00Z', SINCE)!;
  assert.deepEqual(idleStageDue({ idleSince: newSince, now: at('2027-07-01T06:43:00Z'), stages: STAGES, existing: [] }), { due: null, skipped: [] });
  assert.deepEqual(idleStageDue({ idleSince: newSince, now: at('2027-09-01T09:00:00Z'), stages: STAGES, existing: [] }), { due: 3, skipped: [] });
  // Passing the old run's rows by mistake would wrongly block 3 and 6: the caller must pass this run's rows only.
  assert.deepEqual(idleStageDue({ idleSince: newSince, now: at('2027-12-01T09:00:00Z'), stages: STAGES, existing: oldRun }), { due: null, skipped: [] });
  assert.deepEqual(idleStageDue({ idleSince: newSince, now: at('2027-12-01T09:00:00Z'), stages: STAGES, existing: [] }), { due: 6, skipped: [3] });
});

test('the final warning ignores opt-outs', async () => {
  const { reminderDecision } = await import('./rollover.ts');
  assert.deepEqual(reminderDecision({ ...base, stage: 12, alertsOn: false }), { decision: 'send', reason: 'ok' });
  assert.deepEqual(reminderDecision({ ...base, stage: 3, alertsOn: false }), { decision: 'skip', reason: 'alerts_off' });
  assert.deepEqual(reminderDecision({ ...base, stage: 6, alertsOn: false }), { decision: 'skip', reason: 'alerts_off' });
  assert.deepEqual(reminderDecision({ ...base, stage: 3, alertsOn: true }), { decision: 'send', reason: 'ok' });
});

test('no credit to lose means skip', async () => {
  const { reminderDecision } = await import('./rollover.ts');
  for (const stage of [3, 6, 12]) assert.deepEqual(reminderDecision({ ...base, stage, planCreditPence: 0 }), { decision: 'skip', reason: 'no_credit' }, String(stage));
  // Only this month's credit left: nothing would expire, so no final warning (a reminder still goes).
  assert.deepEqual(reminderDecision({ ...base, stage: 12, expirablePence: 0 }), { decision: 'skip', reason: 'nothing_expirable' });
  assert.deepEqual(reminderDecision({ ...base, stage: 3, expirablePence: 0 }), { decision: 'send', reason: 'ok' });
  // No credit wins over the cap: skip, never wait.
  assert.equal(reminderDecision({ ...base, stage: 3, planCreditPence: 0, capUsedToday: true }).decision, 'skip');
});

test('expiryDue: only a sent final warning at least the notice days old', async () => {
  const { expiryDue } = await import('./rollover.ts');
  const sent = '2027-11-20T06:43:00Z';
  assert.equal(expiryDue({ finalNoticeSentAt: null, now: at('2028-06-01T00:00:00Z'), finalNoticeDays: 30 }), false);
  assert.equal(expiryDue({ finalNoticeSentAt: undefined, now: at('2028-06-01T00:00:00Z'), finalNoticeDays: 30 }), false);
  assert.equal(expiryDue({ finalNoticeSentAt: sent, now: at('2027-12-20T06:42:59Z'), finalNoticeDays: 30 }), false);
  assert.equal(expiryDue({ finalNoticeSentAt: sent, now: at('2027-12-20T06:43:00Z'), finalNoticeDays: 30 }), true);
  assert.equal(expiryDue({ finalNoticeSentAt: new Date(sent), now: at('2028-01-01T00:00:00Z'), finalNoticeDays: 30 }), true);
  assert.equal(expiryDue({ finalNoticeSentAt: 'garbage', now: at('2028-01-01T00:00:00Z'), finalNoticeDays: 30 }), false);
});
