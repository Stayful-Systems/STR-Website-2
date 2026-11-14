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
  const p = (risk: 'avoid' | 'consider' | 'go' | null, answered: Record<string, typeof real>) => plainProfile({ ...DEFAULT_GOALS, dealTypes: ['buy_str', 'r2r'] }, [], WIDTHS, { about: { ...DEFAULT_ABOUT, risk }, answered });
  const d = cardDisplayFor(p('avoid', { min_profit: real }), false);
  assert.equal(d.endSale, 'Low end used, as you asked');
  assert.equal(d.endRent, 'Low end used, as you asked', 'the one minimum judges rentals too');
  assert.equal(cardDisplayFor(p('go', { min_profit: real }), false).endSale, 'Top end used, as you asked');
  assert.equal(cardDisplayFor(p(null, { min_profit: real }), false).endSale, 'Middle of the range used, as you asked');
  const none = cardDisplayFor(p('avoid', {}), false);
  assert.equal(none.endSale, null, 'no minimum profit given: no line');
  assert.equal(none.endRent, null);
  assert.deepEqual(cardDisplayFor(null, false), NO_DISPLAY);
});

test('"change" opens the rate screen and comes back to the page', () => {
  assert.equal(changeRateHref('/deals/abc'), '/welcome?q=finance&next=%2Fdeals%2Fabc');
});
