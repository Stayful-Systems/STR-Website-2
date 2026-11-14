/**
 * Batch 29: the starter pack's guardrails, in one place. Batch 25 (slower-
 * spender nudges), Batch 27 (Stayful Intelligence runs analyses) and anything
 * after rely on these rules: change them here, and in the SQL named below.
 *
 * THE PRINCIPLE (decided by Zac): the £20 bonus is credit that only buys things
 * that cost us almost nothing; the £10 the member paid is theirs and buys
 * anything.
 *
 * THE ALLOCATION RULE (enforced in the database, so every path obeys it:
 * supabase/schema.sql credit_bonus_pays_for, used by credit_reserve,
 * credit_debit, credit_debit_face and credit_spendable_for)
 *   - The pack's bonus is a welcome-kind grant marked credit_grants.scope =
 *     'pack_bonus' (credit_grant_pack_bonus). While scope_lifted_at is null it
 *     is RESTRICTED.
 *   - A restricted grant pays only for BONUS_ACTIONS below: opening a deal, a
 *     daily pick (and the per-day Today's 5 charge), and a saved (reused) full
 *     analysis. For those it is spent first. Every other action, including
 *     every action added later, is paid from the member's other credit; if
 *     there is none, the normal 402 (src/lib/credit/http.ts, reason
 *     'bonus_only') shows the top-up / plan offer.
 *   - It expires pack_bonus_expiry_days after it is granted (grants.expires_at,
 *     swept by credit_expire_due). The £10 paid never expires.
 *   - A further payment (a top-up, an automatic top-up or a plan invoice:
 *     member_payments kinds topup / auto_topup / subscription) lifts the
 *     restriction AND the expiry at once (trigger member_payments_pack_unlock).
 *   - Refunds go back to the grant they came from (credit_allocations), an
 *     expired bonus included.
 *
 * PACK-ONLY (isPackOnly): bought the starter pack, has paid for nothing else
 * ever (member_paid_again_at is null), and has no live, trialling, past-due or
 * paused plan. Team seats follow the account that pays. Read with
 * packStateFor (./pack-server.ts), once per request.
 *
 * THE FRESH-REPORT CAP: a pack-only member may run pack_fresh_report_cap fresh
 * full analyses (welcome-price reveal reports included); saved analyses never
 * count. Claim a slot with claimFreshReport before anything is charged and
 * release it if the run ends with nothing charged or turns out to be a saved
 * one (./pack-server.ts; public.pack_fresh_report_claim is race-free). The
 * doors: startDealAnalysis (deal sheet, reveal, /intelligence, Batch 27) and
 * reserveAnalysis (the analyser, the API, MCP).
 *
 * THE SECOND OPINION (section G, decided): a pack-only member cannot buy PMI /
 * a Deep report at all (it needs credit beyond the pack): the button says
 * DEEP_TOP_UP and the server refuses with 'pack_topup_needed'. Batch 22's Deep
 * welcome price applies only once they have paid again.
 *
 * Pure: no network, no database, no server-only.
 */

export const PACK_BONUS_SCOPE = 'pack_bonus';

/** The reservation action a saved (reused) Full analysis is held under, so the bonus may pay for it. */
export const SAVED_ANALYSIS_ACTION = 'full_analysis_saved';

/** What a restricted bonus pays for. Mirrors public.credit_bonus_pays_for (a test checks the two lists match). */
export const BONUS_ACTIONS = ['deal_open', 'cron:sourcing', 'todays_5', SAVED_ANALYSIS_ACTION] as const;

/** Whether a restricted bonus may pay for this action (a Full analysis only when it is a saved one). */
export function bonusPaysFor(action: string | null | undefined, meta?: { reused?: unknown } | null): boolean {
  const a = action ?? '';
  if ((BONUS_ACTIONS as readonly string[]).includes(a)) return true;
  return a === 'full_analysis' && meta?.reused === true;
}

/**
 * The ledger steps of a Full analysis purchase, in the order they are charged:
 * the open (a deal open), the analysis (the bonus may pay only for a saved
 * one, and only without PMI: a purchase with PMI is held as a fresh one), then
 * PMI. For the price on the button (allocateSteps).
 */
export function analysisSteps(due: { openBasePence: number; analysisBasePence: number; pmiBasePence: number }, saved: boolean): { basePence: number; bonusOk: boolean }[] {
  return [
    { basePence: due.openBasePence, bonusOk: bonusPaysFor('deal_open') },
    { basePence: due.analysisBasePence, bonusOk: saved && !(due.pmiBasePence > 0) ? bonusPaysFor(SAVED_ANALYSIS_ACTION) : false },
    { basePence: due.pmiBasePence, bonusOk: bonusPaysFor('pmi_addon') },
  ].filter((s) => s.basePence > 0);
}

/** The reservation action a Full analysis purchase is held under: saved (the bonus may pay) or fresh. */
export function analysisHoldAction(saved: boolean, withPmi: boolean): string {
  return saved && !withPmi ? SAVED_ANALYSIS_ACTION : 'full_analysis';
}

/** A grant the restriction applies to. */
export function isRestrictedGrant(g: { scope?: string | null; scopeLiftedAt?: string | null }): boolean {
  return g.scope === PACK_BONUS_SCOPE && !g.scopeLiftedAt;
}

export type PlanStatus = 'paid' | 'subscription_trial' | 'free' | 'lapsed' | 'paused';

/** Pack-only: bought the pack, paid for nothing else ever, and no live, trialling, past-due or paused plan. */
export function isPackOnly(f: { bought: boolean; paidAgainAt: string | null; planStatus: PlanStatus }): boolean {
  if (!f.bought || f.paidAgainAt) return false;
  return f.planStatus !== 'paid' && f.planStatus !== 'subscription_trial' && f.planStatus !== 'paused';
}

export interface PackState {
  bought: boolean;
  packAt: string | null;
  paidAgainAt: string | null;
  packOnly: boolean;
  /** The restricted bonus left (0 once lifted or expired), and when it expires. */
  bonusPence: number;
  bonusExpiresAt: string | null;
  /** Fresh full analyses run since the pack, and the cap. */
  freshUsed: number;
  freshCap: number;
}

export const NOT_PACK: PackState = { bought: false, packAt: null, paidAgainAt: null, packOnly: false, bonusPence: 0, bonusExpiresAt: null, freshUsed: 0, freshCap: 0 };

/** Fresh analyses a pack-only member has left; null when no cap applies to them. */
export function freshLeft(s: Pick<PackState, 'packOnly' | 'freshUsed' | 'freshCap'>): number | null {
  if (!s.packOnly) return null;
  return Math.max(0, s.freshCap - s.freshUsed);
}

/** The cap stops a fresh analysis now. */
export function capReached(s: Pick<PackState, 'packOnly' | 'freshUsed' | 'freshCap'>): boolean {
  const left = freshLeft(s);
  return left !== null && left <= 0;
}

/** A pack-only member cannot buy the PMI second opinion (it needs credit beyond the pack). */
export function deepNeedsTopUp(s: Pick<PackState, 'packOnly'>): boolean {
  return s.packOnly;
}

// ── The £15 early offer (section C) ──

/** Same UK calendar day. */
export function sameUkDay(a: Date, b: Date): boolean {
  const f = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return f(a) === f(b);
}

export interface EarlyOfferFacts {
  packOnly: boolean;
  /** Total displayed balance, grant pence (every bucket). */
  totalPence: number;
  offerPence: number;
  homeAt: string | null;
  emailedAt: string | null;
  dismissedAt: string | null;
}

function at(iso: string | null): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The balance has fallen to the offer line while pack-only. */
export function earlyOfferEligible(f: Pick<EarlyOfferFacts, 'packOnly' | 'totalPence' | 'offerPence'>): boolean {
  return f.packOnly && f.offerPence > 0 && f.totalPence <= f.offerPence;
}

/**
 * The Home card: shown on the UK day it is first seen (and on later visits that
 * day), never again after that, nor once dismissed.
 */
export function earlyOfferHomeShown(f: EarlyOfferFacts & { lowToldAt?: string | null }, now: Date): boolean {
  if (f.dismissedAt) return false;
  const seen = at(f.homeAt);
  if (seen) return sameUkDay(seen, now) && f.packOnly;
  // Never first shown on the UK day the £5 decision went (by email, call or nudge).
  const told = at(f.lowToldAt ?? null);
  if (told && sameUkDay(told, now)) return false;
  return earlyOfferEligible(f);
}

/** The daily email's section: once ever, riding an email that was going anyway. */
export function earlyOfferEmailDue(f: EarlyOfferFacts): boolean {
  return !f.emailedAt && earlyOfferEligible(f);
}

/**
 * Never both on one day: on the UK day the offer's section went in an email,
 * Batch 20's £5 decision (and Batch 25's nudge, which stands in for it) waits
 * until the next day. The early offer goes first.
 */
export function lowCreditWaitsForOffer(emailedAt: string | null, now: Date): boolean {
  const sent = at(emailedAt);
  return sent !== null && sameUkDay(sent, now);
}

/**
 * Who Batch 20's £5 decision (and Batch 25's nudge) waits for today:
 *   - the offer went in an email today, or its Home card was first shown today;
 *   - or its email section is due and a morning email can carry it (daily
 *     emails on, picks not paused). A member with no morning email is never
 *     held: their £5 notice goes as it always has, and the offer stays on Home.
 * So the offer goes first and never shares a day with the £5 decision.
 */
export function lowCreditHeldForOffer(f: { due: boolean; emailedAt: string | null; homeAt: string | null; dailyEmails: boolean }, now: Date): boolean {
  if (lowCreditWaitsForOffer(f.emailedAt, now)) return true;
  const home = at(f.homeAt);
  if (home && sameUkDay(home, now)) return true;
  return f.due && f.dailyEmails;
}

// ── The picks pause (section D) ──

/**
 * A pack-only member's daily picks pause when they have not been in the app for
 * pauseDays (profiles.last_seen_at, stamped on a visit at most hourly; counted
 * from the pack when they have not visited since). Any visit resumes them.
 */
export function packPauseDue(f: { packOnly: boolean; lastSeenAt: string | null; packAt: string | null; pauseDays: number }, now: Date): boolean {
  if (!f.packOnly || !(f.pauseDays > 0)) return false;
  const seen = at(f.lastSeenAt)?.getTime() ?? 0;
  const pack = at(f.packAt)?.getTime() ?? 0;
  const from = Math.max(seen, pack);
  if (!from) return false;
  return now.getTime() - from >= f.pauseDays * 86_400_000;
}

// ── What members are told (first person, as Stayful Intelligence) ──

function money(pence: number): string {
  const p = Math.max(0, Math.round(pence));
  return p % 100 === 0 ? `£${p / 100}` : `£${(p / 100).toFixed(2)}`;
}

/** "2 December" in UK time. */
export function ukDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long' }).format(new Date(t));
}

/** A pack-only member's own values for Stayful Intelligence's knowledge answers (null for everyone else). */
export function packMemberValues(s: PackState): { packOnly: true; bonusPence: number; bonusExpires: string | null; freshLeft: number | null } | null {
  if (!s.packOnly) return null;
  return { packOnly: true, bonusPence: s.bonusPence, bonusExpires: s.bonusExpiresAt ? ukDate(s.bonusExpiresAt) || null : null, freshLeft: freshLeft(s) };
}

export const PACK_COPY = {
  /** Account billing, Usage, the low-credit email. */
  bonusLine(bonusPence: number, expiresAt: string | null): string {
    const when = expiresAt ? ` It expires on ${ukDate(expiresAt)}.` : '';
    return `${money(bonusPence)} of your balance is bonus credit for opening deals, saved reports and daily picks.${when}`;
  },
  /** The 402 offer when only the bonus would have covered it. */
  bonusOnly: 'Your bonus credit covers opening deals, saved reports and daily picks. A fresh report needs credit you’ve paid for — top up or start Starter and I’ll run it.',
  /** The 4th fresh report. */
  capReached(cap: number): string {
    return `You’ve used your ${cap} fresh reports. Top up or start Starter to keep going. Reports already run on a deal still open with your bonus credit.`;
  },
  deepTopUp: 'Top up to add the second opinion',
  deepTopUpWhy: 'The second opinion needs credit beyond the starter pack.',
  earlyOfferTitle: 'Keep your bonus',
  earlyOffer(totalPence: number, bonusPence: number): string {
    const bonus = bonusPence > 0 ? `your ${money(bonusPence)} bonus` : 'your bonus';
    return `You’re down to ${money(totalPence)}. Start Starter or top up now and ${bonus} stops expiring and works on everything — fresh reports and second opinions included.`;
  },
  picksBack: 'I paused your daily picks while you were away so your credit wasn’t used. They’re back on.',
  reportReady: 'Report ready, opens instantly',
} as const;
