import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysedPrice, btlInsteadFor, rentFromLongLet } from './analyser.ts';
import type { AnalysisResult } from '../types.ts';

const longLet = { monthlyRent: 1_200, estimateLow: 1_150, estimateHigh: 1_250, comparables: [] };

test('the report’s own long-let valuation as a rent range: never narrower than ±10%', () => {
  assert.deepEqual([rentFromLongLet(longLet)!.low, rentFromLongLet(longLet)!.mid, rentFromLongLet(longLet)!.high], [1_080, 1_200, 1_320]);
  assert.deepEqual([rentFromLongLet({ ...longLet, estimateLow: 900, estimateHigh: 1_500 })!.low, rentFromLongLet({ ...longLet, estimateLow: 900, estimateHigh: 1_500 })!.high], [900, 1_500], 'a wider valuation range is kept');
  assert.equal(rentFromLongLet({ ...longLet, monthlyRent: 0 }), null);
  assert.equal(rentFromLongLet(null), null);
});

test('the price it is worked at: the asking price, then the listing’s, then the valuation', () => {
  assert.equal(analysedPrice({ deal: { kind: 'purchase', askingPrice: 160_000 } as never, sourceListing: null, propertyValuation: null }), 160_000);
  assert.equal(analysedPrice({ deal: null, sourceListing: { url: 'x', source: 'rightmove', kind: 'sale', price: { amount: 150_000, period: 'total' } }, propertyValuation: null }), 150_000);
  assert.equal(analysedPrice({ deal: null, sourceListing: null, propertyValuation: { estimatedValue: 140_000 } as never }), 140_000);
  assert.equal(analysedPrice({ deal: null, sourceListing: null, propertyValuation: null }), null);
});

test('"Buy to let instead?": the buy-to-let figures on the report’s own data; nothing without a price or a rent', () => {
  const r = { property: { address: '1 High St', postcode: 'B44 9AA', bedrooms: 3, guests: 6 }, longLet, deal: { kind: 'purchase', askingPrice: 160_000, mortgageRateLive: { ratePct: 5.13, product: '2-year fixed', date: 'Sep 2026' } }, epc: { rating: 'd' }, growth: { outcode: 'B44', region: 'west_midlands', growth5y: 28.9, growth1y: 3.9, asOf: '2026-09-27' } } as unknown as AnalysisResult;
  const card = btlInsteadFor(r)!;
  assert.equal(card.price, 160_000);
  assert.equal(card.ratePct, 5.13);
  assert.equal(card.rateFallback, false);
  assert.equal(card.flags.epc, 'D');
  assert.equal(card.rentTest.requiredRent, 891);
  assert.ok(card.growth && card.growth.value5y.low > 160_000);
  assert.ok(!JSON.stringify(card).includes('High St') && !JSON.stringify(card).includes('B44 9AA'), 'no address or full postcode');
  assert.equal(btlInsteadFor({ ...r, longLet: { ...longLet, monthlyRent: 0 } }), null);
  assert.equal(btlInsteadFor({ ...r, deal: null }), null);
});

// ── Review R4 (R4-24) ──

const reportOf = (over: Partial<AnalysisResult> = {}) =>
  ({ property: { address: '1 High St', postcode: 'B44 9AA', bedrooms: 2, guests: 4 }, longLet, deal: { kind: 'purchase', askingPrice: 160_000, mortgageRateLive: { ratePct: 5.13, product: '2-year fixed', date: 'Sep 2026' } }, epc: { rating: 'c' }, growth: { outcode: 'B44', region: 'west_midlands', growth5y: 28.9, growth1y: 3.9, asOf: '2026-09-27' }, ...over }) as unknown as AnalysisResult;

test('R4-24: a flat’s analyser figure includes the service charge and ground rent, as the screen does', async () => {
  const { DEFAULT_BTL_SETTINGS } = await import('./config.ts');
  const { flatCharges } = await import('./listing.ts');
  const { btlDeal } = await import('./deal.ts');
  const r = reportOf();
  const flat = btlInsteadFor(r, { settings: DEFAULT_BTL_SETTINGS, buyingCosts: 2_500, kind: 'flat' })!;
  const house = btlInsteadFor(r, { settings: DEFAULT_BTL_SETTINGS, buyingCosts: 2_500, kind: 'house' })!;
  assert.equal(flat.kind, 'flat');
  assert.equal(flat.flags.serviceChargeConfirmed, false, 'no listed charge: the estimate, and the card says so');
  assert.ok(flat.costLines.serviceCharge > 0 && flat.costLines.groundRent > 0);
  assert.ok(house.cashflowMonthly.mid - flat.cashflowMonthly.mid > 100, 'about £137 a month less for the flat');
  // The same figure the nightly screen works out for the same flat (screen.ts: flatCharges then btlDeal).
  const charges = flatCharges('flat', {}, false, DEFAULT_BTL_SETTINGS.flats);
  const screen = btlDeal(160_000, rentFromLongLet(longLet)!, { ratePct: 5.13, country: 'england', buyingCosts: 2_500, flat: charges, epc: 'C', finance: DEFAULT_BTL_SETTINGS.finance, costs: DEFAULT_BTL_SETTINGS.costs, epcSettings: DEFAULT_BTL_SETTINGS.epc })!;
  assert.deepEqual(flat.cashflowMonthly, screen.cashflowMonthly);
});

test('R4-24: it uses the settings it is given (a 15% agent fee changes the cashflow; the stored buying costs the cash in)', async () => {
  const { DEFAULT_BTL_SETTINGS } = await import('./config.ts');
  const r = reportOf();
  const base = btlInsteadFor(r, { settings: DEFAULT_BTL_SETTINGS, buyingCosts: 2_500, kind: 'house' })!;
  const agent15 = btlInsteadFor(r, { settings: { ...DEFAULT_BTL_SETTINGS, costs: { ...DEFAULT_BTL_SETTINGS.costs, agentPct: 15 } }, buyingCosts: 4_000, kind: 'house' })!;
  assert.ok(agent15.cashflowMonthly.mid < base.cashflowMonthly.mid, '15% agent fee: less each month');
  assert.equal(agent15.cashIn.mid - base.cashIn.mid, 1_500, 'the stored buying costs');
});

test('R4-24: worked out on the server where the analysis is built; the client section only shows it', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');
  const run = read('../analysis/run.ts');
  assert.match(run, /result\.btlInstead = await btlInsteadForReport\(result, input\);/);
  assert.match(run, /readBtlSettingsCached\(createAdminClient\(\)\)/);
  assert.match(run, /btlInsteadFor\(result, \{ settings: stored\.settings, buyingCosts: stored\.buyingCosts, kind \}\)/);
  const view = read('../../components/report/BuyToLetInstead.tsx');
  assert.match(view, /const card = result\.btlInstead \?\? null;/);
  assert.doesNotMatch(view, /btlInsteadFor\(/, 'the client component never works it out with built-in defaults');
});
