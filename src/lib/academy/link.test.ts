import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelTrialForRefund,
  linkAcademyPurchase,
  linkPendingForUser,
  trialIdempotencyKey,
  unlinkAcademyPurchase,
  type AcademyLinkDeps,
  type AcademyProfileRow,
  type AcademyPurchaseRow,
  type AcademySubscription,
} from './link.ts';
import { ACADEMY_FACTS } from './rules.ts';
import { academyRefundEmail } from './emails.ts';

const NOW = new Date('2026-11-19T10:00:00Z');
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function purchaseRow(over: Partial<AcademyPurchaseRow> = {}): AcademyPurchaseRow {
  return {
    id: 'p1',
    email: 'buyer@example.com',
    stripe_customer_id: 'cus_buy',
    stripe_payment_intent_id: 'pi_1',
    stripe_payment_method_id: 'pm_buy',
    user_id: null,
    linked_at: null,
    linked_by: null,
    trial_subscription_id: null,
    refunded_at: null,
    terms_accepted_at: '2026-11-18T10:00:00Z',
    trial_started_at: null,
    trial_ends_at: null,
    previous_customer_id: null,
    flag_reason: null,
    reminder_sent_at: null,
    trial_cancelled_at: null,
    ...over,
  };
}

function profileRow(over: Partial<AcademyProfileRow> = {}): AcademyProfileRow {
  return {
    id: 'u1',
    email: 'Buyer@Example.com',
    plan_code: 'free',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_subscription_status: null,
    stripe_default_payment_method_id: null,
    ...over,
  };
}

interface World {
  purchases: Map<string, AcademyPurchaseRow>;
  profiles: Map<string, AcademyProfileRow>;
  /** Subscriptions by customer. */
  subs: Map<string, AcademySubscription[]>;
  confirmed: Set<string>;
  team: Set<string>;
  paidInvoices: Set<string>;
}

function fake(init: { purchases?: AcademyPurchaseRow[]; profiles?: AcademyProfileRow[]; subs?: Record<string, AcademySubscription[]>; confirmed?: string[]; team?: string[]; paid?: string[] } = {}) {
  const world: World = {
    purchases: new Map((init.purchases ?? [purchaseRow()]).map((p) => [p.id, { ...p }])),
    profiles: new Map((init.profiles ?? [profileRow()]).map((p) => [p.id, { ...p }])),
    subs: new Map(Object.entries(init.subs ?? {}).map(([k, v]) => [k, v.map((s) => ({ ...s }))])),
    confirmed: new Set(init.confirmed ?? ['u1']),
    team: new Set(init.team ?? []),
    paidInvoices: new Set(init.paid ?? []),
  };
  const calls = {
    create: [] as Array<{ params: Record<string, unknown>; key: string }>,
    cancel: [] as string[],
    purchaseWrites: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    profileWrites: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    savedCards: [] as unknown[][],
    activity: [] as unknown[][],
    emails: [] as unknown[][],
    grants: [] as AcademyPurchaseRow[],
  };
  let n = 0;
  const allSubs = () => [...world.subs.values()].flat();
  const deps: AcademyLinkDeps = {
    now: () => NOW,
    proPriceId: () => 'price_pro',
    loadPurchase: async (id) => (world.purchases.has(id) ? { ...world.purchases.get(id)! } : null),
    loadPurchaseByPaymentIntent: async (pi) => {
      const p = [...world.purchases.values()].find((x) => x.stripe_payment_intent_id === pi);
      return p ? { ...p } : null;
    },
    listUnlinkedPurchases: async (email) => [...world.purchases.values()].filter((p) => p.email === email && !p.user_id && !p.trial_subscription_id && !p.refunded_at).map((p) => ({ ...p })),
    emailHadEarlierTrial: async (email, except) => [...world.purchases.values()].some((p) => p.email === email && p.id !== except && p.trial_subscription_id),
    updatePurchase: async (id, patch, where = {}) => {
      const row = world.purchases.get(id);
      if (!row) return false;
      for (const [k, v] of Object.entries(where)) if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
      Object.assign(row, patch);
      calls.purchaseWrites.push({ id, patch });
      return true;
    },
    loadProfile: async (id) => (world.profiles.has(id) ? { ...world.profiles.get(id)! } : null),
    updateProfile: async (id, patch) => {
      Object.assign(world.profiles.get(id)!, patch);
      calls.profileWrites.push({ id, patch });
    },
    emailConfirmed: async (id) => world.confirmed.has(id),
    isTeamMember: async (id) => world.team.has(id),
    listSubscriptions: async (customer) => (world.subs.get(customer) ?? []).map((s) => ({ ...s })),
    retrieveSubscription: async (id) => {
      const s = allSubs().find((x) => x.id === id);
      return s ? { ...s } : null;
    },
    createSubscription: async (params, key) => {
      calls.create.push({ params: params as unknown as Record<string, unknown>, key });
      const sub: AcademySubscription = {
        id: `sub_new${++n}`,
        status: 'trialing',
        metadata: params.metadata as Record<string, string>,
        trial_start: unix(NOW),
        trial_end: unix(NOW) + ACADEMY_FACTS.trialDays * 86_400,
      };
      const list = world.subs.get(params.customer as string) ?? [];
      list.push(sub);
      world.subs.set(params.customer as string, list);
      return { ...sub };
    },
    cancelSubscription: async (id) => {
      calls.cancel.push(id);
      const s = allSubs().find((x) => x.id === id)!;
      if (s.status === 'canceled') throw new Error('already canceled');
      s.status = 'canceled';
      return { ...s };
    },
    hasPaidInvoice: async (id) => world.paidInvoices.has(id),
    cardLast4: async () => '4242',
    savePaymentMethod: async (...a) => {
      calls.savedCards.push(a);
    },
    logTrialStarted: async (...a) => {
      calls.activity.push(a);
    },
    sendRefundEmail: async (...a) => {
      calls.emails.push(a);
      return true;
    },
    grantTrialMonth: async (purchase) => {
      calls.grants.push({ ...purchase });
      return true;
    },
  };
  return { deps, world, calls };
}

const writesExceptFlag = (calls: ReturnType<typeof fake>['calls']) =>
  calls.purchaseWrites.filter((w) => Object.keys(w.patch).some((k) => k !== 'flag_reason')).length + calls.profileWrites.length + calls.savedCards.length + calls.create.length + calls.cancel.length;

test('linking starts one Pro trial on the purchase customer; linking again is "already" and creates nothing', async () => {
  const { deps, world, calls } = fake();
  const first = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(first.outcome, 'start');
  assert.equal(first.done, true);
  assert.equal(first.customerAction, 'use_purchase_customer');
  assert.equal(first.cardLast4, '4242');
  assert.equal(calls.create.length, 1);
  const { params, key } = calls.create[0];
  assert.equal(key, trialIdempotencyKey('p1'));
  assert.equal(key, 'academy-trial:p1');
  assert.equal(params.customer, 'cus_buy');
  assert.deepEqual(params.items, [{ price: 'price_pro' }]);
  assert.equal(params.trial_period_days, ACADEMY_FACTS.trialDays);
  assert.equal(params.default_payment_method, 'pm_buy');
  assert.deepEqual(params.trial_settings, { end_behavior: { missing_payment_method: 'cancel' } });
  assert.deepEqual(params.metadata, { user_id: 'u1', plan_code: 'pro', source: 'academy', academy_purchase_id: 'p1' });
  assert.equal(params.automatic_tax, undefined);

  const row = world.purchases.get('p1')!;
  assert.equal(row.trial_subscription_id, 'sub_new1');
  assert.equal(row.user_id, 'u1');
  assert.equal(row.linked_by, 'auto');
  assert.equal(row.trial_started_at, NOW.toISOString());
  assert.equal(row.trial_ends_at, new Date(NOW.getTime() + 90 * 86_400_000).toISOString());
  const prof = world.profiles.get('u1')!;
  assert.equal(prof.stripe_customer_id, 'cus_buy');
  assert.equal(prof.stripe_subscription_id, 'sub_new1');
  assert.equal(prof.stripe_subscription_status, 'trialing');
  assert.deepEqual(calls.savedCards, [['u1', 'cus_buy', 'pm_buy']]);
  assert.deepEqual(calls.activity, [['u1', 'sub_new1']]);

  const second = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(second.outcome, 'already');
  assert.equal(second.subscriptionId, 'sub_new1');
  assert.equal(calls.create.length, 1);
});

test('automatic tax is asked for only when configured', async () => {
  const { deps, calls } = fake();
  deps.automaticTax = true;
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.deepEqual(calls.create[0].params.automatic_tax, { enabled: true });
});

test('a member with a live plan is refused: nothing created or written except flag_reason', async () => {
  const { deps, world, calls } = fake({
    profiles: [profileRow({ stripe_customer_id: 'cus_old' })],
    subs: { cus_old: [{ id: 'sub_old', status: 'active' }] },
  });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.outcome, 'refused');
  assert.equal(r.decision, 'refuse_live_plan');
  assert.equal(world.purchases.get('p1')!.flag_reason, 'live_plan');
  assert.equal(writesExceptFlag(calls), 0);
});

test('a live plan on the purchase customer itself is refused too', async () => {
  const { deps, calls } = fake({ subs: { cus_buy: [{ id: 'sub_x', status: 'past_due' }] } });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.decision, 'refuse_live_plan');
  assert.equal(writesExceptFlag(calls), 0);
});

test('a non-matching email does not auto-link; admin can link it', async () => {
  const { deps, world, calls } = fake({ profiles: [profileRow({ email: 'someone@else.com' })] });
  const auto = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(auto.decision, 'refuse_email_mismatch');
  assert.equal(world.purchases.get('p1')!.flag_reason, 'email_mismatch');
  assert.equal(calls.create.length, 0);

  const admin = await linkAcademyPurchase(deps, 'p1', 'u1', 'admin');
  assert.equal(admin.outcome, 'start');
  assert.equal(calls.create.length, 1);
  const row = world.purchases.get('p1')!;
  assert.equal(row.linked_by, 'admin');
  assert.equal(row.flag_reason, null);
});

test('an unconfirmed sign-in email is refused', async () => {
  const { deps, world, calls } = fake({ confirmed: [] });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'admin');
  assert.equal(r.decision, 'refuse_unconfirmed_email');
  assert.equal(world.purchases.get('p1')!.flag_reason, 'unconfirmed_email');
  assert.equal(writesExceptFlag(calls), 0);
});

test('a refunded purchase is refused', async () => {
  const { deps, calls } = fake({ purchases: [purchaseRow({ refunded_at: '2026-11-18T12:00:00Z' })] });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'admin');
  assert.equal(r.decision, 'refuse_refunded');
  assert.equal(writesExceptFlag(calls), 0);
});

test('a team member is refused', async () => {
  const { deps, calls } = fake({ team: ['u1'] });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.decision, 'refuse_team_member');
  assert.equal(writesExceptFlag(calls), 0);
});

test('a second purchase by the same email is refused (one trial per buyer)', async () => {
  const { deps, world } = fake({ purchases: [purchaseRow({ id: 'p0', stripe_payment_intent_id: 'pi_0', trial_subscription_id: 'sub_earlier', user_id: 'u9' }), purchaseRow()] });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.decision, 'refuse_repeat_purchase');
  assert.equal(world.purchases.get('p1')!.flag_reason, 'repeat_purchase');
});

test('a profile with a different customer and no live plan switches to the purchase customer, keeping the old id', async () => {
  const { deps, world, calls } = fake({
    profiles: [profileRow({ stripe_customer_id: 'cus_old' })],
    subs: { cus_old: [{ id: 'sub_gone', status: 'canceled' }] },
  });
  const dry = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto', { dry: true });
  assert.equal(dry.customerAction, 'switch_to_purchase_customer');
  assert.equal(dry.profileCustomerChanges, true);
  assert.equal(dry.profileCustomerBefore, 'cus_old');
  assert.equal(dry.previousCustomerId, 'cus_old');

  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.outcome, 'start');
  assert.equal(world.purchases.get('p1')!.previous_customer_id, 'cus_old');
  assert.equal(world.profiles.get('u1')!.stripe_customer_id, 'cus_buy');
  assert.equal(calls.create[0].params.customer, 'cus_buy');
  assert.equal(calls.cancel.length, 0, 'the old customer is never touched');
});

test('a profile with a different customer holding a live plan is refused', async () => {
  const { deps, world, calls } = fake({
    profiles: [profileRow({ stripe_customer_id: 'cus_old' })],
    subs: { cus_old: [{ id: 'sub_old', status: 'trialing' }] },
  });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.decision, 'refuse_live_plan');
  assert.equal(world.profiles.get('u1')!.stripe_customer_id, 'cus_old');
  assert.equal(writesExceptFlag(calls), 0);
});

test('a trial subscription already in Stripe for this purchase (found by metadata) is reused, not created again', async () => {
  const start = unix(new Date('2026-11-18T09:00:00Z'));
  const { deps, world, calls } = fake({
    subs: { cus_buy: [{ id: 'sub_prev', status: 'trialing', metadata: { academy_purchase_id: 'p1' }, trial_start: start, trial_end: start + 90 * 86_400 }] },
  });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.outcome, 'start');
  assert.equal(r.reusedSubscription, true);
  assert.equal(r.subscriptionId, 'sub_prev');
  assert.equal(calls.create.length, 0);
  assert.equal(world.purchases.get('p1')!.trial_subscription_id, 'sub_prev');
  assert.equal(world.purchases.get('p1')!.trial_started_at, new Date(start * 1000).toISOString());
});

test('a dry run says what would happen and makes no writes or Stripe changes', async () => {
  const { deps, world, calls } = fake();
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto', { dry: true });
  assert.equal(r.outcome, 'start');
  assert.equal(r.dry, true);
  assert.equal(r.done, false);
  assert.equal(r.customerId, 'cus_buy');
  assert.equal(r.cardLast4, '4242');
  assert.equal(r.trialStart, NOW.toISOString());
  assert.equal(r.trialEnd, new Date(NOW.getTime() + 90 * 86_400_000).toISOString());
  assert.equal(calls.purchaseWrites.length + writesExceptFlag(calls) + calls.activity.length, 0);
  assert.equal(world.purchases.get('p1')!.trial_subscription_id, null);

  // A refusal in a dry run writes no flag either.
  const f2 = fake({ confirmed: [] });
  const refused = await linkAcademyPurchase(f2.deps, 'p1', 'u1', 'auto', { dry: true });
  assert.equal(refused.outcome, 'refused');
  assert.equal(f2.calls.purchaseWrites.length, 0);
});

test('a successful link grants month 1 at once (once); a dry run, a refusal or a lost claim does not', async () => {
  const { deps, world, calls } = fake();
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.outcome, 'start');
  assert.equal(calls.grants.length, 1);
  const g = calls.grants[0];
  assert.equal(g.id, 'p1');
  assert.equal(g.user_id, 'u1');
  assert.equal(g.trial_subscription_id, r.subscriptionId);
  assert.equal(g.trial_started_at, world.purchases.get('p1')!.trial_started_at);
  assert.equal(g.trial_ends_at, world.purchases.get('p1')!.trial_ends_at);
  assert.equal(world.profiles.get('u1')!.stripe_subscription_status, 'trialing', 'the profile is stamped before the grant');

  // Linking again is "already": no second grant from here.
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(calls.grants.length, 1);

  const dry = fake();
  await linkAcademyPurchase(dry.deps, 'p1', 'u1', 'auto', { dry: true });
  assert.equal(dry.calls.grants.length, 0);

  const refused = fake({ confirmed: [] });
  assert.equal((await linkAcademyPurchase(refused.deps, 'p1', 'u1', 'auto')).outcome, 'refused');
  assert.equal(refused.calls.grants.length, 0);
});

test('a failed month-1 grant is logged and swallowed; the link still succeeds', async () => {
  const { deps, calls } = fake();
  deps.grantTrialMonth = async () => {
    throw new Error('ledger down');
  };
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
    assert.equal(r.outcome, 'start');
    assert.equal(r.done, true);
  } finally {
    console.error = realError;
  }
  assert.equal(calls.activity.length, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /month-1 grant for purchase p1/);
  assert.doesNotMatch(errors.flat().join(' '), /@/, 'ids only, never an email');
});

test('when another run linked the purchase first, nothing more is created and a stray subscription is cancelled', async () => {
  const { deps, world, calls } = fake();
  const realUpdate = deps.updatePurchase;
  deps.updatePurchase = async (id, patch, where) => {
    if ('trial_subscription_id' in patch && patch.trial_subscription_id) {
      // A concurrent run won with its own subscription.
      world.purchases.get(id)!.trial_subscription_id = 'sub_winner';
      world.purchases.get(id)!.user_id = 'u1';
    }
    return realUpdate(id, patch, where);
  };
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(r.outcome, 'already');
  assert.equal(r.subscriptionId, 'sub_winner');
  assert.deepEqual(calls.cancel, ['sub_new1']);
  assert.equal(calls.activity.length, 0);
  assert.equal(calls.grants.length, 0, 'the losing run grants nothing');
  assert.equal(world.profiles.get('u1')!.stripe_subscription_id, null);
});

test('linkPendingForUser links the unlinked purchases made with the account email', async () => {
  const { deps, calls } = fake({ purchases: [purchaseRow(), purchaseRow({ id: 'p2', email: 'other@example.com', stripe_payment_intent_id: 'pi_2' })] });
  const out = await linkPendingForUser(deps, 'u1');
  assert.equal(out.length, 1);
  assert.equal(out[0].purchaseId, 'p1');
  assert.equal(out[0].by, 'auto');
  assert.equal(calls.create.length, 1);
  assert.deepEqual(await linkPendingForUser(deps, 'u1'), []);
});

test('unlink cancels the trial and frees the purchase; the profile goes back to its old customer', async () => {
  const { deps, world, calls } = fake({ profiles: [profileRow({ stripe_customer_id: 'cus_old' })] });
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  world.profiles.get('u1')!.stripe_default_payment_method_id = 'pm_buy';

  const dry = await unlinkAcademyPurchase(deps, 'p1', { dry: true });
  assert.equal(dry.outcome, 'unlink');
  assert.equal(dry.cancelsSubscription, true);
  assert.equal(dry.restoredCustomerId, 'cus_old');
  assert.equal(calls.cancel.length, 0);

  const r = await unlinkAcademyPurchase(deps, 'p1');
  assert.equal(r.done, true);
  assert.deepEqual(calls.cancel, ['sub_new1']);
  const row = world.purchases.get('p1')!;
  assert.equal(row.user_id, null);
  assert.equal(row.trial_subscription_id, null);
  assert.equal(row.trial_started_at, null);
  assert.equal(row.linked_by, null);
  assert.equal(row.trial_cancelled_at, NOW.toISOString());
  const prof = world.profiles.get('u1')!;
  assert.equal(prof.stripe_customer_id, 'cus_old');
  assert.equal(prof.stripe_default_payment_method_id, null);
});

test('unlink is refused once an invoice has been paid', async () => {
  const { deps, world, calls } = fake({ paid: ['sub_new1'] });
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  const r = await unlinkAcademyPurchase(deps, 'p1');
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, 'paid_invoice');
  assert.equal(calls.cancel.length, 0);
  assert.equal(world.purchases.get('p1')!.trial_subscription_id, 'sub_new1');
});

test('a full refund while trialing cancels the trial and sends one email; a second call changes nothing', async () => {
  const { deps, world, calls } = fake();
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  const r = await cancelTrialForRefund(deps, 'pi_1', true);
  assert.equal(r.outcome, 'trial_cancelled');
  assert.equal(r.emailSent, true);
  assert.deepEqual(calls.cancel, ['sub_new1']);
  assert.deepEqual(calls.emails, [['Buyer@Example.com', 'p1']]);
  const row = world.purchases.get('p1')!;
  assert.equal(row.refunded_at, NOW.toISOString());
  assert.equal(row.trial_cancelled_at, NOW.toISOString());

  const again = await cancelTrialForRefund(deps, 'pi_1', true);
  assert.equal(again.outcome, 'already');
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.emails.length, 1);
});

test('a partial refund is recorded only: no cancel, no email, refunded_at left empty', async () => {
  const { deps, world, calls } = fake();
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  const r = await cancelTrialForRefund(deps, 'pi_1', false);
  assert.equal(r.outcome, 'partial');
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.emails.length, 0);
  assert.equal(world.purchases.get('p1')!.refunded_at, null);
});

test('a full refund of an unlinked purchase marks it refunded (never linkable) with no email', async () => {
  const { deps, world, calls } = fake();
  const r = await cancelTrialForRefund(deps, 'pi_1', true);
  assert.equal(r.outcome, 'refunded');
  assert.equal(calls.emails.length, 0);
  assert.ok(world.purchases.get('p1')!.refunded_at);
  const link = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(link.decision, 'refuse_refunded');
  assert.equal((await cancelTrialForRefund(deps, 'pi_x', true)).outcome, 'not_found');
});

test('the refund email has the agreed subject and body', () => {
  const e = academyRefundEmail({ siteUrl: 'https://example.test/' });
  assert.equal(e.subject, 'Your Academy refund');
  const body = "Your Stayful Academy purchase has been refunded, so your free months of Stayful Intelligence Pro have ended today. You won't be charged anything. Your account, deals and history stay as they are on the free plan.";
  assert.ok(e.text.startsWith(body));
  assert.ok(e.html.includes('won&#39;t') || e.html.includes("won't"));
  assert.ok(e.html.includes('https://example.test/account/billing'));
});

test('after an admin Unlink the automatic paths skip the purchase; only an admin link takes it', async () => {
  const { deps, world, calls } = fake();
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  await unlinkAcademyPurchase(deps, 'p1');
  assert.equal(world.purchases.get('p1')!.flag_reason, 'unlinked_admin');

  const auto = await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  assert.equal(auto.outcome, 'refused');
  assert.equal(auto.reason, 'unlinked_admin');
  assert.deepEqual(await linkPendingForUser(deps, 'u1'), []);
  assert.equal(calls.create.length, 1);
  assert.equal(world.purchases.get('p1')!.trial_subscription_id, null);
  assert.equal(world.purchases.get('p1')!.flag_reason, 'unlinked_admin');

  // A refused admin relink keeps the flag, so the purchase never becomes auto-linkable.
  world.confirmed.delete('u1');
  const refused = await linkAcademyPurchase(deps, 'p1', 'u1', 'admin');
  assert.equal(refused.decision, 'refuse_unconfirmed_email');
  assert.equal(world.purchases.get('p1')!.flag_reason, 'unlinked_admin');
});

test('an admin relink after Unlink uses a fresh idempotency key and starts a new trial', async () => {
  const { deps, world, calls } = fake();
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  await unlinkAcademyPurchase(deps, 'p1');
  const cancelledAt = world.purchases.get('p1')!.trial_cancelled_at!;
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'admin');
  assert.equal(r.outcome, 'start');
  assert.equal(r.done, true);
  assert.equal(calls.create.length, 2);
  assert.equal(calls.create[0].key, 'academy-trial:p1');
  assert.equal(calls.create[1].key, `academy-trial:p1:${Date.parse(cancelledAt)}`);
  assert.equal(trialIdempotencyKey('p1', cancelledAt), calls.create[1].key);
  const row = world.purchases.get('p1')!;
  assert.equal(row.trial_subscription_id, 'sub_new2');
  assert.equal(row.flag_reason, null);
  assert.equal(row.linked_by, 'admin');
});

test('a cancelled subscription handed back by Stripe is never recorded', async () => {
  const { deps, world, calls } = fake();
  const realCreate = deps.createSubscription;
  deps.createSubscription = async (params, key) => ({ ...(await realCreate(params, key)), status: 'canceled' });
  const r = await linkAcademyPurchase(deps, 'p1', 'u1', 'admin');
  assert.equal(r.outcome, 'error');
  assert.equal(r.reason, 'subscription_not_trialing');
  assert.equal(world.purchases.get('p1')!.trial_subscription_id, null);
  assert.equal(world.purchases.get('p1')!.user_id, null);
  assert.equal(calls.profileWrites.length, 0);
  assert.equal(calls.savedCards.length, 0);
  assert.equal(calls.activity.length, 0);
});

test('when creating the subscription fails, the profile customer and card are untouched', async () => {
  const { deps, world, calls } = fake({
    profiles: [profileRow({ stripe_customer_id: 'cus_old' })],
    subs: { cus_old: [{ id: 'sub_gone', status: 'canceled' }] },
  });
  deps.createSubscription = async () => {
    throw new Error('stripe down');
  };
  await assert.rejects(linkAcademyPurchase(deps, 'p1', 'u1', 'auto'), /stripe down/);
  assert.equal(world.profiles.get('u1')!.stripe_customer_id, 'cus_old');
  assert.equal(calls.profileWrites.length, 0);
  assert.equal(calls.savedCards.length, 0);
  assert.equal(calls.purchaseWrites.length, 0);
});

test('a full refund of a trial already cancelled in Stripe still stamps it and sends the email once', async () => {
  const { deps, world, calls } = fake();
  await linkAcademyPurchase(deps, 'p1', 'u1', 'auto');
  world.subs.get('cus_buy')![0].status = 'canceled';
  const r = await cancelTrialForRefund(deps, 'pi_1', true);
  assert.equal(r.outcome, 'trial_cancelled');
  assert.equal(calls.cancel.length, 0);
  assert.equal(world.purchases.get('p1')!.trial_cancelled_at, NOW.toISOString());
  assert.deepEqual(calls.emails, [['Buyer@Example.com', 'p1']]);
  const again = await cancelTrialForRefund(deps, 'pi_1', true);
  assert.equal(again.outcome, 'already');
  assert.equal(calls.emails.length, 1);
});
