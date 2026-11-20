import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { adminEmails } from '../admin';
import { loadSubscriptionEvents } from '../billing/churn-server';
import { COUNTED_KINDS, QUALIFYING_KINDS } from '../activity/kinds';
import { computeWeeklyActive, type WeeklyFacts } from '../activity/metrics';
import { recordActivity } from '../activity/log';
import { expireIdlePlan, idlePlanReport } from '../credit/ledger';
import { readIdleReminderSettings } from '../credit/idle-reminders-server';
import {
  idleExpiryLists,
  idleExpiryViews,
  rolloverMeasure,
  type IdleExpiryDeps,
  type IdleExpiryLists,
  type IdleNoticeRecord,
  type MeasureGrantRow,
  type MeasureMember,
  type RolloverMeasure,
} from './rollover-measure';

/**
 * Batch 34, Phase 7: the reads behind "Plan credit rollover" on
 * /admin/weekly-active. The maths is rollover-measure.ts; this only fetches:
 *
 *   - the launch date (billing_settings plan_credit_rollover_from)
 *   - subscription_events (churn-server.ts, the churn report's own read)
 *   - the weekly-active facts (activity_weekly_facts, summed by metrics.ts
 *     computeWeeklyActive with its rule unchanged), over enough weeks to
 *     reach 12 weeks before the launch
 *   - every plan grant (credit_grants, kind 'plan'), for banked and rolled over
 *
 * Batch 34b (Phase 13) adds the "Warned" and "Due to expire" lists: the idle
 * candidates (credit_idle_plan_report), the two settings, this idle run's
 * final notices (credit_idle_notices) and the members' emails (profiles; the
 * page is admin-gated, as the weekly-active drill-down that shows emails).
 * It also holds the credit sweep's live wiring for the no-spend expiry
 * (liveIdleExpiryDeps).
 *
 * Service role only; the page checks the admin session first. Never throws:
 * a part that cannot be read comes back null with a note. The measure leaves
 * this file as counts and pence; only the two admin lists carry an email.
 */

const PAGE = 1000;
const MAX_ROWS = 50_000;
const WEEK = 7 * 86_400_000;

const ID_CHUNK = 150;

export type RolloverMeasureLoad = { ok: true; measure: RolloverMeasure; idle: IdleExpiryLists | null; notes: string[] } | { ok: false; error: string };

async function launchAt(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  const { data, error } = await admin.from('billing_settings').select('value').eq('key', 'plan_credit_rollover_from').maybeSingle();
  if (error || !data) return null;
  const v = (data as { value: unknown }).value;
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
}

/** 12 weeks before the launch up to now (12 weeks when not launched), at most a year. */
function weeksToRead(launch: string | null, now: Date): number {
  const since = launch ? Math.max(0, Math.ceil((now.getTime() - Date.parse(launch)) / WEEK)) : 0;
  return Math.min(52, 12 + since + 1);
}

async function weeklyMembers(now: Date, weeks: number): Promise<{ members: MeasureMember[] | null; note: string | null }> {
  const { data, error } = await createAdminClient().rpc('activity_weekly_facts', {
    p: { weeks, now: now.toISOString(), qualifying: QUALIFYING_KINDS, counted: COUNTED_KINDS },
  });
  if (error) return { members: null, note: `weekly-active facts unreadable: ${error.message}` };
  const report = computeWeeklyActive(data as WeeklyFacts, { adminEmails: adminEmails(), drillWeeks: weeks });
  // Keep only what the measure needs: no email or name goes further.
  return { members: report.members.map((m) => ({ id: m.id, weeks: m.weeks.map((w) => ({ week: w.week, active: w.active })) })), note: null };
}

async function planGrants(): Promise<{ grants: MeasureGrantRow[] | null; note: string | null }> {
  const admin = createAdminClient();
  const out: MeasureGrantRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await admin
      .from('credit_grants')
      .select('user_id, amount_pence, remaining_pence, created_at, plan_cycle, source_ref, expires_at')
      .eq('kind', 'plan')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { grants: null, note: `plan grants unreadable (schema.sql Batch 34 section not run?): ${error.message}` };
    const rows = (data ?? []) as MeasureGrantRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { grants: out, note: null };
}

/** This stage's 'sent' credit_idle_notices rows of these members (every idle run; the caller matches idle_since). Throws when the table is missing. */
async function finalNotices(userIds: readonly string[], stage: number): Promise<IdleNoticeRecord[]> {
  const admin = createAdminClient();
  const out: IdleNoticeRecord[] = [];
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from('credit_idle_notices')
      .select('user_id, idle_since, stage, status, sent_at')
      .in('user_id', userIds.slice(i, i + ID_CHUNK))
      .eq('stage', stage)
      .eq('status', 'sent');
    if (error) throw new Error(`credit_idle_notices unreadable: ${error.message}`);
    for (const r of (data ?? []) as { user_id: string; idle_since: string; stage: number; status: 'sent' | 'skipped'; sent_at: string | null }[]) {
      out.push({ userId: r.user_id, idleSince: r.idle_since, stage: Number(r.stage), status: r.status, sentAt: r.sent_at });
    }
  }
  return out;
}

/** These members' plan grants, spent ones included (a spent cycle grant still marks the newest month). */
async function memberPlanGrants(userIds: readonly string[]): Promise<MeasureGrantRow[]> {
  const admin = createAdminClient();
  const out: MeasureGrantRow[] = [];
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from('credit_grants')
      .select('user_id, amount_pence, remaining_pence, created_at, plan_cycle, source_ref, expires_at')
      .eq('kind', 'plan')
      .in('user_id', userIds.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`plan grants unreadable: ${error.message}`);
    out.push(...((data ?? []) as MeasureGrantRow[]));
  }
  return out;
}

/**
 * The credit sweep's live wiring for the no-spend expiry (rollover-measure.ts
 * idleExpiryLive / idleExpiryDry). expire is credit_expire_idle_plan, the only
 * authority; the dry run uses only the reads.
 */
export function liveIdleExpiryDeps(): IdleExpiryDeps {
  return {
    expire: (userId, now) => expireIdlePlan(userId, now),
    recordExpired: (userId, { dedupeKey, expiredPence, grants }) => recordActivity(userId, 'credit_idle_expired', { dedupeKey, extras: { expiredPence, grants } }),
    settings: async () => {
      const s = await readIdleReminderSettings(createAdminClient());
      return { idleMonths: s.idleMonths, finalNoticeDays: s.finalNoticeDays };
    },
    finalNotices,
    planGrants: memberPlanGrants,
    log: (line) => console.log(line),
  };
}

/** "Warned" and "Due to expire" for the admin page; null with a note when a part cannot be read. */
async function idleLists(now: Date): Promise<{ idle: IdleExpiryLists | null; note: string | null }> {
  try {
    const admin = createAdminClient();
    const [candidates, s] = await Promise.all([idlePlanReport(now), readIdleReminderSettings(admin)]);
    const settings = { idleMonths: s.idleMonths, finalNoticeDays: s.finalNoticeDays };
    const ids = candidates.map((c) => c.userId);
    if (ids.length === 0) return { idle: idleExpiryLists([], new Map()), note: null };
    const [notices, grants] = await Promise.all([finalNotices(ids, settings.idleMonths), memberPlanGrants(ids)]);
    const views = idleExpiryViews({ candidates, notices, grants, settings, now });
    const listed = views.filter((v) => v.state === 'notice_too_recent' || v.state === 'due').map((v) => v.userId);
    const emails = new Map<string, string | null>();
    for (let i = 0; i < listed.length; i += ID_CHUNK) {
      const { data, error } = await admin.from('profiles').select('id, email').in('id', listed.slice(i, i + ID_CHUNK));
      if (error) break; // the lists still show, by short id
      for (const r of (data ?? []) as { id: string; email: string | null }[]) emails.set(r.id, r.email ?? null);
    }
    return { idle: idleExpiryLists(views, emails), note: null };
  } catch (err) {
    return { idle: null, note: `warned / due-to-expire lists unreadable (schema.sql Batch 34b section not run?): ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function loadRolloverMeasure(now: Date = new Date()): Promise<RolloverMeasureLoad> {
  if (!hasServiceRole()) return { ok: false, error: 'Storage not configured' };
  try {
    const launch = await launchAt(createAdminClient());
    const [events, weekly, grants] = await Promise.all([loadSubscriptionEvents(), weeklyMembers(now, weeksToRead(launch, now)), planGrants()]);
    const idle = await idleLists(now);
    const notes = [weekly.note, grants.note, idle.note].filter((n): n is string => n !== null);
    if (!launch) notes.unshift('No launch date yet (billing_settings plan_credit_rollover_from is set when schema.sql’s Batch 34 section runs): everything counts as before.');
    return { ok: true, measure: rolloverMeasure({ launchAt: launch, now, events, members: weekly.members, grants: grants.grants }), idle: idle.idle, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rollover-measure] read failed:', message);
    return { ok: false, error: message };
  }
}
