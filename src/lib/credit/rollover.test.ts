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
