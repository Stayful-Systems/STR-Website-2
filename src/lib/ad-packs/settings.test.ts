import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_PACK_KEYS, DEFAULT_AD_PACK_SETTINGS, fitsCap, parseAdPackSettings } from './settings.ts';

test('no rows: the defaults the schema seeds', () => {
  assert.deepEqual(parseAdPackSettings([]), { freeRegens: 1, voiceChanges: 1, maxRawPence: 500, monthlyCapPence: 5000, minAreaSamples: 5, renderMaxSeconds: 300, sandboxVcpus: 2 });
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
    { key: 'ad_packs_enabled', value: true },
    { key: 'something_else', value: 99 },
  ]);
  assert.deepEqual(s, { freeRegens: 2, voiceChanges: 3, maxRawPence: 250, monthlyCapPence: 12000, minAreaSamples: 8, renderMaxSeconds: 240, sandboxVcpus: 4 });
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
  const rows = [{ key: AD_PACK_KEYS.renderMaxSeconds, value: 120 }, { key: AD_PACK_KEYS.sandboxVcpus, value: 4 }];
  assert.equal(parseAdPackSettings(rows).renderMaxSeconds, parseRenderSettings(rows).maxSeconds);
  assert.equal(parseAdPackSettings(rows).sandboxVcpus, parseRenderSettings(rows).vcpus);
  assert.equal(SANDBOX_SECONDS_CAP, ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS, 'the estimate prices the time the worker really allows');
});
