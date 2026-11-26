import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEAL_FEED_SETTING_KEYS, DEFAULT_DEAL_FEED_SETTINGS, parseDealFeedSettings } from './deal-feed-settings.ts';

test('no rows: both switches off, 7 days, 2%', () => {
  assert.deepEqual(parseDealFeedSettings([]), { staleCreditEnabled: false, staleCreditDays: 7, dedupeEnabled: false, dedupePricePct: 2 });
  assert.deepEqual(parseDealFeedSettings(null), DEFAULT_DEAL_FEED_SETTINGS);
  assert.deepEqual(parseDealFeedSettings(undefined), DEFAULT_DEAL_FEED_SETTINGS);
});

test('the defaults match the seeds in schema.sql, key for key', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const start = sql.indexOf("('deal_stale_credit_enabled'");
  assert.ok(start > 0, 'the Deal feed seeds are in schema.sql');
  const block = sql.slice(start, sql.indexOf('on conflict', start));
  const seeds = new Map<string, string>();
  for (const m of block.matchAll(/\('([a-z_]+)',\s*'([^']*)'::jsonb\)/g)) seeds.set(m[1], m[2]);
  assert.equal(seeds.size, Object.keys(DEAL_FEED_SETTING_KEYS).length);
  assert.deepEqual(parseDealFeedSettings([...seeds].map(([key, v]) => ({ key, value: JSON.parse(v) }))), DEFAULT_DEAL_FEED_SETTINGS);
});

test('values are read; other keys are ignored', () => {
  const s = parseDealFeedSettings([
    { key: DEAL_FEED_SETTING_KEYS.staleCreditEnabled, value: true },
    { key: DEAL_FEED_SETTING_KEYS.staleCreditDays, value: '10' },
    { key: DEAL_FEED_SETTING_KEYS.dedupeEnabled, value: 'true' },
    { key: DEAL_FEED_SETTING_KEYS.dedupePricePct, value: 2.5 },
    { key: 'something_else', value: 99 },
  ]);
  assert.deepEqual(s, { staleCreditEnabled: true, staleCreditDays: 10, dedupeEnabled: true, dedupePricePct: 2.5 });
});

test('malformed values fall back; a switch is off unless true', () => {
  const s = parseDealFeedSettings([
    { key: DEAL_FEED_SETTING_KEYS.staleCreditEnabled, value: 'yes' },
    { key: DEAL_FEED_SETTING_KEYS.staleCreditDays, value: 1.5 },
    { key: DEAL_FEED_SETTING_KEYS.dedupeEnabled, value: 1 },
    { key: DEAL_FEED_SETTING_KEYS.dedupePricePct, value: 'abc' },
  ]);
  assert.deepEqual(s, DEFAULT_DEAL_FEED_SETTINGS);
  assert.equal(parseDealFeedSettings([{ key: DEAL_FEED_SETTING_KEYS.staleCreditDays, value: 0 }]).staleCreditDays, 7);
  assert.equal(parseDealFeedSettings([{ key: DEAL_FEED_SETTING_KEYS.dedupePricePct, value: 50 }]).dedupePricePct, 2);
  assert.equal(parseDealFeedSettings([{ key: DEAL_FEED_SETTING_KEYS.dedupePricePct, value: 0 }]).dedupePricePct, 0);
});
