import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btlBandFromCash, budgetFromCash, buyingCashTop, cashBandFromBudget, cashNeededFor, maxPriceForCash, priceLine } from './buying-power.ts';
import { DEFAULT_BUYER_GOALS } from '../market/goals.ts';
import { TAILORING } from '../tailoring/config.ts';

const BANDS = ['u30', '30-60', '60-100', '100-200', '200+'] as const;

test('max price from cash: monotonic, rounded down to £5k, never over the cash', () => {
  let lastMortgage = -1;
  let lastCash = -1;
  for (const b of BANDS) {
    const top = TAILORING.cashAvailableTop[b] ?? 200_000;
    const mortgage = maxPriceForCash(top, { cashBuyer: false });
    const cash = maxPriceForCash(top, { cashBuyer: true });
    assert.equal(mortgage % 5000, 0);
    assert.equal(cash % 5000, 0);
    if (b === '200+') assert.ok(mortgage === lastMortgage && cash === lastCash, '£200k+ starts where the band below tops out ("over about")');
    else assert.ok(mortgage > lastMortgage && cash > lastCash, `${b} buys more than the band below`);
    assert.ok(mortgage > cash, `${b}: a mortgage stretches the cash further`);
    assert.ok(cashNeededFor(mortgage, false) <= top, `${b}: the mortgage price fits the cash`);
    assert.ok(cashNeededFor(cash, true) <= top, `${b}: the cash price fits the cash`);
    assert.ok(cashNeededFor(mortgage + 5000, false) > top, `${b}: £5k more would not`);
    lastMortgage = mortgage;
    lastCash = cash;
  }
  assert.equal(maxPriceForCash(5_000, { cashBuyer: false }), 0, 'cash below the furnishing buys nothing');
});

test('price line reads for each band, mortgage and cash', () => {
  for (const b of BANDS) {
    const m = priceLine(b, 'btl')!;
    const c = priceLine(b, 'cash')!;
    if (b === '200+') {
      assert.match(m, /^With a mortgage, that's over about £[\d,]+\.$/);
      assert.match(c, /^With cash, over about £[\d,]+\.$/);
    } else {
      assert.match(m, /^With a mortgage, that's up to about £[\d,]+\.$/);
      assert.match(c, /^With cash, up to about £[\d,]+\.$/);
    }
  }
  assert.equal(priceLine(null, 'cash'), null);
  assert.equal(priceLine('u30', null), priceLine('u30', 'bridging'), 'no funding answer reads as a mortgage');
});

test('budget from cash is a ceiling only', () => {
  assert.equal(budgetFromCash('u30', 'btl'), 'u100');
  assert.equal(budgetFromCash('200+', 'btl'), null, 'open-ended band: no band');
  for (const b of BANDS) {
    const got = budgetFromCash(b, 'btl');
    assert.ok(got === null || got === 'u100' || got === 'u200', `${b} -> ${got}`);
  }
  // cash buyers reach a lower price, so never a higher ceiling than a mortgage buyer
  const rank = (x: string | null) => (x === 'u100' ? 1 : x === 'u200' ? 2 : 3);
  for (const b of BANDS) assert.ok(rank(budgetFromCash(b, 'cash')) <= rank(budgetFromCash(b, 'btl')));
});

test('buy to let band: the band whose top is at or below the cash top', () => {
  assert.equal(btlBandFromCash('u30'), 'under_25k');
  assert.equal(btlBandFromCash('30-60'), '25k_50k');
  assert.equal(btlBandFromCash('60-100'), '50k_100k');
  assert.equal(btlBandFromCash('100-200'), '100k_plus');
  assert.equal(btlBandFromCash('200+'), '100k_plus');
  assert.equal(btlBandFromCash(null), null);
});

test('cash band from budget: every budget band lands on a real cash band that covers it', () => {
  const budgets = ['u100', '100-200', 'u200', '200-350', '350-500', '500+'] as const;
  let last = -1;
  for (const b of budgets) {
    const band = cashBandFromBudget(b)!;
    assert.ok(band, b);
    const idx = BANDS.indexOf(band);
    assert.ok(idx >= last || b === 'u200', `${b} never lands below a cheaper budget`);
    last = Math.max(last, idx);
    const top = TAILORING.cashAvailableTop[band];
    if (top !== null) {
      const topPrice = { u100: 100_000, '100-200': 200_000, u200: 200_000, '200-350': 350_000, '350-500': 500_000, '500+': 0 }[b];
      assert.ok(cashNeededFor(topPrice, false) <= top, `${b}: the band covers the budget top`);
    }
  }
  assert.equal(cashBandFromBudget('500+'), '200+');
  assert.equal(cashBandFromBudget(null), null);
});

test('buying cash top: null when unanswered or only worked out', () => {
  assert.equal(buyingCashTop({ buyer: DEFAULT_BUYER_GOALS }), null);
  assert.equal(buyingCashTop({ buyer: { ...DEFAULT_BUYER_GOALS, cashAvailable: '30-60' } }), 60_000);
  assert.equal(buyingCashTop({ buyer: { ...DEFAULT_BUYER_GOALS, cashAvailable: '30-60', cashFromBudget: true } }), null);
  assert.equal(buyingCashTop({ buyer: { ...DEFAULT_BUYER_GOALS, cashAvailable: '200+' } }), null, 'open-ended: no ceiling');
});
