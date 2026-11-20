/**
 * Batch 32 (plan credit rollover), Phase 7: the success measure on
 * /admin/weekly-active, and the credit sweep's idle-plan report. Pure: no
 * network, no database, no server-only (rollover-measure.test.ts);
 * rollover-measure-server.ts does the reading.
 *
 * The aim of rollover is fewer plan cancellations, so the measure is:
 *
 *   1 Cancellation rate: the monthly plan churn rate of churn.ts
 *     (monthlyTrend: cancellations in the month over plan members at its
 *     start, from subscription_events), averaged over the months before the
 *     launch (billing_settings plan_credit_rollover_from) and the months after.
 *     The launch month has days on both sides, so it is in neither.
 *   2 "Too early" while there are fewer than 50 plan members (live cycles), as
 *     pack-paying.ts does for its buyers.
 *   3 Guardrail: weekly active % of plan members (metrics.ts's weekly-active
 *     rule, unchanged: these are its member rows) in the weeks before vs after.
 *     A member-week counts when a plan cycle covers the week's end (or now, for
 *     the week in progress), the moment metrics.ts judges billing at. The week
 *     the launch falls in is in neither.
 *   4 Credit: all unexpired plan credit held (banked) and the part of it that
 *     rolled over (rollover.ts rolledOverPence: grants older than the member's
 *     newest plan_cycle grant, the line credit_idle_plan_report draws).
 *
 * Nothing here names a member: the output is counts and pence only.
 */
import { cyclesFromEvents, monthlyTrend, type Cycle, type SubEvent, type TrendPoint } from '../billing/churn.ts';
import { rolledOverPence, type RolloverGrantRow } from '../credit/rollover.ts';
import { ukWeekRange } from '../activity/week.ts';

/** Below this many plan members the figures are labelled "too early" (pack-paying.ts SMALL_NUMBERS). */
export const SMALL_NUMBERS = 50;
/** How many months before the launch the "before" rate looks back. */
export const BEFORE_MONTHS = 12;

// ── Inputs ──

/** One member's weeks, from metrics.ts's member rows (only who it counts; no email needed). */
export interface MeasureMember {
  id: string;
  weeks: readonly { week: string; active: boolean }[];
}

/** A plan grant (credit_grants, kind 'plan') with its owner. */
export interface MeasureGrantRow extends RolloverGrantRow {
  user_id: string;
}

export interface RolloverMeasureInput {
  /** plan_credit_rollover_from; null before schema.sql's Batch 32 section is run. */
  launchAt: string | null;
  now: Date;
  events: readonly SubEvent[];
  /** null when the weekly-active facts could not be read. */
  members: readonly MeasureMember[] | null;
  /** null when the plan grants could not be read. */
  grants: readonly MeasureGrantRow[] | null;
}

// ── Outputs ──

export interface PeriodRate {
  /** Months with a rate (some plan member at the month's start). */
  months: number;
  /** Cancellations (plan cycles that ended) in those months. */
  cancelled: number;
  /** Average plan members at the start of those months. */
  averageMembers: number | null;
  /** The average monthly cancellation rate, one decimal; null with no month. */
  ratePct: number | null;
}

export interface ActiveShare {
  /** Plan member-weeks. */
  base: number;
  /** Of those, weekly active. */
  active: number;
  /** Whole percent; null when base is 0. */
  pct: number | null;
}

export interface RolloverMeasure {
  launchAt: string | null;
  /** The month left out of both rates ('YYYY-MM'). */
  launchMonth: string | null;
  planMembers: number;
  tooEarly: boolean;
  cancellation: { before: PeriodRate; after: PeriodRate };
  guardrail: { before: ActiveShare; after: ActiveShare } | null;
  credit: { holders: number; bankedPence: number; rolledOverPence: number } | null;
}

// ── Rules ──

function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Plan members at a month's start, as churn.ts monthlyTrend counts them (activeAtStart). */
function membersAtStart(cycles: readonly Cycle[], month: string): number {
  const start = Date.parse(`${month}-01T00:00:00Z`);
  return cycles.filter((c) => Date.parse(c.startedAt) < start && (c.endedAt === null || Date.parse(c.endedAt) >= start)).length;
}

/** The average of churn.ts's monthly rates over these trend points, with the counts beside it. */
export function periodRate(points: readonly TrendPoint[], cycles: readonly Cycle[] = []): PeriodRate {
  const rated = points.filter((p) => p.churnRatePct !== null);
  if (rated.length === 0) return { months: 0, cancelled: 0, averageMembers: null, ratePct: null };
  return {
    months: rated.length,
    cancelled: rated.reduce((n, p) => n + p.churned, 0),
    averageMembers: round1(rated.reduce((n, p) => n + membersAtStart(cycles, p.month), 0) / rated.length),
    ratePct: round1(rated.reduce((n, p) => n + (p.churnRatePct as number), 0) / rated.length),
  };
}

/**
 * Monthly plan cancellation rate before vs after the launch, from churn.ts's
 * cycles and monthly trend. Before: up to BEFORE_MONTHS whole months ending by
 * the launch month. After: whole or in-progress months starting after it.
 */
export function cancellationBeforeAfter(cycles: Cycle[], launchAt: string | null, now: Date): { before: PeriodRate; after: PeriodRate; launchMonth: string | null } {
  const empty = periodRate([]);
  const launch = launchAt ? new Date(launchAt) : null;
  if (!launch || !Number.isFinite(launch.getTime())) {
    // Not launched: everything so far is "before".
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - BEFORE_MONTHS, 1));
    return { before: periodRate(monthlyTrend(cycles, from, now), cycles), after: empty, launchMonth: null };
  }
  const launchMonth = monthKeyOf(launch);
  const from = new Date(Date.UTC(launch.getUTCFullYear(), launch.getUTCMonth() - BEFORE_MONTHS, 1));
  const trend = monthlyTrend(cycles, from, now.getTime() > launch.getTime() ? now : launch);
  return {
    before: periodRate(trend.filter((p) => p.month < launchMonth), cycles),
    after: periodRate(trend.filter((p) => p.month > launchMonth), cycles),
    launchMonth,
  };
}

/** A plan cycle covers this instant. */
function onPlanAt(cycles: readonly Cycle[], at: number): boolean {
  return cycles.some((c) => Date.parse(c.startedAt) <= at && (c.endedAt === null || Date.parse(c.endedAt) > at));
}

function share(base: number, active: number): ActiveShare {
  return { base, active, pct: base > 0 ? Math.round((active / base) * 100) : null };
}

/**
 * Weekly active % of plan members before vs after the launch. `members` are
 * metrics.ts's rows (its exclusions and weekly-active rule already applied).
 */
export function guardrailBeforeAfter(members: readonly MeasureMember[], cycles: readonly Cycle[], launchAt: string | null, now: Date): { before: ActiveShare; after: ActiveShare } {
  const launch = launchAt ? Date.parse(launchAt) : NaN;
  const byUser = new Map<string, Cycle[]>();
  for (const c of cycles) {
    const list = byUser.get(c.userId);
    if (list) list.push(c);
    else byUser.set(c.userId, [c]);
  }
  const before = { base: 0, active: 0 };
  const after = { base: 0, active: 0 };
  for (const m of members) {
    const mine = byUser.get(m.id);
    if (!mine) continue;
    for (const w of m.weeks) {
      const { start, end } = ukWeekRange(w.week);
      if (start.getTime() > now.getTime()) continue;
      const at = Math.min(end.getTime() - 1, now.getTime());
      if (!onPlanAt(mine, at)) continue;
      const side = !Number.isFinite(launch) || end.getTime() <= launch ? before : start.getTime() >= launch ? after : null;
      if (!side) continue;
      side.base += 1;
      if (w.active) side.active += 1;
    }
  }
  return { before: share(before.base, before.active), after: share(after.base, after.active) };
}

/** Unexpired plan credit across holders, and the part that rolled over (rolledOverPence, per member). */
export function bankedCredit(grants: readonly MeasureGrantRow[], now: Date): { holders: number; bankedPence: number; rolledOverPence: number } {
  const byUser = new Map<string, MeasureGrantRow[]>();
  for (const g of grants) {
    const list = byUser.get(g.user_id);
    if (list) list.push(g);
    else byUser.set(g.user_id, [g]);
  }
  let holders = 0;
  let banked = 0;
  let rolled = 0;
  for (const rows of byUser.values()) {
    let mine = 0;
    for (const r of rows) {
      if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) continue;
      mine += Math.max(0, Number(r.remaining_pence) || 0);
    }
    if (mine > 0) holders += 1;
    banked += mine;
    rolled += rolledOverPence(rows, now);
  }
  return { holders, bankedPence: round4(banked), rolledOverPence: round4(rolled) };
}

/** Everything the section shows. */
export function rolloverMeasure(input: RolloverMeasureInput): RolloverMeasure {
  const cycles = cyclesFromEvents([...input.events], input.now);
  const planMembers = cycles.filter((c) => c.endedAt === null).length;
  const { before, after, launchMonth } = cancellationBeforeAfter(cycles, input.launchAt, input.now);
  return {
    launchAt: input.launchAt,
    launchMonth,
    planMembers,
    tooEarly: planMembers < SMALL_NUMBERS,
    cancellation: { before, after },
    guardrail: input.members ? guardrailBeforeAfter(input.members, cycles, input.launchAt, input.now) : null,
    credit: input.grants ? bankedCredit(input.grants, input.now) : null,
  };
}

// ── The credit sweep's idle-plan report ──

/** One row of credit_idle_plan_report as ledger.ts idlePlanReport returns it. */
export interface IdlePlanRowLike {
  userId: string;
  lastSpentAt: string | null;
  idleSince: string;
  planRemainingPence: number;
  expirablePence: number;
}

/** What the sweep returns per member: user id, dates and pence only. */
export type IdlePlanCandidate = IdlePlanRowLike;

export interface IdlePlanSweepReport {
  /** null when the report could not be read (schema.sql not run yet, say). */
  idlePlanCandidates: IdlePlanCandidate[] | null;
  idlePlanExpirablePence: number;
  idlePlanError?: string;
}

/**
 * The credit sweep's idlePlanCandidates (dry and live): reads the report and
 * keeps only ids, dates and pence. Report-only in 32a: it never expires
 * anything, and a failed read is reported, never thrown.
 */
export async function idlePlanSweepReport(load: () => Promise<readonly IdlePlanRowLike[]>): Promise<IdlePlanSweepReport> {
  try {
    const rows = await load();
    const idlePlanCandidates = rows.map((r) => ({
      userId: r.userId,
      lastSpentAt: r.lastSpentAt,
      idleSince: r.idleSince,
      planRemainingPence: r.planRemainingPence,
      expirablePence: r.expirablePence,
    }));
    return { idlePlanCandidates, idlePlanExpirablePence: round4(idlePlanCandidates.reduce((n, r) => n + (Number(r.expirablePence) || 0), 0)) };
  } catch (err) {
    return { idlePlanCandidates: null, idlePlanExpirablePence: 0, idlePlanError: `idle plan report unreadable (schema.sql Batch 32 section not run?): ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One log line for the sweep (counts and pence; the ids are in the response). */
export function idlePlanLogLine(r: IdlePlanSweepReport, dry: boolean): string {
  const tag = dry ? '[credit-sweep dry]' : '[credit-sweep]';
  if (r.idlePlanCandidates === null) return `${tag} idle plan candidates: unavailable (${r.idlePlanError ?? 'unknown'})`;
  return `${tag} idle plan candidates: ${r.idlePlanCandidates.length} member(s), ${r.idlePlanExpirablePence}p expirable; report only, nothing expires (Batch 32a)`;
}
