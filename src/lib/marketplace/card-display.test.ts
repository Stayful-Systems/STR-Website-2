import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardDisplayFor, changeRateHref, NO_DISPLAY, rateLineFor } from './card-display.ts';
import { plainProfile } from '../tailoring/profile.ts';
import { DEFAULT_GOALS } from '../market/goals.ts';
import { DEFAULT_ABOUT } from '../profile/about.ts';

const fin = (over: Partial<typeof DEFAULT_GOALS.finance>) => ({ ...DEFAULT_GOALS.finance, ...over });
const real = { at: '2026-11-14T00:00:00Z', notSure: false };
const WIDTHS = { high: 10, medium: 15, low: 25 };

test('the rate line says whose rate it is', () => {
  assert.equal(rateLineFor(fin({ mortgageRatePct: 5.4, rateAsOf: '2026-11-14' }), false), 'Using 5.4%, today’s average');
  assert.equal(rateLineFor(fin({ mortgageRatePct: 6, rateSet: true }), false), 'Using your 6%');
  assert.equal(rateLineFor(fin({ mortgageRatePct: 5.5 }), false), 'Using 5.5%, a typical rate', 'before any average has been synced');
  assert.equal(rateLineFor(fin({ mortgageRatePct: 5.29, rateAsOf: '2026-11-14' }), false), 'Using 5.29%, today’s average');
  assert.equal(rateLineFor(fin({}), true), null, 'a cash buyer has no mortgage in the figures');
  assert.equal(rateLineFor(null, false), null);
});

test('the end line only shows when a minimum profit judges the deal, and names the end the answer picked', () => {
  // A member who joined, and answered, after the shorter quiz went live (Review R4, R4-03).
  const p = (risk: 'avoid' | 'consider' | 'go' | null, answered: Record<string, typeof real>) =>
    plainProfile({ ...DEFAULT_GOALS, dealTypes: ['buy_str', 'r2r'] }, [], WIDTHS, { about: { ...DEFAULT_ABOUT, risk }, answered: { ...answered, ...(risk ? { risk: real } : {}) }, profitEndDates: { joinedAt: '2026-11-14T00:00:00Z', shorterFrom: '2026-11-13T00:00:00Z' } });
  const d = cardDisplayFor(p('avoid', { min_profit: real }), false);
  assert.equal(d.endSale, 'Low end used, as you asked');
  assert.equal(d.endRent, 'Low end used, as you asked', 'the one minimum judges rentals too');
  assert.equal(cardDisplayFor(p('go', { min_profit: real }), false).endSale, 'Top end used, as you asked');
  assert.equal(cardDisplayFor(p(null, { min_profit: real }), false).endSale, 'Middle of the range used', 'no answer: named, never "as you asked" (R4-04)');
  const none = cardDisplayFor(p('avoid', {}), false);
  assert.equal(none.endSale, null, 'no minimum profit given: no line');
  assert.equal(none.endRent, null);
  assert.deepEqual(cardDisplayFor(null, false), NO_DISPLAY);
});

test('"change" opens the rate screen and comes back to the page', () => {
  assert.equal(changeRateHref('/deals/abc'), '/welcome?q=finance&next=%2Fdeals%2Fabc');
});

// Review R4 (R4-04): the end note only says "as you asked" when the member answered the new question.
test('no risk answer: the end note without "as you asked"', () => {
  const dates = { joinedAt: '2026-11-16T00:00:00Z', shorterFrom: '2026-11-14T14:30:00Z' };
  const fresh = plainProfile({ ...DEFAULT_GOALS, dealTypes: ['buy_str', 'r2r'] }, [], WIDTHS, { about: { ...DEFAULT_ABOUT, risk: null }, answered: { min_profit: real }, profitEndDates: dates });
  const d = cardDisplayFor(fresh, false);
  assert.equal(d.endSale, 'Middle of the range used', 'a new member who tapped Not sure: the middle, named');
  assert.equal(d.endRent, 'Middle of the range used');
  assert.equal(d.profitEnd, 'mid');
  // An older member who answered the old risk question: the low end, named, until they answer the new one.
  const old = plainProfile({ ...DEFAULT_GOALS, dealTypes: ['buy_str'] }, [], WIDTHS, { about: { ...DEFAULT_ABOUT, risk: 'go' }, answered: { min_profit: real, risk: { at: '2026-10-01T00:00:00Z', notSure: false } }, profitEndDates: { ...dates, joinedAt: '2026-09-01T00:00:00Z' } });
  assert.equal(cardDisplayFor(old, false).endSale, 'Low end used');
  assert.equal(cardDisplayFor(old, false).profitEnd, 'low');
});
