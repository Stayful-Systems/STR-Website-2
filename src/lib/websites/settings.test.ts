import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WEBSITE, WEBSITE_KEYS, parseWebsite } from './settings.ts';

const from = (rows: Record<string, unknown>) => parseWebsite((k) => rows[k]);

const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 31: customer websites');
const section = start === -1 ? '' : sql.slice(start);

test('the defaults are the plan: free, no plan gate, 20 a day, 5 a site', () => {
  assert.deepEqual(from({}), DEFAULT_WEBSITE);
  assert.equal(DEFAULT_WEBSITE.reportChargeOn, false);
  assert.equal(DEFAULT_WEBSITE.reportPence, 300);
  assert.equal(DEFAULT_WEBSITE.planGateOn, false);
  assert.equal(DEFAULT_WEBSITE.freeReportsPerDay, 20);
  assert.equal(DEFAULT_WEBSITE.freeReportsPerSitePerDay, 5);
});

test('every key the schema seeds is parsed, and every seeded value is the default', () => {
  const rows: Record<string, unknown> = {};
  for (const m of section.matchAll(/\('(website_\w+)', '([^']*)'\)/g)) rows[m[1]] = JSON.parse(m[2]);
  assert.deepEqual(Object.keys(rows).sort(), Object.values(WEBSITE_KEYS).sort());
  assert.deepEqual(from(rows), DEFAULT_WEBSITE);
  assert.equal(rows[WEBSITE_KEYS.reportChargeOn], false);
  assert.equal(rows[WEBSITE_KEYS.planGateOn], false);
});

test('the switches read booleans and "true"/"false" only; anything else is off', () => {
  assert.equal(from({ website_report_charge_on: true }).reportChargeOn, true);
  assert.equal(from({ website_report_charge_on: 'true' }).reportChargeOn, true);
  assert.equal(from({ website_plan_gate_on: 'true' }).planGateOn, true);
  assert.equal(from({ website_report_charge_on: false }).reportChargeOn, false);
  assert.equal(from({ website_report_charge_on: 'false' }).reportChargeOn, false);
  for (const bad of ['yes', 'on', 1, 0, '1', 'TRUE', null, undefined, {}, [], '']) {
    assert.equal(from({ website_report_charge_on: bad }).reportChargeOn, false, `charge: ${String(bad)}`);
    assert.equal(from({ website_plan_gate_on: bad }).planGateOn, false, `gate: ${String(bad)}`);
  }
});

test('numbers are whole and in range; stored numbers and numeric strings both read; bad ones fall back', () => {
  const s = from({ website_report_pence: '450', website_free_reports_per_day: 40, website_free_reports_per_site_per_day: '3' });
  assert.equal(s.reportPence, 450);
  assert.equal(s.freeReportsPerDay, 40);
  assert.equal(s.freeReportsPerSitePerDay, 3);
  // 0 is a real value: it is the switch-off for free reports.
  assert.equal(from({ website_free_reports_per_day: 0 }).freeReportsPerDay, 0);
  assert.equal(from({ website_free_reports_per_site_per_day: '0' }).freeReportsPerSitePerDay, 0);
  for (const bad of ['lots', 2.5, -1, '', null, true, NaN, 1e9]) {
    assert.equal(from({ website_free_reports_per_day: bad }).freeReportsPerDay, 20, `per day: ${String(bad)}`);
    assert.equal(from({ website_free_reports_per_site_per_day: bad }).freeReportsPerSitePerDay, 5, `per site: ${String(bad)}`);
  }
  // A price of 0 would be refused by the charge function, so it is not readable as a price.
  for (const bad of [0, -300, 'free', 12.5, null]) assert.equal(from({ website_report_pence: bad }).reportPence, 300, String(bad));
});
