import { test } from 'node:test';
import assert from 'node:assert/strict';
import { academyCheckoutParams, academyTermsMessage, isTermsUrlMissingError, poundsFromPence } from './checkout-params.ts';

const base = { academyPriceId: 'price_academy', termsMessage: academyTermsMessage('£39.99'), siteBase: 'https://example.test/', automaticTax: false };

test('the terms wording is exact, with the amount and months filled in', () => {
  assert.equal(
    academyTermsMessage('£39.99'),
    "Includes 3 months of Stayful Intelligence Pro free, starting when you create your Intelligence account with this email. After that it's £39.99/month on this card until you cancel. Cancel any time in Account → Billing.",
  );
});

test('pounds come from GBP pence only', () => {
  assert.equal(poundsFromPence(3999, 'gbp'), '£39.99');
  assert.equal(poundsFromPence(4000, 'GBP'), '£40.00');
  assert.equal(poundsFromPence(3999, 'usd'), null);
  assert.equal(poundsFromPence(null, 'gbp'), null);
  assert.equal(poundsFromPence(0, 'gbp'), null);
});

for (const automaticTax of [false, true]) {
  test(`signed in (tax ${automaticTax}): their customer and id, never customer_creation`, () => {
    const p = academyCheckoutParams({ ...base, automaticTax, member: { id: 'user-1', customerId: 'cus_1' } });
    assert.equal(p.customer, 'cus_1');
    assert.equal(p.client_reference_id, 'user-1');
    assert.equal(p.customer_creation, undefined);
    assert.deepEqual(p.metadata, { kind: 'academy', user_id: 'user-1' });
    assert.deepEqual(p.payment_intent_data?.metadata, { kind: 'academy', user_id: 'user-1' });
    assert.deepEqual(p.automatic_tax, automaticTax ? { enabled: true } : undefined);
    assert.deepEqual(p.customer_update, automaticTax ? { address: 'auto' } : undefined);
  });

  test(`signed out (tax ${automaticTax}): customer_creation always, never a customer`, () => {
    const p = academyCheckoutParams({ ...base, automaticTax, member: null });
    assert.equal(p.customer, undefined);
    assert.equal(p.client_reference_id, undefined);
    assert.equal(p.customer_creation, 'always');
    assert.equal(p.customer_update, undefined);
    assert.deepEqual(p.metadata, { kind: 'academy' });
    assert.deepEqual(p.payment_intent_data?.metadata, { kind: 'academy' });
    assert.deepEqual(p.automatic_tax, automaticTax ? { enabled: true } : undefined);
  });
}

test('both sets: card only, one-off, saved for later, tick box with the wording, no promo codes', () => {
  for (const member of [null, { id: 'user-1', customerId: 'cus_1' }]) {
    const p = academyCheckoutParams({ ...base, member });
    assert.ok(!(p.customer && p.customer_creation));
    assert.equal(p.mode, 'payment');
    assert.deepEqual(p.payment_method_types, ['card']);
    assert.deepEqual(p.line_items, [{ price: 'price_academy', quantity: 1 }]);
    assert.equal(p.payment_intent_data?.setup_future_usage, 'off_session');
    assert.deepEqual(p.consent_collection, { terms_of_service: 'required' });
    assert.deepEqual(p.custom_text?.terms_of_service_acceptance, { message: base.termsMessage });
    assert.equal(p.allow_promotion_codes, false);
    assert.equal(p.success_url, 'https://example.test/academy/welcome?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(p.cancel_url, 'https://example.test/academy');
  }
});

test('a missing Terms URL is recognised from Stripe’s error', () => {
  assert.ok(isTermsUrlMissingError(new Error('You must set a terms of service URL in your public business details to use consent_collection[terms_of_service].')));
  assert.ok(!isTermsUrlMissingError(new Error('No such price: price_x')));
  assert.ok(!isTermsUrlMissingError(null));
});
