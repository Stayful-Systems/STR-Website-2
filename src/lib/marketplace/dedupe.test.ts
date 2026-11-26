import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dupeChanges, findDupe, fullPostcode, isTwin, planDupes, type DupeRow } from './dedupe.ts';

const row = (over: Partial<DupeRow> & { canonical_url: string }): DupeRow => ({
  kind: 'sale', uprn: null, bedrooms: 2, raw_type: 'Terraced', postcode: 'YO24 1AB', price_amount: 200000, first_seen_at: '2026-11-01T10:00:00Z', ...over,
});

test('a UPRN match is a duplicate, whatever else differs', () => {
  const early = row({ canonical_url: 'rm/1', uprn: '100', postcode: null, bedrooms: null, price_amount: null });
  const late = row({ canonical_url: 'otm/9', uprn: '100', first_seen_at: '2026-11-02T10:00:00Z', price_amount: 999999 });
  assert.equal(findDupe(late, [early, late], 2), 'rm/1');
  assert.equal(findDupe(early, [early, late], 2), null, 'the earlier one is the original');
});

test('the same UPRN for sale and to rent is two deals', () => {
  const sale = row({ canonical_url: 'rm/1', uprn: '100' });
  const rent = row({ canonical_url: 'rm/2', uprn: '100', kind: 'rent', first_seen_at: '2026-11-03T10:00:00Z' });
  assert.equal(findDupe(rent, [sale, rent], 2), null);
});

test('same kind, beds, type and full postcode at a price within 2% is a duplicate', () => {
  const a = row({ canonical_url: 'rm/1' });
  const b = row({ canonical_url: 'zp/1', price_amount: 203900, first_seen_at: '2026-11-02T10:00:00Z', raw_type: 'terraced', postcode: 'yo24  1ab' });
  assert.equal(findDupe(b, [a, b], 2), 'rm/1');
  const exactly = row({ canonical_url: 'zp/2', price_amount: 204000, first_seen_at: '2026-11-02T10:00:00Z' });
  assert.equal(findDupe(exactly, [a, exactly], 2), 'rm/1', '2.0% is inside the setting');
});

test('a 3% price difference is not a match', () => {
  const a = row({ canonical_url: 'rm/1' });
  const b = row({ canonical_url: 'zp/1', price_amount: 206000, first_seen_at: '2026-11-02T10:00:00Z' });
  assert.equal(findDupe(b, [a, b], 2), null);
  assert.equal(findDupe(b, [a, b], 3), 'rm/1', 'the percentage is the setting, not a constant');
});

test('different beds, type, kind or postcode is not a match', () => {
  const a = row({ canonical_url: 'rm/1' });
  const later = { first_seen_at: '2026-11-02T10:00:00Z' };
  assert.equal(findDupe(row({ canonical_url: 'x/1', bedrooms: 3, ...later }), [a], 2), null);
  assert.equal(findDupe(row({ canonical_url: 'x/2', raw_type: 'Detached', ...later }), [a], 2), null);
  assert.equal(findDupe(row({ canonical_url: 'x/3', kind: 'rent', ...later }), [a], 2), null);
  assert.equal(findDupe(row({ canonical_url: 'x/4', postcode: 'YO24 1AC', ...later }), [a], 2), null);
});

test('an outcode or area alone, or a missing value, never matches', () => {
  const a = row({ canonical_url: 'rm/1', postcode: 'YO24' });
  const b = row({ canonical_url: 'zp/1', postcode: 'YO24', first_seen_at: '2026-11-02T10:00:00Z' });
  assert.equal(findDupe(b, [a, b], 2), null);
  const c = row({ canonical_url: 'rm/2' });
  for (const over of [{ bedrooms: null }, { raw_type: null }, { price_amount: null }, { postcode: null }]) {
    assert.equal(findDupe(row({ canonical_url: 'zp/2', first_seen_at: '2026-11-02T10:00:00Z', ...over }), [c], 2), null, JSON.stringify(over));
  }
});

test('the earliest seen wins, and a tie goes to the smaller url', () => {
  const first = row({ canonical_url: 'rm/1' });
  const second = row({ canonical_url: 'otm/1', first_seen_at: '2026-11-02T10:00:00Z' });
  const third = row({ canonical_url: 'zp/1', first_seen_at: '2026-11-03T10:00:00Z' });
  const plan = planDupes([third, second, first], 2);
  assert.equal(plan.get('rm/1'), null);
  assert.equal(plan.get('otm/1'), 'rm/1');
  assert.equal(plan.get('zp/1'), 'rm/1', 'both twins point at the original, not at each other');
  const t1 = row({ canonical_url: 'b/1' });
  const t2 = row({ canonical_url: 'a/1' });
  const tie = planDupes([t1, t2], 2);
  assert.deepEqual([tie.get('a/1'), tie.get('b/1')], [null, 'a/1']);
});

test('a retired original frees its twin: it is no longer in the live rows', () => {
  const original = row({ canonical_url: 'rm/1' });
  const twin = row({ canonical_url: 'zp/1', first_seen_at: '2026-11-02T10:00:00Z' });
  const current = new Map<string, string | null>([['rm/1', null], ['zp/1', 'rm/1']]);
  const before = planDupes([original, twin], 2);
  assert.deepEqual(dupeChanges(before, current), [], 'steady state: nothing to write');
  const after = planDupes([twin], 2); // rm/1 retired, so it is not a live row any more
  assert.deepEqual(dupeChanges(after, current), [{ canonical_url: 'zp/1', dupe_of: null }]);
});

test('a twin moves to the next original when the first goes', () => {
  const b = row({ canonical_url: 'b/1', first_seen_at: '2026-11-02T10:00:00Z' });
  const c = row({ canonical_url: 'c/1', first_seen_at: '2026-11-03T10:00:00Z' });
  const current = new Map<string, string | null>([['a/1', null], ['b/1', 'a/1'], ['c/1', 'a/1']]);
  assert.deepEqual(dupeChanges(planDupes([b, c], 2), current), [{ canonical_url: 'b/1', dupe_of: null }, { canonical_url: 'c/1', dupe_of: 'b/1' }]);
});

test('postcodes: full ones are normalised, others are not postcodes', () => {
  assert.equal(fullPostcode('yo24 1ab'), 'YO24 1AB');
  assert.equal(fullPostcode('YO241AB'), 'YO24 1AB');
  assert.equal(fullPostcode('M1 1AA'), 'M1 1AA');
  assert.equal(fullPostcode('YO24'), null);
  assert.equal(fullPostcode(''), null);
  assert.equal(fullPostcode(null), null);
  assert.equal(isTwin(row({ canonical_url: 'a' }), row({ canonical_url: 'a' }), 2), false, 'a row is never its own twin');
});

test('price may arrive as text from the database', () => {
  const a = row({ canonical_url: 'rm/1', price_amount: '200000' });
  const b = row({ canonical_url: 'zp/1', price_amount: '201000', first_seen_at: '2026-11-02T10:00:00Z' });
  assert.equal(findDupe(b, [a, b], 2), 'rm/1');
});
