import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TRANSFER, TRANSFER_KEYS, checkTransferSetting, parseCodeFrom, parseTransfer } from './transfer-settings.ts';

const from = (rows: Record<string, unknown>) => parseTransfer((k) => rows[k]);

const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 37: customer websites, Phase 5');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

test('the defaults are the plan: 30 days of overlap, stuck after 5, transfer code from 9 Feb 2027', () => {
  assert.deepEqual(from({}), DEFAULT_TRANSFER);
  assert.equal(DEFAULT_TRANSFER.overlapDays, 30);
  assert.equal(DEFAULT_TRANSFER.stuckDays, 5);
  assert.equal(DEFAULT_TRANSFER.codeFrom, '2027-02-09');
});

test('every key the schema seeds is parsed, and every seeded value is the default', () => {
  const rows: Record<string, unknown> = {};
  for (const m of section.matchAll(/\('(website_transfer_\w+)', '([^']*)'(?:::jsonb)?\)/g)) rows[m[1]] = JSON.parse(m[2]);
  assert.deepEqual(Object.keys(rows).sort(), Object.values(TRANSFER_KEYS).sort());
  assert.deepEqual(from(rows), DEFAULT_TRANSFER);
});

test('overlap days are whole numbers from 1 to 365 and stuck days 1 to 90; a bad value falls back', () => {
  assert.equal(from({ website_transfer_overlap_days: 1 }).overlapDays, 1);
  assert.equal(from({ website_transfer_overlap_days: '365' }).overlapDays, 365);
  assert.equal(from({ website_transfer_stuck_days: '90' }).stuckDays, 90);
  assert.equal(from({ website_transfer_stuck_days: 2 }).stuckDays, 2);
  for (const bad of [0, -1, 12.5, 'lots', null, undefined, true, '', {}, []]) {
    assert.equal(from({ website_transfer_overlap_days: bad }).overlapDays, 30, `overlap: ${String(bad)}`);
    assert.equal(from({ website_transfer_stuck_days: bad }).stuckDays, 5, `stuck: ${String(bad)}`);
  }
  assert.equal(from({ website_transfer_overlap_days: 366 }).overlapDays, 30);
  assert.equal(from({ website_transfer_stuck_days: 91 }).stuckDays, 5);
});

test('the code date is a real YYYY-MM-DD day; anything else falls back', () => {
  assert.equal(from({ website_transfer_code_from: '2027-03-01' }).codeFrom, '2027-03-01');
  assert.equal(from({ website_transfer_code_from: ' 2028-02-29 ' }).codeFrom, '2028-02-29');
  for (const bad of ['2027-02-30', '2027-13-01', '2027-2-9', '09/02/2027', '2027-02-09T00:00:00Z', '', 20270209, null, undefined, true, {}]) {
    assert.equal(from({ website_transfer_code_from: bad }).codeFrom, '2027-02-09', `codeFrom: ${JSON.stringify(bad)}`);
  }
  assert.equal(parseCodeFrom('2027-02-29'), null);
  assert.equal(parseCodeFrom('2027-02-28'), '2027-02-28');
});

test('an admin value is checked before it is stored; an unknown key is never stored', () => {
  assert.deepEqual(checkTransferSetting('website_transfer_overlap_days', '45'), { key: 'website_transfer_overlap_days', value: 45 });
  assert.deepEqual(checkTransferSetting('website_transfer_stuck_days', 7), { key: 'website_transfer_stuck_days', value: 7 });
  assert.deepEqual(checkTransferSetting('website_transfer_code_from', ' 2027-04-01 '), { key: 'website_transfer_code_from', value: '2027-04-01' });
  assert.equal(checkTransferSetting('website_transfer_overlap_days', '0'), null);
  assert.equal(checkTransferSetting('website_transfer_overlap_days', '366'), null);
  assert.equal(checkTransferSetting('website_transfer_stuck_days', ''), null);
  assert.equal(checkTransferSetting('website_transfer_code_from', '2027-02-30'), null);
  assert.equal(checkTransferSetting('website_abandon_days', '5'), null);
  assert.equal(checkTransferSetting('anything_else', '5'), null);
});
