import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoRenewRule, canChoose, chargeDecision, daysToExpiry, inRenewalWindow, isFinal, isStuck, nameLocked, nextStep, offerFresh, priceAllowed, renewalPeriod } from './policy.ts';
import { DOMAIN_STATUSES, OFFER_TTL_MS } from './types.ts';

const NOW = new Date('2026-11-20T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

test('the statuses are the schema\'s, and every one has a next step', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const m = sql.match(/website_domains_status_check\s+check \(status in \(([^)]*)\)\)/);
  assert.ok(m, 'the status check is in the schema');
  assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...DOMAIN_STATUSES]);
  for (const s of DOMAIN_STATUSES) assert.ok(nextStep(s), s);
  assert.equal(nextStep('awaiting_admin'), 'wait_admin');
  assert.equal(nextStep('held_cap'), 'retry_next_day');
  assert.equal(nextStep('registering'), 'resume');
  assert.equal(nextStep('connecting'), 'connect');
  assert.equal(nextStep('needs_choice'), 'choose_again');
  assert.equal(nextStep('failed'), 'admin_retry');
});

test('stuck: more than 24 hours in an unfinished state; live, released and needs_choice never are', () => {
  assert.equal(isStuck('connecting', hoursAgo(23), NOW), false);
  assert.equal(isStuck('connecting', hoursAgo(25), NOW), true);
  assert.equal(isStuck('registering', hoursAgo(30), NOW), true);
  assert.equal(isStuck('held_cap', hoursAgo(30), NOW), true);
  assert.equal(isStuck('awaiting_admin', hoursAgo(30), NOW), true);
  assert.equal(isStuck('failed', hoursAgo(30), NOW), true, 'a failed one waits on the admin');
  for (const s of ['live', 'released', 'needs_choice'] as const) {
    assert.equal(isStuck(s, hoursAgo(500), NOW), false, s);
    assert.equal(isFinal(s), true, s);
  }
  assert.equal(isStuck('connecting', 'not a date', NOW), false);
});

test('the renewal window is 30 days before expiry, for a live domain only', () => {
  assert.equal(inRenewalWindow('live', inDays(31), NOW), false);
  assert.equal(inRenewalWindow('live', inDays(30), NOW), true);
  assert.equal(inRenewalWindow('live', inDays(1), NOW), true);
  assert.equal(inRenewalWindow('live', inDays(-3), NOW), true, 'an expired one still needs a decision');
  assert.equal(inRenewalWindow('released', inDays(5), NOW), false);
  assert.equal(inRenewalWindow('connecting', inDays(5), NOW), false);
  assert.equal(inRenewalWindow('live', null, NOW), false);
  assert.equal(daysToExpiry(inDays(7), NOW), 7);
});

test('auto-renew: 7 days left, no decision, site live and allowed', () => {
  const base = { status: 'live' as const, expiresAt: inDays(7), renewDecision: null, siteLive: true, renewAllowed: true };
  assert.equal(autoRenewRule(base, NOW), 'renew');
  assert.equal(autoRenewRule({ ...base, expiresAt: inDays(2) }, NOW), 'renew');
  assert.equal(autoRenewRule({ ...base, expiresAt: inDays(8) }, NOW), 'not_yet');
  assert.equal(autoRenewRule({ ...base, expiresAt: null }, NOW), 'not_yet');
  assert.equal(autoRenewRule({ ...base, renewDecision: 'dont_renew' }, NOW), 'decided');
  assert.equal(autoRenewRule({ ...base, renewDecision: 'renew' }, NOW), 'decided');
  assert.equal(autoRenewRule({ ...base, siteLive: false }, NOW), 'skip_site_off');
  assert.equal(autoRenewRule({ ...base, renewAllowed: false }, NOW), 'skip_not_allowed');
  assert.equal(autoRenewRule({ ...base, status: 'failed' }, NOW), 'skip_not_live');
  assert.equal(autoRenewRule({ ...base, status: 'released' }, NOW), 'skip_not_live');
});

test('charge OFF never charges; year 1 never charges; a renewal charges only when ON', () => {
  for (const year of [-1, 0, 1, 2, 3, 1.5, NaN]) assert.equal(chargeDecision({ chargeOn: false, year }), 'skip_off', `OFF, year ${year}`);
  assert.equal(chargeDecision({ chargeOn: true, year: 1 }), 'skip_year_one');
  assert.equal(chargeDecision({ chargeOn: true, year: 0 }), 'skip_year_one');
  assert.equal(chargeDecision({ chargeOn: true, year: 1.5 }), 'skip_year_one');
  assert.equal(chargeDecision({ chargeOn: true, year: 2 }), 'charge');
  assert.equal(chargeDecision({ chargeOn: true, year: 5 }), 'charge');
});

test('canChoose: no domain yet, or the name went before it was bought; the name locks from registering', () => {
  assert.equal(canChoose(null), true);
  assert.equal(canChoose(undefined), true);
  assert.equal(canChoose({ status: 'needs_choice' }), true);
  for (const s of DOMAIN_STATUSES.filter((x) => x !== 'needs_choice')) assert.equal(canChoose({ status: s }), false, s);
  for (const s of ['registering', 'connecting', 'live', 'failed', 'releasing', 'released'] as const) assert.equal(nameLocked(s), true, s);
  for (const s of ['awaiting_admin', 'held_cap', 'needs_choice'] as const) assert.equal(nameLocked(s), false, s);
});

test('an offer is good for 24 hours, never from the future, never without a date', () => {
  assert.equal(offerFresh(new Date(NOW.getTime() - 1000), NOW), true);
  assert.equal(offerFresh(new Date(NOW.getTime() - OFFER_TTL_MS + 1000), NOW), true);
  assert.equal(offerFresh(new Date(NOW.getTime() - OFFER_TTL_MS), NOW), false);
  assert.equal(offerFresh(hoursAgo(25), NOW), false);
  assert.equal(offerFresh(new Date(NOW.getTime() + 60_000), NOW), false);
  assert.equal(offerFresh(null, NOW), false);
  assert.equal(offerFresh('nonsense', NOW), false);
});

test('a price is a whole number of pence above 0 and no more than the maximum', () => {
  assert.equal(priceAllowed(600, 2500), true);
  assert.equal(priceAllowed(2500, 2500), true);
  for (const bad of [2501, 0, -5, 12.5, NaN, Infinity, '600', null, undefined]) assert.equal(priceAllowed(bad, 2500), false, String(bad));
  assert.equal(renewalPeriod('2027-11-20T08:00:00Z'), '2027-11-20');
});
