import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerColumns, countedFacts, p90, packPayingCsv, packPayingReport, parsePackFacts, ragHigher, ragLower, UNTAGGED, type PackFact, type PackPayingTargets } from './pack-paying.ts';

const NOW = new Date('2026-11-14T12:00:00Z');
const TARGETS: PackPayingTargets = { headlineFloorPct: 10, headlineTargetPct: 22, rundownPaidFloorPct: 35, rundownPaidTargetPct: 50, costTargetPence: 190, costCeilingPence: 250 };
const days = (n: number, from = NOW) => new Date(from.getTime() - n * 86_400_000).toISOString();

function fact(o: Partial<PackFact> = {}): PackFact {
  return {
    u: o.u ?? 'u1',
    email: 'a@example.com',
    excluded: false,
    signedUpAt: days(90),
    weekStart: '2026-08-10',
    packAt: days(90),
    campaign: 'pack-oct',
    content: 'video-a',
    firstWeekActive: true,
    contactedAt: null,
    ranDownAt: null,
    paid: [],
    rawCostPence: 150,
    ...o,
  };
}

test('a buyer’s columns: each window closes on its own day', () => {
  const pack = days(50);
  const f = fact({ packAt: pack, signedUpAt: pack, contactedAt: days(40), ranDownAt: days(20), paid: [days(10)] });
  const c = buyerColumns(f, NOW);
  assert.equal(c.firstWeek, true);
  assert.equal(c.contacted, true, '10 days after the pack');
  assert.equal(c.ranDown, true, '30 days after the pack');
  assert.equal(c.paidAfterRun, undefined, 'step 5 closes at 59 days');
  assert.equal(c.paid60, null, 'the headline closes at 60 days');
  assert.equal(c.third, null);
  const later = buyerColumns(f, new Date(NOW.getTime() + 15 * 86_400_000));
  assert.equal(later.paidAfterRun, true, 'paid 10 days after running down');
  assert.equal(later.paid60, true);
  assert.equal(later.third, false);
});

test('a contact or a run-down outside its window does not count', () => {
  const pack = days(100);
  const c = buyerColumns(fact({ packAt: pack, contactedAt: days(60), ranDownAt: days(50), paid: [days(30)] }), NOW);
  assert.equal(c.contacted, false, '40 days after the pack');
  assert.equal(c.ranDown, false, '50 days after the pack');
  assert.equal(c.paidAfterRun, null, 'never ran down: not in step 5’s base');
  assert.equal(c.paid60, false, 'paid at day 70');
});

test('cohorts: shares, step 5 of step 4, "too early", and the total adds only closed weeks', () => {
  const old = '2026-08-10';
  const recent = '2026-11-09';
  const facts = [
    fact({ u: 'a', weekStart: old, ranDownAt: days(70), paid: [days(65), days(30)], rawCostPence: 400 }),
    fact({ u: 'b', weekStart: old, ranDownAt: days(60), paid: [] , rawCostPence: 100 }),
    fact({ u: 'c', weekStart: old, firstWeekActive: false, rawCostPence: 300 }),
    fact({ u: 'd', weekStart: recent, signedUpAt: days(3), packAt: days(3), rawCostPence: 20 }),
  ];
  const r = packPayingReport(facts, { excluded: new Set(), filter: {}, targets: TARGETS, now: NOW });
  assert.deepEqual(r.cohorts.map((c) => c.weekStart), [recent, old], 'newest first');
  const [young, aug] = r.cohorts;
  assert.equal(aug.bought, 3);
  assert.deepEqual(aug.firstWeek, { count: 2, base: 3, pct: 67 });
  assert.deepEqual(aug.ranDown, { count: 2, base: 3, pct: 67 });
  assert.deepEqual(aug.paidAfterRun, { count: 1, base: 2, pct: 50 });
  assert.deepEqual(aug.paid60, { count: 1, base: 3, pct: 33 });
  assert.deepEqual(aug.third, { count: 1, base: 3, pct: 33 });
  assert.equal(aug.cost.members, 2, 'pack-only: b and c');
  assert.equal(aug.cost.averagePence, 200);
  assert.equal(aug.cost.maxPence, 300);
  assert.equal(young.firstWeek, null, 'too early');
  assert.equal(young.paid60, null);
  assert.equal(young.cost.soFar, true);
  // The total: the young week's open windows are left out, its row still counts as bought.
  assert.equal(r.total.bought, 4);
  assert.deepEqual(r.total.paid60, { count: 1, base: 3, pct: 33 });
  assert.equal(r.headlineRag, 'green');
  assert.equal(r.rundownRag, 'green');
  // Pack-only: b, c and d (a paid again): (100 + 300 + 20) / 3 = 140p, under the 190p target.
  assert.equal(r.total.cost.averagePence, 140);
  assert.equal(r.costRag, 'green');
  assert.equal(packPayingReport([fact({ rawCostPence: 260 })], { excluded: new Set(), filter: {}, targets: TARGETS, now: NOW }).costRag, 'red', 'over the 250p ceiling');
  assert.equal(r.smallNumbers, true);
});

test('the green / amber / red lines', () => {
  assert.equal(ragHigher(22, 10, 22), 'green');
  assert.equal(ragHigher(21, 10, 22), 'amber');
  assert.equal(ragHigher(9, 10, 22), 'red');
  assert.equal(ragHigher(null, 10, 22), null, 'too early');
  assert.equal(ragLower(190, 190, 250), 'green');
  assert.equal(ragLower(251, 190, 250), 'red');
  assert.equal(ragLower(200, 190, 250), 'amber');
});

test('p90 by nearest rank; small numbers under 50 buyers', () => {
  assert.equal(p90([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([42]), 42);
  assert.equal(p90([]), null);
  const many = Array.from({ length: 50 }, (_, i) => fact({ u: `m${i}` }));
  assert.equal(packPayingReport(many, { excluded: new Set(), filter: {}, targets: TARGETS, now: NOW }).smallNumbers, false);
});

test('the ad filter: a campaign, an ad, or "none" for untagged; excluded accounts never count', () => {
  const facts = [fact({ u: 'a' }), fact({ u: 'b', campaign: null, content: null }), fact({ u: 'c', content: 'video-b' }), fact({ u: 'x', excluded: true }), fact({ u: 'admin' })];
  const ex = new Set(['admin']);
  assert.deepEqual(countedFacts(facts, ex, {}).map((f) => f.u), ['a', 'b', 'c']);
  assert.deepEqual(countedFacts(facts, ex, { campaign: UNTAGGED }).map((f) => f.u), ['b']);
  assert.deepEqual(countedFacts(facts, ex, { campaign: 'pack-oct', content: 'video-b' }).map((f) => f.u), ['c']);
  const r = packPayingReport(facts, { excluded: ex, filter: { content: 'video-a' }, targets: TARGETS, now: NOW });
  assert.equal(r.buyers, 1);
  assert.deepEqual(r.contents, ['video-a', 'video-b'], 'the filter lists every tag, whatever is chosen');
});

test('the CSV: one row per buyer, "too early" while a window is open, quoted safely', () => {
  const csv = packPayingCsv([fact({ u: 'a', email: '=cmd@example.com', campaign: null }), fact({ u: 'b', signedUpAt: days(2), packAt: days(2) })], NOW);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^userId,email,signUpWeek,packAt,utmCampaign/);
  assert.match(lines[1], /^a,'=cmd@example\.com,2026-08-10,.*,none,video-a,yes,no,no,n\/a,no,no,0,yes,150$/);
  assert.match(lines[2], /,too early,too early,too early,too early,too early,too early,0,yes,150$/);
});

test('parsePackFacts reads the SQL rows defensively', () => {
  const rows = parsePackFacts([{ u: 'a', pack_at: '2026-10-01T10:00:00Z', week_start: '2026-09-28', signed_up_at: '2026-09-30T09:00:00Z', paid: ['2026-10-20T10:00:00Z'], raw_cost: '123.4567', first_week_active: true }, { nope: 1 }, null]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawCostPence, 123.4567);
  assert.deepEqual(rows[0].paid, ['2026-10-20T10:00:00Z']);
  assert.equal(rows[0].campaign, null);
  assert.deepEqual(parsePackFacts('bad'), []);
});
