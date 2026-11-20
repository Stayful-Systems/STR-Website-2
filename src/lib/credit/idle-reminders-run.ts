/**
 * Batch 34b (Phase 12): the daily no-spend reminder cron,
 * /api/internal/credit-idle-reminders, 06:43 UTC (before the Academy
 * reminders at 06:47 and the morning picks from 07:00).
 *
 * For each member holding plan credit with no spend for at least the smallest
 * reminder stage (credit_idle_plan_report with p_min_months), it reads this
 * idle run's credit_idle_notices rows and asks the pure rules in rollover.ts:
 *
 *   idleStageDue      the highest stage due with no row; lower missed stages
 *                     are recorded 'skipped' (a missed reminder never goes late).
 *   reminderDecision  skip   record a 'skipped' row for the stage
 *                     wait   the one-a-day cap is used: record NOTHING, so the
 *                            same stage is due again tomorrow
 *                     send   claim the day's slot (credit_idle, or
 *                            credit_idle_final for the final warning), send
 *                            with the idempotency key
 *                            credit-idle:<user>:<idle_since ISO>:<stage>, then
 *                            stamp the row 'sent' and record activity. A send
 *                            that fails gives the slot back and records
 *                            nothing (it tries again tomorrow).
 *
 * The 3- and 6-month reminders respect the credit alerts switch; the final
 * warning (the stage equal to plan_credit_idle_months) is a billing notice and
 * ignores it. Nothing here expires credit (that is the 03:00 credit sweep).
 *
 * Dependency-injected (idle-reminders-server.ts holds the live wiring), so the
 * test runs it on fakes. Dry run: lists wouldSend / waiting / skipped and
 * writes nothing (no notices, no claims, no sends, no activity). Lists and
 * logs carry a user id, the stage and an outcome only: never an email
 * address, a name or an email body.
 */
import { firstExpirySweepAfter, idleStageDue, reminderDecision, type IdleNoticeRow } from './rollover.ts';

const TIME_BUDGET_MS = 45_000;

export type IdleReminderKind = 'credit_idle' | 'credit_idle_final';

export interface IdleReminderCandidate {
  userId: string;
  /** The idle run's start, as credit_idle_plan_report returns it. */
  idleSince: string;
  planRemainingPence: number;
  expirablePence: number;
}

export interface IdleReminderSettings {
  /** idleStages(plan_credit_idle_reminder_months, plan_credit_idle_months): sorted, ending with the final stage. */
  stages: number[];
  /** plan_credit_idle_months (the final stage). */
  idleMonths: number;
  /** plan_credit_final_notice_days. */
  finalNoticeDays: number;
}

export interface IdleReminderMember {
  /** The credit alerts switch (profiles.alert_credit; on unless turned off). */
  alertsOn: boolean;
  email: string | null;
}

export type IdleReminderClaim = { ok: true; id: string } | { ok: false; reason: string };

export interface IdleSendResult {
  sent: boolean;
  reason?: string;
}

export interface IdleRemindersDeps {
  settings(): Promise<IdleReminderSettings>;
  /** Members idle at least minMonths (credit_idle_plan_report). Throws when the function is missing. */
  candidates(now: Date, minMonths: number): Promise<IdleReminderCandidate[]>;
  /** credit_idle_notices rows per member, with their idle_since. Throws when the table is missing. */
  notices(userIds: readonly string[]): Promise<Map<string, Array<IdleNoticeRow & { idleSince: string }>>>;
  members(userIds: readonly string[]): Promise<Map<string, IdleReminderMember>>;
  /** Dry run only: who has used today's daily slot already (null: unreadable, assume free). */
  slotsUsedToday(userIds: readonly string[], now: Date): Promise<Set<string> | null>;
  /** The member's whole balance, for the email (null: unreadable; the plan credit is shown instead). */
  balancePence(userId: string): Promise<number | null>;
  claimSlot(userId: string, kind: IdleReminderKind, now: Date): Promise<IdleReminderClaim>;
  releaseClaim(claimId: string): Promise<void>;
  /** About to send (the cap record); false: could not be written, so do not send. */
  markSending(claimId: string, summary: Record<string, unknown>): Promise<boolean>;
  /** The send did not go: the cap row is deleted so a later run may use the slot. */
  abandonSend(claimId: string): Promise<void>;
  finishSend(claimId: string, summary: Record<string, unknown>): Promise<void>;
  sendReminder(to: string | null, data: { months: number; balancePence: number }, idempotencyKey: string): Promise<IdleSendResult>;
  sendFinalWarning(to: string | null, data: { balancePence: number; expiringPence: number; expiresOn: Date; months: number }, idempotencyKey: string): Promise<IdleSendResult>;
  /** Insert a 'skipped' row (on conflict do nothing). */
  recordSkipped(userId: string, idleSince: string, stage: number): Promise<void>;
  /** Stamp the stage 'sent' with sent_at. */
  stampSent(userId: string, idleSince: string, stage: number, sentAt: Date): Promise<void>;
  recordActivity(userId: string, opts: { dedupeKey: string; stage: number; kind: IdleReminderKind }): Promise<void>;
  log(line: string): void;
  /** Milliseconds, for the time budget (tests pass a fake clock). */
  clock?(): number;
}

export interface IdleReminderEntry {
  userId: string;
  stage: number;
  kind: IdleReminderKind;
  reason?: string;
}

export interface IdleRemindersResult {
  status: number;
  body: Record<string, unknown>;
}

function msg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** The ISO form of an idle_since, so the key is the same whatever form the database returned. */
export function idleSinceIso(idleSince: string | Date): string {
  const d = idleSince instanceof Date ? idleSince : new Date(idleSince);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(idleSince);
}

/** credit-idle:<user_id>:<idle_since ISO>:<stage> */
export function creditIdleKey(userId: string, idleSince: string | Date, stage: number): string {
  return `credit-idle:${userId}:${idleSinceIso(idleSince)}:${stage}`;
}

/** A short, stable tag for log lines (never the email). */
function tag(userId: string): string {
  return userId.slice(0, 8);
}

function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
}

export async function runCreditIdleReminders(deps: IdleRemindersDeps, opts: { dry: boolean; now?: Date }): Promise<IdleRemindersResult> {
  const dry = opts.dry;
  const now = opts.now ?? new Date();
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  const outOfTime = () => clock() - started > TIME_BUDGET_MS;

  let settings: IdleReminderSettings;
  try {
    settings = await deps.settings();
  } catch (err) {
    return { status: 503, body: { error: `billing settings unreadable: ${msg(err)}` } };
  }
  const stages = settings.stages;
  if (stages.length === 0) return { status: 503, body: { error: 'no reminder stages (plan_credit_idle_months unreadable)' } };
  const finalStage = stages[stages.length - 1];
  const kindOf = (stage: number): IdleReminderKind => (stage >= finalStage ? 'credit_idle_final' : 'credit_idle');

  let candidates: IdleReminderCandidate[];
  let notices: Map<string, Array<IdleNoticeRow & { idleSince: string }>>;
  let members: Map<string, IdleReminderMember>;
  try {
    candidates = await deps.candidates(now, stages[0]);
  } catch (err) {
    return { status: 503, body: { error: `credit_idle_plan_report unavailable (schema.sql not run?): ${msg(err)}` } };
  }
  const ids = [...new Set(candidates.map((c) => c.userId))];
  try {
    notices = ids.length > 0 ? await deps.notices(ids) : new Map();
  } catch (err) {
    return { status: 503, body: { error: `credit_idle_notices unavailable (schema.sql not run?): ${msg(err)}` } };
  }
  try {
    members = ids.length > 0 ? await deps.members(ids) : new Map();
  } catch (err) {
    return { status: 503, body: { error: `profiles unreadable: ${msg(err)}` } };
  }
  const usedToday = dry && ids.length > 0 ? await deps.slotsUsedToday(ids, now).catch(() => null) : null;

  const wouldSend: IdleReminderEntry[] = [];
  const waiting: IdleReminderEntry[] = [];
  const skipped: IdleReminderEntry[] = [];
  const sentList: IdleReminderEntry[] = [];
  const errors: string[] = [];
  let ranOutOfTime = false;

  for (const c of candidates) {
    if (outOfTime()) {
      ranOutOfTime = true;
      break;
    }
    try {
      const existing = (notices.get(c.userId) ?? []).filter((n) => sameInstant(n.idleSince, c.idleSince));
      const { due, skipped: missed } = idleStageDue({ idleSince: c.idleSince, now, stages, existing });
      for (const stage of missed) {
        if (!dry) await deps.recordSkipped(c.userId, c.idleSince, stage);
        skipped.push({ userId: c.userId, stage, kind: kindOf(stage), reason: 'missed' });
      }
      if (due == null) continue;
      const kind = kindOf(due);
      const member = members.get(c.userId);
      const alertsOn = member?.alertsOn ?? true;
      const capUsedToday = dry ? Boolean(usedToday?.has(c.userId)) : false;
      const decision = reminderDecision({ stage: due, finalStage, alertsOn, capUsedToday, planCreditPence: c.planRemainingPence, expirablePence: c.expirablePence });
      const entry: IdleReminderEntry = { userId: c.userId, stage: due, kind };

      if (decision.decision === 'skip') {
        if (!dry) await deps.recordSkipped(c.userId, c.idleSince, due);
        skipped.push({ ...entry, reason: decision.reason });
        if (!dry) deps.log(`[credit-idle-reminders] ${tag(c.userId)} stage ${due} skipped: ${decision.reason}`);
        continue;
      }
      if (decision.decision === 'wait') {
        waiting.push({ ...entry, reason: decision.reason });
        continue;
      }
      if (dry) {
        wouldSend.push(entry);
        continue;
      }

      // ── Live send: claim, mark, send, stamp ──
      const claim = await deps.claimSlot(c.userId, kind, now);
      if (!claim.ok) {
        // The day's slot is used (or the record unavailable): nothing recorded, tomorrow.
        waiting.push({ ...entry, reason: claim.reason === 'slot_used' ? 'cap_used' : claim.reason });
        continue;
      }
      const key = creditIdleKey(c.userId, c.idleSince, due);
      const summary = { creditIdle: true, stage: due, kind };
      if (!(await deps.markSending(claim.id, summary))) {
        await deps.releaseClaim(claim.id);
        waiting.push({ ...entry, reason: 'cap_record_unavailable' });
        continue;
      }
      let balance: number | null = null;
      try {
        balance = await deps.balancePence(c.userId);
      } catch {
        balance = null;
      }
      const balancePence = balance ?? c.planRemainingPence;
      const to = member?.email ?? null;
      let res: IdleSendResult;
      try {
        res =
          kind === 'credit_idle_final'
            ? await deps.sendFinalWarning(to, { balancePence, expiringPence: c.expirablePence, expiresOn: firstExpirySweepAfter(now, settings.finalNoticeDays), months: settings.idleMonths }, key)
            : await deps.sendReminder(to, { months: due, balancePence }, key);
      } catch (err) {
        res = { sent: false, reason: msg(err) };
      }
      if (!res.sent) {
        await deps.abandonSend(claim.id);
        errors.push(`${c.userId} stage ${due}: ${res.reason ?? 'send_failed'}`);
        deps.log(`[credit-idle-reminders] ${tag(c.userId)} stage ${due} send failed: ${res.reason ?? 'send_failed'}`);
        continue;
      }
      await deps.finishSend(claim.id, summary);
      try {
        await deps.stampSent(c.userId, c.idleSince, due, new Date());
      } catch (err) {
        // Logged to fix by hand: an unstamped stage could go again tomorrow (Resend keeps a key 24 hours).
        errors.push(`${c.userId} stage ${due}: stamp failed`);
        deps.log(`[credit-idle-reminders] ${tag(c.userId)} stage ${due} stamp failed: ${msg(err)}`);
      }
      await deps.recordActivity(c.userId, { dedupeKey: key, stage: due, kind });
      sentList.push(entry);
      deps.log(`[credit-idle-reminders] ${tag(c.userId)} stage ${due} sent`);
    } catch (err) {
      errors.push(`${c.userId}: ${msg(err)}`);
      deps.log(`[credit-idle-reminders] ${tag(c.userId)} failed: ${msg(err)}`);
    }
  }

  const ms = clock() - started;
  if (dry) return { status: 200, body: { dry: true, candidates: candidates.length, wouldSend, waiting, skipped, errors, ranOutOfTime, ms } };
  deps.log(`[credit-idle-reminders] candidates ${candidates.length}, sent ${sentList.length}, waiting ${waiting.length}, skipped ${skipped.length}, errors ${errors.length}`);
  return {
    status: 200,
    body: { dry: false, candidates: candidates.length, sent: sentList, waiting, skipped, counts: { sent: sentList.length, waiting: waiting.length, skipped: skipped.length, errors: errors.length }, errors, ranOutOfTime, ms },
  };
}
