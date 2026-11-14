import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisOffer, maxSafeDiscountPct, offerLabel, pmiAddonOffer, welcomeApplies, type OfferMember } from './offers.ts';

const settings = { revealAnalysisDiscountPct: 50, revealWelcomeDays: 7, deepFirstRunExtraPence: 100 };
const list = { fullPence: 500, pmiPence: 200 };
const floors = { fullRawPence: 217, deepRawPence: 292, pmiRawPence: 75 };
const now = new Date('2026-10-05T12:00:00Z');
const member: OfferMember = { offerDealIds: ['d1', 'd2', 'd3'], revealViewedAt: '2026-10-01T09:00:00Z', paysForSelf: true, hadDeepReport: false, usedWelcomeOn: [] };
const offer = (o: Partial<Parameters<typeof analysisOffer>[0]> = {}) => analysisOffer({ dealId: 'd1', withPmi: false, list, member, settings, floors, now, ...o });

test('welcome: half price on a revealed deal inside the week', () => {
  const p = offer();
  assert.equal(p.offer, 'welcome');
  assert.equal(p.fullPence, 250);
  assert.equal(p.listTotalPence, 500);
});

test('welcome only on revealed deals, inside the window, for members paying for themselves, once a deal', () => {
  assert.equal(offer({ dealId: 'other' }).offer, null);
  assert.equal(offer({ now: new Date('2026-10-08T09:00:01Z') }).offer, null);
  assert.equal(offer({ member: { ...member, paysForSelf: false } }).offer, null);
  assert.equal(offer({ member: { ...member, usedWelcomeOn: ['d1'] } }).offer, null);
  assert.equal(offer({ member: { ...member, revealViewedAt: null } }).offer, null);
  assert.equal(offer({ member: null }).offer, null);
  assert.equal(welcomeApplies('d1', member, { ...settings, revealAnalysisDiscountPct: 0 }, now), false);
});

test('welcome deep report: (full + PMI) at half, and it is the first deep report', () => {
  const p = offer({ withPmi: true });
  assert.equal(p.offer, 'welcome_deep');
  assert.equal(p.fullPence + p.pmiPence, 350);
  assert.equal(p.firstDeep, true);
});

test('first deep report: full + £1, once per paying account', () => {
  const p = offer({ dealId: 'other', withPmi: true });
  assert.equal(p.offer, 'first_deep');
  assert.equal(p.fullPence + p.pmiPence, 600);
  assert.equal(p.firstDeep, true);
  assert.equal(offer({ dealId: 'other', withPmi: true, member: { ...member, hadDeepReport: true } }).offer, null);
});

test('never below the worst-case raw cost', () => {
  const p = offer({ settings: { ...settings, revealAnalysisDiscountPct: 80 } });
  assert.equal(p.fullPence, 217);
  const d = offer({ withPmi: true, settings: { ...settings, revealAnalysisDiscountPct: 80 } });
  assert.equal(d.fullPence + d.pmiPence, 292);
  // A floor at or above the list price drops the offer.
  assert.equal(offer({ floors: { ...floors, fullRawPence: 600 } }).offer, null);
});

test('PMI added later: + £1 the first time, never welcome-priced', () => {
  assert.deepEqual(pmiAddonOffer({ listPmiPence: 200, hadDeepReport: false, settings, floors }), { pmiPence: 100, offer: 'first_pmi', firstDeep: true });
  assert.deepEqual(pmiAddonOffer({ listPmiPence: 200, hadDeepReport: true, settings, floors }), { pmiPence: 200, offer: null, firstDeep: false });
  assert.equal(pmiAddonOffer({ listPmiPence: 200, hadDeepReport: false, settings, floors: { pmiRawPence: 150 } }).pmiPence, 150);
});

test('labels and the admin limit', () => {
  assert.equal(offerLabel('welcome'), 'welcome price');
  assert.equal(offerLabel('first_deep'), 'first-time price');
  assert.equal(offerLabel(null), null);
  assert.equal(maxSafeDiscountPct(list, floors), 56);
});

// ── Batch 29, section G: the Deep report's welcome price and starter pack buyers ──
const deep = (m: Partial<OfferMember>, at = now) => analysisOffer({ dealId: 'd1', withPmi: true, list, member: { ...member, ...m }, settings, floors, now: at });

test('a pack-only member is never shown or charged a Deep welcome or first-time price', () => {
  const p = deep({ packBuyer: true, packOnly: true, paidAgainAt: null });
  assert.equal(p.offer, null);
  assert.equal(p.firstDeep, false);
  assert.equal(pmiAddonOffer({ listPmiPence: 200, hadDeepReport: false, settings, floors, packOnly: true }).offer, null);
  // The full analysis's welcome price is unchanged for them.
  assert.equal(offer({ member: { ...member, packBuyer: true, packOnly: true, paidAgainAt: null } }).offer, 'welcome');
});

test('the Deep welcome price unlocks once a pack buyer has paid again', () => {
  assert.equal(deep({ packBuyer: true, packOnly: false, paidAgainAt: '2026-10-03T10:00:00Z' }).offer, 'welcome_deep');
  // Not pack-only (a trial) but never paid again: no welcome price yet.
  assert.notEqual(deep({ packBuyer: true, packOnly: false, paidAgainAt: null }).offer, 'welcome_deep');
});

test('paid again after the 7-day window closed: the window starts again from that payment, own reveal deals only', () => {
  const paid = '2026-10-20T10:00:00Z';
  const m = { packBuyer: true, packOnly: false, paidAgainAt: paid };
  assert.equal(deep(m, new Date('2026-10-21T10:00:00Z')).offer, 'welcome_deep');
  assert.notEqual(deep(m, new Date('2026-10-27T10:00:01Z')).offer, 'welcome_deep', 'seven days after the payment it closes');
  assert.notEqual(analysisOffer({ dealId: 'other', withPmi: true, list, member: { ...member, ...m }, settings, floors, now: new Date('2026-10-21T10:00:00Z') }).offer, 'welcome_deep');
  // The full analysis's own window is not reopened.
  assert.equal(analysisOffer({ dealId: 'd1', withPmi: false, list, member: { ...member, ...m }, settings, floors, now: new Date('2026-10-21T10:00:00Z') }).offer, null);
});

test('members who joined before the pack keep Batch 22 exactly', () => {
  assert.equal(deep({}).offer, 'welcome_deep');
  assert.equal(deep({}, new Date('2026-10-09T09:00:00Z')).offer, 'first_deep');
});
