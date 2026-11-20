import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELIGIBILITY_REASONS, evaluateEligibility, parseSwitch, plainReason, type EligibilityFacts, type EligibilityReason } from './eligibility.ts';

const OK: EligibilityFacts = { isOwner: true, academy: 'active', hasSite: true, siteLive: true, hasDomain: true, domainLive: true, switchOn: true };
const reasons = (over: Partial<EligibilityFacts>, opts?: { admin?: boolean }) => evaluateEligibility({ ...OK, ...over }, opts).reasons;

test('everything in place and the switch on: eligible, no reasons', () => {
  assert.deepEqual(evaluateEligibility(OK), { eligible: true, reasons: [] });
});

test('each ineligible reason', () => {
  assert.deepEqual(reasons({ isOwner: false }), ['not_owner']);
  assert.deepEqual(reasons({ academy: 'none' }), ['no_academy']);
  assert.deepEqual(reasons({ academy: 'refunded' }), ['academy_refunded']);
  assert.deepEqual(reasons({ hasSite: false, siteLive: false, hasDomain: false, domainLive: false }), ['no_site']);
  assert.deepEqual(reasons({ siteLive: false }), ['site_not_live']);
  assert.deepEqual(reasons({ hasDomain: false, domainLive: false }), ['no_domain']);
  assert.deepEqual(reasons({ domainLive: false }), ['domain_not_live']);
  assert.deepEqual(reasons({ switchOn: false }), ['switch_off']);
  for (const r of ELIGIBILITY_REASONS) {
    const facts: Record<EligibilityReason, Partial<EligibilityFacts>> = {
      not_owner: { isOwner: false },
      no_academy: { academy: 'none' },
      academy_refunded: { academy: 'refunded' },
      no_site: { hasSite: false },
      site_not_live: { siteLive: false },
      no_domain: { hasDomain: false },
      domain_not_live: { domainLive: false },
      switch_off: { switchOn: false },
    };
    const v = evaluateEligibility({ ...OK, ...facts[r] });
    assert.equal(v.eligible, false, r);
    assert.ok(v.reasons.includes(r), r);
  }
});

test('reasons come most basic first and several can apply', () => {
  const v = evaluateEligibility({ isOwner: true, academy: 'none', hasSite: true, siteLive: false, hasDomain: true, domainLive: false, switchOn: false });
  assert.deepEqual(v.reasons, ['no_academy', 'site_not_live', 'domain_not_live', 'switch_off']);
  assert.equal(v.eligible, false);
});

test('a non-owner is told only that; nothing else is said about an account that is not theirs', () => {
  assert.deepEqual(reasons({ isOwner: false, academy: 'none', hasSite: false, switchOn: false }), ['not_owner']);
});

test('no site hides the site and domain reasons that cannot apply', () => {
  assert.deepEqual(reasons({ hasSite: false, siteLive: false, hasDomain: false, domainLive: false, switchOn: false }), ['no_site', 'switch_off']);
});

test('admin preview bypasses only the switch', () => {
  assert.deepEqual(evaluateEligibility({ ...OK, switchOn: false }, { admin: true }), { eligible: true, reasons: [] });
  assert.deepEqual(reasons({ switchOn: false, academy: 'none' }, { admin: true }), ['no_academy']);
  assert.deepEqual(reasons({ switchOn: false, siteLive: false }, { admin: true }), ['site_not_live']);
  assert.deepEqual(reasons({ switchOn: false, domainLive: false }, { admin: true }), ['domain_not_live']);
  assert.deepEqual(reasons({ switchOn: false, isOwner: false }, { admin: true }), ['not_owner']);
  assert.deepEqual(reasons({ switchOn: false }, { admin: false }), ['switch_off']);
});

test('plainReason: a sentence for every reason, no jargon', () => {
  const seen = new Set<string>();
  for (const r of ELIGIBILITY_REASONS) {
    const s = plainReason(r);
    assert.match(s, /^[A-Z].*[.]$/, r);
    assert.doesNotMatch(s, /switch|billing|row|database|status|null|owner_id|academy_purchases|DNS|API|_/i, `jargon in ${r}: ${s}`);
    assert.ok(!seen.has(s), 'each reason reads differently');
    seen.add(s);
  }
  assert.ok(plainReason('nope' as EligibilityReason).length > 0);
});

test('parseSwitch: only true switches on (jsonb true or the string "true")', () => {
  assert.equal(parseSwitch(true), true);
  assert.equal(parseSwitch('true'), true);
  for (const v of [false, 'false', null, undefined, 1, 'yes', 'TRUE', {}, []]) assert.equal(parseSwitch(v), false, String(v));
});
