import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { handleStripeEvent, reasonFromStripeFeedback, type WebhookActivity, type WebhookDeps } from './webhook.ts';
import type { SubscriptionEventInput } from '../billing/subscription-events.ts';
import { dedupeKeyFor, purchaseFromPack, repeatPurchaseDue, repeatValue, subscribeFromInvoice } from '../meta/events.ts';
import { clawbackDue, refundedShare, thisCycleGrants, trialEndedUnpaid, upgradeTopUpPence } from './plan-credit.ts';
import { planSourcePattern } from '../credit/ledger.ts';

const env = { STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_PRO_ANNUAL: 'price_annual' };

function fakeDeps() {
  const calls: Record<string, unknown[][]> = {};
  const rec = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const user = {
    id: 'u1',
    email: 'a@example.com',
    plan_code: 'starter' as string | null,
    cancel_reason: null as string | null,
    cancel_reason_comment: null as string | null,
    subscription_cancel_at: null as string | null,
    subscription_paused_until: null as string | null,
    stripe_subscription_status: null as string | null,
  };
  const sub = (priceId: string, status = 'active', cancel = false): Stripe.Subscription =>
    ({ id: 'sub_1', status, cancel_at_period_end: cancel, customer: 'cus_1', items: { data: [{ price: { id: priceId }, current_period_end: 1_800_000_000 }] } }) as unknown as Stripe.Subscription;
  let subscription: Stripe.Subscription | null = sub('price_starter');
  const events: SubscriptionEventInput[] = [];
  const activity: WebhookActivity[] = [];
  const deps: WebhookDeps & {
    calls: typeof calls;
    setSub: (s: Stripe.Subscription | null) => void;
    events: SubscriptionEventInput[];
    activity: WebhookActivity[];
    user: typeof user;
  } = {
    events,
    activity,
    user,
    env,
    calls,
    setSub: (s) => {
      subscription = s;
    },
    findUserBySubscription: async (id) => (id === 'sub_1' ? user : null),
    findUserByCustomer: async (id) => (id === 'cus_1' ? user : null),
    findUserByEmail: async (e) => (e === user.email ? user : null),
    findUserById: async (id) => (id === 'u1' ? user : null),
    updateProfile: async (...a) => rec('updateProfile')(...a),
    grantPlanCycle: async (...a) => rec('grantPlanCycle')(...a),
    grantUpgradeDifference: async (...a) => rec('grantUpgradeDifference')(...a),
    grantTopup: async (...a) => {
      rec('grantTopup')(...a);
      return true;
    },
    savePaymentMethod: async (...a) => rec('savePaymentMethod')(...a),
    retrievePaymentIntent: async (id) => ({ id, payment_method: 'pm_1', customer: 'cus_1', amount: 2500, amount_received: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } }) as unknown as Stripe.PaymentIntent,
    retrieveSubscription: async () => subscription,
    refundTopup: async (...a) => rec('refundTopup')(...a),
    onSubscriptionStarted: async (...a) => rec('onSubscriptionStarted')(...a),
    onSubscriptionCancelled: async (...a) => rec('onSubscriptionCancelled')(...a),
    paymentFailedEmail: async (...a) => rec('paymentFailedEmail')(...a),
    cardNeedsUpdateEmail: async (...a) => rec('cardNeedsUpdateEmail')(...a),
    recordSubscriptionEvent: async (input) => {
      events.push(input);
    },
    logActivity: async (input) => {
      activity.push(input);
    },
    restoreDisputedCredit: async (...a) => {
      rec('restoreDisputedCredit')(...a);
      return 2500;
    },
    log: () => {},
  };
  return deps;
}

const ev = (type: string, object: unknown): Stripe.Event => ({ id: `evt_${type}`, type, data: { object } }) as unknown as Stripe.Event;

test('invoice.paid on subscription_create grants a plan cycle expiring at the period end', async () => {
  const deps = fakeDeps();
  const invoice = { id: 'in_1', customer: 'cus_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end: 1_800_000_000 }, pricing: { price_details: { price: 'price_starter' } } }] } };
  const r = await handleStripeEvent(ev('invoice.paid', invoice), deps);
  assert.equal(r.handled, true);
  const [userId, planCode, sourceRef, periodEnd] = deps.calls.grantPlanCycle![0];
  assert.equal(userId, 'u1');
  assert.equal(planCode, 'starter');
  assert.equal(sourceRef, 'inv:in_1');
  assert.equal((periodEnd as Date).getTime(), 1_800_000_000 * 1000);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.stripe_price_id, 'price_starter');
  assert.equal(patch.plan, 'pro');
});

test('invoice.paid with subscription_update grants the upgrade difference, not a new cycle', async () => {
  const deps = fakeDeps();
  deps.setSub({ id: 'sub_1', status: 'active', cancel_at_period_end: false, customer: 'cus_1', items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_800_000_000 }] } } as unknown as Stripe.Subscription);
  const invoice = { id: 'in_2', customer: 'cus_1', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [] } };
  const r = await handleStripeEvent(ev('invoice.paid', invoice), deps);
  assert.equal(r.handled, true);
  assert.equal(deps.calls.grantPlanCycle, undefined);
  const [, from, to, ref] = deps.calls.grantUpgradeDifference![0];
  assert.equal(from, 'starter');
  assert.equal(to, 'pro');
  assert.equal(ref, 'inv:in_2');
});

test('annual invoices grant one month now with an annual: source ref', async () => {
  const deps = fakeDeps();
  deps.setSub({ id: 'sub_1', status: 'active', cancel_at_period_end: false, customer: 'cus_1', items: { data: [{ price: { id: 'price_annual' }, current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400 }] } } as unknown as Stripe.Subscription);
  const invoice = { id: 'in_3', customer: 'cus_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [] } };
  await handleStripeEvent(ev('invoice.paid', invoice), deps);
  const [, planCode, sourceRef, periodEnd] = deps.calls.grantPlanCycle![0];
  assert.equal(planCode, 'pro_annual');
  assert.match(String(sourceRef), /^annual:sub_1:\d{4}-\d{2}$/);
  const days = ((periodEnd as Date).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 27 && days < 32, `month slot expiry, got ${days} days`);
});

test('invoice.paid for an unknown price is ignored', async () => {
  const deps = fakeDeps();
  deps.setSub({ id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_other' }, current_period_end: 1 }] } } as unknown as Stripe.Subscription);
  const r = await handleStripeEvent(ev('invoice.paid', { id: 'in_4', customer: 'cus_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [] } }), deps);
  assert.equal(r.handled, false);
  assert.equal(deps.calls.grantPlanCycle, undefined);
});

test('subscription deleted drops the plan but keeps its plan credit (Batch 32)', async () => {
  const deps = fakeDeps();
  const r = await handleStripeEvent(ev('customer.subscription.deleted', { id: 'sub_1', status: 'canceled', customer: 'cus_1', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1 }] } }), deps);
  assert.equal(r.handled, true);
  assert.match(r.note ?? '', /plan credit kept/);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.plan_code, null);
  assert.equal(patch.plan, 'free');
  assert.equal(deps.calls.onSubscriptionCancelled![0][0], 'a@example.com');
});

test('subscription updated with cancel_at_period_end keeps the plan and credit', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('customer.subscription.updated', { id: 'sub_1', status: 'active', customer: 'cus_1', cancel_at_period_end: true, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } }), deps);
  assert.equal(deps.calls.expirePlanGrants, undefined);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.cancel_at_period_end, true);
  assert.equal(patch.plan_code, 'starter');
});

test('payment_intent.succeeded for a top-up saves the card and grants once', async () => {
  const deps = fakeDeps();
  const pi = { id: 'pi_9', customer: 'cus_1', payment_method: 'pm_9', amount: 2500, amount_received: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  const r = await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  assert.equal(r.handled, true);
  assert.deepEqual(deps.calls.savePaymentMethod![0], ['u1', 'cus_1', 'pm_9']);
  const [userId, amount, ref] = deps.calls.grantTopup![0];
  assert.equal(userId, 'u1');
  assert.equal(amount, 2500);
  assert.equal(ref, 'pi:pi_9');
});

test('payment_intent.succeeded that is not a top-up is ignored', async () => {
  const deps = fakeDeps();
  const r = await handleStripeEvent(ev('payment_intent.succeeded', { id: 'pi_x', metadata: {} }), deps);
  assert.equal(r.handled, false);
  assert.equal(deps.calls.grantTopup, undefined);
});

test('checkout.session.completed in payment mode saves the card and grants the top-up; subscription mode only records ids', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_7', amount_total: 2500, consent: { terms_of_service: 'accepted' }, customer_details: { email: 'a@example.com' } }), deps);
  assert.equal(deps.calls.grantTopup![0][2], 'pi:pi_7');
  assert.ok((deps.calls.updateProfile![0][1] as Record<string, unknown>).terms_accepted_at);

  const deps2 = fakeDeps();
  await handleStripeEvent(ev('checkout.session.completed', { id: 'cs_2', mode: 'subscription', client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1', customer_details: { email: 'a@example.com' } }), deps2);
  assert.equal(deps2.calls.grantTopup, undefined);
  assert.equal(deps2.calls.grantPlanCycle, undefined);
  const patch = deps2.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.stripe_subscription_id, 'sub_1');
  assert.equal(patch.plan_code, 'starter');
  assert.equal(deps2.calls.onSubscriptionStarted![0][0], 'a@example.com');
});

test('invoice.payment_failed marks past_due and emails', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('invoice.payment_failed', { id: 'in_f', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } } }), deps);
  assert.equal((deps.calls.updateProfile![0][1] as Record<string, unknown>).stripe_subscription_status, 'past_due');
  assert.equal(deps.calls.paymentFailedEmail![0][0], 'a@example.com');
});

test('charge.refunded on a top-up claws the credit back', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_9', amount_refunded: 2500 }), deps);
  assert.deepEqual(deps.calls.refundTopup![0], ['u1', 'pi:pi_9', 2500, 'refunded']);
});

// ---------------------------------------------------------------------------
// Pause / cancel mirroring and event-order guards
// ---------------------------------------------------------------------------

const subObj = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  cancel_at: null,
  start_date: 1_700_000_000,
  pause_collection: null,
  metadata: {},
  items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] },
  ...over,
});

test('a pause writes both ends of the window and keeps the plan and credit', async () => {
  const deps = fakeDeps();
  const r = await handleStripeEvent(
    ev('customer.subscription.updated', subObj({ pause_collection: { behavior: 'void', resumes_at: 1_810_000_000 }, metadata: { stayful_paused_from: '2027-01-15T00:00:00.000Z' } })),
    deps,
  );
  assert.equal(r.handled, true);
  assert.equal(deps.calls.expirePlanGrants, undefined);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.subscription_paused_from, '2027-01-15T00:00:00.000Z');
  assert.equal(patch.subscription_paused_until, new Date(1_810_000_000 * 1000).toISOString());
  assert.equal(patch.plan_code, 'starter');
  assert.equal(patch.plan_source, 'stripe');
  // A pause is not churn — no cancellation reaches the CRM.
  assert.equal(deps.calls.onSubscriptionCancelled, undefined);
});

test('an auto-resume clears the pause window by itself', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('customer.subscription.updated', subObj()), deps);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.subscription_paused_from, null);
  assert.equal(patch.subscription_paused_until, null);
  assert.equal(patch.subscription_ended_at, null);
  assert.equal(patch.subscription_started_at, new Date(1_700_000_000 * 1000).toISOString());
});

test('a scheduled cancellation stores the date; undoing it clears the captured reason', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ cancel_at_period_end: true, cancel_at: 1_800_000_000 })), deps);
  const booked = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(booked.subscription_cancel_at, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal('cancel_reason' in booked, false);

  await handleStripeEvent(ev('customer.subscription.updated', subObj()), deps);
  const undone = deps.calls.updateProfile![1][1] as Record<string, unknown>;
  assert.equal(undone.subscription_cancel_at, null);
  assert.equal(undone.cancel_reason, null);
  assert.equal(undone.cancel_reason_at, null);
});

test('a late delete for a superseded subscription does not expire the credit the customer is paying for', async () => {
  const deps = fakeDeps();
  deps.listSubscriptions = async () => [subObj({ id: 'sub_new', status: 'active' }) as unknown as Stripe.Subscription];
  const r = await handleStripeEvent(ev('customer.subscription.deleted', subObj({ status: 'canceled' })), deps);
  assert.equal(r.handled, false);
  assert.equal(deps.calls.expirePlanGrants, undefined);
  assert.equal(deps.calls.updateProfile, undefined);
});

test('customer.subscription.created links a subscription arranged by hand in the dashboard', async () => {
  const deps = fakeDeps();
  deps.findUserBySubscription = async () => null;
  const r = await handleStripeEvent(ev('customer.subscription.created', subObj({ id: 'sub_hand' })), deps);
  assert.equal(r.handled, true);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.stripe_subscription_id, 'sub_hand');
  assert.equal(patch.stripe_customer_id, 'cus_1');
  assert.equal(patch.plan_code, 'starter');
  // Credit is not granted here — it follows invoice.paid.
  assert.equal(deps.calls.grantPlanCycle, undefined);
});

test('a manual plan grant is not revoked by a stray dead-subscription event', async () => {
  const deps = fakeDeps();
  const manual = { id: 'u1', email: 'a@example.com', plan_code: 'pro', plan_source: 'manual' };
  deps.findUserBySubscription = async () => manual;
  await handleStripeEvent(ev('customer.subscription.deleted', subObj({ status: 'canceled' })), deps);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.stripe_subscription_status, 'canceled');
  assert.equal('plan_code' in patch, false);
  assert.equal('plan' in patch, false);
});

// ---------------------------------------------------------------
// Churn capture
// ---------------------------------------------------------------

const deadSub = (over: Partial<Record<string, unknown>> = {}): Stripe.Subscription =>
  ({
    id: 'sub_1',
    status: 'canceled',
    cancel_at_period_end: false,
    cancel_at: null,
    customer: 'cus_1',
    start_date: 1_700_000_000,
    items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] },
    ...over,
  }) as unknown as Stripe.Subscription;

test('REGRESSION: the cancel reason survives the subscription actually ending', async () => {
  // It used to be wiped here. Stripe clears cancel_at when a subscription
  // ends, and the old code read that as "they changed their mind" — deleting
  // the reason at the exact moment it became the answer to why they left.
  const deps = fakeDeps();
  deps.user.cancel_reason = 'too_expensive';
  deps.user.cancel_reason_comment = 'costs more than I get out of it';

  const r = await handleStripeEvent(ev('customer.subscription.deleted', deadSub()), deps);
  assert.equal(r.handled, true);

  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.ok(!('cancel_reason' in patch) || patch.cancel_reason !== null, 'must not null the reason on the way out');
  assert.equal(patch.subscription_ended_at !== undefined, true);
});

test('a live subscription that un-cancels still clears the reason', async () => {
  // The other half of the same branch: still live and no longer cancelling
  // really does mean the reason describes nothing.
  const deps = fakeDeps();
  const live = { id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: null, customer: 'cus_1', start_date: 1_700_000_000, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } } as unknown as Stripe.Subscription;
  await handleStripeEvent(ev('customer.subscription.updated', live), deps);
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.cancel_reason, null);
});

test('the ended event logs the reason the member gave us', async () => {
  const deps = fakeDeps();
  deps.user.cancel_reason = 'not_using';
  deps.user.cancel_reason_comment = 'too busy';
  await handleStripeEvent(ev('customer.subscription.deleted', deadSub()), deps);

  const ended = deps.events.find((e) => e.kind === 'ended')!;
  assert.equal(ended.reason, 'not_using');
  assert.equal(ended.reasonComment, 'too busy');
  assert.equal(ended.source, 'self_serve');
  assert.equal(ended.cycleStartedAt, new Date(1_700_000_000 * 1000).toISOString());
});

test('a portal cancel is rescued from Stripe cancellation_details', async () => {
  // Nobody cancelling in the Stripe portal ever reaches our own flow, so this
  // is the only place their reason can come from.
  const deps = fakeDeps();
  const sub = deadSub({ cancellation_details: { feedback: 'missing_features', comment: 'no API' } });
  await handleStripeEvent(ev('customer.subscription.deleted', sub), deps);

  const ended = deps.events.find((e) => e.kind === 'ended')!;
  assert.equal(ended.reason, 'missing_feature');
  assert.equal(ended.reasonComment, 'no API');
  assert.equal(ended.source, 'portal');
});

test('a subscription that dies past due is logged as payment_failed', async () => {
  const deps = fakeDeps();
  deps.user.stripe_subscription_status = 'past_due';
  await handleStripeEvent(ev('customer.subscription.deleted', deadSub({ status: 'unpaid' })), deps);

  const ended = deps.events.find((e) => e.kind === 'ended')!;
  assert.equal(ended.reason, 'payment_failed', 'an involuntary churn is still a churn');
  assert.equal(ended.source, 'stripe');
});

test('a churn with nothing attached logs no invented reason', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('customer.subscription.deleted', deadSub()), deps);
  assert.equal(deps.events.find((e) => e.kind === 'ended')!.reason, null);
});

test('a scheduled cancellation is logged once, on the way in', async () => {
  const deps = fakeDeps();
  const cancelling = { id: 'sub_1', status: 'active', cancel_at_period_end: true, cancel_at: 1_800_000_000, customer: 'cus_1', start_date: 1_700_000_000, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } } as unknown as Stripe.Subscription;

  await handleStripeEvent(ev('customer.subscription.updated', cancelling), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'cancel_scheduled').length, 1);

  // Stripe re-sends the whole object on every update. Now that the profile
  // carries the state, a repeat must not log a second time.
  deps.user.subscription_cancel_at = new Date(1_800_000_000 * 1000).toISOString();
  await handleStripeEvent(ev('customer.subscription.updated', cancelling), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'cancel_scheduled').length, 1);
});

test('undoing a cancellation logs cancel_reverted', async () => {
  const deps = fakeDeps();
  deps.user.subscription_cancel_at = '2027-01-01T00:00:00.000Z';
  const live = { id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: null, customer: 'cus_1', start_date: 1_700_000_000, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } } as unknown as Stripe.Subscription;
  await handleStripeEvent(ev('customer.subscription.updated', live), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'cancel_reverted').length, 1);
  // The webhook sees no portal source on a revert, so it leaves the activity
  // log to the app, which records the member's own undo as self_serve (E20).
  assert.equal(deps.activity.some((a) => a.kind === 'plan_cancel_undone'), false);
});

test('a failed invoice logs past_due once per episode', async () => {
  const deps = fakeDeps();
  const invoice = { id: 'in_2', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } } };
  await handleStripeEvent(ev('invoice.payment_failed', invoice), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'past_due').length, 1);

  deps.user.stripe_subscription_status = 'past_due';
  await handleStripeEvent(ev('invoice.payment_failed', invoice), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'past_due').length, 1, 'same episode, not a new one');
});

test('a card that goes through after failing logs recovered', async () => {
  const deps = fakeDeps();
  deps.user.stripe_subscription_status = 'past_due';
  const invoice = { id: 'in_3', customer: 'cus_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end: 1_800_000_000 }, pricing: { price_details: { price: 'price_starter' } } }] } };
  await handleStripeEvent(ev('invoice.paid', invoice), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'recovered').length, 1);
});

test('a churn log that throws does not fail the delivery', async () => {
  // The route records the event id BEFORE handling, so a throw here would have
  // Stripe retry the whole handler and re-run the grant expiry.
  const deps = fakeDeps();
  deps.recordSubscriptionEvent = async () => {
    throw new Error('database on fire');
  };
  const r = await handleStripeEvent(ev('customer.subscription.deleted', deadSub()), deps);
  assert.equal(r.handled, true);
  assert.equal(deps.calls.onSubscriptionCancelled!.length, 1);
});

test('reasonFromStripeFeedback maps every Stripe value to something we report', () => {
  assert.equal(reasonFromStripeFeedback('too_expensive'), 'too_expensive');
  assert.equal(reasonFromStripeFeedback('switched_service'), 'another_tool');
  assert.equal(reasonFromStripeFeedback('unused'), 'not_using');
  assert.equal(reasonFromStripeFeedback('low_quality'), 'other');
  assert.equal(reasonFromStripeFeedback('something_new_stripe_added'), 'other');
  assert.equal(reasonFromStripeFeedback(null), null);
});

// ── Batch 9: the activity log ──

test('a top-up is logged as the member topping up, keyed like the app logs it', async () => {
  const deps = fakeDeps();
  const pi = { id: 'pi_9', customer: 'cus_1', payment_method: 'pm_9', amount: 2500, amount_received: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  assert.deepEqual(deps.activity, [{ userId: 'u1', kind: 'topup', dedupeKey: 'topup:pi:pi_9', source: undefined, extras: { amount_pence: 2500 } }]);
});

test('an automatic top-up is logged as automatic, never as the member', async () => {
  const deps = fakeDeps();
  const pi = { id: 'pi_a', customer: 'cus_1', payment_method: 'pm_9', amount: 2000, amount_received: 2000, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2000', auto: '1' } };
  await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  assert.equal(deps.activity.length, 1);
  assert.equal(deps.activity[0].kind, 'auto_topup');
  assert.equal(deps.activity[0].source, 'system');
  assert.equal(deps.activity[0].dedupeKey, 'topup:pi:pi_a');
});

test('a Checkout top-up is logged once, with the payment as its key', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_7', amount_total: 2500, customer_details: { email: 'a@example.com' } }), deps);
  assert.deepEqual(deps.activity.map((a) => [a.kind, a.dedupeKey]), [['topup', 'topup:pi:pi_7']]);
});

test('a new subscription reported twice is one plan start', async () => {
  const deps = fakeDeps();
  await handleStripeEvent(ev('checkout.session.completed', { id: 'cs_2', mode: 'subscription', client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1', customer_details: { email: 'a@example.com' } }), deps);
  await handleStripeEvent(ev('customer.subscription.created', subObj()), deps);
  const starts = deps.activity.filter((a) => a.kind === 'plan_start');
  assert.ok(starts.length >= 1);
  assert.deepEqual([...new Set(starts.map((a) => a.dedupeKey))], ['plan_start:sub_1']);
});

test('a cancellation booked in the portal is logged; Stripe ending or resuming by itself is not', async () => {
  const deps = fakeDeps();
  // A portal cancellation carries Stripe's own cancellation feedback, which is
  // how the webhook tells it from an admin cancelling in the dashboard (E20).
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ cancel_at_period_end: true, cancel_at: 1_800_000_000, cancellation_details: { feedback: 'too_expensive' } })), deps);
  assert.deepEqual(deps.activity.map((a) => a.kind), ['plan_cancel']);
  assert.match(deps.activity[0].dedupeKey ?? '', /^sub:evt_customer\.subscription\.updated:cancel_scheduled$/);

  const resumed = fakeDeps();
  resumed.user.subscription_paused_until = '2026-01-01T00:00:00.000Z';
  await handleStripeEvent(ev('customer.subscription.updated', subObj()), resumed);
  assert.equal(resumed.activity.some((a) => a.kind === 'plan_resume'), false);

  const ended = fakeDeps();
  await handleStripeEvent(ev('customer.subscription.deleted', subObj({ status: 'canceled' })), ended);
  assert.equal(ended.activity.length, 0);
});

test('a cancellation made in the Stripe dashboard is recorded for churn but not logged as the member cancelling (E20)', async () => {
  const deps = fakeDeps();
  // No in-app reason and no Stripe feedback: the webhook labels it 'stripe',
  // which may be the admin acting in the dashboard, so it is not the member's.
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ cancel_at_period_end: true, cancel_at: 1_800_000_000 })), deps);
  assert.equal(deps.events.filter((e) => e.kind === 'cancel_scheduled').length, 1, 'still recorded in the churn log');
  assert.equal(deps.events.find((e) => e.kind === 'cancel_scheduled')?.source, 'stripe');
  assert.equal(
    deps.activity.some((a) => a.kind === 'plan_cancel'),
    false,
    'a dashboard cancellation is not a weekly-active action',
  );
});

test('a cancellation the member made in the app is logged by the app, not a second time by the webhook (E20)', async () => {
  const deps = fakeDeps();
  deps.user.cancel_reason = 'too_expensive';
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ cancel_at_period_end: true, cancel_at: 1_800_000_000 })), deps);
  assert.equal(deps.events.find((e) => e.kind === 'cancel_scheduled')?.source, 'self_serve');
  assert.equal(
    deps.activity.some((a) => a.kind === 'plan_cancel'),
    false,
    'the app already logged the self-serve cancellation; the webhook does not repeat it',
  );
});

test('a subscription on a plan granted by hand is not the member starting a plan', async () => {
  const deps = fakeDeps();
  deps.findUserBySubscription = async () => ({ id: 'u1', email: 'a@example.com', plan_code: 'pro', plan_source: 'manual' });
  await handleStripeEvent(ev('customer.subscription.created', subObj()), deps);
  assert.equal(deps.events.find((e) => e.kind === 'started')?.source, 'manual');
  assert.equal(deps.activity.filter((a) => a.kind === 'plan_start').length, 0);
});

test('an activity log that throws does not fail the delivery', async () => {
  const deps = fakeDeps();
  deps.logActivity = async () => {
    throw new Error('down');
  };
  const pi = { id: 'pi_9', customer: 'cus_1', payment_method: 'pm_9', amount: 2500, amount_received: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  const r = await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  assert.equal(r.handled, true);
  assert.equal(deps.calls.grantTopup!.length, 1);
});

// ── Batch 19: Meta's Subscribe; Batch 29: Purchase (the pack) and RepeatPurchase ──
// The fake records with the same once-only key and rules as src/lib/meta/conversions.ts. `packAt`: when
// each member's pack was granted (none: they joined before the pack). A RepeatPurchase is due only for the
// first further payment the fake has seen since the pack (the server reads member_payments for that).
const TRACKING_SINCE = '2026-09-01T00:00:00.000Z';

function withConversions(deps: ReturnType<typeof fakeDeps>, packAt: Record<string, string> = {}) {
  const recorded: Array<{ key: string; name: string; eventId: string | null; valuePence: number }> = [];
  const payments = new Map<string, Set<string>>();
  deps.recordConversion = async (c) => {
    const key = dedupeKeyFor(c.name, { userId: c.userId });
    if (!key || recorded.some((r) => r.key === key)) return;
    let v: { valuePence: number } | null = null;
    if (c.name === 'Subscribe') v = subscribeFromInvoice(c.invoice, TRACKING_SINCE);
    else if (c.name === 'Purchase') v = purchaseFromPack(c.pack);
    else {
      const seen = payments.get(c.userId) ?? new Set<string>();
      const earlier = [...seen].some((id) => id !== c.repeat.paymentId);
      seen.add(c.repeat.paymentId);
      payments.set(c.userId, seen);
      v = repeatPurchaseDue({ packAt: packAt[c.userId] ?? null, trackingSince: TRACKING_SINCE, earlierFurtherPayment: earlier }) ? repeatValue(c.repeat) : null;
    }
    if (v) recorded.push({ key, name: c.name, eventId: c.eventId, valuePence: v.valuePence });
  };
  return recorded;
}

const PACKED = { u1: '2026-10-01T09:00:00.000Z' };

const subStarted = (iso: string) =>
  ({ id: 'sub_1', status: 'active', start_date: Date.parse(iso) / 1000, cancel_at_period_end: false, customer: 'cus_1', items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } }) as unknown as Stripe.Subscription;

const paidInvoice = (id: string, reason: string, paid: number, exVat: number) => ({
  id,
  customer: 'cus_1',
  billing_reason: reason,
  amount_paid: paid,
  total_excluding_tax: exVat,
  currency: 'gbp',
  parent: { subscription_details: { subscription: 'sub_1' } },
  lines: { data: [{ period: { end: 1_800_000_000 }, pricing: { price_details: { price: 'price_starter' } } }] },
});

test('Batch 29: a pack buyer’s first top-up (Checkout and payment_intent.succeeded, each delivered twice) is one RepeatPurchase at the credit bought, and never a Purchase', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps, PACKED);
  const session = { id: 'cs_1', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_7', amount_total: 3000, customer_details: { email: 'a@example.com' } };
  const pi = { id: 'pi_7', customer: 'cus_1', payment_method: 'pm_1', amount: 3000, amount_received: 3000, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  for (let i = 0; i < 2; i += 1) {
    await handleStripeEvent(ev('checkout.session.completed', session), deps);
    await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  }
  assert.deepEqual(recorded, [{ key: 'RepeatPurchase:u1', name: 'RepeatPurchase', eventId: 'pi_7', valuePence: 2500 }]);
});

const topupPi = (id: string, pence: number, auto?: '1') => ({ id, customer: 'cus_1', amount: pence, amount_received: pence, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: String(pence), ...(auto ? { auto } : {}) } });

test('Batch 29: a top-up by a member who joined before the pack sends nothing (Zac, question 10)', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps);
  await handleStripeEvent(ev('payment_intent.succeeded', topupPi('pi_old', 1000)), deps);
  assert.deepEqual(recorded, []);
  assert.equal(deps.calls.grantTopup?.length, 1, 'the credit is still granted');
});

test('Batch 29: a pack buyer’s automatic first top-up is their RepeatPurchase; the next payment sends nothing new', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps, PACKED);
  await handleStripeEvent(ev('payment_intent.succeeded', topupPi('pi_auto', 1000, '1')), deps);
  await handleStripeEvent(ev('payment_intent.succeeded', topupPi('pi_next', 2000)), deps);
  assert.deepEqual(recorded, [{ key: 'RepeatPurchase:u1', name: 'RepeatPurchase', eventId: 'pi_auto', valuePence: 1000 }]);
});

test('Batch 29: a second top-up is never a RepeatPurchase, even when the first was not recorded', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps, PACKED);
  // The first further payment (say its Meta record failed) still makes the next one a "later payment".
  const first = deps.recordConversion!;
  deps.recordConversion = async (c) => {
    if (c.name === 'RepeatPurchase' && c.eventId === 'pi_first') {
      await first({ ...c, repeat: { ...c.repeat, topup: { ...c.repeat.topup!, currency: 'usd' } } });
      return;
    }
    await first(c);
  };
  await handleStripeEvent(ev('payment_intent.succeeded', topupPi('pi_first', 1000)), deps);
  await handleStripeEvent(ev('payment_intent.succeeded', topupPi('pi_second', 1000)), deps);
  assert.deepEqual(recorded, []);
});

test('Batch 29: a pack buyer whose first payment after the pack is a plan invoice sends Subscribe and RepeatPurchase (question 10)', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps, PACKED);
  deps.setSub(subStarted('2026-10-10T09:00:00Z'));
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_first', 'subscription_create', 1200, 1000)), deps);
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_first', 'subscription_create', 1200, 1000)), deps);
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_second', 'subscription_cycle', 1200, 1000)), deps);
  assert.deepEqual(recorded, [
    { key: 'Subscribe:u1', name: 'Subscribe', eventId: 'in_first', valuePence: 1000 },
    { key: 'RepeatPurchase:u1', name: 'RepeatPurchase', eventId: 'in_first', valuePence: 1000 },
  ]);
});

test('Batch 29: a plan taken after a top-up sends Subscribe only (the top-up was the RepeatPurchase)', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps, PACKED);
  await handleStripeEvent(ev('payment_intent.succeeded', topupPi('pi_t', 1000)), deps);
  deps.setSub(subStarted('2026-10-10T09:00:00Z'));
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_1', 'subscription_create', 1200, 1000)), deps);
  assert.deepEqual(recorded.map((r) => [r.name, r.eventId]), [['RepeatPurchase', 'pi_t'], ['Subscribe', 'in_1']]);
});

test('Batch 19: a 100%-off first invoice is not a Subscribe; the first paid one is, excluding VAT, once', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps);
  deps.setSub(subStarted('2026-10-01T09:00:00Z'));
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_free', 'subscription_create', 0, 0)), deps);
  assert.deepEqual(recorded, []);
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_paid', 'subscription_cycle', 1200, 1000)), deps);
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_paid', 'subscription_cycle', 1200, 1000)), deps);
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_next', 'subscription_cycle', 1200, 1000)), deps);
  assert.deepEqual(recorded, [{ key: 'Subscribe:u1', name: 'Subscribe', eventId: 'in_paid', valuePence: 1000 }]);
  assert.equal(deps.calls.grantPlanCycle?.length, 4, 'every invoice still grants its credit');
});

test('Batch 19: renewals of a subscription started before tracking began, and plan-change invoices, never fire', async () => {
  const deps = fakeDeps();
  const recorded = withConversions(deps);
  deps.setSub(subStarted('2026-06-01T09:00:00Z'));
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_old', 'subscription_cycle', 1200, 1000)), deps);
  deps.setSub(subStarted('2026-10-01T09:00:00Z'));
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_upgrade', 'subscription_update', 500, 400)), deps);
  assert.deepEqual(recorded, []);
});

test('Batch 19: a failure to record never fails the delivery', async () => {
  const deps = fakeDeps();
  deps.recordConversion = async () => {
    throw new Error('database down');
  };
  const r = await handleStripeEvent(ev('payment_intent.succeeded', { id: 'pi_8', customer: 'cus_1', amount: 1000, amount_received: 1000, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '1000' } }), deps);
  assert.equal(r.handled, true);
});

// ── Batch 20: the payments behind "Total paid" ──
// The fake stores rows as the database does: a payment once per id, a refund as the charge's largest cumulative amount.
function withPayments(deps: ReturnType<typeof fakeDeps>) {
  const payments = new Map<string, { kind: string; amountPence: number; userId: string; planCode: string | null }>();
  const refunds = new Map<string, { userId: string; amount: number; pi: string | null }>();
  deps.recordPayment = async (p) => {
    if (!payments.has(p.id)) payments.set(p.id, { kind: p.kind, amountPence: p.amountPence, userId: p.userId, planCode: p.planCode });
  };
  deps.recordRefund = async (r) => {
    const prev = refunds.get(r.chargeId);
    refunds.set(r.chargeId, { userId: r.userId, pi: r.paymentIntentId, amount: Math.max(prev?.amount ?? 0, r.amountRefundedPence) });
  };
  return { payments, refunds };
}

test('Batch 20: a Checkout top-up and its payment_intent.succeeded, each delivered twice, are one payment at the amount charged', async () => {
  const deps = fakeDeps();
  const { payments } = withPayments(deps);
  const session = { id: 'cs_1', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_7', amount_total: 3000, currency: 'gbp', customer_details: { email: 'a@example.com' } };
  const pi = { id: 'pi_7', customer: 'cus_1', payment_method: 'pm_1', amount: 3000, amount_received: 3000, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  deps.retrievePaymentIntent = async () => pi as unknown as Stripe.PaymentIntent;
  for (let i = 0; i < 2; i += 1) {
    await handleStripeEvent(ev('checkout.session.completed', session), deps);
    await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  }
  assert.deepEqual([...payments.entries()], [['pi:pi_7', { kind: 'topup', amountPence: 3000, userId: 'u1', planCode: null }]]);
});

test('Batch 20: an automatic top-up is a payment too, marked automatic', async () => {
  const deps = fakeDeps();
  const { payments } = withPayments(deps);
  const pi = { id: 'pi_a', customer: 'cus_1', payment_method: 'pm_1', amount: 2000, amount_received: 2000, currency: 'gbp', metadata: { kind: 'topup', auto: '1', user_id: 'u1', amount_pence: '2000' } };
  await handleStripeEvent(ev('payment_intent.succeeded', pi), deps);
  assert.equal(payments.get('pi:pi_a')?.kind, 'auto_topup');
});

test('Batch 20: every paid invoice is a payment (a renewal, a plan change, an unknown price); a £0 one is not', async () => {
  const deps = fakeDeps();
  const { payments } = withPayments(deps);
  await handleStripeEvent(ev('invoice.paid', { ...paidInvoice('in_a', 'subscription_create', 2280, 1900) }), deps);
  await handleStripeEvent(ev('invoice.paid', { ...paidInvoice('in_a', 'subscription_create', 2280, 1900) }), deps);
  await handleStripeEvent(ev('invoice.paid', { ...paidInvoice('in_b', 'subscription_update', 500, 417) }), deps);
  await handleStripeEvent(ev('invoice.paid', { ...paidInvoice('in_c', 'subscription_cycle', 0, 0) }), deps);
  deps.setSub(null);
  await handleStripeEvent(ev('invoice.paid', { ...paidInvoice('in_d', 'subscription_cycle', 999, 999), lines: { data: [{ pricing: { price_details: { price: 'price_unknown' } } }] } }), deps);
  assert.deepEqual(
    [...payments.entries()].map(([k, v]) => [k, v.kind, v.amountPence, v.planCode]),
    [
      ['inv:in_a', 'subscription', 2280, 'starter'],
      ['inv:in_b', 'subscription', 500, 'starter'],
      ['inv:in_d', 'subscription', 999, null],
    ],
  );
});

test('Batch 20: refunds are recorded for any charge, as the cumulative amount, and the top-up clawback is unchanged', async () => {
  const deps = fakeDeps();
  const { refunds } = withPayments(deps);
  // A top-up's charge: the member comes from the payment's own metadata.
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_9', customer: 'cus_1', amount_refunded: 1000 }), deps);
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_9', customer: 'cus_1', amount_refunded: 2500 }), deps);
  // A redelivery of the first, arriving late, never lowers it.
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_9', customer: 'cus_1', amount_refunded: 1000 }), deps);
  assert.deepEqual(refunds.get('ch_1'), { userId: 'u1', pi: 'pi_9', amount: 2500 });
  assert.deepEqual(deps.calls.refundTopup![0], ['u1', 'pi:pi_9', 1000, 'refunded']);
  // A subscription invoice's charge: no metadata, so the member is the customer.
  deps.retrievePaymentIntent = async (id) => ({ id, customer: 'cus_1', metadata: {} }) as unknown as Stripe.PaymentIntent;
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_2', payment_intent: 'pi_inv', customer: 'cus_1', amount_refunded: 1900 }), deps);
  assert.deepEqual(refunds.get('ch_2'), { userId: 'u1', pi: 'pi_inv', amount: 1900 });
  assert.equal(r.note, 'not a top-up');
});

test('Batch 20: bookkeeping that throws never fails the delivery', async () => {
  const deps = fakeDeps();
  deps.recordPayment = async () => {
    throw new Error('down');
  };
  deps.recordRefund = async () => {
    throw new Error('down');
  };
  const pi = { id: 'pi_9', customer: 'cus_1', payment_method: 'pm_9', amount: 2500, amount_received: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  assert.equal((await handleStripeEvent(ev('payment_intent.succeeded', pi), deps)).handled, true);
  assert.equal((await handleStripeEvent(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_9', amount_refunded: 100 }), deps)).handled, true);
});

// ── Batch 20: the £10 starter pack ──
const packPi = (over: Record<string, unknown> = {}) =>
  ({ id: 'pi_pack', status: 'succeeded', customer: 'cus_1', payment_method: 'pm_1', amount: 1000, amount_received: 1000, currency: 'gbp', metadata: { kind: 'starter_pack', user_id: 'u1', price_pence: '1000', credit_pence: '3000' }, ...over }) as unknown as Stripe.PaymentIntent;

function withPack(deps: ReturnType<typeof fakeDeps>, outcomes: Array<'granted' | 'already' | 'blocked' | 'ignored'> = ['granted', 'already']) {
  const settled: string[] = [];
  const granted: string[] = [];
  const clawed: Array<{ refundedPence: number; chargedPence: number; reason: string }> = [];
  deps.settleStarterPack = async (piId) => {
    settled.push(piId);
    return 'captured';
  };
  deps.grantStarterPack = async ({ paymentIntent }) => {
    granted.push(paymentIntent.id);
    return outcomes[Math.min(granted.length - 1, outcomes.length - 1)];
  };
  deps.clawbackStarterPack = async (c) => {
    clawed.push({ refundedPence: c.refundedPence, chargedPence: c.chargedPence, reason: c.reason });
  };
  return { settled, granted, clawed };
}

test('Batch 20: a pack Checkout saves the card and settles the authorised payment; it never grants a top-up', async () => {
  const deps = fakeDeps();
  const { settled } = withPack(deps);
  deps.retrievePaymentIntent = async () => packPi({ status: 'requires_capture' });
  const session = { id: 'cs_p', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_pack', amount_total: 1000, metadata: { kind: 'starter_pack', user_id: 'u1' } };
  const r = await handleStripeEvent(ev('checkout.session.completed', session), deps);
  assert.equal(r.handled, true);
  assert.deepEqual(settled, ['pi_pack']);
  assert.equal(deps.calls.savePaymentMethod?.length, 1);
  assert.equal(deps.calls.grantTopup, undefined);
});

test('Batch 20: a captured pack is granted, logged, measured and booked once, however often it is delivered', async () => {
  const deps = fakeDeps();
  const { granted } = withPack(deps);
  const recorded = withConversions(deps);
  const { payments } = withPayments(deps);
  const seen = new Set<string>();
  deps.logActivity = async (a) => {
    if (a.dedupeKey && seen.has(a.dedupeKey)) return;
    if (a.dedupeKey) seen.add(a.dedupeKey);
    deps.activity.push(a);
  };
  for (let i = 0; i < 3; i += 1) await handleStripeEvent(ev('payment_intent.succeeded', packPi()), deps);
  assert.deepEqual(granted, ['pi_pack', 'pi_pack', 'pi_pack']);
  assert.deepEqual(deps.activity.map((a) => [a.kind, a.dedupeKey]), [['starter_pack', 'starter_pack:pi:pi_pack']]);
  // Batch 29: the pack is the Purchase, once per member, at its price excluding VAT.
  assert.deepEqual(recorded, [{ key: 'Purchase:u1', name: 'Purchase', eventId: 'pi_pack', valuePence: 1000 }]);
  assert.deepEqual([...payments.entries()].map(([k, v]) => [k, v.kind, v.amountPence]), [['pi:pi_pack', 'starter_pack', 1000]]);
  assert.equal(deps.calls.grantTopup, undefined);
});

test('Batch 20: a repeat that was charged anyway becomes a top-up and is logged as one', async () => {
  const deps = fakeDeps();
  withPack(deps, ['blocked']);
  // Batch 29: and it sends Meta nothing: neither the pack's Purchase nor a RepeatPurchase.
  const recorded = withConversions(deps, PACKED);
  const r = await handleStripeEvent(ev('payment_intent.succeeded', packPi()), deps);
  assert.equal(r.note, 'starter pack blocked');
  assert.deepEqual(deps.activity.map((a) => a.kind), ['topup']);
  assert.deepEqual(recorded, []);
});

test('Batch 20: a pack payment the grant will not take (not captured) is not handled', async () => {
  const deps = fakeDeps();
  withPack(deps, ['ignored']);
  const r = await handleStripeEvent(ev('payment_intent.succeeded', packPi()), deps);
  assert.equal(r.handled, false);
  assert.equal(deps.activity.length, 0);
});

test('Batch 20: without the pack wired in, a pack payment is left alone, never granted as a top-up', async () => {
  const deps = fakeDeps();
  const r = await handleStripeEvent(ev('payment_intent.succeeded', packPi()), deps);
  assert.equal(r.handled, false);
  assert.equal(deps.calls.grantTopup, undefined);
});

test("Batch 20: refunding or disputing a pack claws its credit back, and never touches the top-up clawback", async () => {
  const deps = fakeDeps();
  const { clawed } = withPack(deps);
  deps.retrievePaymentIntent = async () => packPi();
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_p', payment_intent: 'pi_pack', customer: 'cus_1', amount: 1000, amount_refunded: 500 }), deps);
  assert.equal(r.note, 'starter pack credit clawed back');
  await handleStripeEvent(ev('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_pack', amount: 1000 }), deps);
  assert.deepEqual(clawed, [
    { refundedPence: 500, chargedPence: 1000, reason: 'refunded' },
    { refundedPence: 1000, chargedPence: 1000, reason: 'disputed' },
  ]);
  assert.equal(deps.calls.refundTopup, undefined);
});

test('Batch 20: an invoice payment carries its PaymentIntent (from the invoice, else asked of Stripe), so its refunds can be matched', async () => {
  const deps = fakeDeps();
  const seen: Array<[string, string | null]> = [];
  deps.recordPayment = async (p) => {
    seen.push([p.id, p.paymentIntentId]);
  };
  deps.invoicePaymentIntent = async (invoiceId) => (invoiceId === 'in_ask' ? 'pi_asked' : null);
  await handleStripeEvent(ev('invoice.paid', { ...paidInvoice('in_has', 'subscription_cycle', 1900, 1900), payments: { data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_on_invoice' } }] } }), deps);
  await handleStripeEvent(ev('invoice.paid', paidInvoice('in_ask', 'subscription_cycle', 1900, 1900)), deps);
  deps.invoicePaymentIntent = async () => {
    throw new Error('Stripe down');
  };
  const r = await handleStripeEvent(ev('invoice.paid', paidInvoice('in_down', 'subscription_cycle', 1900, 1900)), deps);
  assert.equal(r.handled, true);
  assert.deepEqual(seen, [
    ['inv:in_has', 'pi_on_invoice'],
    ['inv:in_ask', 'pi_asked'],
    ['inv:in_down', null],
  ]);
});

test('Batch 20: a pack authorised or cancelled is settled (captured, or its claim let go); other payments are left alone', async () => {
  const deps = fakeDeps();
  const { settled } = withPack(deps);
  assert.equal((await handleStripeEvent(ev('payment_intent.amount_capturable_updated', packPi({ status: 'requires_capture' })), deps)).note, 'starter pack captured');
  assert.equal((await handleStripeEvent(ev('payment_intent.canceled', packPi({ status: 'canceled' })), deps)).handled, true);
  const topup = { id: 'pi_t', status: 'canceled', metadata: { kind: 'topup', user_id: 'u1' } };
  assert.equal((await handleStripeEvent(ev('payment_intent.canceled', topup), deps)).handled, false);
  assert.deepEqual(settled, ['pi_pack', 'pi_pack']);
});

test('Batch 20: a pack hold released before capture is reported as refunded; nothing is clawed back or taken off Total paid', async () => {
  const deps = fakeDeps();
  const { clawed } = withPack(deps);
  const { refunds } = withPayments(deps);
  deps.retrievePaymentIntent = async () => packPi({ status: 'canceled' });
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_hold', payment_intent: 'pi_pack', customer: 'cus_1', captured: false, amount: 1000, amount_refunded: 1000 }), deps);
  assert.equal(r.note, 'starter pack authorisation released (never charged)');
  assert.deepEqual(clawed, []);
  assert.equal(refunds.size, 0);
  assert.equal(deps.calls.refundTopup, undefined);
});

test('Batch 20: a refund whose payment cannot be read fails the delivery, so Stripe sends it again and no clawback is lost', async () => {
  const deps = fakeDeps();
  const { clawed } = withPack(deps);
  deps.retrievePaymentIntentStrict = async () => {
    throw new Error('Stripe down');
  };
  await assert.rejects(handleStripeEvent(ev('charge.refunded', { id: 'ch_p', payment_intent: 'pi_pack', customer: 'cus_1', captured: true, amount: 1000, amount_refunded: 1000 }), deps), /Stripe down/);
  deps.retrievePaymentIntentStrict = async () => packPi();
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_p', payment_intent: 'pi_pack', customer: 'cus_1', captured: true, amount: 1000, amount_refunded: 1000 }), deps);
  assert.deepEqual(clawed, [{ refundedPence: 1000, chargedPence: 1000, reason: 'refunded' }]);
  // No such payment (not ours): not a pack, and the delivery goes on as before.
  deps.retrievePaymentIntentStrict = async () => null;
  assert.equal((await handleStripeEvent(ev('charge.refunded', { id: 'ch_x', payment_intent: 'pi_gone', customer: 'cus_1', captured: true, amount: 500, amount_refunded: 500 }), deps)).handled, true);
});

// ── Batch 21 ──

test('invoice.paid with no linked subscription or customer is matched by the invoice email (B19)', async () => {
  const deps = fakeDeps();
  const invoice = { id: 'in_19', customer: 'cus_other', customer_email: 'a@example.com', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_new' } }, lines: { data: [{ period: { end: 1_800_000_000 }, pricing: { price_details: { price: 'price_starter' } } }] } };
  deps.setSub(null);
  const r = await handleStripeEvent(ev('invoice.paid', invoice), deps);
  assert.equal(r.handled, true);
  assert.equal(deps.calls.grantPlanCycle![0][0], 'u1');
});

test('a subscription that is still incomplete is neither ended nor mirrored (B42)', async () => {
  const deps = fakeDeps();
  const r = await handleStripeEvent(ev('customer.subscription.updated', { id: 'sub_1', status: 'incomplete', customer: 'cus_1', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } }), deps);
  assert.equal(r.handled, true);
  assert.equal(deps.calls.expirePlanGrants, undefined);
  assert.equal(deps.calls.updateProfile, undefined);
  assert.deepEqual(deps.events, []);
});

test('a failed one-off invoice does not mark the member past due (B43)', async () => {
  const deps = fakeDeps();
  const r = await handleStripeEvent(ev('invoice.payment_failed', { id: 'in_43', customer: 'cus_1', parent: null }), deps);
  assert.equal(r.handled, false);
  assert.equal(deps.calls.updateProfile, undefined);
  assert.equal(deps.calls.paymentFailedEmail, undefined);
});

test('a top-up checkout completed before the money arrived grants nothing yet (B15)', async () => {
  const deps = fakeDeps();
  const session = { id: 'cs_15', mode: 'payment', payment_status: 'unpaid', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_15', amount_total: 2500, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } };
  const r = await handleStripeEvent(ev('checkout.session.completed', session), deps);
  assert.equal(r.handled, true);
  assert.ok(!('grantTopup' in deps.calls), 'nothing granted while unpaid');
  const paid = await handleStripeEvent(ev('checkout.session.completed', { ...session, payment_status: 'paid' }), deps);
  assert.equal(paid.handled, true);
  assert.equal((deps.calls['grantTopup'] ?? []).length, 1);
});

test('a refund of a VAT-inclusive charge claws back the same share of the ex-VAT credit (B18)', async () => {
  const deps = fakeDeps();
  deps.retrievePaymentIntent = async (id) => ({ id, amount: 3000, amount_received: 3000, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } }) as unknown as Stripe.PaymentIntent;
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_18', payment_intent: 'pi_18', amount: 3000, amount_refunded: 1500, refunded: false }), deps);
  const [userId, sourceRef, amount, reason] = deps.calls.refundTopup![0];
  assert.equal(userId, 'u1');
  assert.equal(sourceRef, 'pi:pi_18');
  assert.equal(amount, 1250);
  assert.equal(reason, 'refunded');
});

test('a dispute won gives the credit back; one lost does not (B17)', async () => {
  const deps = fakeDeps();
  deps.retrievePaymentIntentStrict = async (id) => ({ id, amount: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } }) as unknown as Stripe.PaymentIntent;
  const won = await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_1', status: 'won', payment_intent: 'pi_17', amount: 2500 }), deps);
  assert.equal(won.handled, true);
  assert.deepEqual(deps.calls.restoreDisputedCredit![0], ['u1', 'pi_17']);
  const lost = await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_2', status: 'lost', payment_intent: 'pi_17', amount: 2500 }), deps);
  assert.equal(lost.handled, false);
  assert.equal(deps.calls.restoreDisputedCredit!.length, 1);
});

test('Batch 23: the auto top-up link\'s checkout switches auto top-up on (only if off) and records it once', async () => {
  const deps = fakeDeps();
  const switched: unknown[][] = [];
  let off = true;
  deps.enableAutoTopup = async (...a) => {
    switched.push(a);
    const was = off;
    off = false;
    return was;
  };
  deps.retrievePaymentIntent = async (id) => ({ id, payment_method: 'pm_1', customer: 'cus_1', amount: 2500, amount_received: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500', auto_topup_on: '1', auto_topup_threshold_pence: '500' } }) as unknown as Stripe.PaymentIntent;
  const session = { id: 'cs_9', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_9', amount_total: 2500, payment_status: 'paid', customer_details: { email: 'a@example.com' } };
  await handleStripeEvent(ev('checkout.session.completed', session), deps);
  assert.deepEqual(switched[0], ['u1', 2500, 500]);
  assert.equal(deps.activity.filter((a) => a.kind === 'auto_topup_settings').length, 1);
  assert.equal(deps.activity.find((a) => a.kind === 'auto_topup_settings')?.source, 'sms_link');
  // The payment_intent.succeeded for the same payment: already on, nothing more recorded.
  await handleStripeEvent(ev('payment_intent.succeeded', { id: 'pi_9', customer: 'cus_1', payment_method: 'pm_1', amount: 2500, amount_received: 2500, currency: 'gbp', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500', auto_topup_on: '1', auto_topup_threshold_pence: '500' } }), deps);
  assert.equal(deps.activity.filter((a) => a.kind === 'auto_topup_settings').length, 1);
});

test('Batch 23: an ordinary top-up never switches auto top-up on', async () => {
  const deps = fakeDeps();
  let called = false;
  deps.enableAutoTopup = async () => {
    called = true;
    return true;
  };
  await handleStripeEvent(ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', client_reference_id: 'u1', customer: 'cus_1', payment_intent: 'pi_7', amount_total: 2500, customer_details: { email: 'a@example.com' } }), deps);
  assert.equal(called, false);
});

test('Review R4 (R4-14): a dispute marks its payment (so a charged-back payment stops counting as paying again); one won clears it; one lost changes nothing', async () => {
  const deps = fakeDeps();
  const marks: Array<{ paymentIntentId: string; open: boolean }> = [];
  deps.recordDispute = async (m) => {
    marks.push(m);
  };
  deps.retrievePaymentIntent = async () => ({ id: 'pi_top', metadata: { kind: 'topup', user_id: 'u1', amount_pence: '1000' }, amount: 1200 }) as unknown as Stripe.PaymentIntent;
  await handleStripeEvent(ev('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_top', amount: 1200 }), deps);
  await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_1', payment_intent: 'pi_top', status: 'lost' }), deps);
  await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_2', payment_intent: 'pi_top', status: 'won' }), deps);
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_top', customer: 'cus_1', amount: 1200, amount_refunded: 1200 }), deps);
  assert.deepEqual(marks, [
    { paymentIntentId: 'pi_top', open: true },
    { paymentIntentId: 'pi_top', open: false },
  ]);
});

// ── Batch 31a: Stayful Academy ──

function academyDeps() {
  const deps = fakeDeps();
  const records: unknown[] = [];
  const links: Array<[string, string]> = [];
  const refunds: Array<[string, boolean]> = [];
  const byPi = new Map<string, string>();
  const started = new Set<string>();
  const academyPi = (id: string) => ({ id, payment_method: 'pm_academy', customer: 'cus_new', amount: 9900, amount_received: 9900, metadata: { kind: 'academy' } }) as unknown as Stripe.PaymentIntent;
  deps.retrievePaymentIntent = async (id) => academyPi(id);
  deps.recordRefund = async (...a) => {
    (deps.calls.recordRefund ??= []).push(a);
  };
  deps.academy = {
    recordPurchase: async (input) => {
      records.push(input);
      if (!byPi.has(input.paymentIntentId)) byPi.set(input.paymentIntentId, `ap_${byPi.size + 1}`);
      return { id: byPi.get(input.paymentIntentId)! };
    },
    linkAfterPurchase: async (purchaseId, userId) => {
      links.push([purchaseId, userId]);
      if (started.has(purchaseId)) return 'academy link already (already)';
      started.add(purchaseId);
      return 'academy link start (start)';
    },
    cancelTrialForRefund: async (pi, fully) => {
      refunds.push([pi, fully]);
      return 'ok';
    },
  };
  return { deps, records, links, refunds };
}

const academySession = (over: Record<string, unknown> = {}) => ({
  id: 'cs_academy',
  mode: 'payment',
  payment_status: 'paid',
  metadata: { kind: 'academy' },
  payment_intent: 'pi_academy',
  customer: 'cus_new',
  customer_details: { email: 'A@Example.com' },
  consent: { terms_of_service: 'accepted' },
  created: 1_790_000_000,
  ...over,
});

const academyTrialSub = (trialStart: number, trialEnd: number, metadata: Record<string, string> = { source: 'academy' }) =>
  ({ id: 'sub_x', status: 'trialing', cancel_at_period_end: false, customer: 'cus_1', metadata, trial_start: trialStart, trial_end: trialEnd, start_date: trialStart, items: { data: [{ price: { id: 'price_pro' }, current_period_end: trialEnd }] } }) as unknown as Stripe.Subscription;

const zeroInvoice = (id: string, subId: string, reason = 'subscription_create') => ({ id, customer: 'cus_1', amount_paid: 0, billing_reason: reason, parent: { subscription_details: { subscription: subId } }, lines: { data: [] } });

test('Batch 31a: an Academy trial’s £0 first invoice grants month 1 only, keyed trial:<sub>:<YYYY-MM of trial start>, expiring one clamped month later', async () => {
  const deps = fakeDeps();
  const start = Date.UTC(2027, 0, 31, 10) / 1000; // 31 Jan: one clamped month is 28 Feb
  const end = start + 90 * 86400;
  deps.setSub(academyTrialSub(start, end));
  const r = await handleStripeEvent(ev('invoice.paid', zeroInvoice('in_trial', 'sub_x')), deps);
  assert.equal(r.handled, true);
  assert.equal(deps.calls.grantPlanCycle!.length, 1);
  const [userId, planCode, sourceRef, expiry] = deps.calls.grantPlanCycle![0];
  assert.equal(userId, 'u1');
  assert.equal(planCode, 'pro');
  assert.equal(sourceRef, 'trial:sub_x:2027-01');
  assert.equal((expiry as Date).toISOString(), new Date(Date.UTC(2027, 1, 28, 10)).toISOString());
  // The profile write is as before.
  const patch = deps.calls.updateProfile![0][1] as Record<string, unknown>;
  assert.equal(patch.stripe_subscription_status, 'trialing');
  assert.equal(patch.plan_code, 'pro');
});

test('Batch 31a: an Academy trial shorter than a month expires month 1 at the trial end', async () => {
  const deps = fakeDeps();
  const start = Date.UTC(2027, 2, 10) / 1000;
  const end = start + 20 * 86400;
  deps.setSub(academyTrialSub(start, end));
  await handleStripeEvent(ev('invoice.paid', zeroInvoice('in_trial', 'sub_x')), deps);
  const [, , sourceRef, expiry] = deps.calls.grantPlanCycle![0];
  assert.equal(sourceRef, 'trial:sub_x:2027-03');
  assert.equal((expiry as Date).getTime(), end * 1000);
});

test('Batch 31a: a non-Academy £0 trial invoice is unchanged (inv:<id>, period end); the Academy’s day-91 invoice follows the normal cycle', async () => {
  const deps = fakeDeps();
  const start = Date.UTC(2027, 0, 31, 10) / 1000;
  const end = start + 90 * 86400;
  deps.setSub(academyTrialSub(start, end, {}));
  await handleStripeEvent(ev('invoice.paid', zeroInvoice('in_other', 'sub_x')), deps);
  const [, planCode, sourceRef, expiry] = deps.calls.grantPlanCycle![0];
  assert.equal(planCode, 'pro');
  assert.equal(sourceRef, 'inv:in_other');
  assert.equal((expiry as Date).getTime(), end * 1000);

  const deps2 = fakeDeps();
  deps2.setSub({ ...academyTrialSub(start, end), status: 'active' } as Stripe.Subscription);
  await handleStripeEvent(ev('invoice.paid', { ...zeroInvoice('in_91', 'sub_x', 'subscription_cycle'), amount_paid: 3999 }), deps2);
  assert.equal(deps2.calls.grantPlanCycle![0][2], 'inv:in_91');
});

test('Batch 31a: an Academy checkout records the purchase and links it, never touching the profile, card or top-ups', async () => {
  const { deps, records, links } = academyDeps();
  const r = await handleStripeEvent(ev('checkout.session.completed', academySession()), deps);
  assert.equal(r.handled, true);
  assert.match(r.note ?? '', /academy purchase recorded; academy link start/);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    email: 'a@example.com',
    customerId: 'cus_new',
    paymentIntentId: 'pi_academy',
    paymentMethodId: 'pm_academy',
    amountPence: 9900,
    paidAt: new Date(1_790_000_000 * 1000).toISOString(),
    checkoutSessionId: 'cs_academy',
    termsAcceptedAt: (records[0] as { termsAcceptedAt: string }).termsAcceptedAt,
  });
  assert.ok((records[0] as { termsAcceptedAt: string | null }).termsAcceptedAt);
  assert.deepEqual(links, [['ap_1', 'u1']]);
  assert.equal(deps.calls.updateProfile, undefined);
  assert.equal(deps.calls.savePaymentMethod, undefined);
  assert.equal(deps.calls.grantTopup, undefined);
});

test('Batch 31a: an Academy checkout links the client_reference_id account first; no tick box means no consent recorded', async () => {
  const { deps, records, links } = academyDeps();
  await handleStripeEvent(ev('checkout.session.completed', academySession({ client_reference_id: 'u1', customer_details: { email: 'someone@else.com' }, consent: null })), deps);
  assert.equal((records[0] as { termsAcceptedAt: string | null }).termsAcceptedAt, null);
  assert.deepEqual(links, [['ap_1', 'u1']]);
});

test('Batch 31a: an Academy checkout with no account is recorded only', async () => {
  const { deps, records, links } = academyDeps();
  const r = await handleStripeEvent(ev('checkout.session.completed', academySession({ customer_details: { email: 'nobody@example.com' } })), deps);
  assert.equal(r.handled, true);
  assert.equal(r.note, 'academy purchase recorded; no account yet');
  assert.equal(records.length, 1);
  assert.equal(links.length, 0);
  assert.equal(deps.calls.updateProfile, undefined);
});

test('Batch 31a: a replayed Academy checkout records the same purchase again and linking answers already', async () => {
  const { deps, records, links } = academyDeps();
  await handleStripeEvent(ev('checkout.session.completed', academySession()), deps);
  const r = await handleStripeEvent(ev('checkout.session.completed', academySession()), deps);
  assert.equal(records.length, 2);
  assert.deepEqual(links, [['ap_1', 'u1'], ['ap_1', 'u1']]);
  assert.match(r.note ?? '', /already/);
  assert.equal(deps.calls.updateProfile, undefined);
  assert.equal(deps.calls.grantTopup, undefined);
});

test('Batch 31a: an Academy checkout known only by its payment intent’s metadata is still the Academy’s', async () => {
  const { deps, records } = academyDeps();
  await handleStripeEvent(ev('checkout.session.completed', academySession({ metadata: {} })), deps);
  assert.equal(records.length, 1);
  assert.equal(deps.calls.updateProfile, undefined);
  assert.equal(deps.calls.savePaymentMethod, undefined);
});

test('Batch 31a: an unpaid Academy checkout records nothing; without the Academy wired in it is still kept off the generic path', async () => {
  const { deps, records } = academyDeps();
  const r = await handleStripeEvent(ev('checkout.session.completed', academySession({ payment_status: 'unpaid' })), deps);
  assert.equal(r.handled, true);
  assert.equal(records.length, 0);
  const plain = fakeDeps();
  const r2 = await handleStripeEvent(ev('checkout.session.completed', academySession()), plain);
  assert.equal(r2.handled, false);
  assert.equal(plain.calls.updateProfile, undefined);
  assert.equal(plain.calls.grantTopup, undefined);
});

test('Batch 31a: a full Academy refund cancels the trial and is kept off Total paid; a partial one is passed on as partial', async () => {
  const { deps, refunds } = academyDeps();
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_a', payment_intent: 'pi_academy', captured: true, amount: 9900, amount_refunded: 9900, refunded: true }), deps);
  assert.equal(r.handled, true);
  assert.deepEqual(refunds, [['pi_academy', true]]);
  assert.equal(deps.calls.recordRefund, undefined);
  assert.equal(deps.calls.refundTopup, undefined);

  await handleStripeEvent(ev('charge.refunded', { id: 'ch_a', payment_intent: 'pi_academy', captured: true, amount: 9900, amount_refunded: 5000, refunded: false }), deps);
  assert.deepEqual(refunds[1], ['pi_academy', false]);
  assert.equal(deps.calls.recordRefund, undefined);
});

test('Batch 31a: a refund that is not the Academy’s follows the existing path', async () => {
  const { deps, refunds } = academyDeps();
  deps.retrievePaymentIntent = async (id) => ({ id, amount: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } }) as unknown as Stripe.PaymentIntent;
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_t', payment_intent: 'pi_t', captured: true, amount: 2500, amount_refunded: 2500, refunded: true }), deps);
  assert.equal(r.note, 'top-up clawed back');
  assert.equal(refunds.length, 0);
  assert.equal(deps.calls.recordRefund!.length, 1);
  assert.equal(deps.calls.refundTopup!.length, 1);
});

test('Batch 31a: a late Academy first invoice once the trial has ended (refund, unlink) grants nothing and leaves the profile alone', async () => {
  const deps = fakeDeps();
  const start = Date.UTC(2027, 0, 31, 10) / 1000;
  deps.setSub({ ...academyTrialSub(start, start + 90 * 86400), status: 'canceled' } as Stripe.Subscription);
  const r = await handleStripeEvent(ev('invoice.paid', zeroInvoice('in_late', 'sub_x')), deps);
  assert.equal(r.handled, true);
  assert.match(r.note ?? '', /nothing granted/);
  assert.equal(deps.calls.grantPlanCycle, undefined);
  assert.equal(deps.calls.updateProfile, undefined);
});

test('Batch 31a: an Academy checkout asks Stripe strictly: an outage throws (Stripe retries) instead of saving the purchase without its card', async () => {
  const { deps, records } = academyDeps();
  deps.retrievePaymentIntentStrict = async () => {
    throw new Error('stripe down');
  };
  await assert.rejects(handleStripeEvent(ev('checkout.session.completed', academySession()), deps), /stripe down/);
  assert.equal(records.length, 0);
});

// ── Batch 32: plan credit rollover ──
// A small in-memory plan ledger behind the plan deps: grants keyed by source_ref (unique, as in the
// database), credit_expire_plan_source's LIKE match on the ledger's escaped pattern, and expire rows
// carrying their reason, so redeliveries and cumulative refunds are checked against real sums.

interface FakeGrant {
  id: string;
  sourceRef: string;
  kind: 'plan' | 'topup';
  amount: number;
  remaining: number;
  planCycle: boolean;
  createdAt: string;
}

/** A LIKE pattern (with '\' escapes) as a RegExp, as Postgres reads it. */
function likeRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') out += (pattern[++i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') out += '.*';
    else if (c === '_') out += '.';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 's');
}

function planLedgerDeps() {
  const deps = fakeDeps();
  const grants: FakeGrant[] = [];
  const expires: Array<{ grantId: string; amount: number; reason: string }> = [];
  const invoices = new Map<string, { userId: string; invoiceId: string; paidPence: number }>();
  const paidSubs = new Map<string, boolean>();
  let clock = Date.UTC(2027, 0, 1);
  const PLAN_CREDIT: Record<string, number> = { starter: 1900, pro: 3900, pro_annual: 3900 };
  const add = (sourceRef: string, amount: number, planCycle: boolean, kind: 'plan' | 'topup' = 'plan'): boolean => {
    if (grants.some((g) => g.sourceRef === sourceRef)) return false;
    clock += 86_400_000;
    grants.push({ id: `g${grants.length + 1}`, sourceRef, kind, amount, remaining: amount, planCycle, createdAt: new Date(clock).toISOString() });
    return true;
  };
  const spend = (sourceRef: string, pence: number) => {
    const g = grants.find((x) => x.sourceRef === sourceRef)!;
    g.remaining -= pence;
  };
  const balance = () => grants.reduce((sum, g) => sum + g.remaining, 0);
  const remainingOf = (sourceRef: string) => grants.find((g) => g.sourceRef === sourceRef)?.remaining ?? null;
  deps.grantPlanCycle = async (_userId, planCode, sourceRef) => {
    (deps.calls.grantPlanCycle ??= []).push([_userId, planCode, sourceRef]);
    add(sourceRef, PLAN_CREDIT[planCode] ?? 0, true);
  };
  deps.grantUpgradeDifference = async (_userId, from, to, sourceRef) => {
    (deps.calls.grantUpgradeDifference ??= []).push([_userId, from, to, sourceRef]);
    // As grants.ts: the new plan's credit less THIS cycle's plan grants.
    const cycle = thisCycleGrants(grants.filter((g) => g.kind === 'plan').map((g) => ({ amount_pence: g.amount, created_at: g.createdAt, plan_cycle: g.planCycle, source_ref: g.sourceRef })));
    const diff = upgradeTopUpPence(PLAN_CREDIT[to] ?? 0, cycle, PLAN_CREDIT[from ?? ''] ?? 0);
    if (diff > 0) add(sourceRef, diff, false);
  };
  deps.expirePlanSource = async (_userId, match, maxPence, reason) => {
    (deps.calls.expirePlanSource ??= []).push([_userId, match, maxPence, reason]);
    const re = likeRegex(planSourcePattern(match));
    let left = maxPence;
    let total = 0;
    let n = 0;
    for (const g of grants) {
      if (g.kind !== 'plan' || !re.test(g.sourceRef) || g.remaining <= 0) continue;
      if (left !== null && left <= 0) break;
      const take = left === null ? g.remaining : Math.min(left, g.remaining);
      g.remaining -= take;
      expires.push({ grantId: g.id, amount: take, reason });
      total += take;
      if (left !== null) left -= take;
      n++;
    }
    return { expiredPence: total, grants: n };
  };
  deps.planInvoiceForPayment = async (pi) => invoices.get(pi) ?? null;
  deps.planInvoiceCredit = async (_userId, invoiceId, reason) => {
    const own = grants.filter((g) => g.kind === 'plan' && g.sourceRef === `inv:${invoiceId}`);
    const ids = new Set(own.map((g) => g.id));
    return { grantedPence: own.reduce((s, g) => s + g.amount, 0), removedPence: expires.filter((e) => ids.has(e.grantId) && e.reason === reason).reduce((s, e) => s + e.amount, 0) };
  };
  deps.restorePlanCredit = async (_userId, sourceRef, amount) => {
    (deps.calls.restorePlanCredit ??= []).push([_userId, sourceRef, amount]);
    return add(sourceRef, amount, false);
  };
  deps.subscriptionHasPaidInvoice = async (_userId, subId) => paidSubs.get(subId) ?? false;
  // Plan invoices' payments carry no metadata of ours.
  deps.retrievePaymentIntent = async (pi) => ({ id: pi, amount: 1900, amount_received: 1900, metadata: {} }) as unknown as Stripe.PaymentIntent;
  return { deps, grants, expires, invoices, paidSubs, add, spend, balance, remainingOf };
}

const planInvoice = (id: string, reason = 'subscription_cycle', price = 'price_starter') => ({
  id,
  customer: 'cus_1',
  amount_paid: 1900,
  billing_reason: reason,
  parent: { subscription_details: { subscription: 'sub_1' } },
  lines: { data: [{ period: { end: 1_800_000_000 }, pricing: { price_details: { price } } }] },
});

test('Batch 32: a redelivered plan invoice grants its credit once, and the next month adds on top of what is left', async () => {
  const { deps, grants, spend, balance } = planLedgerDeps();
  await handleStripeEvent(ev('invoice.paid', planInvoice('in_1', 'subscription_create')), deps);
  await handleStripeEvent(ev('invoice.paid', planInvoice('in_1', 'subscription_create')), deps);
  assert.equal(grants.length, 1);
  assert.equal(balance(), 1900);
  spend('inv:in_1', 600);
  await handleStripeEvent(ev('invoice.paid', planInvoice('in_2')), deps);
  await handleStripeEvent(ev('invoice.paid', planInvoice('in_2')), deps);
  assert.equal(grants.length, 2);
  assert.equal(balance(), 1300 + 1900, '£13 rolled over + £19 new');
  assert.equal(deps.calls.expirePlanSource, undefined);
});

test('Batch 32: cancelling (scheduled, then ended) keeps the plan credit', async () => {
  const { deps, add, balance } = planLedgerDeps();
  add('inv:in_1', 1900, true);
  add('inv:in_2', 1900, true);
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ cancel_at_period_end: true, cancel_at: 1_800_000_000 })), deps);
  const r = await handleStripeEvent(ev('customer.subscription.deleted', deadSub()), deps);
  assert.equal(r.handled, true);
  assert.match(r.note ?? '', /plan credit kept/);
  assert.equal(balance(), 3800);
  assert.equal(deps.calls.expirePlanSource, undefined);
  assert.equal((deps.calls.updateProfile!.at(-1)![1] as Record<string, unknown>).plan, 'free');
});

test('Batch 32: a pause and a downgrade keep the plan credit', async () => {
  const { deps, add, balance } = planLedgerDeps();
  deps.user.plan_code = 'pro';
  add('inv:in_1', 3900, true);
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ pause_collection: { behavior: 'void', resumes_at: 1_810_000_000 } })), deps);
  // Downgrade pro → starter: the subscription moves to the starter price.
  await handleStripeEvent(ev('customer.subscription.updated', subObj({ items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1_800_000_000 }] } })), deps);
  assert.equal(balance(), 3900);
  assert.equal(deps.calls.expirePlanSource, undefined);
});

test('Batch 32: an upgrade with banked credit still gets its top-up (only this cycle’s grants come off)', async () => {
  const { deps, add, spend, remainingOf, balance } = planLedgerDeps();
  add('inv:in_old', 1900, true);
  spend('inv:in_old', 600); // £13 banked from last month
  add('inv:in_now', 1900, true); // this month's starter credit
  deps.setSub({ id: 'sub_1', status: 'active', cancel_at_period_end: false, customer: 'cus_1', items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_800_000_000 }] } } as unknown as Stripe.Subscription);
  await handleStripeEvent(ev('invoice.paid', planInvoice('in_up', 'subscription_update', 'price_pro')), deps);
  assert.equal(remainingOf('inv:in_up'), 2000, 'pro £39 − this cycle’s £19; the banked £13 does not count');
  assert.equal(balance(), 1300 + 1900 + 2000);
  // Redelivered: nothing more.
  await handleStripeEvent(ev('invoice.paid', planInvoice('in_up', 'subscription_update', 'price_pro')), deps);
  assert.equal(balance(), 1300 + 1900 + 2000);
});

test('Batch 32: this cycle’s grants and the upgrade top-up (pure)', () => {
  const rows = [
    { amount_pence: 1900, created_at: '2027-01-01T00:00:00Z', plan_cycle: true, source_ref: 'inv:a' },
    { amount_pence: 2000, created_at: '2027-01-10T00:00:00Z', plan_cycle: false, source_ref: 'inv:up' },
    { amount_pence: 1900, created_at: '2027-02-01T00:00:00Z', plan_cycle: true, source_ref: 'inv:b' },
    { amount_pence: 500, created_at: '2027-02-03T00:00:00Z', plan_cycle: false, source_ref: 'inv:a:dispute_won' },
    { amount_pence: 1000, created_at: '2027-02-05T00:00:00Z', plan_cycle: false, source_ref: 'inv:up2' },
  ];
  assert.deepEqual(thisCycleGrants(rows).map((r) => r.source_ref), ['inv:b', 'inv:up2']);
  assert.equal(upgradeTopUpPence(3900, thisCycleGrants(rows)), 1000);
  assert.equal(upgradeTopUpPence(1900, thisCycleGrants(rows)), 0, 'never below zero');
  assert.deepEqual(thisCycleGrants([{ amount_pence: 1900, created_at: '2027-01-01T00:00:00Z', plan_cycle: false }]), []);
  assert.equal(upgradeTopUpPence(3900, [], 1900), 2000, 'no cycle grant: the old plan’s credit stands in');
});

test('Batch 32: a refunded plan invoice removes only its own leftover credit, once', async () => {
  const { deps, add, spend, invoices, remainingOf, expires } = planLedgerDeps();
  add('inv:in_A', 1900, true);
  spend('inv:in_A', 600);
  add('inv:in_B', 1900, true);
  add('pi:pi_top', 2500, false, 'topup');
  invoices.set('pi_A', { userId: 'u1', invoiceId: 'in_A', paidPence: 1900 });
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_A', payment_intent: 'pi_A', captured: true, amount: 1900, amount_refunded: 1900, refunded: true }), deps);
  assert.equal(r.handled, true);
  assert.equal(remainingOf('inv:in_A'), 0, 'its unspent £13 removed, never below zero');
  assert.equal(remainingOf('inv:in_B'), 1900, 'another month untouched');
  assert.equal(remainingOf('pi:pi_top'), 2500, 'top-up untouched');
  assert.equal(deps.calls.refundTopup, undefined);
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_A', payment_intent: 'pi_A', captured: true, amount: 1900, amount_refunded: 1900, refunded: true }), deps);
  assert.equal(remainingOf('inv:in_B'), 1900);
  assert.equal(expires.reduce((sum, e) => sum + e.amount, 0), 1300, 'a redelivery removes nothing more');
  assert.deepEqual(deps.calls.expirePlanSource![0][1], { exact: 'inv:in_A' });
});

test('Batch 32: a partial plan refund removes the refunded share; a later refund of the rest removes the rest', async () => {
  const { deps, add, invoices, remainingOf } = planLedgerDeps();
  add('inv:in_A', 1900, true);
  invoices.set('pi_A', { userId: 'u1', invoiceId: 'in_A', paidPence: 2280 });
  // VAT-inclusive charge of £22.80 for £19 of credit; half refunded.
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_A', payment_intent: 'pi_A', captured: true, amount: 2280, amount_refunded: 1140, refunded: false }), deps);
  assert.equal(remainingOf('inv:in_A'), 950);
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_A', payment_intent: 'pi_A', captured: true, amount: 2280, amount_refunded: 1140, refunded: false }), deps);
  assert.equal(remainingOf('inv:in_A'), 950, 'redelivery: same cumulative amount, nothing more');
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_A', payment_intent: 'pi_A', captured: true, amount: 2280, amount_refunded: 2280, refunded: true }), deps);
  assert.equal(remainingOf('inv:in_A'), 0);
  assert.equal(refundedShare(1900, 1140, 2280), 950);
  assert.equal(refundedShare(1900, 5000, 2280), 1900, 'never more than was granted');
  assert.equal(clawbackDue(950, 1200), 0);
});

test('Batch 32: a chargeback removes the invoice’s leftover credit; a won dispute restores it once; a lost one restores nothing', async () => {
  const { deps, add, spend, invoices, remainingOf, balance } = planLedgerDeps();
  add('inv:in_A', 1900, true);
  spend('inv:in_A', 400);
  add('inv:in_B', 1900, true);
  invoices.set('pi_A', { userId: 'u1', invoiceId: 'in_A', paidPence: 1900 });
  deps.retrievePaymentIntentStrict = deps.retrievePaymentIntent;
  await handleStripeEvent(ev('charge.dispute.created', { id: 'dp_A', payment_intent: 'pi_A', amount: 1900 }), deps);
  await handleStripeEvent(ev('charge.dispute.created', { id: 'dp_A', payment_intent: 'pi_A', amount: 1900 }), deps);
  assert.equal(remainingOf('inv:in_A'), 0);
  assert.equal(remainingOf('inv:in_B'), 1900);
  const lost = await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_A', payment_intent: 'pi_A', status: 'lost', amount: 1900 }), deps);
  assert.equal(lost.handled, false);
  assert.equal(balance(), 1900);
  const won = await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_A', payment_intent: 'pi_A', status: 'won', amount: 1900 }), deps);
  assert.equal(won.handled, true);
  await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_A', payment_intent: 'pi_A', status: 'won', amount: 1900 }), deps);
  assert.equal(remainingOf('inv:in_A:dispute_won'), 1500, 'what was removed comes back as plan credit');
  assert.equal(balance(), 1900 + 1500, 'restored once');
  assert.equal(deps.calls.restoreDisputedCredit, undefined);
});

test('Batch 32: a won dispute on a plan invoice whose credit was all spent gives nothing back', async () => {
  const { deps, add, spend, invoices } = planLedgerDeps();
  add('inv:in_A', 1900, true);
  spend('inv:in_A', 1900);
  invoices.set('pi_A', { userId: 'u1', invoiceId: 'in_A', paidPence: 1900 });
  await handleStripeEvent(ev('charge.dispute.created', { id: 'dp_A', payment_intent: 'pi_A', amount: 1900 }), deps);
  const r = await handleStripeEvent(ev('charge.dispute.closed', { id: 'dp_A', payment_intent: 'pi_A', status: 'won', amount: 1900 }), deps);
  assert.match(r.note ?? '', /nothing was removed/);
  assert.equal(deps.calls.restorePlanCredit, undefined);
});

test('Batch 32: a top-up refund still takes the top-up path when the plan path is wired', async () => {
  const { deps } = planLedgerDeps();
  deps.retrievePaymentIntent = async (id) => ({ id, amount: 2500, metadata: { kind: 'topup', user_id: 'u1', amount_pence: '2500' } }) as unknown as Stripe.PaymentIntent;
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_t', payment_intent: 'pi_t', captured: true, amount: 2500, amount_refunded: 2500 }), deps);
  assert.equal(r.note, 'top-up clawed back');
  assert.equal(deps.calls.expirePlanSource, undefined);
});

test('Batch 32: a full Academy refund removes only that trial’s credit; a partial one removes nothing', async () => {
  const { deps: academy } = academyDeps();
  const { deps, add, remainingOf } = planLedgerDeps();
  deps.academy = { ...academy.academy!, trialFor: async () => ({ userId: 'u1', subscriptionId: 'sub_x' }) };
  deps.retrievePaymentIntent = academy.retrievePaymentIntent;
  add('trial:sub_x:2027-01', 3900, true);
  add('trial:sub_x:2027-02', 3900, true);
  add('trial:sub_xy:2027-02', 3900, true); // another trial's (a prefix that only matches unescaped)
  add('inv:in_B', 1900, true);
  await handleStripeEvent(ev('charge.refunded', { id: 'ch_a', payment_intent: 'pi_academy', captured: true, amount: 9900, amount_refunded: 5000, refunded: false }), deps);
  assert.equal(deps.calls.expirePlanSource, undefined, 'partial: nothing removed');
  const r = await handleStripeEvent(ev('charge.refunded', { id: 'ch_a', payment_intent: 'pi_academy', captured: true, amount: 9900, amount_refunded: 9900, refunded: true }), deps);
  assert.match(r.note ?? '', /7800p trial credit removed/);
  assert.equal(remainingOf('trial:sub_x:2027-01'), 0);
  assert.equal(remainingOf('trial:sub_x:2027-02'), 0);
  assert.equal(remainingOf('trial:sub_xy:2027-02'), 3900);
  assert.equal(remainingOf('inv:in_B'), 1900);
});

test('Batch 32: an Academy trial cancelled before any paid month forfeits only its trial credit; after a paid month it keeps it', async () => {
  const start = Date.UTC(2027, 0, 10) / 1000;
  const end = start + 90 * 86400;
  const academySub = (over: Record<string, unknown>) => ({ ...academyTrialSub(start, end), id: 'sub_1', ...over }) as unknown as Stripe.Subscription;

  // Cancelled during the trial.
  const a = planLedgerDeps();
  a.add('trial:sub_1:2027-01', 3900, true);
  a.add('pi:pi_top', 2500, false, 'topup');
  a.add('inv:in_old', 1900, true); // an earlier paid plan's banked credit
  const r = await handleStripeEvent(ev('customer.subscription.deleted', academySub({ status: 'canceled', ended_at: start + 20 * 86400, canceled_at: start + 20 * 86400 })), a.deps);
  assert.match(r.note ?? '', /unpaid academy trial: 3900p/);
  assert.equal(a.remainingOf('trial:sub_1:2027-01'), 0);
  assert.equal(a.remainingOf('pi:pi_top'), 2500);
  assert.equal(a.remainingOf('inv:in_old'), 1900);

  // Ended after the trial with no paid invoice (the first charge failed).
  const b = planLedgerDeps();
  b.add('trial:sub_1:2027-01', 3900, true);
  await handleStripeEvent(ev('customer.subscription.deleted', academySub({ status: 'canceled', ended_at: end + 10 * 86400 })), b.deps);
  assert.equal(b.remainingOf('trial:sub_1:2027-01'), 0);

  // Ended after a paid month: the trial credit rolls over like any plan credit.
  const c = planLedgerDeps();
  c.add('trial:sub_1:2027-01', 3900, true);
  c.add('inv:in_91', 3900, true);
  c.paidSubs.set('sub_1', true);
  const rc = await handleStripeEvent(ev('customer.subscription.deleted', academySub({ status: 'canceled', ended_at: end + 40 * 86400 })), c.deps);
  assert.doesNotMatch(rc.note ?? '', /unpaid/);
  assert.equal(c.remainingOf('trial:sub_1:2027-01'), 3900);
  assert.equal(c.deps.calls.expirePlanSource, undefined);

  // Paused at the trial end without a card: not over, nothing removed.
  const d = planLedgerDeps();
  d.add('trial:sub_1:2027-01', 3900, true);
  await handleStripeEvent(ev('customer.subscription.updated', academySub({ status: 'paused' })), d.deps);
  assert.equal(d.remainingOf('trial:sub_1:2027-01'), 3900);

  // A non-Academy subscription ending never forfeits anything.
  assert.equal(trialEndedUnpaid({ trial_end: end, ended_at: start + 86400 }, new Date(), true), true);
  assert.equal(trialEndedUnpaid({ trial_end: end, ended_at: end + 86400 }, new Date(), null), false, 'cannot tell: kept');
});
