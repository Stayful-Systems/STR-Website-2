/**
 * Batch 33: the rules about a website's domain, as pure functions. The
 * engine (purchase-server.ts) and the cron ask these; they never touch the
 * network or the database.
 *
 *   nextStep          what happens next for each status, and who does it
 *   isStuck           more than 24 hours in an unfinished state
 *   inRenewalWindow   30 days before expiry: it is on the admin's list
 *   autoRenewRule     7 days left and nobody decided: renew only if the site is
 *                     live, not switched off; the cap is checked at the claim
 *   chargeDecision    the yearly charge: OFF never, the first year never
 *   canChoose         the member may pick a name: no domain yet, or needs_choice
 *   nameLocked        the name can no longer change (registering or later)
 *   offerFresh        an offer is good for 24 hours
 *
 * Pure: no network, no database, no server-only.
 */
import { AUTO_RENEW_DAYS, OFFER_TTL_MS, RENEWAL_WINDOW_DAYS, STUCK_HOURS, type DomainStatus } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type NextStep =
  | 'choose' // the member picks a name
  | 'wait_admin' // auto-buy is off: the admin presses Buy
  | 'retry_next_day' // the daily cap stopped it: the cron retries the next UK day
  | 'resume' // a registrar call may be in flight: check ownership, then continue
  | 'connect' // DNS, Vercel and HTTPS under way: the cron advances it
  | 'none' // nothing to do
  | 'choose_again' // the name went before purchase: the member picks again
  | 'admin_retry' // three tries failed: the admin presses Retry
  | 'release'; // being released

const STEPS: Record<DomainStatus, NextStep> = {
  awaiting_admin: 'wait_admin',
  held_cap: 'retry_next_day',
  registering: 'resume',
  connecting: 'connect',
  live: 'none',
  needs_choice: 'choose_again',
  failed: 'admin_retry',
  releasing: 'release',
  released: 'none',
};

export function nextStep(status: DomainStatus): NextStep {
  return STEPS[status];
}

/** A status that never needs the admin alerted to it: finished, or in the member's hands. */
const NOT_STUCK: ReadonlySet<DomainStatus> = new Set<DomainStatus>(['live', 'released', 'needs_choice']);

export function isFinal(status: DomainStatus): boolean {
  return NOT_STUCK.has(status);
}

/** More than 24 hours in an unfinished state (a failed one counts: it waits on the admin). */
export function isStuck(status: DomainStatus, stateChangedAt: string | Date, now: Date = new Date()): boolean {
  if (NOT_STUCK.has(status)) return false;
  const since = new Date(stateChangedAt).getTime();
  if (!Number.isFinite(since)) return false;
  return now.getTime() - since > STUCK_HOURS * 60 * 60 * 1000;
}

/** The whole days from `now` to the expiry (negative once expired); null when unknown. */
export function daysToExpiry(expiresAt: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now.getTime()) / DAY_MS);
}

/** On the admin's renewal list: a live domain within 30 days of expiry. */
export function inRenewalWindow(status: DomainStatus, expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (status !== 'live') return false;
  const d = daysToExpiry(expiresAt, now);
  return d !== null && d <= RENEWAL_WINDOW_DAYS;
}

export interface AutoRenewFacts {
  status: DomainStatus;
  expiresAt: string | Date | null | undefined;
  renewDecision: 'renew' | 'dont_renew' | null;
  /** The website's own status is live (not paused, not in preview). */
  siteLive: boolean;
  /** domain.renew_allowed: Batch 36 clears it when the site is switched off or the plan lapsed. */
  renewAllowed: boolean;
}

export type AutoRenewVerdict = 'renew' | 'not_yet' | 'decided' | 'skip_not_live' | 'skip_site_off' | 'skip_not_allowed';

/**
 * If nobody decides by 7 days before expiry, renew automatically, but only
 * when the site is live and not switched off. (The daily cap is not here: it
 * is checked at the spend claim, and a renewal it stops is tried again the next
 * day while the window lasts.) Any admin decision wins over the rule.
 */
export function autoRenewRule(f: AutoRenewFacts, now: Date = new Date()): AutoRenewVerdict {
  if (f.status !== 'live') return 'skip_not_live';
  if (f.renewDecision) return 'decided';
  const d = daysToExpiry(f.expiresAt, now);
  if (d === null || d > AUTO_RENEW_DAYS) return 'not_yet';
  if (!f.siteLive) return 'skip_site_off';
  if (!f.renewAllowed) return 'skip_not_allowed';
  return 'renew';
}

export type ChargeVerdict = 'charge' | 'skip_off' | 'skip_year_one';

/**
 * The yearly charge. OFF means never; year 1 (the registration year) means
 * never, because the first year is free. `year` is the year being paid for:
 * registration is year 1, the first renewal is year 2.
 */
export function chargeDecision(input: { chargeOn: boolean; year: number }): ChargeVerdict {
  if (!input.chargeOn) return 'skip_off';
  if (!Number.isInteger(input.year) || input.year <= 1) return 'skip_year_one';
  return 'charge';
}

/** The member may pick a name: they have no domain row yet, or their name went before it was bought. */
export function canChoose(row: { status: DomainStatus } | null | undefined): boolean {
  return !row || row.status === 'needs_choice';
}

/** From registering on, the name can no longer change. */
export function nameLocked(status: DomainStatus): boolean {
  return status !== 'awaiting_admin' && status !== 'held_cap' && status !== 'needs_choice';
}

/** An offer older than 24 hours is never honoured. */
export function offerFresh(offeredAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!offeredAt) return false;
  const t = new Date(offeredAt).getTime();
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t < OFFER_TTL_MS;
}

/** Is this price one we will pay: a whole number of pence, above 0, not over the maximum. */
export function priceAllowed(pence: unknown, max: number): pence is number {
  return typeof pence === 'number' && Number.isInteger(pence) && pence > 0 && pence <= max;
}

/** One admin email per domain per period: the expiry date (YYYY-MM-DD) a renewal reminder is for. */
export function renewalPeriod(expiresAt: string | Date): string {
  return new Date(expiresAt).toISOString().slice(0, 10);
}
