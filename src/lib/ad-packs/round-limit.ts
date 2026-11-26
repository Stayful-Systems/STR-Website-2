/**
 * Batch 55 (Part A), phase A8: the lead database route's creative cap and monthly backstop, as pure decisions.
 *
 *   one round     An operator on the lead database route may make ONE preview (an 'operator' run that ended 'preview')
 *                 per rolling ad_pack_ld_round_days. A second one inside the window is refused (`round_limit`) unless the
 *                 owner holds an UNUSED round grant (an admin's reason-stamped "one more round"); the grant is marked
 *                 used only when that run succeeds. A run that ended failed or checks_failed never counts, an admin run
 *                 never counts, and a hand edit (a voice change, a retry, any change that makes no new version) is not a
 *                 run at all.
 *   backstop      The lead database route's own monthly house-spend cap (ad_pack_ld_monthly_cap_pence): this UK month's
 *                 lead database runs, plus the estimate of the one asked for, may not pass it (`backstop`). The Academy
 *                 monthly cap sums only academy runs (sumRunSpend with route 'academy').
 *
 * Pure: no network, no database, no server-only. The reads and writes are in store-server.ts / test-store.ts.
 */
import type { AdRoute } from './eligibility.ts';
import { DEFAULT_AD_PACK_SETTINGS, fitsCap } from './settings.ts';
import type { RunBy } from './store-types.ts';

const DAY_MS = 86_400_000;

/** What the round rule reads of one run row. */
export type RoundRun = { by: RunBy; dry?: boolean; createdAt: string; result: { outcome?: string } | null };

/** One admin grant of an extra round (ad_pack_round_grants). */
export type RoundGrant = { id: string; createdAt: string; usedAt: string | null };

/** A run that uses up the owner's round: made by the operator, not a dry run, and it ended with ads to look at. */
export function countsAsRound(run: RoundRun): boolean {
  return run.by === 'operator' && run.dry !== true && run.result?.outcome === 'preview';
}

export type RoundDecision =
  | { allowed: true; /** The unused grant this run would use up, or null when it is the round the window allows. */ grantId: string | null }
  | { allowed: false; code: 'round_limit'; /** When the window clears (ISO), for an admin to read; never shown as a code. */ nextRoundAt: string };

/** ISO instant the window opens: runs made after it are inside. */
export function roundWindowStart(now: Date, roundDays: number): Date {
  const days = Number.isFinite(roundDays) && roundDays >= 1 ? roundDays : DEFAULT_AD_PACK_SETTINGS.ldRoundDays;
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * May the owner make another round now? Pure over their runs, their grants, the setting and the clock.
 *
 *   - No counted run inside the window: allowed, no grant used (an unused grant stays for later).
 *   - One or more inside the window and an unused grant: allowed, using the OLDEST unused grant.
 *   - Otherwise refused, with the instant the newest counted run leaves the window.
 *
 * A counted run whose time cannot be read is treated as inside the window (fail closed).
 */
export function decideLeadDbRound(i: { runs: readonly RoundRun[]; grants: readonly RoundGrant[]; roundDays: number; now: Date }): RoundDecision {
  const start = roundWindowStart(i.now, i.roundDays).getTime();
  const days = Number.isFinite(i.roundDays) && i.roundDays >= 1 ? i.roundDays : DEFAULT_AD_PACK_SETTINGS.ldRoundDays;
  const inside = i.runs.filter((r) => {
    if (!countsAsRound(r)) return false;
    const t = Date.parse(r.createdAt);
    return Number.isNaN(t) || t > start;
  });
  if (inside.length === 0) return { allowed: true, grantId: null };

  const unused = i.grants.filter((g) => g.usedAt === null).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  if (unused.length > 0) return { allowed: true, grantId: unused[0].id };

  const times = inside.map((r) => Date.parse(r.createdAt)).filter((t) => !Number.isNaN(t));
  const newest = times.length > 0 ? Math.max(...times) : i.now.getTime();
  return { allowed: false, code: 'round_limit', nextRoundAt: new Date(newest + days * DAY_MS).toISOString() };
}

/** The lead database route's backstop: true when this run would take this month's route spend over the cap (a cap of 0 stops everything). */
export function overBackstop(spentPence: number, estimatePence: number, capPence: number): boolean {
  return !fitsCap(spentPence, estimatePence, capPence);
}

/** A run row as the monthly sum reads it (the route is its pack's). */
export type SpendRun = { route: AdRoute; dry: boolean; costPence: number; createdAt: string };

/**
 * Raw cost of every non-dry run since the instant, for one route (or every route when none is given). The Academy cap
 * asks for 'academy' only, so lead database runs never use up its £50; with no lead database run the sum is what it
 * always was.
 */
export function sumRunSpend(runs: readonly SpendRun[], route: AdRoute | undefined, sinceIso: string): number {
  return runs.filter((r) => !r.dry && r.createdAt >= sinceIso && (route === undefined || r.route === route)).reduce((n, r) => n + r.costPence, 0);
}

/** The most an admin's reason for a grant may be (plain text). */
export const GRANT_REASON_MAX = 500;

/** The reason for a grant, trimmed; null when it is missing, not text, blank, or too long. Server-side: never trust the screen. */
export function cleanGrantReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 && t.length <= GRANT_REASON_MAX ? t : null;
}
