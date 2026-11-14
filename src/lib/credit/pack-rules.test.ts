import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BONUS_ACTIONS,
  NOT_PACK,
  PACK_COPY,
  analysisHoldAction,
  analysisSteps,
  bonusPaysFor,
  capReached,
  deepNeedsTopUp,
  earlyOfferEmailDue,
  earlyOfferHomeShown,
  freshLeft,
  isPackOnly,
  isRestrictedGrant,
  lowCreditHeldForOffer,
  lowCreditWaitsForOffer,
  packPauseDue,
  type EarlyOfferFacts,
} from './pack-rules.ts';
import { allocate, allocateSteps, type GrantLite } from './deal-pricing.ts';

test('the bonus pays for deal opens, picks and saved analyses only', () => {
  for (const a of ['deal_open', 'cron:sourcing', 'todays_5', 'full_analysis_saved']) assert.equal(bonusPaysFor(a), true, a);
  assert.equal(bonusPaysFor('full_analysis', { reused: true }), true, 'a saved analysis debit');
  for (const a of ['full_analysis', 'report', 'report_enhanced', 'pmi_addon', 'si_call', 'si_text', 'si_email', 'si_chat_full', 'briefing', 'btl_report', 'deep_search', 'team_seat', 'funnel_lead', 'some_future_action', '', null, undefined]) {
    assert.equal(bonusPaysFor(a as string), false, String(a));
  }
  assert.equal(bonusPaysFor('full_analysis', { reused: 'true' }), false, 'only a real boolean');
});

test('the TypeScript list is the SQL list (credit_bonus_pays_for in schema.sql)', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function public.credit_bonus_pays_for'));
  const body = fn.slice(0, fn.indexOf('$$;'));
  const listed = [...body.matchAll(/in \(([^)]*)\)/g)][0]?.[1] ?? '';
  const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, [...BONUS_ACTIONS].sort());
  assert.match(body, /p_action, ''\) = 'full_analysis' and coalesce\(p_meta ->> 'reused', ''\) = 'true'/);
});

test('a restricted grant: the pack bonus until lifted', () => {
  assert.equal(isRestrictedGrant({ scope: 'pack_bonus', scopeLiftedAt: null }), true);
  assert.equal(isRestrictedGrant({ scope: 'pack_bonus', scopeLiftedAt: '2026-11-01T00:00:00Z' }), false);
  assert.equal(isRestrictedGrant({ scope: null }), false, 'the ordinary welcome credit');
});

test('pack-only: bought, paid for nothing else, no live / trialling / past-due / paused plan', () => {
  assert.equal(isPackOnly({ bought: true, paidAgainAt: null, planStatus: 'free' }), true);
  assert.equal(isPackOnly({ bought: true, paidAgainAt: null, planStatus: 'lapsed' }), true, 'a trial that ended without paying');
  assert.equal(isPackOnly({ bought: true, paidAgainAt: '2026-11-02T00:00:00Z', planStatus: 'free' }), false, 'topped up since');
  for (const s of ['paid', 'subscription_trial', 'paused'] as const) assert.equal(isPackOnly({ bought: true, paidAgainAt: null, planStatus: s }), false, s);
  assert.equal(isPackOnly({ bought: false, paidAgainAt: null, planStatus: 'free' }), false, 'a member who joined before the pack');
});

test('the cap: 3 fresh reports, then the offer; nobody else is capped', () => {
  const s = { ...NOT_PACK, packOnly: true, freshCap: 3, freshUsed: 2 };
  assert.equal(freshLeft(s), 1);
  assert.equal(capReached(s), false);
  assert.equal(capReached({ ...s, freshUsed: 3 }), true, 'the 4th is blocked');
  assert.equal(capReached({ ...s, packOnly: false, freshUsed: 9 }), false);
  assert.equal(freshLeft(NOT_PACK), null);
  assert.equal(PACK_COPY.capReached(3), 'You’ve used your 3 fresh reports. Top up or start Starter to keep going. Reports already run on a deal still open with your bonus credit.');
});

test('a saved analysis is held as saved (the bonus may pay); a fresh one, or any with PMI, is not', () => {
  assert.equal(analysisHoldAction(true, false), 'full_analysis_saved');
  assert.equal(analysisHoldAction(false, false), 'full_analysis');
  assert.equal(analysisHoldAction(true, true), 'full_analysis', 'PMI is never bonus-paid');
  assert.deepEqual(analysisSteps({ openBasePence: 25, analysisBasePence: 200, pmiBasePence: 0 }, true), [
    { basePence: 25, bonusOk: true },
    { basePence: 200, bonusOk: true },
  ]);
  assert.deepEqual(analysisSteps({ openBasePence: 0, analysisBasePence: 400, pmiBasePence: 200 }, true), [
    { basePence: 400, bonusOk: false },
    { basePence: 200, bonusOk: false },
  ]);
});

test('the second opinion needs credit beyond the pack', () => {
  assert.equal(deepNeedsTopUp({ packOnly: true }), true);
  assert.equal(deepNeedsTopUp({ packOnly: false }), false);
});

// ── The allocation mirror (credit_debit's walk) ──
const g = (o: Partial<GrantLite> & Pick<GrantLite, 'id' | 'kind' | 'priority' | 'remainingPence' | 'spendRate'>): GrantLite => ({ expiresAt: null, createdAt: '2026-11-01T00:00:00Z', ...o });
const packGrants = [g({ id: 'top', kind: 'topup', priority: 3, remainingPence: 1000, spendRate: 1.3 }), g({ id: 'bonus', kind: 'welcome', priority: 2, remainingPence: 2000, spendRate: 1, expiresAt: '2099-01-01T00:00:00Z', restricted: true })];

test('allocate: a fresh report never walks the bonus; a deal open walks it first', () => {
  const fresh = allocate(packGrants, 200);
  assert.deepEqual(fresh.parts.map((p) => p.grantId), ['top']);
  assert.equal(fresh.facePence, 260);
  const open = allocate(packGrants, 50, undefined, { bonusOk: true });
  assert.deepEqual(open.parts.map((p) => p.grantId), ['bonus']);
  assert.equal(open.facePence, 50);
  const big = allocate(packGrants, 1000);
  assert.ok(big.shortfallBasePence > 0, 'the paid £10 cannot cover £10 of base at 1.3');
});

test('allocate: grants without a scope walk exactly as before', () => {
  const plain = [g({ id: 'w', kind: 'welcome', priority: 2, remainingPence: 500, spendRate: 1 }), g({ id: 't', kind: 'topup', priority: 3, remainingPence: 1300, spendRate: 1.3 })];
  for (const ok of [true, false]) {
    const q = allocate(plain, 700, undefined, { bonusOk: ok });
    assert.deepEqual(q.parts.map((p) => [p.grantId, p.basePence]), [['w', 500], ['t', 200]]);
  }
});

test('allocateSteps: the open from the bonus, then a fresh analysis from paid credit', () => {
  const q = allocateSteps(packGrants, analysisSteps({ openBasePence: 25, analysisBasePence: 200, pmiBasePence: 0 }, false));
  const by = Object.fromEntries(q.parts.map((p) => [p.grantId, p.facePence]));
  assert.deepEqual(by, { bonus: 25, top: 260 });
  assert.equal(q.facePence, 285);
});

// ── The £15 early offer ──
const facts = (o: Partial<EarlyOfferFacts> = {}): EarlyOfferFacts => ({ packOnly: true, totalPence: 1500, offerPence: 1500, homeAt: null, emailedAt: null, dismissedAt: null, ...o });

test('early offer: at £15 or less while pack-only, once in an email, Home on the day first seen', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  assert.equal(earlyOfferEmailDue(facts()), true);
  assert.equal(earlyOfferEmailDue(facts({ totalPence: 1501 })), false);
  assert.equal(earlyOfferEmailDue(facts({ emailedAt: '2026-11-10T07:00:00Z' })), false, 'once only');
  assert.equal(earlyOfferEmailDue(facts({ packOnly: false })), false, 'paid again: never');
  assert.equal(earlyOfferHomeShown(facts(), now), true);
  assert.equal(earlyOfferHomeShown(facts({ homeAt: '2026-11-14T08:00:00Z' }), now), true, 'later that UK day');
  assert.equal(earlyOfferHomeShown(facts({ homeAt: '2026-11-13T08:00:00Z' }), now), false, 'never after that day');
  assert.equal(earlyOfferHomeShown(facts({ dismissedAt: '2026-11-14T08:30:00Z' }), now), false);
});

test('never both on one day: the £5 decision waits for the day after the offer', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  assert.equal(lowCreditWaitsForOffer('2026-11-14T07:05:00Z', now), true);
  assert.equal(lowCreditWaitsForOffer('2026-11-13T07:05:00Z', now), false);
  assert.equal(lowCreditWaitsForOffer(null, now), false);
});

test('the £5 decision is held while the offer can go first, never forever', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  const f = { due: true, emailedAt: null, homeAt: null, dailyEmails: true };
  assert.equal(lowCreditHeldForOffer(f, now), true, 'due, and a morning email will carry it');
  assert.equal(lowCreditHeldForOffer({ ...f, dailyEmails: false }, now), false, 'no morning email to carry it: the £5 notice goes as always');
  assert.equal(lowCreditHeldForOffer({ ...f, due: false, emailedAt: '2026-11-14T07:02:00Z' }, now), true, 'the offer went this morning');
  assert.equal(lowCreditHeldForOffer({ ...f, due: false, emailedAt: '2026-11-13T07:02:00Z' }, now), false, 'the day after: the £5 decision goes');
  assert.equal(lowCreditHeldForOffer({ ...f, due: false, homeAt: '2026-11-14T09:00:00Z', dailyEmails: false }, now), true, 'the Home card was first shown today');
  assert.equal(lowCreditHeldForOffer({ ...f, due: false, homeAt: '2026-11-12T09:00:00Z' }, now), false);
});

test('the Home card is never first shown on the day the £5 decision went', () => {
  const now = new Date('2026-11-14T18:00:00Z');
  assert.equal(earlyOfferHomeShown({ ...facts(), lowToldAt: '2026-11-14T07:00:00Z' }, now), false);
  assert.equal(earlyOfferHomeShown({ ...facts(), lowToldAt: '2026-11-13T07:00:00Z' }, now), true, 'a later day');
  assert.equal(earlyOfferHomeShown({ ...facts({ homeAt: '2026-11-14T06:00:00Z' }), lowToldAt: '2026-11-14T07:00:00Z' }, now), true, 'already shown first today: it stays for the day');
});

// ── The picks pause ──
test('picks pause after 7 days without a visit, counted from the pack when never seen since; any visit resumes', () => {
  const now = new Date('2026-11-14T06:00:00Z');
  const base = { packOnly: true, packAt: '2026-11-01T09:00:00Z', pauseDays: 7 };
  assert.equal(packPauseDue({ ...base, lastSeenAt: '2026-11-07T05:59:00Z' }, now), true);
  assert.equal(packPauseDue({ ...base, lastSeenAt: '2026-11-08T09:00:00Z' }, now), false, 'visited 6 days ago');
  assert.equal(packPauseDue({ ...base, lastSeenAt: null }, now), true, 'never visited since the pack 13 days ago');
  assert.equal(packPauseDue({ ...base, lastSeenAt: null, packAt: '2026-11-10T00:00:00Z' }, now), false);
  assert.equal(packPauseDue({ ...base, packOnly: false, lastSeenAt: null }, now), false, 'everyone else: Batch 20 rules');
});

test('the bonus line names the date in UK time', () => {
  assert.equal(PACK_COPY.bonusLine(2000, '2026-12-02T10:00:00Z'), '£20 of your balance is bonus credit for opening deals, saved reports and daily picks. It expires on 2 December.');
  assert.equal(PACK_COPY.bonusLine(1250, null), '£12.50 of your balance is bonus credit for opening deals, saved reports and daily picks.');
});
