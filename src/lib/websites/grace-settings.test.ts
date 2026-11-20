import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_GRACE, GRACE_KEYS, checkGraceSetting, largestWarningDay, parseGrace, parseWarningDays } from './grace-settings.ts';

const from = (rows: Record<string, unknown>) => parseGrace((k) => rows[k]);

const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 36: customer websites, Phase 4');
const section = start === -1 ? '' : sql.slice(start);

test('the defaults are the plan: 90 days, warnings at 30, 14 and 3, deleted 90 days after switch-off', () => {
  assert.deepEqual(from({}), DEFAULT_GRACE);
  assert.equal(DEFAULT_GRACE.abandonDays, 90);
  assert.deepEqual(DEFAULT_GRACE.warningDays, [30, 14, 3]);
  assert.equal(DEFAULT_GRACE.deleteAfterDays, 90);
  assert.equal(largestWarningDay(DEFAULT_GRACE), 30);
});

test('every key the schema seeds is parsed, and every seeded value is the default', () => {
  const rows: Record<string, unknown> = {};
  for (const m of section.matchAll(/\('(website_(?:abandon|warning|delete)\w*)', '([^']*)'\)/g)) rows[m[1]] = JSON.parse(m[2]);
  assert.deepEqual(Object.keys(rows).sort(), Object.values(GRACE_KEYS).sort());
  assert.deepEqual(from(rows), DEFAULT_GRACE);
});

test('the parser does not hand out the shared default list', () => {
  const a = from({});
  a.warningDays.push(1);
  assert.deepEqual(from({}).warningDays, [30, 14, 3]);
});

test('abandon and delete days are whole numbers from 1 to 3650; a bad value falls back', () => {
  assert.equal(from({ website_abandon_days: 1 }).abandonDays, 1);
  assert.equal(from({ website_abandon_days: '3650' }).abandonDays, 3650);
  assert.equal(from({ website_delete_after_days: '45' }).deleteAfterDays, 45);
  for (const bad of [0, -1, 3651, 12.5, 'lots', null, undefined, true, '', {}, []]) {
    assert.equal(from({ website_abandon_days: bad }).abandonDays, 90, `abandon: ${String(bad)}`);
    assert.equal(from({ website_delete_after_days: bad }).deleteAfterDays, 90, `delete: ${String(bad)}`);
  }
});

test('warning days are unique whole numbers 1 to 365, at most 5, sorted largest first', () => {
  assert.deepEqual(from({ website_warning_days: '3,30,14' }).warningDays, [30, 14, 3]);
  assert.deepEqual(from({ website_warning_days: ' 7 , 21 ' }).warningDays, [21, 7]);
  assert.deepEqual(from({ website_warning_days: [10, 20] }).warningDays, [20, 10]);
  assert.deepEqual(from({ website_warning_days: '60' }).warningDays, [60]);
  assert.deepEqual(from({ website_warning_days: '365,1' }).warningDays, [365, 1]);
  assert.deepEqual(from({ website_warning_days: '5,4,3,2,1' }).warningDays, [5, 4, 3, 2, 1]);
  for (const bad of ['', '0', '366', '30,30', '30,,3', '30,x', '6,5,4,3,2,1', '1.5', '-3', 7, null, undefined, true, {}, [], ['a']]) {
    assert.deepEqual(from({ website_warning_days: bad }).warningDays, [30, 14, 3], `warnings: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseWarningDays('30,14'), [30, 14]);
  assert.equal(parseWarningDays('30,30'), null);
  assert.equal(largestWarningDay(from({ website_warning_days: '5,45' })), 45);
});

test('an admin value is checked before it is stored; an unknown key is never stored', () => {
  assert.deepEqual(checkGraceSetting('website_abandon_days', '120'), { key: 'website_abandon_days', value: 120 });
  assert.deepEqual(checkGraceSetting('website_delete_after_days', 30), { key: 'website_delete_after_days', value: 30 });
  assert.deepEqual(checkGraceSetting('website_warning_days', '3, 30,14'), { key: 'website_warning_days', value: '30,14,3' });
  assert.equal(checkGraceSetting('website_abandon_days', '0'), null);
  assert.equal(checkGraceSetting('website_abandon_days', '3651'), null);
  assert.equal(checkGraceSetting('website_delete_after_days', ''), null);
  assert.equal(checkGraceSetting('website_warning_days', '30,30'), null);
  assert.equal(checkGraceSetting('website_warning_days', ''), null);
  assert.equal(checkGraceSetting('website_report_pence', '5'), null);
  assert.equal(checkGraceSetting('domain_charge_on', 'true'), null);
  assert.equal(checkGraceSetting('anything_else', '5'), null);
});
