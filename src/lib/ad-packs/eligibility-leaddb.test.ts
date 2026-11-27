import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adRouteVerdict, type LeadDbAdAccount } from '../leaddb/ad-account.ts';
import {
  AD_ROUTES,
  chooseAdRoute,
  ELIGIBILITY_REASONS,
  evaluateEligibility,
  evaluateLeadDbEligibility,
  LEADDB_ONLY_REASONS,
  LEADDB_REASON_OF_VERDICT,
  LEADDB_REASONS,
  leadDbAccountFacts,
  plainReason,
  type LeadDbEligibilityFacts,
  type LeadDbEligibilityReason,
} from './eligibility.ts';

const NOW = new Date('2026-11-26T12:00:00Z');
const OK: LeadDbEligibilityFacts = { isOwner: true, hasWebsite: false, linked: true, allowed: true, cardOnFile: true, stopped: false, switchOn: true };
const reasons = (over: Partial<LeadDbEligibilityFacts>, opts?: { admin?: boolean }) => evaluateLeadDbEligibility({ ...OK, ...over }, opts).reasons;

function account(over: Partial<LeadDbAdAccount> = {}): LeadDbAdAccount {
  return {
    ownerId: 'owner-1',
    ldCustomerId: 'cust_1',
    linkId: null,
    allowed: true,
    cardOnFile: true,
    accountStatus: 'active',
    cancelEffectiveAt: null,
    lapsed: false,
    stateAsOf: new Date('2026-11-25T10:00:00Z'),
    ...over,
  };
}

test('the two routes', () => {
  assert.deepEqual([...AD_ROUTES], ['academy', 'leaddb']);
});

test('lead database route: everything in place and the switch on is eligible', () => {
  assert.deepEqual(evaluateLeadDbEligibility(OK), { eligible: true, reasons: [] });
});

test('lead database route: each reason on its own', () => {
  assert.deepEqual(reasons({ isOwner: false }), ['not_owner']);
  assert.deepEqual(reasons({ hasWebsite: true }), ['has_website']);
  assert.deepEqual(reasons({ linked: false }), ['no_leaddb_account']);
  assert.deepEqual(reasons({ stopped: true }), ['account_stopped']);
  assert.deepEqual(reasons({ cardOnFile: false }), ['no_card']);
  assert.deepEqual(reasons({ allowed: false }), ['not_allowed']);
  assert.deepEqual(reasons({ switchOn: false }), ['switch_off']);
});

test('lead database route: reasons come most basic first and several can apply', () => {
  assert.deepEqual(reasons({ stopped: true, cardOnFile: false, allowed: false, switchOn: false }), ['account_stopped', 'no_card', 'not_allowed', 'switch_off']);
  assert.deepEqual(reasons({ cardOnFile: false, allowed: false }), ['no_card', 'not_allowed']);
});

test('lead database route: a non-owner is told only that; no account hides the account reasons; a website hides them too', () => {
  assert.deepEqual(reasons({ isOwner: false, hasWebsite: true, linked: false, allowed: false, switchOn: false }), ['not_owner']);
  assert.deepEqual(reasons({ linked: false, stopped: true, cardOnFile: false, allowed: false }), ['no_leaddb_account']);
  assert.deepEqual(reasons({ hasWebsite: true, stopped: true, cardOnFile: false, allowed: false }), ['has_website']);
  assert.deepEqual(reasons({ hasWebsite: true, switchOn: false }), ['has_website', 'switch_off']);
});

test('lead database route: admin preview bypasses only the switch', () => {
  assert.deepEqual(evaluateLeadDbEligibility({ ...OK, switchOn: false }, { admin: true }), { eligible: true, reasons: [] });
  assert.deepEqual(reasons({ switchOn: false, allowed: false }, { admin: true }), ['not_allowed']);
  assert.deepEqual(reasons({ switchOn: false, cardOnFile: false }, { admin: true }), ['no_card']);
  assert.deepEqual(reasons({ switchOn: false, hasWebsite: true }, { admin: true }), ['has_website']);
  assert.deepEqual(reasons({ switchOn: false, isOwner: false }, { admin: true }), ['not_owner']);
  assert.deepEqual(reasons({ switchOn: false }, { admin: false }), ['switch_off']);
});

test('lead database route: the whole matrix agrees with the rules, never eligible with a reason, always a listed reason', () => {
  let n = 0;
  for (const isOwner of [true, false])
    for (const hasWebsite of [true, false])
      for (const linked of [true, false])
        for (const allowed of [true, false])
          for (const cardOnFile of [true, false])
            for (const stopped of [true, false])
              for (const switchOn of [true, false])
                for (const admin of [true, false]) {
                  n += 1;
                  const f: LeadDbEligibilityFacts = { isOwner, hasWebsite, linked, allowed, cardOnFile, stopped, switchOn };
                  const v = evaluateLeadDbEligibility(f, { admin });
                  assert.equal(v.eligible, v.reasons.length === 0, JSON.stringify(f));
                  assert.equal(v.eligible, isOwner && !hasWebsite && linked && allowed && cardOnFile && !stopped && (switchOn || admin), JSON.stringify(f));
                  for (const r of v.reasons) assert.ok((LEADDB_REASONS as readonly string[]).includes(r), r);
                  const order = v.reasons.map((r) => (LEADDB_REASONS as readonly string[]).indexOf(r));
                  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'most basic first');
                }
  assert.equal(n, 256);
});

test('the Academy route is untouched beside it: same facts, same verdict, no lead database reason', () => {
  const academyOk = { isOwner: true, academy: 'active' as const, hasSite: true, siteLive: true, hasDomain: true, domainLive: true, switchOn: true };
  assert.deepEqual(evaluateEligibility(academyOk), { eligible: true, reasons: [] });
  for (const r of ELIGIBILITY_REASONS) assert.ok(!(LEADDB_ONLY_REASONS as readonly string[]).includes(r), r);
  assert.deepEqual(evaluateEligibility({ ...academyOk, academy: 'none', hasSite: false, siteLive: false, hasDomain: false, domainLive: false }).reasons, ['no_academy', 'no_site']);
});

test('plainReason: plain English for every lead database reason, none repeated, none jargon', () => {
  const seen = new Set<string>(ELIGIBILITY_REASONS.map((r) => plainReason(r)));
  for (const r of LEADDB_ONLY_REASONS) {
    const s = plainReason(r);
    assert.match(s, /^[A-Z][^!]*[.]$/, r);
    assert.doesNotMatch(s, /!|switch|billing|row|status|null|owner_id|_|API|DNS|stay\s*ful|\bpacks?\b|\bcodes?\b|\bversions?\b|\bregenerat/i, `jargon in ${r}: ${s}`);
    assert.ok(!seen.has(s), `${r} reads differently from the others`);
    seen.add(s);
  }
  // The reasons both routes share keep their one sentence.
  for (const r of ['not_owner', 'switch_off'] as const) assert.equal(plainReason(r), plainReason(r));
  assert.ok(plainReason('nope' as LeadDbEligibilityReason).length > 0);
});

test('chooseAdRoute: an ad account and no website of their own is the lead database route; everything else is the Academy', () => {
  assert.equal(chooseAdRoute({ hasAdAccount: true, hasSiteWebsite: false }), 'leaddb');
  assert.equal(chooseAdRoute({ hasAdAccount: true, hasSiteWebsite: true }), 'academy');
  assert.equal(chooseAdRoute({ hasAdAccount: false, hasSiteWebsite: true }), 'academy');
  assert.equal(chooseAdRoute({ hasAdAccount: false, hasSiteWebsite: false }), 'academy');
});

test('leadDbAccountFacts: no account is not linked; no calculator site is not linked either', () => {
  assert.deepEqual(leadDbAccountFacts(null, NOW), { linked: false, allowed: false, cardOnFile: false, stopped: true });
  assert.equal(leadDbAccountFacts(account(), NOW, false).linked, false);
  assert.deepEqual(leadDbAccountFacts(account(), NOW), { linked: true, allowed: true, cardOnFile: true, stopped: false });
});

test('leadDbAccountFacts: stopped never includes the card; pause is never read', () => {
  assert.equal(leadDbAccountFacts(account({ cardOnFile: false }), NOW).stopped, false);
  assert.equal(leadDbAccountFacts(account({ cardOnFile: false }), NOW).cardOnFile, false);
  assert.equal(leadDbAccountFacts(account({ accountStatus: 'paused' }), NOW).stopped, false);
  assert.equal(leadDbAccountFacts(account({ accountStatus: 'past_due' }), NOW).stopped, false);
  assert.equal(leadDbAccountFacts(account({ stateAsOf: null }), NOW).stopped, true);
  assert.equal(leadDbAccountFacts(account({ lapsed: true }), NOW).stopped, true);
  assert.equal(leadDbAccountFacts(account({ accountStatus: 'cancelled' }), NOW).stopped, true);
  assert.equal(leadDbAccountFacts(account({ cancelEffectiveAt: new Date('2026-11-26T11:59:59Z') }), NOW).stopped, true);
  assert.equal(leadDbAccountFacts(account({ cancelEffectiveAt: new Date('2026-11-27T00:00:00Z') }), NOW).stopped, false);
});

test('mapping: adRouteVerdict’s reason is the first eligibility reason, over every account state', () => {
  // Batch 55 step 2: the unpaid hold reads as account_stopped (the same neutral wording).
  assert.deepEqual(LEADDB_REASON_OF_VERDICT, { no_account: 'no_leaddb_account', account_stopped: 'account_stopped', unpaid_hold: 'account_stopped', no_card: 'no_card', not_allowed: 'not_allowed' });
  const accounts: (LeadDbAdAccount | null)[] = [null];
  for (const allowed of [true, false])
    for (const cardOnFile of [true, false])
      for (const lapsed of [true, false])
        for (const accountStatus of ['active', 'paused', 'past_due', 'pending_cancel', 'cancelled', 'lapsed', null])
          for (const stateAsOf of [new Date('2026-11-25T10:00:00Z'), null])
            for (const cancelEffectiveAt of [null, new Date('2026-11-20T00:00:00Z'), new Date('2026-12-20T00:00:00Z')])
              for (const unpaidHold of [false, true])
                accounts.push(account({ allowed, cardOnFile, lapsed, accountStatus, stateAsOf, cancelEffectiveAt, unpaidHold }));
  for (const a of accounts) {
    const verdict = adRouteVerdict(a, NOW);
    const v = evaluateLeadDbEligibility({ isOwner: true, hasWebsite: false, ...leadDbAccountFacts(a, NOW), switchOn: true });
    assert.equal(v.eligible, verdict.ok, JSON.stringify(a));
    if (!verdict.ok) assert.equal(v.reasons[0], LEADDB_REASON_OF_VERDICT[verdict.reason], JSON.stringify(a));
  }
});

test('eligibility-server (source pin): the route is chosen by chooseAdRoute from the ad account and the owner’s own site; a calculator site is not an own website', () => {
  const src = readFileSync(new URL('./eligibility-server.ts', import.meta.url), 'utf8');
  assert.match(src, /readAdAccount\(ownerId\)/);
  assert.match(src, /chooseAdRoute\(\{ hasAdAccount: adAccount !== null, hasSiteWebsite: ownedSite !== null && !isCalculator \}\)/);
  assert.match(src, /evaluateLeadDbEligibility\(/);
  assert.match(src, /leadDbAccountFacts\(adAccount, new Date\(\), isCalculator\)/);
  // The Academy branch still reads the Academy purchase, the domain and the domain's live word, in that branch.
  const academy = src.slice(src.indexOf('The Academy route, exactly as it was'));
  assert.match(academy, /domainOfSite\(website\.id\)/);
  assert.match(academy, /domainIsLiveFor\(website\.id, domainRow\.name\)/);
  assert.match(academy, /evaluateEligibility\(/);
  // The lead database branch never reads a domain.
  const leaddb = src.slice(src.indexOf("if (route === 'leaddb')"), src.indexOf('The Academy route, exactly as it was'));
  assert.doesNotMatch(leaddb, /domainOfSite|domainIsLiveFor|academyOf/);
  // Never writes anything.
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\(/);
});
