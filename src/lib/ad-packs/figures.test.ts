import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_SAMPLES,
  FIGURE_LABEL_RE,
  buildFigure,
  figureIsLabelled,
  figureLabel,
  figureUnavailableReason,
  formatPounds,
  monthlyRounded,
  numberInWords,
  percentInWords,
  type FigureAgg,
  type FigureInput,
} from './figures.ts';

const AGG: FigureAgg = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };
const base = (over: Partial<FigureInput> = {}): FigureInput => ({ area_label: 'Cambridge', agg: AGG, feePct: 12, netIncludesFee: false, ...over });

test('figures are per month: the snapshot holds yearly values, divided by 12 and rounded to £50', () => {
  assert.equal(monthlyRounded(48_200), 4000); // 4,016.67
  assert.equal(monthlyRounded(31_000), 2600); // 2,583.33
  assert.equal(monthlyRounded(30_000), 2500);
  const f = buildFigure(base());
  assert.ok(f);
  assert.equal(f.gross, 4000);
  assert.equal(f.net, 2600);
  assert.equal(f.occupancyPct, 71);
  for (const n of [f.gross, f.net, f.takeHome, f.amount]) assert.equal((n as number) % 50, 0);
});

test('take-home: net minus the operator fee on the gross when net excludes the fee', () => {
  const f = buildFigure(base({ feePct: 12, netIncludesFee: false }));
  assert.ok(f);
  // (31,000 - 48,200 * 12%) / 12 = 2,101.33 -> 2,100
  assert.equal(f.takeHome, 2100);
  assert.equal(f.basis, 'take-home');
  assert.match(f.sentence, /Take-home: about £2,100 a month after costs and fees\./);
});

test('take-home equals net when net already includes a fee; the operator fee is not taken twice', () => {
  const f = buildFigure(base({ netIncludesFee: true, feePct: 12 }));
  assert.ok(f);
  assert.equal(f.takeHome, 2600);
  const noFee = buildFigure(base({ netIncludesFee: true, feePct: null }));
  assert.equal(noFee?.takeHome, 2600);
});

test('no fee set and net excludes it: no take-home, the net is quoted as "after costs"', () => {
  const f = buildFigure(base({ feePct: null, netIncludesFee: false }));
  assert.ok(f);
  assert.equal(f.takeHome, null);
  assert.equal(f.basis, 'net');
  assert.match(f.sentence, /After costs: about £2,600 a month\./);
  assert.doesNotMatch(f.sentence, /take-home|fee/i);
});

test('no net figure: the gross is quoted as bookings before costs', () => {
  const f = buildFigure(base({ agg: { ...AGG, avg_net_revenue: null } }));
  assert.ok(f);
  assert.equal(f.basis, 'gross');
  assert.equal(f.net, null);
  assert.match(f.sentence, /Bookings: about £4,000 a month, before costs\./);
});

test('too few reports: null with a reason, against the minSamples argument (default 5)', () => {
  assert.equal(DEFAULT_MIN_SAMPLES, 5);
  const few = base({ agg: { ...AGG, sample_count: 4 } });
  assert.equal(buildFigure(few), null);
  assert.equal(figureUnavailableReason(few), 'too_few_samples');
  assert.ok(buildFigure({ ...few, minSamples: 3 }));
  assert.equal(buildFigure({ ...few, minSamples: 5 }), null);
  assert.ok(buildFigure(base({ agg: { ...AGG, sample_count: 5 } })));
  assert.equal(figureUnavailableReason(base()), null);
});

test('other reasons: no area, no revenue data, a fee that leaves nothing', () => {
  assert.equal(figureUnavailableReason(base({ area_label: '   ' })), 'no_area');
  assert.equal(figureUnavailableReason(base({ agg: { ...AGG, avg_gross_revenue: null, avg_net_revenue: null } })), 'no_revenue_data');
  assert.equal(figureUnavailableReason(base({ agg: { ...AGG, avg_gross_revenue: 0, avg_net_revenue: 0 } })), 'no_revenue_data');
  assert.equal(figureUnavailableReason(base({ feePct: 90 })), 'figure_not_positive');
  assert.equal(buildFigure(base({ feePct: 90 })), null);
});

test('the label: exact wording, in the figure sentence, found by FIGURE_LABEL_RE', () => {
  const f = buildFigure(base({ area_label: '  Cambridge ' }));
  assert.ok(f);
  assert.equal(f.label, 'Example: a typical 3-bed in Cambridge, from 14 reports. Every property is different.');
  assert.ok(FIGURE_LABEL_RE.test(f.label));
  assert.ok(f.sentence.startsWith(f.label));
  assert.ok(FIGURE_LABEL_RE.test(f.sentence));
  assert.equal(figureLabel(2, 'Leeds', 1), 'Example: a typical 2-bed in Leeds, from 1 report. Every property is different.');
  assert.ok(FIGURE_LABEL_RE.test(figureLabel(2, 'Leeds', 1)));
});

test('every sentence with a £ figure carries the label; one figure, never a range', () => {
  for (const feePct of [null, 12, 12.5]) {
    for (const netIncludesFee of [true, false]) {
      const f = buildFigure(base({ feePct, netIncludesFee }));
      assert.ok(f);
      assert.ok(figureIsLabelled(f.sentence));
      assert.equal((f.sentence.match(/£/g) ?? []).length, 1);
      assert.doesNotMatch(f.sentence, /£[\d,]+\s*(?:-|–|to)\s*£?\d/);
      assert.doesNotMatch(f.sentence, /[–—]/);
    }
  }
  assert.equal(figureIsLabelled('Take-home: about £2,100 a month.'), false);
  assert.equal(figureIsLabelled('No figure here.'), true);
  assert.equal(figureIsLabelled(`Hello. ${buildFigure(base())!.sentence}`), true);
});

test('the spoken form has no £ and no digits, and still says the example is not universal', () => {
  const f = buildFigure(base());
  assert.ok(f);
  assert.doesNotMatch(f.spoken, /[£\d]/);
  assert.match(f.spoken, /Every property is different\./);
  assert.match(f.spoken, /three-bed in Cambridge, from fourteen reports/);
  assert.match(f.spoken, /two thousand, one hundred pounds a month/);
});

test('numbers in words and pound formatting', () => {
  assert.equal(numberInWords(14), 'fourteen');
  assert.equal(numberInWords(2300), 'two thousand, three hundred');
  assert.equal(numberInWords(2350), 'two thousand, three hundred and fifty');
  assert.equal(numberInWords(2005), 'two thousand and five');
  assert.equal(numberInWords(100_000), 'one hundred thousand');
  assert.equal(numberInWords(21), 'twenty-one');
  assert.equal(percentInWords(12), 'twelve percent');
  assert.equal(percentInWords(12.5), 'twelve point five percent');
  assert.equal(formatPounds(950), '£950');
  assert.equal(formatPounds(1_234_567), '£1,234,567');
});
