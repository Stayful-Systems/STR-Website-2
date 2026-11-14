import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserParams, carriesValue, dedupeKeyFor, eventSourceUrl, isCustomEvent, isPostLaunch, purchaseFromPack, repeatPurchaseDue, repeatValue, subscribeFromInvoice, topupValue } from './events.ts';

const SINCE = '2026-10-01T00:00:00Z';

test('one key per account for every event (Batch 29: Purchase is the pack, RepeatPurchase the first payment after it)', () => {
  assert.equal(dedupeKeyFor('CompleteRegistration', { userId: 'u1' }), 'CompleteRegistration:u1');
  assert.equal(dedupeKeyFor('Subscribe', { userId: 'u1' }), 'Subscribe:u1');
  assert.equal(dedupeKeyFor('Purchase', { userId: 'u1' }), 'Purchase:u1');
  assert.equal(dedupeKeyFor('RepeatPurchase', { userId: 'u1' }), 'RepeatPurchase:u1');
  assert.equal(dedupeKeyFor('FirstReport', { userId: '' }), null);
});

test('our own events go through trackCustom (RepeatPurchase too); the payments carry a value', () => {
  assert.equal(isCustomEvent('ProfileComplete'), true);
  assert.equal(isCustomEvent('FirstReport'), true);
  assert.equal(isCustomEvent('RepeatPurchase'), true);
  assert.equal(isCustomEvent('Purchase'), false);
  for (const n of ['Subscribe', 'Purchase', 'RepeatPurchase'] as const) assert.equal(carriesValue(n), true, n);
  assert.equal(carriesValue('mc_pack_paid'), false, 'the management-company events are unchanged');
});

test('the page a server event is reported against never has a query string', () => {
  assert.equal(eventSourceUrl('Purchase', 'https://intelligence.stayful.co.uk/'), 'https://intelligence.stayful.co.uk/account/billing');
  assert.equal(eventSourceUrl('CompleteRegistration', 'https://x.test'), 'https://x.test/signup');
});

test('only accounts created after tracking began count for the journey events', () => {
  assert.equal(isPostLaunch('2026-10-02T09:00:00Z', SINCE), true);
  assert.equal(isPostLaunch('2026-09-20T09:00:00Z', SINCE), false);
  assert.equal(isPostLaunch('2026-10-02T09:00:00Z', null), false);
});

test('Subscribe: the first paid invoice of a subscription started after launch, ex-VAT', () => {
  const base = { amountPaid: 4799, totalExcludingTax: 3999, billingReason: 'subscription_create', currency: 'gbp', subscriptionStartedAt: '2026-10-05T10:00:00Z' };
  assert.deepEqual(subscribeFromInvoice(base, SINCE), { valuePence: 3999, currency: 'GBP' });
  // A 100%-off first month pays nothing: not yet.
  assert.equal(subscribeFromInvoice({ ...base, amountPaid: 0, totalExcludingTax: 0 }, SINCE), null);
  // Its next (paid) invoice is the one that counts.
  assert.deepEqual(subscribeFromInvoice({ ...base, billingReason: 'subscription_cycle' }, SINCE), { valuePence: 3999, currency: 'GBP' });
  // A plan change's proration invoice is never a Subscribe.
  assert.equal(subscribeFromInvoice({ ...base, billingReason: 'subscription_update' }, SINCE), null);
  // An existing subscriber's renewal never is.
  assert.equal(subscribeFromInvoice({ ...base, billingReason: 'subscription_cycle', subscriptionStartedAt: '2026-03-01T00:00:00Z' }, SINCE), null);
  // Without the ex-VAT figure the amount paid is used.
  assert.deepEqual(subscribeFromInvoice({ ...base, totalExcludingTax: null, amountPaid: 1900 }, SINCE), { valuePence: 1900, currency: 'GBP' });
  assert.equal(subscribeFromInvoice({ ...base, currency: 'usd' }, SINCE), null);
});

test('Purchase: the starter pack only, at its price excluding VAT; never a repeat charged anyway', () => {
  assert.deepEqual(purchaseFromPack({ pricePence: '1000', currency: 'gbp', outcome: 'granted' }), { valuePence: 1000, currency: 'GBP' });
  assert.deepEqual(purchaseFromPack({ pricePence: 1000, currency: 'gbp', outcome: 'already' }), { valuePence: 1000, currency: 'GBP' });
  assert.equal(purchaseFromPack({ pricePence: 1000, currency: 'gbp', outcome: 'blocked' }), null);
  assert.equal(purchaseFromPack({ pricePence: 1000, currency: 'usd' }), null);
  assert.equal(purchaseFromPack({ pricePence: 0, currency: 'gbp' }), null);
});

test('RepeatPurchase: a top-up (chosen or automatic) or a plan invoice, excluding VAT', () => {
  assert.deepEqual(topupValue({ kind: 'topup', auto: '1', amountPence: '1000', currency: 'gbp' }), { valuePence: 1000, currency: 'GBP' }, 'automatic counts');
  assert.equal(topupValue({ kind: 'plan', auto: undefined, amountPence: '1000', currency: 'gbp' }), null);
  assert.equal(topupValue({ kind: 'topup', auto: undefined, amountPence: 'x', currency: 'gbp' }), null);
  assert.deepEqual(repeatValue({ paymentId: 'pi:pi_1', topup: { kind: 'topup', auto: null, amountPence: 2500, currency: 'gbp' } }), { valuePence: 2500, currency: 'GBP' });
  const invoice = { amountPaid: 4799, totalExcludingTax: 3999, billingReason: 'subscription_create', currency: 'gbp', subscriptionStartedAt: '2026-10-05T10:00:00Z' };
  assert.deepEqual(repeatValue({ paymentId: 'inv:in_1', invoice }), { valuePence: 3999, currency: 'GBP' });
  assert.equal(repeatValue({ paymentId: 'inv:in_2', invoice: { ...invoice, billingReason: 'subscription_update' } }), null, 'a proration invoice is not a plan payment');
  assert.equal(repeatValue({ paymentId: '', invoice }), null);
});

test('RepeatPurchase: only a pack buyer’s first payment after a pack bought since tracking began', () => {
  const pack = '2026-10-03T10:00:00Z';
  assert.equal(repeatPurchaseDue({ packAt: pack, trackingSince: SINCE, earlierFurtherPayment: false }), true);
  assert.equal(repeatPurchaseDue({ packAt: pack, trackingSince: SINCE, earlierFurtherPayment: true }), false, 'a later payment sends nothing new');
  assert.equal(repeatPurchaseDue({ packAt: null, trackingSince: SINCE, earlierFurtherPayment: false }), false, 'joined before the pack');
  assert.equal(repeatPurchaseDue({ packAt: '2026-09-20T10:00:00Z', trackingSince: SINCE, earlierFurtherPayment: false }), false, 'a pack before tracking began');
});

test('the browser sends a value only with the payments', () => {
  assert.deepEqual(browserParams('Purchase', 1000), { value: 10, currency: 'GBP' });
  assert.deepEqual(browserParams('RepeatPurchase', 2500), { value: 25, currency: 'GBP' });
  assert.deepEqual(browserParams('FirstReport', 1000), {});
  assert.deepEqual(browserParams('Subscribe', null), {});
});
