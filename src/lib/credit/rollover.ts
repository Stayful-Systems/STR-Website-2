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

/* ------------------------------------------------------------------------- *
 * Batch 34b (Phase 11): the no-spend reminders and the final warning, as pure
 * rules. The cron (idle-reminders-run.ts) reads credit_idle_notices for the
 * member's CURRENT idle run (same idle_since) and asks these; the SQL function
 * credit_expire_idle_plan stays the authority on expiry (expiryDue mirrors it
 * for dry runs and listings).
 * ------------------------------------------------------------------------- */

/** One credit_idle_notices row of this idle run. */
export interface IdleNoticeRow {
  stage: number;
  status: 'sent' | 'skipped';
}

/**
 * The reminder stages, in months, from plan_credit_idle_reminder_months (a
 * settings array such as [3, 6, 12]): whole, positive, unique, sorted, none
 * past the final stage, and always ending with the final stage itself
 * (plan_credit_idle_months, rounded as the SQL rounds it). Unreadable input
 * leaves only the final stage; an unreadable final stage gives [].
 */
export function idleStages(reminderMonths: unknown, idleMonths: unknown): number[] {
  const final = Math.round(Number(idleMonths));
  if (!Number.isFinite(final) || final <= 0) return [];
  const raw = Array.isArray(reminderMonths) ? reminderMonths : [];
  const set = new Set<number>([final]);
  for (const v of raw) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0 && n <= final) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Which stage is due for this idle run. A stage is due once
 * addMonthsClamped(idleSince, stage) <= now. `due` is the HIGHEST due stage
 * with no row yet; `skipped` are the lower due stages with no row, which the
 * caller records as 'skipped' (a missed reminder is never sent late, so a
 * member who missed 3 and 6 gets one email, the highest due). A stage with any
 * row, sent or skipped, is never due again. A spend starts a new run (a new
 * idleSince) and the caller passes only that run's rows, so it starts fresh.
 */
export function idleStageDue(input: { idleSince: Date | string; now: Date; stages: readonly number[]; existing: readonly IdleNoticeRow[] }): { due: number | null; skipped: number[] } {
  const since = input.idleSince instanceof Date ? input.idleSince : new Date(input.idleSince);
  if (!Number.isFinite(since.getTime())) return { due: null, skipped: [] };
  const handled = new Set(input.existing.map((r) => Number(r.stage)));
  const open = [...new Set(input.stages)]
    .filter((s) => Number.isFinite(s) && s > 0 && !handled.has(s) && addMonthsClamped(since, s).getTime() <= input.now.getTime())
    .sort((a, b) => a - b);
  if (open.length === 0) return { due: null, skipped: [] };
  return { due: open[open.length - 1], skipped: open.slice(0, -1) };
}

export type IdleReminderDecision =
  | { decision: 'send'; reason: 'ok' }
  | { decision: 'wait'; reason: 'cap_used' }
  | { decision: 'skip'; reason: 'no_credit' | 'nothing_expirable' | 'alerts_off' };

/**
 * Whether to send the due stage today:
 * - skip: no plan credit to lose (for the final stage, also nothing that
 *   would expire), or a non-final stage with the "credit alerts" switch off.
 *   The FINAL stage (plan_credit_idle_months) is a billing notice and ignores
 *   the switch entirely. The caller records a skip.
 * - wait: today's one-a-day cap is already used. Record nothing: the same
 *   stage is due again tomorrow (a cap-skipped reminder is never recorded as
 *   skipped).
 * - send: otherwise.
 */
export function reminderDecision(input: { stage: number; finalStage: number; alertsOn: boolean; capUsedToday: boolean; planCreditPence: number; expirablePence: number }): IdleReminderDecision {
  const final = input.stage >= input.finalStage;
  if (!(Number(input.planCreditPence) > 0)) return { decision: 'skip', reason: 'no_credit' };
  if (final && !(Number(input.expirablePence) > 0)) return { decision: 'skip', reason: 'nothing_expirable' };
  if (!final && !input.alertsOn) return { decision: 'skip', reason: 'alerts_off' };
  if (input.capUsedToday) return { decision: 'wait', reason: 'cap_used' };
  return { decision: 'send', reason: 'ok' };
}

/**
 * Whether earlier months' plan credit may now expire: the final warning was
 * actually SENT (never a skipped or missing one) at least finalNoticeDays ago.
 * Mirrors credit_expire_idle_plan (sent_at <= now - final notice days).
 */
export function expiryDue(input: { finalNoticeSentAt: Date | string | null | undefined; now: Date; finalNoticeDays: number }): boolean {
  if (input.finalNoticeSentAt == null) return false;
  const sent = input.finalNoticeSentAt instanceof Date ? input.finalNoticeSentAt.getTime() : Date.parse(input.finalNoticeSentAt);
  const days = Number(input.finalNoticeDays);
  if (!Number.isFinite(sent) || !Number.isFinite(days) || days < 0) return false;
  return sent <= input.now.getTime() - days * 86_400_000;
}
