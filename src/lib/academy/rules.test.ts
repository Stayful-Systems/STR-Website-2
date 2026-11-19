import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACADEMY_FACTS,
  academyTrialEnd,
  daysBeforeTrialEnd,
  emailKey,
  linkDecision,
  maskEmail,
  reminderDecision,
  trialMonthDue,
  trialSlotKey,
  trialSlots,
  type LinkInput,
  type ReminderState,
} from './rules.ts';

const DAY = 86_400_000;

function input(over: {
  purchase?: Partial<LinkInput['purchase']>;
  profile?: Partial<LinkInput['profile']>;
  rest?: Partial<Omit<LinkInput, 'purchase' | 'profile'>>;
} = {}): LinkInput {
  return {
    purchase: {
      email: 'jo@gmail.com',
      stripeCustomerId: 'cus_academy',
      stripePaymentMethodId: 'pm_card',
      trialSubscriptionId: null,
      userId: null,
      refundedAt: null,
      termsAcceptedAt: '2026-11-19T10:00:00Z',
      ...over.purchase,
    },
    profile: {
      id: 'user-1',
      email: 'Jo@Gmail.com ',
      emailConfirmed: true,
      stripeCustomerId: null,
      isTeamMember: false,
      ...over.profile,
    },
    profileCustomerHasLivePlan: false,
    purchaseCustomerHasLivePlan: false,
    emailHadEarlierTrial: false,
    by: 'auto',
    ...over.rest,
  };
}

test('the facts are the agreed figures', () => {
  assert.deepEqual({ ...ACADEMY_FACTS }, { trialDays: 90, trialMonths: 3, reminderDaysBefore: 7, reminderLatestDaysBefore: 5, chaseUnlinkedDays: 14 });
});

test('emailKey trims and lower-cases; maskEmail never shows the full address', () => {
  assert.equal(emailKey('  Jo.Bloggs@GMail.com '), 'jo.bloggs@gmail.com');
  assert.equal(maskEmail('Jane@gmail.com'), 'j•••@gmail.com');
  assert.equal(maskEmail(' x@y.co.uk'), 'x•••@y.co.uk');
  assert.equal(maskEmail('nope'), '•••');
  assert.equal(maskEmail('@gmail.com'), '•••');
  assert.equal(maskEmail('jo@'), '•••');
});

test('trialSlotKey is trial:<subscription>:<YYYY-MM>', () => {
  assert.equal(trialSlotKey('sub_123', '2026-11'), 'trial:sub_123:2026-11');
});

test('link: a matching confirmed account with no customer takes the purchase customer', () => {
  assert.deepEqual(linkDecision(input()), { decision: 'start', customer: 'use_purchase_customer', customerId: 'cus_academy', previousCustomerId: null });
});

test('link: a non-matching email does not auto-link, but admin may link it by hand', () => {
  const other = { profile: { email: 'someone@else.com' } };
  assert.deepEqual(linkDecision(input(other)), { decision: 'refuse_email_mismatch' });
  assert.deepEqual(linkDecision(input({ profile: { email: null } })), { decision: 'refuse_email_mismatch' });
  assert.equal(linkDecision(input({ ...other, rest: { by: 'admin' } })).decision, 'start');
});

test('link: a live plan on either customer is refused', () => {
  assert.deepEqual(linkDecision(input({ profile: { stripeCustomerId: 'cus_old' }, rest: { profileCustomerHasLivePlan: true } })), { decision: 'refuse_live_plan' });
  assert.deepEqual(linkDecision(input({ rest: { purchaseCustomerHasLivePlan: true } })), { decision: 'refuse_live_plan' });
  assert.deepEqual(
    linkDecision(input({ profile: { stripeCustomerId: 'cus_academy' }, rest: { profileCustomerHasLivePlan: true, purchaseCustomerHasLivePlan: true } })),
    { decision: 'refuse_live_plan' },
  );
  // Admin cannot override a live plan either.
  assert.deepEqual(linkDecision(input({ profile: { stripeCustomerId: 'cus_old' }, rest: { profileCustomerHasLivePlan: true, by: 'admin' } })), { decision: 'refuse_live_plan' });
});

test('link: every refusal', () => {
  assert.deepEqual(linkDecision(input({ rest: { emailHadEarlierTrial: true } })), { decision: 'refuse_repeat_purchase' });
  assert.deepEqual(linkDecision(input({ profile: { emailConfirmed: false } })), { decision: 'refuse_unconfirmed_email' });
  assert.deepEqual(linkDecision(input({ profile: { emailConfirmed: false }, rest: { by: 'admin' } })), { decision: 'refuse_unconfirmed_email' });
  assert.deepEqual(linkDecision(input({ purchase: { refundedAt: '2026-11-20T00:00:00Z' } })), { decision: 'refuse_refunded' });
  assert.deepEqual(linkDecision(input({ profile: { isTeamMember: true } })), { decision: 'refuse_team_member' });
  assert.deepEqual(linkDecision(input({ purchase: { termsAcceptedAt: null } })), { decision: 'refuse_no_consent' });
  assert.deepEqual(linkDecision(input({ purchase: { stripePaymentMethodId: null } })), { decision: 'refuse_no_card' });
  assert.deepEqual(linkDecision(input({ purchase: { stripeCustomerId: null } })), { decision: 'refuse_no_card' });
});

test('link: a purchase whose trial already exists is "already", whatever else is true', () => {
  assert.deepEqual(
    linkDecision(input({ purchase: { trialSubscriptionId: 'sub_1', userId: 'user-1', refundedAt: new Date() }, rest: { profileCustomerHasLivePlan: true } })),
    { decision: 'already', userId: 'user-1' },
  );
});

test('link: customer actions', () => {
  assert.deepEqual(linkDecision(input({ profile: { stripeCustomerId: 'cus_academy' } })), { decision: 'start', customer: 'same_customer', customerId: 'cus_academy', previousCustomerId: null });
  assert.deepEqual(linkDecision(input({ profile: { stripeCustomerId: 'cus_old' } })), { decision: 'start', customer: 'switch_to_purchase_customer', customerId: 'cus_academy', previousCustomerId: 'cus_old' });
});

test('trial slots: a start on every day of every month (and leap February) gives 3 contiguous slots ending at the trial end', () => {
  const years = [2026, 2028]; // 2028 is a leap year
  for (const year of years) {
    for (let month = 0; month < 12; month++) {
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      for (let day = 1; day <= 31; day++) {
        if (day > daysInMonth) continue;
        const start = new Date(Date.UTC(year, month, day, 14, 7, 3));
        const end = academyTrialEnd(start);
        assert.equal(end.getTime() - start.getTime(), 90 * DAY);
        const slots = trialSlots(start, end);
        const label = start.toISOString();
        assert.equal(slots.length, 3, label);
        assert.equal(new Set(slots.map((s) => s.key)).size, 3, `${label}: ${slots.map((s) => s.key).join(',')}`);
        assert.equal(slots[0].from.getTime(), start.getTime(), label);
        assert.equal(slots[2].to.getTime(), end.getTime(), label);
        for (let i = 0; i < 3; i++) assert.ok(slots[i].from.getTime() < slots[i].to.getTime(), `${label} slot ${i} non-empty`);
        for (let i = 1; i < 3; i++) assert.equal(slots[i].from.getTime(), slots[i - 1].to.getTime(), `${label} contiguous`);

        // A daily sweep from day 0 to day 100 grants each due slot once (the grant key refuses replays).
        const granted = new Set<string>();
        const grants: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
        for (let d = 0; d <= 100; d++) {
          const slot = trialMonthDue(start, end, new Date(start.getTime() + d * DAY));
          if (!slot) continue;
          const key = trialSlotKey('sub_x', slot.key);
          if (granted.has(key)) continue;
          granted.add(key);
          grants[slot.slot]++;
        }
        assert.equal(granted.size, 3, label);
        assert.deepEqual(grants, { 0: 1, 1: 1, 2: 1 }, label);
      }
    }
  }
});

test('trialMonthDue: nothing before the start or from the trial end', () => {
  const start = new Date('2026-11-30T08:00:00Z');
  const end = academyTrialEnd(start);
  assert.equal(trialMonthDue(start, end, new Date(start.getTime() - 1)), null);
  assert.equal(trialMonthDue(start, end, end), null);
  assert.equal(trialMonthDue(start, end, new Date(end.getTime() - 1))?.slot, 2);
  assert.equal(trialMonthDue(start, end, start)?.key, '2026-11');
});

const fresh: ReminderState = { slotFree: true, sentAt: null, trialing: true, cancelling: false, refunded: false };

test('daysBeforeTrialEnd rounds the time left up to whole days', () => {
  const end = new Date('2027-02-20T10:00:00Z');
  assert.equal(daysBeforeTrialEnd(end, new Date(end.getTime() - 7 * DAY)), 7);
  assert.equal(daysBeforeTrialEnd(end, new Date(end.getTime() - 7 * DAY - 1)), 8);
  assert.equal(daysBeforeTrialEnd(end, new Date(end.getTime() - 6 * DAY - 1)), 7);
  assert.equal(daysBeforeTrialEnd(end, new Date(end.getTime() - 1)), 1);
  assert.equal(daysBeforeTrialEnd(end, end), 0);
});

test('reminder decision boundaries', () => {
  const end = new Date('2027-02-20T10:00:00Z');
  const at = (ms: number) => new Date(end.getTime() - ms);
  // More than 7 days left: not yet.
  assert.equal(reminderDecision(end, at(7 * DAY + 1), fresh), 'not_yet');
  assert.equal(reminderDecision(end, at(30 * DAY), fresh), 'not_yet');
  // 7 days left (exactly, and just under): send with a free slot, wait without.
  assert.equal(reminderDecision(end, at(7 * DAY), fresh), 'send');
  assert.equal(reminderDecision(end, at(7 * DAY), { ...fresh, slotFree: false }), 'wait');
  // 6 days left: same.
  assert.equal(reminderDecision(end, at(6 * DAY), fresh), 'send');
  assert.equal(reminderDecision(end, at(5 * DAY + 1), { ...fresh, slotFree: false }), 'wait');
  // 5 days or fewer: send anyway, slot or not.
  assert.equal(reminderDecision(end, at(5 * DAY), { ...fresh, slotFree: false }), 'send_anyway');
  assert.equal(reminderDecision(end, at(5 * DAY), fresh), 'send_anyway');
  assert.equal(reminderDecision(end, at(1), { ...fresh, slotFree: false }), 'send_anyway');
  // Ended: skip.
  assert.equal(reminderDecision(end, end, fresh), 'skip');
  assert.equal(reminderDecision(end, new Date(end.getTime() + DAY), fresh), 'skip');
  // Already sent, not trialing, cancelling or refunded: skip, even on day 7.
  for (const s of [{ sentAt: '2027-02-13T06:00:00Z' }, { trialing: false }, { cancelling: true }, { refunded: true }]) {
    assert.equal(reminderDecision(end, at(7 * DAY), { ...fresh, ...s }), 'skip', JSON.stringify(s));
    assert.equal(reminderDecision(end, at(3 * DAY), { ...fresh, ...s }), 'skip', JSON.stringify(s));
  }
});

test('a daily cron with the slot always taken sends exactly once, 5 days before', () => {
  const end = new Date('2027-02-20T10:00:00Z');
  let sentAt: Date | null = null;
  const outcomes: string[] = [];
  for (let d = 0; d <= 92; d++) {
    const now = new Date(end.getTime() - 90 * DAY + d * DAY - 4 * 3_600_000); // 06:00 runs
    const r = reminderDecision(end, now, { ...fresh, slotFree: false, sentAt });
    if (r === 'send' || r === 'send_anyway') {
      sentAt = now;
      outcomes.push(`${r}@${daysBeforeTrialEnd(end, now)}`);
    }
  }
  assert.deepEqual(outcomes, ['send_anyway@5']);
});
