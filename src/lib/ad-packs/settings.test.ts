import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AD_PACK_KEYS, DEFAULT_AD_PACK_SETTINGS, fitsCap, parseAdPackSettings } from './settings.ts';

test('no rows: the defaults the schema seeds', () => {
  assert.deepEqual(parseAdPackSettings([]), { freeRegens: 1, voiceChanges: 1, maxRawPence: 500, monthlyCapPence: 5000, minAreaSamples: 5, renderMaxSeconds: 300, sandboxVcpus: 2, renderMaxAttempts: 3, ldRoundDays: 30, ldMonthlyCapPence: 25000 });
  assert.deepEqual(parseAdPackSettings(null), DEFAULT_AD_PACK_SETTINGS);
  assert.deepEqual(parseAdPackSettings(undefined), DEFAULT_AD_PACK_SETTINGS);
});

test('jsonb numbers and numeric strings are read; the other keys are ignored', () => {
  const s = parseAdPackSettings([
    { key: AD_PACK_KEYS.freeRegens, value: 2 },
    { key: AD_PACK_KEYS.voiceChanges, value: '3' },
    { key: AD_PACK_KEYS.maxRawPence, value: 250 },
    { key: AD_PACK_KEYS.monthlyCapPence, value: 12000 },
    { key: AD_PACK_KEYS.minAreaSamples, value: 8 },
    { key: AD_PACK_KEYS.renderMaxSeconds, value: 240 },
    { key: AD_PACK_KEYS.sandboxVcpus, value: '4' },
    { key: AD_PACK_KEYS.renderMaxAttempts, value: 5 },
    { key: AD_PACK_KEYS.ldRoundDays, value: '14' },
    { key: AD_PACK_KEYS.ldMonthlyCapPence, value: 40000 },
    { key: 'ad_packs_enabled', value: true },
    { key: 'something_else', value: 99 },
  ]);
  assert.deepEqual(s, { freeRegens: 2, voiceChanges: 3, maxRawPence: 250, monthlyCapPence: 12000, minAreaSamples: 8, renderMaxSeconds: 240, sandboxVcpus: 4, renderMaxAttempts: 5, ldRoundDays: 14, ldMonthlyCapPence: 40000 });
});

test('zero is allowed where it means "none" (no free regenerations, cap 0)', () => {
  const s = parseAdPackSettings([
    { key: AD_PACK_KEYS.freeRegens, value: 0 },
    { key: AD_PACK_KEYS.monthlyCapPence, value: 0 },
  ]);
  assert.equal(s.freeRegens, 0);
  assert.equal(s.monthlyCapPence, 0);
});

test('malformed values fall back to the default, one by one', () => {
  const s = parseAdPackSettings([
    { key: AD_PACK_KEYS.freeRegens, value: -1 },
    { key: AD_PACK_KEYS.voiceChanges, value: 1.5 },
    { key: AD_PACK_KEYS.maxRawPence, value: 'lots' },
    { key: AD_PACK_KEYS.monthlyCapPence, value: 99_999_999 },
    { key: AD_PACK_KEYS.minAreaSamples, value: 0 },
    { key: AD_PACK_KEYS.renderMaxSeconds, value: 30 },
    { key: AD_PACK_KEYS.sandboxVcpus, value: 99 },
    { key: AD_PACK_KEYS.renderMaxAttempts, value: 0 },
    { key: AD_PACK_KEYS.ldRoundDays, value: 0 },
    { key: AD_PACK_KEYS.ldMonthlyCapPence, value: -5 },
  ]);
  assert.deepEqual(s, DEFAULT_AD_PACK_SETTINGS);
  const t = parseAdPackSettings([
    { key: AD_PACK_KEYS.freeRegens, value: true },
    { key: AD_PACK_KEYS.voiceChanges, value: null },
    { key: AD_PACK_KEYS.maxRawPence, value: '' },
  ]);
  assert.deepEqual(t, DEFAULT_AD_PACK_SETTINGS);
});

test('fitsCap: spend plus the estimate may not pass the cap, and a cap of 0 stops everything', () => {
  assert.equal(fitsCap(4000, 1000, 5000), true);
  assert.equal(fitsCap(4000, 1001, 5000), false);
  assert.equal(fitsCap(0, 0, 0), false);
  assert.equal(fitsCap(0, 0, 1), true);
});

test('the render settings default to 300 seconds and 2 vCPUs, and agree with the render worker\'s own parser', async () => {
  const { DEFAULT_RENDER_SETTINGS, parseRenderSettings } = await import('./render-store.ts');
  const { ROUTE_MAX_SECONDS, ROUTE_RESERVE_SECONDS } = await import('./render-core.ts');
  const { SANDBOX_SECONDS_CAP } = await import('./settings.ts');
  assert.equal(DEFAULT_AD_PACK_SETTINGS.renderMaxSeconds, DEFAULT_RENDER_SETTINGS.maxSeconds);
  assert.equal(DEFAULT_AD_PACK_SETTINGS.sandboxVcpus, DEFAULT_RENDER_SETTINGS.vcpus);
  assert.equal(DEFAULT_AD_PACK_SETTINGS.renderMaxAttempts, DEFAULT_RENDER_SETTINGS.maxAttempts);
  const rows = [{ key: AD_PACK_KEYS.renderMaxSeconds, value: 120 }, { key: AD_PACK_KEYS.sandboxVcpus, value: 4 }, { key: AD_PACK_KEYS.renderMaxAttempts, value: 6 }];
  assert.equal(parseAdPackSettings(rows).renderMaxAttempts, parseRenderSettings(rows).maxAttempts);
  assert.equal(parseAdPackSettings(rows).renderMaxSeconds, parseRenderSettings(rows).maxSeconds);
  assert.equal(parseAdPackSettings(rows).sandboxVcpus, parseRenderSettings(rows).vcpus);
  assert.equal(SANDBOX_SECONDS_CAP, ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS, 'the estimate prices the time the worker really allows');
});

test('Batch 55: the lead database route settings default to 30 days and 25000p, and a cap of 0 is allowed (it stops the route)', () => {
  assert.equal(DEFAULT_AD_PACK_SETTINGS.ldRoundDays, 30);
  assert.equal(DEFAULT_AD_PACK_SETTINGS.ldMonthlyCapPence, 25000);
  assert.equal(parseAdPackSettings([{ key: AD_PACK_KEYS.ldMonthlyCapPence, value: 0 }]).ldMonthlyCapPence, 0);
  // A round gap of 0 days would let every round through, so it is not readable.
  assert.equal(parseAdPackSettings([{ key: AD_PACK_KEYS.ldRoundDays, value: 0 }]).ldRoundDays, 30);
  assert.equal(parseAdPackSettings([{ key: AD_PACK_KEYS.ldRoundDays, value: 366 }]).ldRoundDays, 30);
});

test('every ad pack setting the schema seeds is parsed, and the seeded values are the defaults (Batch 38 and Batch 55 blocks)', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const rows: { key: string; value: unknown }[] = [];
  for (const m of sql.matchAll(/\('(ad_pack_[a-z_]+)',\s*'([^']*)'::jsonb\)/g)) rows.push({ key: m[1], value: JSON.parse(m[2]) });
  const keys = new Set(rows.map((r) => r.key));
  // The render settings are seeded in the 38b block with other statements; the rest must be in the file.
  for (const k of [AD_PACK_KEYS.freeRegens, AD_PACK_KEYS.voiceChanges, AD_PACK_KEYS.maxRawPence, AD_PACK_KEYS.monthlyCapPence, AD_PACK_KEYS.minAreaSamples, AD_PACK_KEYS.ldRoundDays, AD_PACK_KEYS.ldMonthlyCapPence]) {
    assert.ok(keys.has(k), `${k} is seeded in schema.sql`);
  }
  const seeded = parseAdPackSettings(rows);
  for (const f of ['freeRegens', 'voiceChanges', 'maxRawPence', 'monthlyCapPence', 'minAreaSamples', 'ldRoundDays', 'ldMonthlyCapPence'] as const) {
    assert.equal(seeded[f], DEFAULT_AD_PACK_SETTINGS[f], `${f}: the seed is the default`);
  }
  assert.equal(rows.find((r) => r.key === AD_PACK_KEYS.ldRoundDays)?.value, 30);
  assert.equal(rows.find((r) => r.key === AD_PACK_KEYS.ldMonthlyCapPence)?.value, 25000);
});
