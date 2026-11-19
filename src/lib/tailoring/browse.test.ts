import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestForYouOrder, leanDeal, type BrowseRow } from './browse.ts';
import { plainProfile, type TailoringProfile } from './profile.ts';
import { DEFAULT_GOALS, type MarketGoals } from '../market/goals.ts';

const NOW = new Date('2026-09-28T09:00:00Z');
const WIDTHS = { high: 10, medium: 15, low: 25 };
const AT = '2026-09-20T10:00:00Z';
const real = { at: AT, notSure: false };

const row = (over: Partial<BrowseRow> = {}): BrowseRow => ({
  id: 'd1', source: 'rightmove', kind: 'rent', postcode_area: 'DE', outcode: 'DE1', town: 'Derby', bedrooms: 2,
  price_amount: 1_100, price_period: 'pcm', raw_type: 'Terraced house', tenure: null, band: 'qualified',
  annual_profit: 9_000, uplift_pct: null, reduced_at: null, listed_date: '2026-06-01T00:00:00Z', status: 'live',
  first_seen_at: '2026-06-01T00:00:00Z', last_checked_live_at: null, last_confirmed_at: AT, last_confirmed_via: 'live',
  screening_gross: '42000', screening_confidence: 'medium', motivation: null, price_history: null,
  deal_setup: '9000', deal_breakeven: '48', deal_payback: '12', deal_margin: '760',
  suitability: 'ok', deal_target_margin: '500',
  ...over,
});
const sale = (over: Partial<BrowseRow> = {}) =>
  row({ kind: 'sale', price_amount: 180_000, price_period: 'total', deal_setup: null, deal_breakeven: null, deal_payback: null, deal_margin: null, deal_target_margin: null, deal_yield: '9', deal_target_yield: '10', ...over });
const operator = (g: Partial<MarketGoals> = {}, over: Partial<TailoringProfile> = {}) =>
  plainProfile({ ...DEFAULT_GOALS, path: 'r2r', sourcingKind: 'rent', maxRentPcm: 1_500, bedrooms: 2, finance: { ...DEFAULT_GOALS.finance, targetMarginPcm: 400 }, ...g }, [], WIDTHS, { answered: { r2r_min_profit: real }, ...over });
const input = (tailoring: TailoringProfile | null = null, goals: MarketGoals | null = null) => ({ goals, tailoring, cards: null, now: NOW });

test('the lean deal carries only what the fit reads, and nothing without figures', () => {
  assert.deepEqual(leanDeal(row()), { kind: 'rent-to-rent', monthlyMargin: 760, targetMarginPcm: 500 });
  assert.deepEqual(leanDeal(sale()), { kind: 'purchase', grossYieldPct: 9, targetYieldPct: 10 });
  assert.equal(leanDeal(row({ deal_margin: null })), null);
  assert.equal(leanDeal(sale({ deal_yield: '' })), null);
});

test('no new answers: the shared fit, then profit, then the id; unusable rows last', () => {
  const rows = [
    row({ id: 'c', deal_margin: '600' }),
    row({ id: 'a', deal_margin: '900' }),
    row({ id: 'b', deal_margin: '900' }),
    row({ id: 'z-loss', deal_margin: '-50', annual_profit: 50_000 }),
    row({ id: 'y-nofig', deal_margin: null, annual_profit: 40_000 }),
    row({ id: 'x-room', suitability: 'room', annual_profit: 30_000 }),
  ];
  const order = bestForYouOrder(rows, input());
  assert.deepEqual(order.slice(0, 3), ['a', 'b', 'c'], 'better margin first; equal fits by id');
  assert.deepEqual(order.slice(3), ['z-loss', 'y-nofig', 'x-room'], 'what the order cannot use goes last, best profit first');
  assert.equal(order.length, rows.length, 'every row is placed: the cards add up to the total');
});

test('the order is total: shuffled input gives the same ids', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ id: `d${String(i).padStart(2, '0')}`, deal_margin: String(500 + (i % 4) * 100), annual_profit: 9_000 + (i % 3) * 100 }));
  const first = bestForYouOrder(rows, input());
  const again = bestForYouOrder([...rows].reverse(), input());
  assert.deepEqual(again, first);
});

test('a tailored profile: a must-have miss is sorted lower, never hidden', () => {
  const p = operator();
  const fits = row({ id: 'fits', deal_margin: '600' });
  const tooDear = row({ id: 'dear', price_amount: 1_900, deal_margin: '1200' });
  const order = bestForYouOrder([tooDear, fits], input(p, p.goals));
  assert.deepEqual(order, ['fits', 'dear']);
});

test('a tailored profile: fewer nice-to-haves missed ranks first, then the fit', () => {
  const p = operator();
  const oneBed = row({ id: 'one-bed', bedrooms: 1, deal_margin: '1200' });
  const twoBed = row({ id: 'two-bed', bedrooms: 2, deal_margin: '600' });
  assert.deepEqual(bestForYouOrder([oneBed, twoBed], input(p, p.goals)), ['two-bed', 'one-bed'], 'bedrooms is a nice-to-have it misses');
});

test('an untailored member is not sorted by the tailored rules', () => {
  const p = plainProfile(DEFAULT_GOALS, [], WIDTHS);
  const oneBed = row({ id: 'one-bed', bedrooms: 1, deal_margin: '1200' });
  const twoBed = row({ id: 'two-bed', bedrooms: 2, deal_margin: '600' });
  assert.deepEqual(bestForYouOrder([twoBed, oneBed], input(p, DEFAULT_GOALS)), ['one-bed', 'two-bed']);
});

// ── Batch 22e: Browse is the deals picked for you ──

test('Batch 22e: by default nothing outside the profile is listed: areas, budget (u200 included), deal types, must-haves', async () => {
  const { profileFits, nearestMisses, missLabel } = await import('./browse.ts');
  const buyer = plainProfile({ ...DEFAULT_GOALS, path: 'buy', sourcingKind: 'sale', where: 'areas', budget: 'u200', dealTypes: ['buy_str'] }, ['DE'], WIDTHS, { answered: { where: real, budget: real } });
  const rows = [
    sale({ id: 'in', postcode_area: 'DE', price_amount: 180_000 }),
    sale({ id: 'dear', postcode_area: 'DE', price_amount: 260_000 }),
    sale({ id: 'away', postcode_area: 'M', price_amount: 150_000 }),
    row({ id: 'rental', postcode_area: 'DE' }),
  ];
  const fits = profileFits(rows, buyer, ['buy_str'], NOW);
  assert.ok(fits);
  const listed = rows.map((r) => r.id).filter((id) => fits!.get(id)!.misses.length === 0);
  assert.deepEqual(listed, ['in'], 'only the deal inside the profile');
  assert.deepEqual(fits!.get('dear')!.misses, ['budget'], "legacy 'u200' is a £200,000 ceiling");
  assert.deepEqual(fits!.get('away')!.misses, ['location']);
  assert.ok(fits!.get('rental')!.misses.includes('deal_type'));
  assert.deepEqual(nearestMisses(['away', 'in', 'rental', 'dear'], fits!), ['away', 'rental', 'dear'], 'one miss each: the given order; never a match');
  const twoMisses = profileFits([sale({ id: 'both', postcode_area: 'M', price_amount: 260_000 }), sale({ id: 'one', postcode_area: 'M', price_amount: 150_000 })], buyer, ['buy_str'], NOW)!;
  assert.deepEqual(nearestMisses(['both', 'one'], twoMisses), ['one', 'both'], 'fewest misses first');
  assert.equal(missLabel('budget'), 'Budget');
  assert.equal(missLabel('deal_type'), 'Deal type');
});

test('Batch 22e: an area or budget made a nice-to-have still narrows Browse; other nice-to-haves do not', async () => {
  const { profileFits } = await import('./browse.ts');
  const p = plainProfile({ ...DEFAULT_GOALS, path: 'buy', sourcingKind: 'sale', where: 'areas', budget: '100-200', bedrooms: 3, dealTypes: ['buy_str'] }, ['DE'], WIDTHS, { answered: { where: real, budget: real, bedrooms: real }, modes: { location: 'nice', budget: 'nice' } });
  const fits = profileFits([sale({ id: 'away', postcode_area: 'M', price_amount: 150_000, bedrooms: 2 }), sale({ id: 'twobed', postcode_area: 'DE', price_amount: 150_000, bedrooms: 2 })], p, ['buy_str'], NOW)!;
  assert.deepEqual(fits.get('away')!.misses, ['location']);
  assert.deepEqual(fits.get('twobed')!.misses, [], 'bedrooms is a nice-to-have: shown');
});

test('Batch 22e: a profile with no answers narrows nothing', async () => {
  const { profileFits } = await import('./browse.ts');
  assert.equal(profileFits([row()], null, [], NOW), null);
  assert.equal(profileFits([row()], plainProfile(null, [], WIDTHS), [], NOW), null);
});

test('Batch 22e: the other sorts inside the list', async () => {
  const { sortRows } = await import('./browse.ts');
  const rows = [sale({ id: 'a', annual_profit: 5_000, price_amount: 90_000, first_seen_at: '2026-09-01T00:00:00Z' }), sale({ id: 'b', annual_profit: 9_000, price_amount: 120_000, first_seen_at: '2026-09-20T00:00:00Z' })];
  assert.deepEqual(sortRows(rows, 'profit'), ['b', 'a']);
  assert.deepEqual(sortRows(rows, 'price'), ['a', 'b']);
  assert.deepEqual(sortRows(rows, 'newest'), ['b', 'a']);
});

// ── Review R4 (R4-23) ──

test('R4-23: a row judged as Buy to let uses its buy-to-let cash in (no "Misses" on a £56k deal for Buying cash 30-60), and no short-let profit check', async () => {
  const { profileFits } = await import('./browse.ts');
  const { judgeDeal, factsFromRow, forTypes, rentalFromCard, wantsFor } = await import('./criteria.ts');
  // Member A: Buy to let, Buying cash £30–60k, a minimum profit answered for short-lets.
  const memberA = plainProfile(
    { ...DEFAULT_GOALS, path: 'buy', sourcingKind: 'sale', where: 'areas', dealTypes: ['btl'], btl: { priority: 'income', cashBand: '25k_50k' }, buyer: { ...DEFAULT_GOALS.buyer, cashAvailable: '30-60', cashFromBudget: false }, finance: { ...DEFAULT_GOALS.finance, targetMarginPcm: 900 } },
    ['DE'], WIDTHS, { answered: { where: real, cash_available: real, min_profit: real, main_goal: real } },
  );
  const at = (mid: number) => ({ cashIn: { low: mid, mid, high: mid + 5_000 } }) as unknown as BrowseRow['btl'];
  // £175k 3-bed: £56,000 cash in as a buy-to-let (no furnishing); about £70,000 as a short-let purchase.
  const btl56 = sale({ id: 'a', postcode_area: 'DE', bedrooms: 3, price_amount: 175_000, band: 'unqualified', btl_pass: true, btl: at(56_000), annual_profit: 1_000 });
  const btl64 = sale({ id: 'b', postcode_area: 'DE', bedrooms: 3, price_amount: 175_000, band: 'unqualified', btl_pass: true, btl: at(64_000), annual_profit: 1_000 });
  const fits = profileFits([btl56, btl64], memberA, ['btl'], NOW)!;
  assert.deepEqual(fits.get('a')!.misses, [], 'on Today at £56k ≤ £60k: no "Misses: Cash available" on Browse either');
  assert.deepEqual(fits.get('b')!.misses, ['cash'], 'over the same £60k ceiling as Today');
  const facts = forTypes(factsFromRow(btl56, rentalFromCard(btl56), { qualifies: undefined, score: 0 }), ['btl']);
  const keys = judgeDeal(facts, memberA, wantsFor(memberA)).judgement.checks.map((c) => c.key);
  assert.ok(keys.includes('cash') && !keys.includes('profit'), 'judged on its own cash in, never the short-let profit');
});
