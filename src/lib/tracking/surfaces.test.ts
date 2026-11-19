import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firesConversionsOnly, isCleanForSend, isStripeReturn, pixelPlan, surfaceFor, tidiedHref } from './surfaces.ts';
import { HOME_PATH, quizPathFor } from '../auth/landing.ts';

const SITE = 'https://intelligence.stayful.co.uk';

test('white-label, admin, token and unknown pages get nothing at all', () => {
  for (const p of ['/f/abc123', '/r/tok', '/r/tok/pdf', '/admin', '/admin/signups', '/api/consent', '/auth/callback', '/team/join', '/extension/connect', '/presentation', '/demo-report', '/m', '/profiles/switch', '/no-such-page', '/deals-nope', '', 'relative']) {
    assert.equal(surfaceFor(p), 'none', p);
  }
});

test('marketing and members’ list pages may send a PageView', () => {
  for (const p of ['/', '/pricing', '/features', '/privacy', '/upgrade', '/markets', '/markets/leeds', '/short-let-deals', '/short-let-deals/york', '/today', '/my-deals', '/deals', '/picks', '/account', '/account/billing', '/estimate', '/welcome', '/today/']) {
    assert.equal(surfaceFor(p), 'tracked', p);
  }
});

test('forms with personal details, id and token pages, and share pages show the banner but never send', () => {
  for (const p of ['/login', '/signup', '/signup/check-email', '/forgot-password', '/reset-password', '/account/notifications', '/account/team', '/account/feedback', '/profile', '/profiles', '/leads', '/leads/123', '/leads/funnels/9', '/deals/8f14e45f-ceea-467a-9c3b-1a2b3c4d5e6f', '/reports', '/reports/abc', '/d/sharetoken', '/deal/sharetoken', '/p/picktoken', '/p/d/tok/deal']) {
    assert.equal(surfaceFor(p), 'banner', p);
  }
});

test('an area page takes a town slug only', () => {
  assert.equal(surfaceFor('/markets/leeds'), 'tracked');
  assert.equal(surfaceFor('/markets/new-york'), 'tracked');
  assert.equal(surfaceFor('/markets/Leeds'), 'none');
  assert.equal(surfaceFor('/markets/leeds/extra'), 'none');
});

test('tracking tags come off the address everywhere', () => {
  assert.equal(tidiedHref(`${SITE}/?utm_source=facebook&utm_campaign=test1&utm_content=adA&fbclid=abc`), `${SITE}/`);
  assert.equal(tidiedHref(`${SITE}/pricing?gclid=x&keep=1`), `${SITE}/pricing?keep=1`);
  assert.equal(tidiedHref(`${SITE}/pricing`), null);
});

test('one-shot flags come off only on their own page', () => {
  assert.equal(tidiedHref(`${SITE}/account/billing?topup=1`), `${SITE}/account/billing`);
  assert.equal(tidiedHref(`${SITE}/account/billing?subscribed=1&plan=pro`), `${SITE}/account/billing`);
  assert.equal(tidiedHref(`${SITE}/today?topup=1`), null);
  assert.equal(tidiedHref(`${SITE}/signup?ref=ABCD1234`), `${SITE}/signup`);
});

test('/welcome loses ?next only when it is the default way back', () => {
  assert.equal(tidiedHref(`${SITE}/welcome?next=%2Fhome`), `${SITE}/welcome`);
  assert.equal(tidiedHref(`${SITE}/welcome?next=%2Ftoday`), null);
  assert.equal(tidiedHref(`${SITE}/welcome?next=%2Fmarkets`), null);
  assert.equal(tidiedHref(`${SITE}/welcome?q=roles&next=%2Fprofile`), null);
});

// Review R4 (R4-01): a new member's first page is the quiz with Home as the way back.
test('/welcome loses ?next when it is HOME_PATH', () => {
  assert.equal(tidiedHref(`${SITE}${quizPathFor(HOME_PATH)}`), `${SITE}/welcome`);
  assert.equal(isCleanForSend(`${SITE}/welcome`), true);
  // The quiz's starter pack returns here from Checkout: noticed first, then tidied too.
  const packReturn = `${SITE}${quizPathFor(HOME_PATH)}&pack=1`;
  assert.equal(isStripeReturn(packReturn), true);
  assert.equal(tidiedHref(packReturn), `${SITE}/welcome`);
  // The reveal's default way back goes too; any other stays.
  assert.equal(tidiedHref(`${SITE}/welcome/reveal?next=${encodeURIComponent(HOME_PATH)}`), `${SITE}/welcome/reveal`);
  assert.equal(tidiedHref(`${SITE}/welcome/reveal?next=%2Fdeals`), null);
});

// Review R4 (R4-01; Zac, 19 Nov 2026: no PageView on Home or the reveal).
test('a held FirstReport/CompleteRegistration fires on /home with no PageView', () => {
  for (const page of [HOME_PATH, '/welcome/reveal']) {
    const href = `${SITE}${page}`;
    // No banner and no PageView there…
    assert.equal(surfaceFor(page), 'none', page);
    assert.equal(firesConversionsOnly(page), true, page);
    assert.equal(isCleanForSend(href), false, page);
    assert.equal(isCleanForSend(href, 'PageView'), false, page);
    // …but a held conversion (CompleteRegistration, FirstReport…) may fire from a clean address.
    assert.equal(isCleanForSend(href, 'conversion'), true, page);
    assert.deepEqual(pixelPlan(href, 2), { start: true, pageView: false, conversions: true }, page);
    // Nothing held: the pixel is not even loaded there.
    assert.deepEqual(pixelPlan(href, 0), { start: false, pageView: false, conversions: true }, page);
    // Anything after the path: nothing at all.
    assert.deepEqual(pixelPlan(`${href}?via=email`, 2), { start: false, pageView: false, conversions: false }, page);
  }
  // The quiz itself keeps its PageView, as before; other pages off the lists still get nothing.
  assert.deepEqual(pixelPlan(`${SITE}/welcome`, 1), { start: true, pageView: true, conversions: true });
  for (const page of ['/welcome/choices', '/home/extra', '/admin', '/deals/8f14e45f-ceea-467a-9c3b-1a2b3c4d5e6f', '/signup']) {
    assert.equal(isCleanForSend(`${SITE}${page}`, 'conversion'), false, page);
    assert.equal(pixelPlan(`${SITE}${page}`, 3).start, false, page);
  }
});

test('?via is left for the visit heartbeat', () => {
  assert.equal(tidiedHref(`${SITE}/today?via=email`), null);
});

test('nothing is sent from an address with anything after the path', () => {
  assert.equal(isCleanForSend(`${SITE}/today`), true);
  assert.equal(isCleanForSend(`${SITE}/privacy#cookies`), true);
  assert.equal(isCleanForSend(`${SITE}/today?via=email`), false);
  assert.equal(isCleanForSend(`${SITE}/markets?pane=listings&listing=abc&q=12%20High%20St`), false);
  assert.equal(isCleanForSend(`${SITE}/estimate?listing=https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F1`), false);
  assert.equal(isCleanForSend(`${SITE}/signup/check-email?email=a%40b.co`), false);
  assert.equal(isCleanForSend(`${SITE}/?`), false);
  assert.equal(isCleanForSend(`${SITE}/today#access_token=abc.def`), false);
});

test('nothing is sent from a page off the list, even with a clean address', () => {
  assert.equal(isCleanForSend(`${SITE}/deals/8f14e45f-ceea-467a-9c3b-1a2b3c4d5e6f`), false);
  assert.equal(isCleanForSend(`${SITE}/signup`), false);
  assert.equal(isCleanForSend(`${SITE}/f/abc`), false);
  assert.equal(isCleanForSend(`${SITE}/admin`), false);
  assert.equal(isCleanForSend(null), false);
});

test('a Stripe return is recognised before the flags are tidied away', () => {
  assert.equal(isStripeReturn(`${SITE}/account/billing?topup=1`), true);
  assert.equal(isStripeReturn(`${SITE}/account/billing?subscribed=1&plan=pro`), true);
  assert.equal(isStripeReturn(`${SITE}/account/billing`), false);
  assert.equal(isStripeReturn(`${SITE}/today?topup=1`), false);
  // Batch 21 (E28): the starter pack's Checkout return is a Stripe return too.
  assert.equal(isStripeReturn(`${SITE}/today?pack=1`), true);
  assert.equal(isStripeReturn(`${SITE}/today`), false);
  assert.equal(isStripeReturn(`${SITE}/today?offer=pack`), false);
});
