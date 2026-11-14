import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoToLondonLocal, londonLocalToIso, parseLifecycleForm } from './admin-form.ts';

test('UK time in, UTC out, in summer and in winter', () => {
  assert.equal(londonLocalToIso('2026-10-01T09:30'), '2026-10-01T08:30:00.000Z');
  assert.equal(londonLocalToIso('2026-11-01T09:30'), '2026-11-01T09:30:00.000Z');
  assert.equal(londonLocalToIso('2026-10-01'), '2026-09-30T23:00:00.000Z');
  assert.equal(londonLocalToIso('2026-02-31T10:00'), null);
  assert.equal(londonLocalToIso('soon'), null);
  assert.equal(isoToLondonLocal('2026-10-01T08:30:00.000Z'), '2026-10-01T09:30');
  assert.equal(isoToLondonLocal(null), '');
});

const base: Record<string, string> = {
  starter_pack_from: '',
  inactivity_from: '',
  starter_pack_price_pence: '1000',
  starter_pack_credit_pence: '3000',
  starter_pack_snooze_days: '7',
  low_credit_pence: '500',
  inactive_reengage_days: '14',
  picks_pause_inactive_days: '25',
};
const get = (over: Record<string, string>) => (name: string) => ({ ...base, ...over })[name] ?? null;
const now = new Date('2026-10-01T08:00:00Z');

test('the defaults save as they are, with both dates off', () => {
  const r = parseLifecycleForm(get({}), now);
  assert.ok(r.ok);
  assert.equal(r.values.starter_pack_from, '');
  assert.equal(r.values.inactivity_from, '');
  assert.equal(r.values.starter_pack_price_pence, 1000);
  assert.equal(r.values.picks_pause_inactive_days, 25);
});

test('"now" sets the current instant; a typed date is read as UK time', () => {
  const r = parseLifecycleForm(get({ starter_pack_from_now: '1', inactivity_from: '2026-10-02T00:00' }), now);
  assert.ok(r.ok);
  assert.equal(r.values.starter_pack_from, '2026-10-01T08:00:00.000Z');
  assert.equal(r.values.inactivity_from, '2026-10-01T23:00:00.000Z');
});

test('bad input is refused with a reason', () => {
  const cheap = parseLifecycleForm(get({ starter_pack_credit_pence: '500' }), now);
  assert.equal(cheap.ok, false);
  const zero = parseLifecycleForm(get({ inactive_reengage_days: '0' }), now);
  assert.equal(zero.ok, false);
  const frac = parseLifecycleForm(get({ low_credit_pence: '4.5' }), now);
  assert.equal(frac.ok, false);
  const date = parseLifecycleForm(get({ inactivity_from: 'tomorrow' }), now);
  assert.equal(date.ok, false);
  const lowZero = parseLifecycleForm(get({ low_credit_pence: '0' }), now);
  assert.equal(lowZero.ok, true);
});

test('Batch 29: the starter pack guardrails save when sent, are checked, and an older form leaves them alone', () => {
  const r = parseLifecycleForm(get({ pack_bonus_expiry_days: '30', pack_fresh_report_cap: '3', pack_early_offer_pence: '1500', pack_paying_headline_floor_pct: '10', pack_paying_headline_target_pct: '22', pack_cost_target_pence: '190', pack_cost_ceiling_pence: '250' }), now);
  assert.ok(r.ok);
  assert.equal(r.values.pack_bonus_expiry_days, 30);
  assert.equal(r.values.pack_fresh_report_cap, 3);
  assert.equal(r.values.pack_cost_ceiling_pence, 250);
  const old = parseLifecycleForm(get({}), now);
  assert.ok(old.ok);
  assert.equal('pack_bonus_expiry_days' in old.values, false);
  assert.equal(parseLifecycleForm(get({ pack_bonus_expiry_days: '0' }), now).ok, false);
  assert.equal(parseLifecycleForm(get({ pack_paying_headline_floor_pct: '30', pack_paying_headline_target_pct: '22' }), now).ok, false, 'amber above green');
  assert.equal(parseLifecycleForm(get({ pack_paying_rundown_paid_target_pct: '101' }), now).ok, false);
  assert.equal(parseLifecycleForm(get({ pack_cost_target_pence: '300', pack_cost_ceiling_pence: '250' }), now).ok, false);
});
