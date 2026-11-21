import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickUnqueued } from './sweep.ts';

test('website leads keep their order and come first; delivered ones are skipped', () => {
  assert.deepEqual(pickUnqueued(['w1', 'w2', 'w3'], [], new Set(['w2']), 10), ['w1', 'w3']);
  assert.deepEqual(pickUnqueued(['w1'], ['s1'], new Set(), 10), ['w1', 's1']);
});

test('a sheet lead with no report and no delivery is swept; one with a delivery is not; repeats are dropped', () => {
  assert.deepEqual(pickUnqueued([], ['s1', 's2', 's1'], new Set(['s2']), 10), ['s1']);
  assert.deepEqual(pickUnqueued(['x'], ['x', 's1'], new Set(), 10), ['x', 's1']);
});

test('the limit is kept across both kinds', () => {
  assert.deepEqual(pickUnqueued(['w1', 'w2'], ['s1', 's2'], new Set(), 3), ['w1', 'w2', 's1']);
  assert.deepEqual(pickUnqueued(['w1'], ['s1'], new Set(), 0), []);
});

test('source pin: the website sweep is unchanged and the sheet sweep reads ad_sheet_rows, lead-only, writing nothing', () => {
  const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
  const sweep = src.slice(src.indexOf('async unqueued(limit)'), src.indexOf('async reportsOwed'));
  assert.match(sweep, /website_reports!inner\(state\)/);
  assert.match(sweep, /\.neq\('status', 'held'\)/);
  assert.match(sweep, /from\('ad_sheet_rows'\)/);
  assert.match(sweep, /\.in\('state', \['imported', 'merged'\]\)/);
  assert.match(sweep, /pickUnqueued\(/);
  assert.doesNotMatch(sweep, /\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
});
