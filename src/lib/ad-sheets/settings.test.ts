import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SHEET_SETTINGS, SHEET_SETTING_KEYS, parseSheetSettings, sheetCardAvailable } from './settings.ts';

test('no rows: the defaults the schema seeds', () => {
  assert.deepEqual(parseSheetSettings([]), {
    enabled: false, minLeads: 5, quietDays: 7, outcomePct: 50, outcomeAgeDays: 14, reminderAgeDays: 7, dedupeDays: 30, guideCheckedAt: null,
  });
  assert.deepEqual(parseSheetSettings(null), DEFAULT_SHEET_SETTINGS);
  assert.deepEqual(parseSheetSettings(undefined), DEFAULT_SHEET_SETTINGS);
});

test('the defaults match the seeds in schema.sql, key for key', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const block = sql.slice(sql.indexOf("('ad_sheets_enabled'"), sql.indexOf('on conflict', sql.indexOf("('ad_sheets_enabled'")));
  const seeds = new Map<string, string>();
  for (const m of block.matchAll(/\('([a-z_]+)',\s*'([^']*)'::jsonb\)/g)) seeds.set(m[1], m[2]);
  assert.equal(seeds.size, Object.keys(SHEET_SETTING_KEYS).length);
  const parsed = parseSheetSettings([...seeds].map(([key, v]) => ({ key, value: JSON.parse(v) })));
  assert.deepEqual(parsed, DEFAULT_SHEET_SETTINGS);
});

test('jsonb values and numeric strings are read; other keys are ignored', () => {
  const s = parseSheetSettings([
    { key: SHEET_SETTING_KEYS.enabled, value: true },
    { key: SHEET_SETTING_KEYS.minLeads, value: 8 },
    { key: SHEET_SETTING_KEYS.quietDays, value: '10' },
    { key: SHEET_SETTING_KEYS.outcomePct, value: 60 },
    { key: SHEET_SETTING_KEYS.outcomeAgeDays, value: 21 },
    { key: SHEET_SETTING_KEYS.reminderAgeDays, value: 5 },
    { key: SHEET_SETTING_KEYS.dedupeDays, value: 45 },
    { key: SHEET_SETTING_KEYS.guideCheckedAt, value: '2026-11-01T09:00:00Z' },
    { key: 'something_else', value: 99 },
  ]);
  assert.deepEqual(s, { enabled: true, minLeads: 8, quietDays: 10, outcomePct: 60, outcomeAgeDays: 21, reminderAgeDays: 5, dedupeDays: 45, guideCheckedAt: '2026-11-01T09:00:00Z' });
});

test('malformed values fall back; the switch is off unless true', () => {
  const s = parseSheetSettings([
    { key: SHEET_SETTING_KEYS.enabled, value: 'yes' },
    { key: SHEET_SETTING_KEYS.minLeads, value: -1 },
    { key: SHEET_SETTING_KEYS.quietDays, value: 'abc' },
    { key: SHEET_SETTING_KEYS.outcomePct, value: 150 },
    { key: SHEET_SETTING_KEYS.outcomeAgeDays, value: 1.5 },
    { key: SHEET_SETTING_KEYS.reminderAgeDays, value: null },
    { key: SHEET_SETTING_KEYS.dedupeDays, value: true },
    { key: SHEET_SETTING_KEYS.guideCheckedAt, value: 'not a date' },
  ]);
  assert.deepEqual(s, DEFAULT_SHEET_SETTINGS);
  assert.equal(parseSheetSettings([{ key: SHEET_SETTING_KEYS.enabled, value: 'true' }]).enabled, true);
});

test('the card needs both switches, or an admin', () => {
  assert.equal(sheetCardAvailable({ adPacksEnabled: true, sheetsEnabled: true, admin: false }), true);
  assert.equal(sheetCardAvailable({ adPacksEnabled: true, sheetsEnabled: false, admin: false }), false);
  assert.equal(sheetCardAvailable({ adPacksEnabled: false, sheetsEnabled: true, admin: false }), false);
  assert.equal(sheetCardAvailable({ adPacksEnabled: false, sheetsEnabled: false, admin: true }), true);
});
