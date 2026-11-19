import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_ESTIMATE_CAVEAT, SUMMARY_LABEL, buildSummary, summaryLines } from './summary.ts';
import { qualityOk } from './policy.ts';

const ADDRESS = '12 Acacia Avenue, Headingley';
const POSTCODE = 'LS6 1AB';
const result = {
  property: { address: ADDRESS, postcode: POSTCODE, bedrooms: 2, guests: 4, locality: 'Leeds' },
  shortLet: {
    annualRevenue: 28_437,
    occupancyRate: 0.684,
    averageDailyRate: 121.4,
    activeListings: 31,
    comparables: [{ title: `Lovely flat near ${ADDRESS}`, url: 'https://airbnb.example/rooms/1' }],
    monthlyRevenue: [],
  },
} as never;

test('summary: headline figures, labelled an estimate', () => {
  const s = buildSummary(result, true)!;
  assert.equal(s.kind, 'estimate');
  assert.equal(s.label, SUMMARY_LABEL);
  assert.deepEqual(s.figures, { annualIncome: 28_440, monthlyIncome: 2_370, occupancyPct: 68, nightlyRate: 121, bedrooms: 2 });
  for (const label of Object.values(s.figureLabels)) assert.ok(label.length > 0);
  assert.match(s.figureLabels.annualIncome, /Estimated/);
});

test('summary carries the caveat only when quality is false', () => {
  const ok = buildSummary(result, true)!;
  assert.equal(ok.early, false);
  assert.equal(ok.caveat, null);
  assert.equal(JSON.stringify(ok).includes(EARLY_ESTIMATE_CAVEAT), false);
  assert.equal(summaryLines(ok).some((l) => l.includes(EARLY_ESTIMATE_CAVEAT)), false);

  const low = buildSummary(result, false)!;
  assert.equal(low.early, true);
  assert.equal(low.caveat, 'early estimate, limited local data');
  assert.equal(summaryLines(low).at(-1), 'Note: early estimate, limited local data');
  // Straight from the policy: complete but untrustworthy, or trustworthy but incomplete, is low quality.
  assert.equal(buildSummary(result, qualityOk({ complete: true, trustworthy: false }))!.early, true);
  assert.equal(buildSummary(result, qualityOk({ complete: true, trustworthy: true }))!.early, false);
});

test('summary contains no address', () => {
  for (const q of [true, false]) {
    const s = buildSummary(result, q)!;
    const text = JSON.stringify(s) + summaryLines(s).join('\n');
    for (const secret of [ADDRESS, 'Acacia', 'Headingley', POSTCODE, 'LS6', 'Leeds', 'airbnb', 'Lovely flat']) {
      assert.equal(text.toLowerCase().includes(secret.toLowerCase()), false, secret);
    }
    // Only the allow-listed keys are present.
    assert.deepEqual(Object.keys(s).sort(), ['caveat', 'early', 'figureLabels', 'figures', 'kind', 'label']);
    assert.deepEqual(Object.keys(s.figures).sort(), ['annualIncome', 'bedrooms', 'monthlyIncome', 'nightlyRate', 'occupancyPct']);
  }
});

test('summary: no figures means no summary', () => {
  assert.equal(buildSummary({ shortLet: { annualRevenue: 0 } } as never, true), null);
  assert.equal(buildSummary({ shortLet: undefined } as never, true), null);
  assert.equal(buildSummary({ shortLet: { annualRevenue: Number.NaN } } as never, true), null);
  assert.equal(buildSummary(null as never, true), null);
});

test('summary: odd inputs stay sane', () => {
  const s = buildSummary({ shortLet: { annualRevenue: 12_000, occupancyRate: 1.4, averageDailyRate: -5 } } as never, true)!;
  assert.equal(s.figures.occupancyPct, 100);
  assert.equal(s.figures.nightlyRate, 0);
  assert.equal(s.figures.bedrooms, 0);
});
