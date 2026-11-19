/**
 * Batch 30: "today's average" mortgage rate, kept current on every profile.
 *
 * The live average (the higher of the 2-year and 3-year fixed averages,
 * mortgage-rate.ts) comes from PropertyData through the broker's daily cache.
 * Once a day, after market-warm has bought it, it is written into the
 * finance of every profile whose member has not typed their own rate
 * (finance.rateSet is not true): profiles.market_goals and every
 * search_profiles.criteria, by one SQL function (public.sync_live_mortgage_rate,
 * supabase/schema.sql "Batch 30"). Every page then reads the same figure with
 * no reader changes, so a card and the page behind it can never disagree.
 *
 * Skipped when the cache has no rate: yesterday's figure stays.
 *
 * Review R4 (R4-33): skipped, with a logged reason, until the Batch 30
 * backfill has stamped billing_settings.quiz_v2_backfill_done_at. The backfill
 * marks a rate a member chose as theirs only while no average has been
 * synced yet, so a sync that ran first would have overwritten it for good.
 * schema.sql seeds the stamp as done (live's backfill finished on
 * 14-15 Nov 2026, before the stamp existed).
 *
 * This file is the pure part (which rate, which day, what to say); the write
 * is live-rate-sync-server.ts.
 */
import { liveMortgageRate } from './mortgage-rate.ts';
import type { MortgageRates } from '../apis/propertydata-parse.ts';

export interface RateToSync {
  /** The average, to two decimals (5.29). */
  ratePct: number;
  /** The UK day it was synced (YYYY-MM-DD). */
  asOf: string;
}

/** The UK calendar day of an instant, YYYY-MM-DD. */
export function ukDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today's average and its day, or null when there is no usable rate (nothing is written then). */
export function rateToSync(rates: MortgageRates | null | undefined, now: Date): RateToSync | null {
  const live = liveMortgageRate(rates);
  if (!live || !Number.isFinite(live.ratePct) || live.ratePct <= 0 || live.ratePct > 25) return null;
  return { ratePct: Math.round(live.ratePct * 100) / 100, asOf: ukDay(now) };
}

/** The billing_settings row a finished quiz v2 backfill writes (when it ran, an ISO time) and the rate sync waits for. */
export const QUIZ_V2_BACKFILL_DONE_KEY = 'quiz_v2_backfill_done_at';

/** The stamp is there: any stored time (the backfill writes its own run time; schema.sql seeds one). */
export function backfillStamped(raw: unknown): boolean {
  return typeof raw === 'string' && Number.isFinite(Date.parse(raw));
}

/** Why the sync is skipped while the stamp is missing (the run's log line and the dry run say this). */
export const WAITING_FOR_BACKFILL = `skipped: waiting for the quiz v2 backfill (billing_settings.${QUIZ_V2_BACKFILL_DONE_KEY} is not set), so no member's chosen rate can be overwritten; run the backfill on /admin/profiles`;

/** Whether today's run writes the average: a rate to write, and the backfill's stamp. */
export function syncPlan(rate: RateToSync | null, stamp: unknown): { sync: boolean; line: string | null } {
  if (!rate) return { sync: false, line: syncSummary(null) };
  if (!backfillStamped(stamp)) return { sync: false, line: WAITING_FOR_BACKFILL };
  return { sync: true, line: null };
}

/** What a run says it did. */
export function syncSummary(r: RateToSync | null, result?: { profiles: number; search_profiles: number } | 'failed', dry = false): string {
  if (!r) return 'no rate in the cache: yesterday’s stays';
  if (dry) return `would sync ${r.ratePct}% (${r.asOf}) to every profile on today’s average`;
  if (result === 'failed' || !result) return `failed to sync ${r.ratePct}%`;
  return `synced ${r.ratePct}% (${r.asOf}): ${result.profiles} profiles, ${result.search_profiles} saved searches`;
}
