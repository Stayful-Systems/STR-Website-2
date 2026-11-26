import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ELIGIBILITY_REASONS, evaluateEligibility, parseSwitch, plainReason, type EligibilityFacts } from './eligibility.ts';

/**
 * Batch 55 (Part A), phase A7: the Academy route's eligibility is pinned byte for byte, so adding the lead database
 * route cannot change a word or a reason order on the Academy path. This was written and run green BEFORE the lead
 * database route was added. If a line here must change, the Academy route changed: stop and ask.
 */

// The facts shape: exactly these keys, in this order.
const SHAPE: EligibilityFacts = { isOwner: true, academy: 'active', hasSite: true, siteLive: true, hasDomain: true, domainLive: true, switchOn: true };

test('the Academy facts have exactly the Batch 38 shape', () => {
  assert.deepEqual(Object.keys(SHAPE), ['isOwner', 'academy', 'hasSite', 'siteLive', 'hasDomain', 'domainLive', 'switchOn']);
});

test('the Academy reason list is unchanged, in order', () => {
  assert.deepEqual([...ELIGIBILITY_REASONS], ['not_owner', 'no_academy', 'academy_refunded', 'no_site', 'site_not_live', 'no_domain', 'domain_not_live', 'switch_off']);
});

test('every Academy sentence is word for word what it was', () => {
  assert.deepEqual(Object.fromEntries(ELIGIBILITY_REASONS.map((r) => [r, plainReason(r)])), {
    not_owner: 'Only the owner of the account can set up the ad pack.',
    no_academy: 'The ad pack comes with the Academy. Once your Academy purchase is linked to this account, it will appear here.',
    academy_refunded: 'The ad pack comes with the Academy, and your Academy purchase has been refunded.',
    no_site: 'You need a website first. The ads send people to it.',
    site_not_live: 'Your website is not live yet. Put it live, then come back for your ads.',
    no_domain: 'Your website needs its own .co.uk address first. The ads send people there.',
    domain_not_live: 'Your website address is not live yet. It can take a little while to go live, so check back soon.',
    switch_off: 'The ad pack is not open yet. We will tell you as soon as it is.',
  });
  assert.equal(plainReason('nope' as never), 'The ad pack is not available for this account yet.');
});

/** Every combination of the facts, with and without the admin preview, as one JSON string. */
function matrix(): { facts: EligibilityFacts; admin: boolean; out: ReturnType<typeof evaluateEligibility> }[] {
  const rows: { facts: EligibilityFacts; admin: boolean; out: ReturnType<typeof evaluateEligibility> }[] = [];
  for (const isOwner of [true, false])
    for (const academy of ['active', 'refunded', 'none'] as const)
      for (const hasSite of [true, false])
        for (const siteLive of [true, false])
          for (const hasDomain of [true, false])
            for (const domainLive of [true, false])
              for (const switchOn of [true, false])
                for (const admin of [false, true]) {
                  const facts: EligibilityFacts = { isOwner, academy, hasSite, siteLive, hasDomain, domainLive, switchOn };
                  rows.push({ facts, admin, out: evaluateEligibility(facts, { admin }) });
                }
  return rows;
}

test('the whole Academy matrix (every fact, with and without admin) is unchanged', () => {
  const rows = matrix();
  assert.equal(rows.length, 2 * 3 * 2 * 2 * 2 * 2 * 2 * 2);
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  assert.equal(digest, '716c7d44956c4db60cfc6516a8999562f45aaddb701270d95589df951eae2e68');
});

test('representative Academy verdicts, spelled out', () => {
  const e = (over: Partial<EligibilityFacts>, admin = false) => evaluateEligibility({ ...SHAPE, ...over }, { admin });
  assert.deepEqual(e({}), { eligible: true, reasons: [] });
  assert.deepEqual(e({ isOwner: false, academy: 'none', switchOn: false }), { eligible: false, reasons: ['not_owner'] });
  assert.deepEqual(e({ academy: 'none', siteLive: false, domainLive: false, switchOn: false }), { eligible: false, reasons: ['no_academy', 'site_not_live', 'domain_not_live', 'switch_off'] });
  assert.deepEqual(e({ academy: 'refunded', hasSite: false, siteLive: false, hasDomain: false, domainLive: false }), { eligible: false, reasons: ['academy_refunded', 'no_site'] });
  assert.deepEqual(e({ switchOn: false }, true), { eligible: true, reasons: [] });
  assert.deepEqual(e({ switchOn: false }), { eligible: false, reasons: ['switch_off'] });
});

test('parseSwitch is unchanged', () => {
  assert.equal(parseSwitch(true), true);
  assert.equal(parseSwitch('true'), true);
  for (const v of [false, 'false', null, undefined, 1, 'yes', 'TRUE', {}, []]) assert.equal(parseSwitch(v), false);
});
