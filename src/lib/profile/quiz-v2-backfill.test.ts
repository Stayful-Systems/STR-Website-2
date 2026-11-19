import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillDone, backfillQuizV2, beforeOf, summarise } from './quiz-v2-backfill.ts';
import { DEFAULT_GOALS, parseMarketGoals, type MarketGoals } from '../market/goals.ts';
import { DEFAULT_ABOUT } from './about.ts';

const AT = '2026-10-01T00:00:00Z';
const real = { at: AT, notSure: false };
const shrug = { at: AT, notSure: true };
const stored = (over: Partial<MarketGoals> = {}, extra: Record<string, unknown> = {}) => ({ ...DEFAULT_GOALS, ...over, ...extra });
const r2rWith = (setupBudget: string) => stored({ dealTypes: ['r2r'], sourcingKind: 'rent' }, { r2r: { ...DEFAULT_GOALS.r2r, setupBudget } });

test('an old setup answer moves onto the new bands and stays a nice-to-have, as it was', () => {
  const expected: Record<string, string> = { u3k: 'u10k', '3-6k': 'u10k', '6-10k': 'u10k', '10k+': '10-15k' };
  for (const [old, now] of Object.entries(expected)) {
    const r = backfillQuizV2(r2rWith(old), DEFAULT_ABOUT, { setup_budget: real }, {});
    assert.equal(r.status, 'map', old);
    if (r.status !== 'map') continue;
    assert.equal(r.goals.r2r.setupBudget, now, old);
    assert.deepEqual(r.modes, { setup: 'nice' });
    assert.equal(r.after.setupMode, 'nice');
  }
});

test('a member who already chose the setup switch keeps it; no modes to write to means none are written', () => {
  const must = backfillQuizV2(r2rWith('3-6k'), DEFAULT_ABOUT, {}, { setup: 'must' });
  assert.ok(must.status === 'map' && must.modes === null, 'their own switch stays');
  const none = backfillQuizV2(r2rWith('3-6k'), DEFAULT_ABOUT, {}, null);
  assert.ok(none.status === 'map' && none.modes === null);
  assert.equal(none.status === 'map' && none.goals.r2r.setupBudget, 'u10k', 'the band still moves');
});

test('an answer already on the new bands is not touched: a new member is never made a nice-to-have', () => {
  for (const band of ['u10k', '10-15k', '15-20k', '20k+']) assert.equal(backfillQuizV2(r2rWith(band), DEFAULT_ABOUT, { setup_budget: real }, {}).status, 'already', band);
});

test('a buyer with a budget and no cash gets the cash band it points to, marked as worked out', () => {
  const buyer = (budget: string) => stored({ dealTypes: ['buy_str'], budget: budget as never });
  const r = backfillQuizV2(buyer('u100'), DEFAULT_ABOUT, { budget: real }, {});
  assert.ok(r.status === 'map');
  if (r.status !== 'map') return;
  assert.ok(r.goals.buyer.cashAvailable);
  assert.equal(r.goals.buyer.cashFromBudget, true);
  assert.equal(r.after.cashFromBudget, true);
  assert.equal(backfillQuizV2(buyer('500+'), DEFAULT_ABOUT, {}, {}).status === 'map' && (backfillQuizV2(buyer('500+'), DEFAULT_ABOUT, {}, {}) as { goals: MarketGoals }).goals.buyer.cashAvailable, '200+');
  // A project buyer's budget counts too.
  const brrr = backfillQuizV2(stored({ dealTypes: ['brrr'], brrr: { budget: '100-200', work: null } }), DEFAULT_ABOUT, {}, {});
  assert.ok(brrr.status === 'map' && brrr.goals.buyer.cashFromBudget);
  // Never over a real answer, and never for a profile that does not buy.
  assert.equal(backfillQuizV2(stored({ dealTypes: ['buy_str'], budget: 'u100', buyer: { ...DEFAULT_GOALS.buyer, cashAvailable: '30-60' } }), DEFAULT_ABOUT, {}, {}).status, 'already');
  assert.equal(backfillQuizV2(stored({ dealTypes: ['r2r'], sourcingKind: 'rent', budget: 'u100' }), DEFAULT_ABOUT, {}, {}).status, 'already');
});

test('the worked-out band is never written with an answered mark: the result carries goals and modes only', () => {
  const r = backfillQuizV2(stored({ dealTypes: ['buy_str'], budget: 'u200' }), DEFAULT_ABOUT, {}, {});
  assert.ok(r.status === 'map');
  assert.deepEqual(Object.keys(r).sort(), ['after', 'goals', 'modes', 'status'], 'no marks to write');
});

test('a rate the member chose is theirs; one the daily sync has already moved is never mistaken for one', () => {
  const buyer = (rate: number, rateAsOf: string | null, rateSet = false) => stored({ dealTypes: ['buy_str'], finance: { ...DEFAULT_GOALS.finance, mortgageRatePct: rate, rateAsOf, rateSet } });
  const set = (r: ReturnType<typeof backfillQuizV2>) => r.status === 'map' && r.goals.finance.rateSet;
  assert.equal(set(backfillQuizV2(buyer(6, null), DEFAULT_ABOUT, {}, {})), true, 'not the house rate: theirs');
  assert.equal(set(backfillQuizV2(buyer(5.5, null), DEFAULT_ABOUT, { finance: real }, {})), true, 'a real finance answer, even at the house rate');
  assert.equal(backfillQuizV2(buyer(5.5, null), DEFAULT_ABOUT, { finance: shrug }, {}).status, 'already', '"Not sure" on the rate is no answer');
  assert.equal(backfillQuizV2(buyer(5.5, null), DEFAULT_ABOUT, {}, {}).status, 'already', 'the house rate they never touched stays on today’s average');
  assert.equal(backfillQuizV2(buyer(5.29, '2026-11-14'), DEFAULT_ABOUT, {}, {}).status, 'already', 'already synced: it is the average, not their choice');
  assert.equal(backfillQuizV2(buyer(6, null, true), DEFAULT_ABOUT, {}, {}).status, 'already');
});

test('idempotent: running it again on what it wrote changes nothing', () => {
  const messy = stored({ dealTypes: ['buy_str', 'r2r'], sourcingKind: 'both', budget: '100-200', finance: { ...DEFAULT_GOALS.finance, mortgageRatePct: 6.1 } }, { r2r: { ...DEFAULT_GOALS.r2r, setupBudget: '10k+' } });
  const first = backfillQuizV2(messy, DEFAULT_ABOUT, { finance: real }, {});
  assert.ok(first.status === 'map');
  if (first.status !== 'map') return;
  // The stored form is what parseMarketGoals read back (the database reorders keys, never values).
  const written = JSON.parse(JSON.stringify(first.goals));
  assert.equal(backfillQuizV2(written, DEFAULT_ABOUT, { finance: real }, first.modes ?? {}).status, 'already');
  assert.ok(parseMarketGoals(written));
});

test('the dry run reads before and after as option keys only', () => {
  const raw = r2rWith('6-10k');
  const before = beforeOf(raw, {});
  assert.deepEqual(before, { setup: '6-10k', budget: null, brrrBudget: null, cash: null, rate: 5.5, rateSet: false, rateAsOf: null, setupMode: null });
  assert.equal(beforeOf('junk', {}), null);
  assert.deepEqual(summarise(['map', 'map', 'already', 'no_goals']), { toMap: 2, already: 1, noGoals: 1 });
  assert.equal(backfillQuizV2(null, null, {}, {}).status, 'no_goals');
  for (const s of JSON.stringify(before)) assert.ok(s !== '@', 'no email');
});

// Review R4 (R4-43): an older Buy to let member's Buying cash row was "Not answered yet" for good.
test('a BTL-only member with a BTL band gets a worked-out Buying cash', () => {
  const btl = stored({ dealTypes: ['btl'] }, { btl: { ...DEFAULT_GOALS.btl, cashBand: '25k_50k' } });
  const r = backfillQuizV2(btl, DEFAULT_ABOUT, { btl_cash: real }, {});
  assert.equal(r.status, 'map');
  if (r.status !== 'map') return;
  assert.equal(r.goals.buyer.cashAvailable, '30-60', 'the band that covers £25–50k');
  assert.equal(r.goals.buyer.cashFromBudget, true, 'worked out, never a filter');
  assert.equal(r.after.cash, '30-60');
  assert.equal(r.goals.btl.cashBand, '25k_50k', 'their Buy to let band is untouched');
  // Idempotent: a second run changes nothing.
  assert.equal(backfillQuizV2(r.goals, DEFAULT_ABOUT, { btl_cash: real }, {}).status, 'already');
  // A budget, when they have one, still decides.
  const both = backfillQuizV2(stored({ dealTypes: ['btl'], budget: 'u100' }, { btl: { ...DEFAULT_GOALS.btl, cashBand: '100k_plus' } }), DEFAULT_ABOUT, {}, {});
  assert.ok(both.status === 'map' && both.goals.buyer.cashAvailable !== '100-200');
});

// Review R4 (R4-33): what counts as done, for the stamp the rate sync waits for.
test('a real run stamps "done" only when nothing is left', () => {
  assert.equal(backfillDone({ profilesReadable: true, left: 0, outOfTime: false }), true);
  assert.equal(backfillDone({ profilesReadable: true, left: 1, outOfTime: false }), false);
  assert.equal(backfillDone({ profilesReadable: true, left: 0, outOfTime: true }), false);
  assert.equal(backfillDone({ profilesReadable: false, left: 0, outOfTime: false }), false);
});
