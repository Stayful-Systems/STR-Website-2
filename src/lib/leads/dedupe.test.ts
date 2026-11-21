import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaseCutoff, reuseSince, QUEUED_LEASE_MS, REUSE_WINDOW_MS } from './dedupe.ts';

test('Batch 21 (C3, D10): a resubmission is matched within the hour; a queued lead is claimable after five minutes', () => {
  const now = new Date('2026-10-01T10:00:00.000Z');
  assert.equal(REUSE_WINDOW_MS, 3_600_000);
  assert.equal(QUEUED_LEASE_MS, 300_000);
  assert.equal(reuseSince(now), '2026-10-01T09:00:00.000Z');
  assert.equal(leaseCutoff(now), '2026-10-01T09:55:00.000Z');
});

import { readFileSync } from 'node:fs';
import { pickSameLandlord, sameLandlord, sameLandlordSince } from './dedupe.ts';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const cand = { postcode: 'sw1a1aa', email: 'Jo@Example.com', phone: null };

test('Batch 35: same landlord needs the postcode and an email or phone, inside the window', () => {
  const at = NOW;
  const other = { postcode: 'SW1A 1AA', email: 'jo@example.com ', phone: '07700 900123', at: daysAgo(10) };
  assert.equal(sameLandlord({ ...cand, at }, other, 30), true);
  // phone alone is enough, +44 and 07 are one number
  assert.equal(sameLandlord({ postcode: 'SW1A 1AA', email: null, phone: '+447700900123', at }, other, 30), true);
  // wrong postcode, no shared contact, or no postcode at all
  assert.equal(sameLandlord({ ...cand, postcode: 'E1 6AN', at }, other, 30), false);
  assert.equal(sameLandlord({ postcode: 'SW1A 1AA', email: 'x@y.com', phone: '07700 111111', at }, other, 30), false);
  assert.equal(sameLandlord({ ...cand, postcode: null, at }, { ...other, postcode: null }, 30), false);
  // an empty email never matches an empty email
  assert.equal(sameLandlord({ postcode: 'SW1A 1AA', email: '', phone: '', at }, { ...other, email: '', phone: '' }, 30), false);
  // window by timestamps
  assert.equal(sameLandlord({ ...cand, at }, { ...other, at: daysAgo(31) }, 30), false);
  assert.equal(sameLandlord({ ...cand, at }, { ...other, at: daysAgo(30) }, 30), true);
});

test('Batch 35: the cutoff is days before now', () => {
  assert.equal(sameLandlordSince(NOW, 30).toISOString(), '2026-10-22T12:00:00.000Z');
});

test('Batch 35: a 10-day-old lead matches, an older-than-30-days one does not, the newest wins', () => {
  const row = (id: string, d: number) => ({ id, email: 'jo@example.com', phone: null, postcode: 'SW1A 1AA', created_at: daysAgo(d) });
  assert.equal(pickSameLandlord([row('old', 40)], cand, 30, NOW), null);
  assert.equal(pickSameLandlord([row('ten', 10)], cand, 30, NOW)?.id, 'ten');
  assert.equal(pickSameLandlord([row('ten', 10), row('two', 2), row('old', 40)], cand, 30, NOW)?.id, 'two');
  assert.equal(pickSameLandlord([{ ...row('p', 5), postcode: 'E1 6AN' }], cand, 30, NOW), null);
});

test('Batch 35: the store query is owner scoped, skips archived, and never writes a lead', () => {
  const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function findSameLandlordLead'), src.indexOf('async function rememberLeadInput'));
  assert.match(fn, /\.eq\('user_id', ownerId\)/);
  assert.match(fn, /\.is\('archived_at', null\)/);
  assert.match(fn, /\.gte\('created_at'/);
  assert.doesNotMatch(fn, /\.(insert|update|delete|upsert)\(|crm_pushed_at|status/);
  // the website reuse check is unchanged and still needs a funnel
  assert.match(src, /input\.funnelId && input\.contact\.email && input\.property\.postcode/);
});
