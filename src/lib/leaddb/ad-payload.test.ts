import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adBilling, adLeadRetryable, adTag, billingAgrees, packNoticeOutcome, pickRepeat } from './ad-payload.ts';

/** Batch 55 step 2 (contract section 10, rules 10 and 11): the pure parts of the ad lead push. */

test('adTag: the pack code only when SI matched it, Meta id digits only, none without a link', () => {
  assert.deepEqual(adTag(null), { pack_code: null, ad_id: null, ad_match: 'none' });
  assert.deepEqual(adTag({ match: 'code', metaAdIdSeen: null, packAdCode: 'SI-a1b2c3-5B-1' }), { pack_code: 'SI-a1b2c3-5B-1', ad_id: null, ad_match: 'code' });
  assert.deepEqual(adTag({ match: 'ad_id', metaAdIdSeen: '6001', packAdCode: 'SI-a1b2c3-5B-2' }), { pack_code: 'SI-a1b2c3-5B-2', ad_id: '6001', ad_match: 'ad_id' });
  assert.deepEqual(adTag({ match: 'foreign_code', metaAdIdSeen: '6001', packAdCode: 'SI-zz-5B-1' }), { pack_code: null, ad_id: '6001', ad_match: 'foreign_code' });
  assert.deepEqual(adTag({ match: 'none', metaAdIdSeen: '{{ad.id}}', packAdCode: null }), { pack_code: null, ad_id: null, ad_match: 'none' });
  assert.equal(adTag({ match: 'weird', metaAdIdSeen: null, packAdCode: 'X' }).ad_match, 'none');
});

test('adBilling: test, then no figures, then repeat, then low data, then report_ran', () => {
  assert.deepEqual(adBilling({ isTest: true, phase: 'report', qualityOk: true, repeat: true }), { billable: false, reason: 'test', lowData: false });
  assert.deepEqual(adBilling({ isTest: true, phase: 'report_failed', qualityOk: null, repeat: false }), { billable: false, reason: 'test', lowData: false });
  assert.deepEqual(adBilling({ isTest: false, phase: 'report_failed', qualityOk: null, repeat: true }), { billable: false, reason: 'no_figures', lowData: false });
  assert.deepEqual(adBilling({ isTest: false, phase: 'report', qualityOk: false, repeat: true }), { billable: true, reason: 'repeat', lowData: true });
  assert.deepEqual(adBilling({ isTest: false, phase: 'report', qualityOk: false, repeat: false }), { billable: true, reason: 'low_data', lowData: true });
  assert.deepEqual(adBilling({ isTest: false, phase: 'report', qualityOk: null, repeat: false }), { billable: true, reason: 'low_data', lowData: true });
  assert.deepEqual(adBilling({ isTest: false, phase: 'report', qualityOk: true, repeat: false }), { billable: true, reason: 'report_ran', lowData: false });
});

test('billingAgrees mirrors the lead database’s 400 rule', () => {
  assert.equal(billingAgrees(true, false, 'test'), true);
  assert.equal(billingAgrees(true, true, 'report_ran'), false);
  assert.equal(billingAgrees(false, false, 'test'), false);
  assert.equal(billingAgrees(false, false, 'no_figures'), true);
  for (const r of ['report_ran', 'low_data', 'repeat']) assert.equal(billingAgrees(false, true, r), true, r);
  assert.equal(billingAgrees(false, true, 'no_figures'), false);
});

test('pickRepeat: an earlier lead of the same landlord inside 30 days, never itself or a later one', () => {
  const self = { id: 'b', createdAt: '2026-12-02T10:00:00Z', postcode: 'LS1 1AA', email: 'ann@example.test', phone: null };
  const row = (id: string, at: string, over: Record<string, string | null> = {}) => ({ id, email: 'ann@example.test', phone: null, postcode: 'LS11AA', created_at: at, ...over });
  assert.equal(pickRepeat([row('a', '2026-11-20T10:00:00Z')], self), 'a');
  assert.equal(pickRepeat([row('b', '2026-12-02T10:00:00Z')], self), null, 'never itself');
  assert.equal(pickRepeat([row('c', '2026-12-03T10:00:00Z')], self), null, 'never a later lead');
  assert.equal(pickRepeat([row('a', '2026-10-20T10:00:00Z')], self), null, 'outside 30 days');
  assert.equal(pickRepeat([row('a', '2026-11-20T10:00:00Z', { postcode: 'M1 1AA' })], self), null);
  assert.equal(pickRepeat([row('a', '2026-11-20T10:00:00Z', { email: 'x@y.test', phone: '07700900123' })], { ...self, phone: '+447700900123' }), 'a', 'by phone');
  assert.equal(pickRepeat([row('a', '2026-11-20T10:00:00Z')], { ...self, postcode: null }), null, 'no postcode yet: no repeat');
  assert.equal(pickRepeat([row('a', '2026-11-20T10:00:00Z'), row('a2', '2026-11-28T10:00:00Z')], self), 'a2', 'the newest');
});

test('adLeadRetryable follows contract section 10', () => {
  for (const [s, c] of [[0, 'network'], [0, 'timeout'], [0, 'not_configured'], [404, 'not_available'], [401, 'bad_signature'], [408, 'http_408'], [500, 'server_error'], [503, 'http_503']] as const) {
    assert.equal(adLeadRetryable(s, c), true, `${s} ${c}`);
  }
  for (const [s, c] of [[400, 'bad_request'], [403, 'stopped'], [403, 'unpaid_hold'], [404, 'unknown_customer'], [409, 'conflict'], [413, 'too_large'], [422, 'bad_report'], [429, 'daily_cap'], [200, 'http_200']] as const) {
    assert.equal(adLeadRetryable(s, c), false, `${s} ${c}`);
  }
});

test('packNoticeOutcome: recorded or already_recorded is done; 404 unknown_customer is final; an unset secret retries', () => {
  assert.equal(packNoticeOutcome({ ok: true, status: 200, code: 'ok', data: { code: 'recorded' } }), 'done');
  assert.equal(packNoticeOutcome({ ok: true, status: 200, code: 'ok', data: { code: 'already_recorded' } }), 'done');
  assert.equal(packNoticeOutcome({ ok: false, status: 404, code: 'unknown_customer' }), 'final');
  assert.equal(packNoticeOutcome({ ok: false, status: 404, code: 'not_available' }), 'retry');
  assert.equal(packNoticeOutcome({ ok: false, status: 401, code: 'bad_signature' }), 'retry');
  assert.equal(packNoticeOutcome({ ok: false, status: 500, code: 'server_error' }), 'retry');
  assert.equal(packNoticeOutcome({ ok: false, status: 0, code: 'not_configured' }), 'retry');
  assert.equal(packNoticeOutcome({ ok: false, status: 400, code: 'bad_request' }), 'final');
});
