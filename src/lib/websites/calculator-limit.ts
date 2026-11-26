/**
 * Batch 55 (Part A), phase A6: the calculator site's daily report limit.
 *
 * A calculator site (websites.mode = 'calculator') takes at most
 * `ad_calc_reports_per_day` new leads a day per owner, counted over the UK
 * calendar day (Europe/London). It is a bot guard, not billing: the lead
 * database bills these reports later (Phase 2), and this site's own credit is
 * never charged.
 *
 * PURE: no network, no database, no server-only, so it runs under node --test.
 * The count itself is one query in the step-1 lead route:
 *   leads of this owner's calculator funnel with created_at in [start, end).
 *
 * ACCEPTED: the count is read, then the lead inserted, with no lock between.
 * A burst can overshoot the limit by one or two. That is fine for a bot guard.
 */

const TZ = 'Europe/London';

/** Shown to the visitor when today's limit is reached. Neutral: no figure, no reason, no name. */
export const CALCULATOR_DAY_FULL_MESSAGE = 'We cannot take another request just now. Please try again tomorrow.';

function londonParts(d: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

/** The UTC instant at which the London calendar day (year, month, day) starts. */
function londonMidnightUtc(year: number, month: number, day: number): Date {
  const candidate = Date.UTC(year, month - 1, day, 0, 0);
  // London is on UTC+1 in summer: at 00:00 UTC it is already 01:00, so its midnight was an hour earlier.
  // (Clocks change at 01:00 UTC, never at midnight, so this one test is exact on every day of the year.)
  return new Date(londonParts(new Date(candidate)).hour === 1 ? candidate - 3_600_000 : candidate);
}

export interface UkDayWindow {
  /** The London calendar day, YYYY-MM-DD. */
  day: string;
  /** Inclusive start, ISO (UTC). */
  startIso: string;
  /** Exclusive end (the start of the next London day), ISO (UTC). */
  endIso: string;
}

/** The UK calendar day that contains `now`, as a half-open UTC window for a `created_at` filter. */
export function ukDayWindow(now: Date): UkDayWindow {
  const { year, month, day } = londonParts(now);
  const start = londonMidnightUtc(year, month, day);
  // The next day's date through UTC arithmetic (month and year roll over correctly), then its London midnight.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const end = londonMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { day: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, startIso: start.toISOString(), endIso: end.toISOString() };
}

export type CalculatorDayDecision = { allowed: true } | { allowed: false; reason: 'none_allowed' | 'day_full' };

/**
 * Whether one more new lead may be taken today. A limit of 0 (or less, or not a
 * number) means none are allowed; otherwise the lead is refused once `usedToday`
 * has reached the limit, so the 51st at a limit of 50 is refused.
 */
export function calculatorDayDecision(f: { limit: number; usedToday: number }): CalculatorDayDecision {
  const limit = Number.isFinite(f.limit) ? Math.floor(f.limit) : 0;
  if (limit <= 0) return { allowed: false, reason: 'none_allowed' };
  const used = Number.isFinite(f.usedToday) ? Math.max(0, Math.floor(f.usedToday)) : 0;
  return used >= limit ? { allowed: false, reason: 'day_full' } : { allowed: true };
}
