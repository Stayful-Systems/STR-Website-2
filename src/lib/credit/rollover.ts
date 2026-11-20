/**
 * Batch 34 (plan credit rollover): the pure rules behind "this month's plan
 * credit" and "what rolled over". No network, no database, no server-only, so
 * they run under node --test (rollover.test.ts); summary.ts and
 * usage-server.ts use them.
 *
 * The cycle is defined once, in src/lib/stripe/plan-credit.ts
 * (thisCycleGrants: the newest plan_cycle grant and every plan grant after it,
 * a won dispute's restore excluded). It is re-exported here as
 * currentCycleGrants so the upgrade top-up and the display can never disagree.
 */
import { addMonthsClamped } from '../stripe/annual.ts';
import { thisCycleGrants, type PlanGrantRow } from '../stripe/plan-credit.ts';

export type { PlanGrantRow } from '../stripe/plan-credit.ts';

/** One plan grant as the rollover sums read it (credit_grants, kind 'plan'). */
export interface RolloverGrantRow extends PlanGrantRow {
  remaining_pence: number | string;
  /** Null after Batch 34; a past date means the grant lapsed (pre-launch credit). */
  expires_at?: string | null;
}

/** This cycle's plan grants, oldest first (thisCycleGrants). Empty when no grant is a cycle grant. */
export const currentCycleGrants = thisCycleGrants;

/** The newest plan_cycle grant (the renewal that began this cycle), or null. */
export function newestCycleGrant<T extends PlanGrantRow>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!r.plan_cycle) continue;
    if (!best || Date.parse(r.created_at) > Date.parse(best.created_at)) best = r;
  }
  return best;
}

function liveRemaining(r: RolloverGrantRow, now: Date): number {
  if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) return 0;
  return Math.max(0, Number(r.remaining_pence) || 0);
}

/**
 * Plan credit that rolled over: what is left in plan grants created BEFORE the
 * newest plan_cycle grant (the same line credit_idle_plan_report's
 * expirable_pence draws). A won dispute's restore made after the renewal is
 * neither this cycle's nor rolled over. 0 with no cycle grant. Spend is oldest
 * first, so rolled-over credit is spent before this month's.
 */
export function rolledOverPence(rows: readonly RolloverGrantRow[], now: Date = new Date()): number {
  const newest = newestCycleGrant(rows);
  if (!newest) return 0;
  const start = Date.parse(newest.created_at);
  let sum = 0;
  for (const r of rows) if (Date.parse(r.created_at) < start) sum += liveRemaining(r, now);
  return Math.round(sum * 10_000) / 10_000;
}

/** What this cycle granted (the allowance): the sum of currentCycleGrants' amounts. */
export function cycleAllowancePence(rows: readonly PlanGrantRow[]): number {
  return currentCycleGrants(rows).reduce((n, r) => n + (Number(r.amount_pence) || 0), 0);
}

/**
 * When the next plan credit arrives: one calendar month after the cycle grant
 * (day clamped: 31 Jan -> 28/29 Feb), or the period end if that is sooner (a
 * monthly plan renews at its period end; an annual plan's period end is a
 * year away, so its next monthly slot wins). A period end on or before the
 * grant is stale and ignored. Null with no grant.
 */
export function nextPlanCreditAt(newestCycleGrant: { created_at: string } | null, currentPeriodEnd: string | null): string | null {
  const created = newestCycleGrant ? Date.parse(newestCycleGrant.created_at) : NaN;
  if (!Number.isFinite(created)) return null;
  const month = addMonthsClamped(new Date(created), 1).getTime();
  const end = currentPeriodEnd ? Date.parse(currentPeriodEnd) : NaN;
  const at = Number.isFinite(end) && end > created && end < month ? end : month;
  return new Date(at).toISOString();
}

/**
 * When the no-spend clock started: the later of the last spend and the
 * rollover launch (plan_credit_rollover_from). Null when neither is known.
 */
export function idleSince(lastSpentAt: string | Date | null | undefined, rolloverFrom: string | Date | null | undefined): Date | null {
  const t = (v: string | Date | null | undefined) => (v == null ? NaN : v instanceof Date ? v.getTime() : Date.parse(v));
  const a = t(lastSpentAt);
  const b = t(rolloverFrom);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  if (!Number.isFinite(a)) return new Date(b);
  if (!Number.isFinite(b)) return new Date(a);
  return new Date(Math.max(a, b));
}

/**
 * The plan side of the credit summary (summary.ts), from the member's plan
 * grants:
 * - allowancePence: this cycle's grants only (banked credit is not "this
 *   month's"); the plan's monthly credit when no cycle grant can be read;
 * - rolledOverPence: rolledOverPence();
 * - endsAt: nextPlanCreditAt(), so the 80% rule and the once-a-cycle emails
 *   (after-debit.ts) keep a monthly meaning for annual members too;
 *   `fallbackEndsAt` when there is no cycle grant.
 * The low-balance rule (lowBalanceState, used = allowance − plan credit) then
 * reads "plan credit below 20% of one month's": rolled-over credit counts in
 * the plan balance, so a member with a month banked is not "low".
 */
export function planCycleView(
  rows: readonly RolloverGrantRow[] | null,
  opts: { planMonthlyCreditPence: number; currentPeriodEnd: string | null; fallbackEndsAt: string | null; now?: Date },
): { allowancePence: number; rolledOverPence: number; endsAt: string | null } {
  const list = rows ?? [];
  const granted = cycleAllowancePence(list);
  const newest = newestCycleGrant(list);
  return {
    allowancePence: granted > 0 ? granted : opts.planMonthlyCreditPence,
    rolledOverPence: rolledOverPence(list, opts.now ?? new Date()),
    endsAt: nextPlanCreditAt(newest, opts.currentPeriodEnd) ?? opts.fallbackEndsAt,
  };
}
