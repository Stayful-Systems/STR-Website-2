/**
 * Batch 34 (plan credit rollover), Phase 7: the success measure on
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
 * Nothing in the measure names a member: its output is counts and pence only.
 *
 * Batch 34b (Phase 13) adds, below, the no-spend expiry's pure side: which
 * idle members are warned (final notice sent, still inside
 * plan_credit_final_notice_days) or due (the notice is that old), the exact
 * pence credit_expire_idle_plan would expire for each, the credit sweep's
 * idleExpirySweep (live: the SQL decides and this passes its answer through;
 * dry: the same members and pence, computed from reads), and the admin lists.
 */
import { cyclesFromEvents, monthlyTrend, type Cycle, type SubEvent, type TrendPoint } from '../billing/churn.ts';
import { expiryDue, firstExpirySweepAfter, rolledOverPence, type RolloverGrantRow } from '../credit/rollover.ts';
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
  /** plan_credit_rollover_from; null before schema.sql's Batch 34 section is run. */
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
 * keeps only ids, dates and pence. Report-only in 34a: it never expires
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
    return { idlePlanCandidates: null, idlePlanExpirablePence: 0, idlePlanError: `idle plan report unreadable (schema.sql Batch 34 section not run?): ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One log line for the sweep (counts and pence; the ids are in the response). */
export function idlePlanLogLine(r: IdlePlanSweepReport, dry: boolean): string {
  const tag = dry ? '[credit-sweep dry]' : '[credit-sweep]';
  if (r.idlePlanCandidates === null) return `${tag} idle plan candidates: unavailable (${r.idlePlanError ?? 'unknown'})`;
  return `${tag} idle plan candidates: ${r.idlePlanCandidates.length} member(s), ${r.idlePlanExpirablePence}p expirable before the final-notice check (credit_expire_idle_plan decides what expires)`;
}

// ── Batch 34b (Phase 13): the no-spend expiry ──

/** A credit_idle_notices row (any stage, any run). */
export interface IdleNoticeRecord {
  userId: string;
  idleSince: string;
  stage: number;
  status: 'sent' | 'skipped';
  sentAt: string | null;
}

/** plan_credit_idle_months (the final stage) and plan_credit_final_notice_days, rounded and at least 1 as the SQL reads them. */
export interface IdleExpirySettings {
  idleMonths: number;
  finalNoticeDays: number;
}

/**
 * Where an idle member stands, in the order credit_expire_idle_plan checks:
 *   no_final_notice    this idle run has no final-stage row with status 'sent'
 *                      (none, or a 'skipped' one: a skipped row never counts)
 *   notice_too_recent  sent, but less than plan_credit_final_notice_days ago ("warned")
 *   no_cycle_grant     no plan_cycle grant known, so the newest month is unknown: nothing expires
 *   none_expirable     no unexpired plan credit created before both the notice and the newest cycle grant
 *   due                the next sweep expires expiringPence
 */
export type IdleExpiryState = 'no_final_notice' | 'notice_too_recent' | 'no_cycle_grant' | 'none_expirable' | 'due';

export interface IdleExpiryView {
  userId: string;
  idleSince: string;
  state: IdleExpiryState;
  /** The final notice's sent_at for this idle run (null: none sent). */
  noticeSentAt: string | null;
  /** The first 03:00 UTC credit sweep at or after sent_at + plan_credit_final_notice_days (firstExpirySweepAfter): the date the final email states (null: none sent). */
  dueAt: string | null;
  /** What credit_expire_idle_plan would expire at `now` (for a warned member: if it were due now). */
  expiringPence: number;
  grants: number;
}


function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
}

/**
 * The plan credit credit_expire_idle_plan expires for one member, given the
 * final notice's sent_at: unexpired plan grants with credit left, created
 * before the notice AND before the newest plan_cycle grant created at or
 * before the notice (the month that was newest when the warning went out,
 * which the email promised never expires; a cycle grant arriving after the
 * notice is after it and so safe too). No cycle grant at the notice: nothing
 * (noCycleGrant). `rows` are that member's plan grants, spent ones included
 * (a spent cycle grant still marks the newest month). Times compare to the
 * millisecond.
 */
export function idleExpiringPence(rows: readonly RolloverGrantRow[], sentAt: string, now: Date): { pence: number; grants: number; noCycleGrant: boolean } {
  const sent = Date.parse(sentAt);
  let newest = -Infinity;
  for (const r of rows) {
    const at = Date.parse(r.created_at);
    if (r.plan_cycle && Number.isFinite(at) && at <= sent && at > newest) newest = at;
  }
  if (!Number.isFinite(newest)) return { pence: 0, grants: 0, noCycleGrant: true };
  let pence = 0;
  let grants = 0;
  for (const r of rows) {
    const at = Date.parse(r.created_at);
    const left = Number(r.remaining_pence) || 0;
    if (!(left > 0) || !Number.isFinite(at)) continue;
    if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) continue;
    if (!(at < sent) || !(at < newest)) continue;
    pence += left;
    grants += 1;
  }
  return { pence: round4(pence), grants, noCycleGrant: false };
}

/**
 * For each idle candidate (credit_idle_plan_report at plan_credit_idle_months:
 * still idle and holding plan credit), where it stands against the expiry,
 * mirroring credit_expire_idle_plan without writing anything. `notices` may
 * hold any rows; only this idle run's (same idle_since) final-stage 'sent'
 * row counts. `grants` are plan grants of any of the members.
 */
export function idleExpiryViews(input: {
  candidates: readonly Pick<IdlePlanRowLike, 'userId' | 'idleSince'>[];
  notices: readonly IdleNoticeRecord[];
  grants: readonly MeasureGrantRow[];
  settings: IdleExpirySettings;
  now: Date;
}): IdleExpiryView[] {
  const { settings, now } = input;
  const grantsBy = new Map<string, MeasureGrantRow[]>();
  for (const g of input.grants) {
    const list = grantsBy.get(g.user_id);
    if (list) list.push(g);
    else grantsBy.set(g.user_id, [g]);
  }
  return input.candidates.map((c) => {
    const notice = input.notices.find((n) => n.userId === c.userId && n.stage === settings.idleMonths && n.status === 'sent' && n.sentAt !== null && sameInstant(n.idleSince, c.idleSince));
    const base = { userId: c.userId, idleSince: c.idleSince };
    if (!notice || !notice.sentAt || !Number.isFinite(Date.parse(notice.sentAt))) {
      return { ...base, state: 'no_final_notice' as const, noticeSentAt: null, dueAt: null, expiringPence: 0, grants: 0 };
    }
    const sentAt = notice.sentAt;
    const dueAt = firstExpirySweepAfter(sentAt, settings.finalNoticeDays).toISOString();
    const exp = idleExpiringPence(grantsBy.get(c.userId) ?? [], sentAt, now);
    const view = { ...base, noticeSentAt: sentAt, dueAt, expiringPence: exp.pence, grants: exp.grants };
    if (!expiryDue({ finalNoticeSentAt: sentAt, now, finalNoticeDays: settings.finalNoticeDays })) return { ...view, state: 'notice_too_recent' as const };
    if (exp.noCycleGrant) return { ...view, state: 'no_cycle_grant' as const };
    if (exp.grants === 0) return { ...view, state: 'none_expirable' as const };
    return { ...view, state: 'due' as const };
  });
}

// ── The credit sweep's live expiry and its dry run ──

export interface IdleExpiryOutcome {
  expiredPence: number;
  grants: number;
  reason?: string;
}

export interface IdleExpiryDeps {
  /** Live only: credit_expire_idle_plan (ledger.ts expireIdlePlan). Throws { schemaMissing: true } when the function is missing. */
  expire(userId: string, now: Date): Promise<IdleExpiryOutcome>;
  /** Live only: the record-only activity credit_idle_expired (never throws in production). */
  recordExpired(userId: string, opts: { dedupeKey: string; expiredPence: number; grants: number }): Promise<void>;
  /** Dry only: the two settings. */
  settings(): Promise<IdleExpirySettings>;
  /** Dry only: credit_idle_notices rows of these members at this stage. Throws when the table is missing. */
  finalNotices(userIds: readonly string[], stage: number): Promise<IdleNoticeRecord[]>;
  /** Dry only: these members' plan grants (credit_grants kind 'plan', spent ones included). */
  planGrants(userIds: readonly string[]): Promise<MeasureGrantRow[]>;
  log(line: string): void;
}

export interface IdleExpiryLive {
  idleExpired: Array<{ userId: string; expiredPence: number; grants: number }> | null;
  idleExpiredPence: number;
  /** Members the SQL expired nothing for, counted by its reason. */
  idleExpireSkipped: Record<string, number>;
  idleExpireError?: string;
  /** Per-member failures ("idle-expire <id>: <message>"), for the sweep's errors. */
  errors: string[];
}

export interface IdleExpiryDry {
  wouldExpireIdle: Array<{ userId: string; expiringPence: number; grants: number }> | null;
  wouldExpireIdlePence: number;
  idleExpireSkipped: Record<string, number>;
  idleExpireError?: string;
}

/** The dedupe key of the credit_idle_expired activity: one per member per idle run. */
export function idleExpiredKey(userId: string, idleSince: string): string {
  const d = new Date(idleSince);
  return `credit-idle-expired:${userId}:${Number.isFinite(d.getTime()) ? d.toISOString() : idleSince}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NO_REPORT = 'not run: the idle plan report is unreadable (see idlePlanError)';

/**
 * Live: for every idle candidate, ask credit_expire_idle_plan. It alone
 * decides whether and what expires (still idle, final notice for this run
 * sent at least plan_credit_final_notice_days ago, grants before the notice
 * and the newest month); nothing here judges or expires anything itself. A
 * member it expired credit for gets credit_idle_expired (id and pence only)
 * and a line in idleExpired; the rest are counted by the SQL's reason. One
 * member's failure is logged (id only) and listed in errors; the rest carry
 * on. A missing function stops the loop with idleExpireError (nothing can
 * have expired: the call itself failed).
 */
export async function idleExpiryLive(candidates: readonly IdlePlanRowLike[] | null, deps: IdleExpiryDeps, now: Date): Promise<IdleExpiryLive> {
  const expired: Array<{ userId: string; expiredPence: number; grants: number }> = [];
  const out: IdleExpiryLive = { idleExpired: expired, idleExpiredPence: 0, idleExpireSkipped: {}, errors: [] };
  if (!candidates) return { ...out, idleExpired: null, idleExpireError: NO_REPORT };
  for (const c of candidates) {
    let r: IdleExpiryOutcome;
    try {
      r = await deps.expire(c.userId, now);
    } catch (err) {
      if ((err as { schemaMissing?: boolean } | null)?.schemaMissing) {
        out.idleExpireError = `idle expiry unavailable (schema.sql Batch 34b section not run?): ${errMsg(err)}`;
        deps.log(`[credit-sweep] idle expiry: unavailable, nothing expired`);
        break;
      }
      deps.log(`[credit-sweep] idle expiry failed for ${c.userId}`);
      out.errors.push(`idle-expire ${c.userId}: ${errMsg(err)}`);
      continue;
    }
    const pence = Number(r.expiredPence) || 0;
    if (pence > 0) {
      expired.push({ userId: c.userId, expiredPence: round4(pence), grants: Number(r.grants) || 0 });
      out.idleExpiredPence = round4(out.idleExpiredPence + pence);
      deps.log(`[credit-sweep] idle expiry: ${c.userId} ${round4(pence)}p in ${Number(r.grants) || 0} grant(s)`);
      try {
        await deps.recordExpired(c.userId, { dedupeKey: idleExpiredKey(c.userId, c.idleSince), expiredPence: round4(pence), grants: Number(r.grants) || 0 });
      } catch (err) {
        out.errors.push(`idle-expire activity ${c.userId}: ${errMsg(err)}`);
      }
    } else {
      const reason = r.reason || 'none_expired';
      out.idleExpireSkipped[reason] = (out.idleExpireSkipped[reason] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Dry: the members and pence the live run would expire, from reads only
 * (settings, this run's final notices, plan grants) and idleExpiryViews, the
 * mirror of credit_expire_idle_plan. Exact, not an estimate: it counts only
 * grants created before the notice and before the newest cycle grant. Calls
 * nothing that writes. A read that fails gives idleExpireError.
 */
export async function idleExpiryDry(candidates: readonly IdlePlanRowLike[] | null, deps: IdleExpiryDeps, now: Date): Promise<IdleExpiryDry> {
  if (!candidates) return { wouldExpireIdle: null, wouldExpireIdlePence: 0, idleExpireSkipped: {}, idleExpireError: NO_REPORT };
  try {
    const settings = await deps.settings();
    const ids = candidates.map((c) => c.userId);
    const [notices, grants] = ids.length ? await Promise.all([deps.finalNotices(ids, settings.idleMonths), deps.planGrants(ids)]) : [[], []];
    const views = idleExpiryViews({ candidates, notices, grants, settings, now });
    const wouldExpireIdle: IdleExpiryDry['wouldExpireIdle'] = [];
    const idleExpireSkipped: Record<string, number> = {};
    for (const v of views) {
      if (v.state === 'due') wouldExpireIdle.push({ userId: v.userId, expiringPence: v.expiringPence, grants: v.grants });
      else idleExpireSkipped[v.state] = (idleExpireSkipped[v.state] ?? 0) + 1;
    }
    return { wouldExpireIdle, wouldExpireIdlePence: round4(wouldExpireIdle.reduce((n, r) => n + r.expiringPence, 0)), idleExpireSkipped };
  } catch (err) {
    return { wouldExpireIdle: null, wouldExpireIdlePence: 0, idleExpireSkipped: {}, idleExpireError: `idle expiry preview unavailable (schema.sql Batch 34b section not run?): ${errMsg(err)}` };
  }
}

// ── The admin lists ──

export interface IdleExpiryListRow {
  userId: string;
  /** Shown to the admin only (the page is admin-gated); null when unknown. */
  email: string | null;
  noticeSentAt: string;
  dueAt: string;
  expiringPence: number;
}

export interface IdleExpiryLists {
  /** Final notice sent, still inside plan_credit_final_notice_days: soonest due first. */
  warned: IdleExpiryListRow[];
  /** Notice at least that old, still idle, with credit to expire: what the next 03:00 sweep expires. Largest first. */
  due: IdleExpiryListRow[];
  warnedPence: number;
  duePence: number;
}

/** The two admin lists from idleExpiryViews; members neither warned nor due are left out. */
export function idleExpiryLists(views: readonly IdleExpiryView[], emails: ReadonlyMap<string, string | null>): IdleExpiryLists {
  const row = (v: IdleExpiryView): IdleExpiryListRow => ({ userId: v.userId, email: emails.get(v.userId) ?? null, noticeSentAt: v.noticeSentAt as string, dueAt: v.dueAt as string, expiringPence: v.expiringPence });
  const warned = views.filter((v) => v.state === 'notice_too_recent').map(row).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const due = views.filter((v) => v.state === 'due' && v.expiringPence > 0).map(row).sort((a, b) => b.expiringPence - a.expiringPence);
  return {
    warned,
    due,
    warnedPence: round4(warned.reduce((n, r) => n + r.expiringPence, 0)),
    duePence: round4(due.reduce((n, r) => n + r.expiringPence, 0)),
  };
}
