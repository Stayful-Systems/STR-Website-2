import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_DOMAINS, DOMAIN_KEYS, checkDomainSetting, parseDomains } from './settings.ts';

const from = (rows: Record<string, unknown>) => parseDomains((k) => rows[k]);

const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 33: customer website domains');
const section = start === -1 ? '' : sql.slice(start);

test('the defaults are the plan: charge off, £50 a day, buy automatically', () => {
  assert.deepEqual(from({}), DEFAULT_DOMAINS);
  assert.equal(DEFAULT_DOMAINS.chargeOn, false);
  assert.equal(DEFAULT_DOMAINS.dailySpendCapPence, 5000);
  assert.equal(DEFAULT_DOMAINS.autoBuy, true);
});

test('every key the schema seeds is parsed, and every seeded value is the default', () => {
  const rows: Record<string, unknown> = {};
  for (const m of section.matchAll(/\('(domain_\w+)', '([^']*)'\)/g)) rows[m[1]] = JSON.parse(m[2]);
  assert.deepEqual(Object.keys(rows).sort(), Object.values(DOMAIN_KEYS).sort());
  assert.deepEqual(from(rows), DEFAULT_DOMAINS);
  assert.equal(rows[DOMAIN_KEYS.chargeOn], false, 'the yearly charge is seeded OFF');
});

test('the switches read booleans and "true"/"false" only; anything else is the default', () => {
  assert.equal(from({ domain_charge_on: true }).chargeOn, true);
  assert.equal(from({ domain_charge_on: 'true' }).chargeOn, true);
  assert.equal(from({ domain_auto_buy: false }).autoBuy, false);
  assert.equal(from({ domain_auto_buy: 'false' }).autoBuy, false);
  for (const bad of ['yes', 'on', 1, 0, '1', 'TRUE', null, undefined, {}, [], '']) {
    assert.equal(from({ domain_charge_on: bad }).chargeOn, false, `charge: ${String(bad)}`);
    assert.equal(from({ domain_auto_buy: bad }).autoBuy, true, `auto buy: ${String(bad)}`);
  }
});

test('the cap is a whole number of pence from 0 to 100000', () => {
  assert.equal(from({ domain_daily_spend_cap_pence: 0 }).dailySpendCapPence, 0);
  assert.equal(from({ domain_daily_spend_cap_pence: '2500' }).dailySpendCapPence, 2500);
  assert.equal(from({ domain_daily_spend_cap_pence: 100000 }).dailySpendCapPence, 100000);
  for (const bad of [-1, 100001, 12.5, 'lots', null, undefined, true, '', {}]) {
    assert.equal(from({ domain_daily_spend_cap_pence: bad }).dailySpendCapPence, 5000, String(bad));
  }
});

test('an admin value is checked before it is stored; an unknown key is never stored', () => {
  assert.deepEqual(checkDomainSetting('domain_charge_on', 'true'), { key: 'domain_charge_on', value: true });
  assert.deepEqual(checkDomainSetting('domain_auto_buy', false), { key: 'domain_auto_buy', value: false });
  assert.deepEqual(checkDomainSetting('domain_daily_spend_cap_pence', '0'), { key: 'domain_daily_spend_cap_pence', value: 0 });
  assert.equal(checkDomainSetting('domain_daily_spend_cap_pence', '100001'), null);
  assert.equal(checkDomainSetting('domain_daily_spend_cap_pence', ''), null);
  assert.equal(checkDomainSetting('domain_charge_on', 'maybe'), null);
  assert.equal(checkDomainSetting('website_report_pence', '5'), null);
  assert.equal(checkDomainSetting('anything_else', 'true'), null);
});
